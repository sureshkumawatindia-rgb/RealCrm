const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const MessageTemplate = require('../models/MessageTemplate');
const Order = require('../models/Order');
const Organization = require('../models/Organization');
const PaymentLink = require('../models/PaymentLink');
const Product = require('../models/Product');
const Quotation = require('../models/Quotation');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const httpError = require('../utils/httpError');
const logger = require('../config/logger');
const { audit } = require('../utils/audit');
const { nextSequence } = require('../utils/counter');
const { financialYear, formatRupees } = require('../utils/money');
const { stateName } = require('../constants/gst');
const { ORDER_FLOW, ORDER_STAGES } = require('../constants/crm');
const { toPage, paginationMeta } = require('../utils/pagination');
const { visibilityFilter } = require('./access');
const { billingOf } = require('./organizationService');
const leadService = require('./leadService');
const conversationService = require('./conversationService');
const templateService = require('./templateService');
const automationEvents = require('./automation/events');

// Orders (Phase 5): made from an accepted quotation, then moved through ORDER_FLOW (any step,
// forwards or back, except out of Cancelled; a paid order is not cancelled). Dispatch details
// (transporter, LR number) are kept; "Payment Collected" wins the lead. With "reduce stock on
// dispatch" the stock goes down once when the order reaches Dispatched or later and comes back
// if it is cancelled or moved back. A stage change can also send the customer a WhatsApp update.
// Payments (Phase 8) come from payment links or are entered by hand; see recordPayment.
const MODULES = leadService.MODULES;
const SHIPPED = ORDER_FLOW.slice(ORDER_FLOW.indexOf('Dispatched')); // Dispatched and after

const scope = (req) => ({ organizationId: req.tenant.organizationId, ...visibilityFilter(req, MODULES) });
const plain = (value) => (value?.toObject ? value.toObject() : value);

function nextStages(stage) {
  if (stage === 'Cancelled') return [];
  return [...ORDER_FLOW.filter((s) => s !== stage), ...(stage === 'Payment Collected' ? [] : ['Cancelled'])];
}

// --- what is paid (Phase 8) -------------------------------------------------------------
// Paid in full by payments, or moved to Payment Collected by hand (collected outside the CRM).
function paymentStatusOf(order) {
  const total = order.totals?.grandTotalPaise || 0;
  const paid = order.amountPaidPaise || 0;
  if (order.stage === 'Payment Collected' || (total > 0 && paid >= total)) return 'paid';
  return paid > 0 ? 'partly_paid' : 'unpaid';
}
function duePaise(order) {
  if (order.stage === 'Cancelled' || paymentStatusOf(order) === 'paid') return 0;
  return Math.max((order.totals?.grandTotalPaise || 0) - (order.amountPaidPaise || 0), 0);
}
const serializePayment = (payment) => ({
  id: payment._id, source: payment.source, amountPaise: payment.amountPaise, method: payment.method || '', reference: payment.reference || '',
  paidAt: payment.paidAt, paymentLinkId: payment.paymentLinkId || null, provider: payment.provider || '', providerPaymentId: payment.providerPaymentId || '',
  recordedByName: payment.recordedByName || '',
});

function serializeOrder(order) {
  return {
    id: order._id,
    number: order.number,
    financialYear: order.financialYear,
    quotationId: order.quotationId || null,
    quotationNumber: order.quotationNumber || '',
    source: order.source || 'quotation',
    catalogOrder: order.catalogOrder?.messageId
      ? { messageId: order.catalogOrder.messageId, conversationId: order.catalogOrder.conversationId || null, text: order.catalogOrder.text || '', warnings: order.catalogOrder.warnings || [] }
      : null,
    leadId: order.leadId || null,
    contactId: order.contactId || null,
    ownerId: order.ownerId || null,
    stage: order.stage,
    orderDate: order.orderDate,
    billTo: plain(order.billTo) || {},
    seller: plain(order.seller) || {},
    supply: { ...(plain(order.supply) || {}), placeOfSupply: stateName(order.supply?.placeOfSupplyCode) },
    items: plain(order.items) || [],
    totals: plain(order.totals) || {},
    dispatch: plain(order.dispatch) || {},
    deliveredAt: order.deliveredAt || null,
    paidAt: order.paidAt || null,
    paymentStatus: paymentStatusOf(order),
    amountPaidPaise: order.amountPaidPaise || 0,
    duePaise: duePaise(order),
    payments: (order.payments || []).map(serializePayment),
    cancelledAt: order.cancelledAt || null,
    cancelReason: order.cancelReason || '',
    notes: order.notes || '',
    stockReduced: Boolean(order.stockReduced),
    history: (order.history || []).map(plain),
    nextStages: nextStages(order.stage),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

async function findVisible(req, id, session) {
  const order = await Order.findOne({ _id: id, ...scope(req) }).session(session || null);
  if (!order) throw httpError(404, 'NOT_FOUND', 'Order not found');
  return order;
}

async function leadOf(order, session) {
  return order.leadId ? Lead.findById(order.leadId).session(session || null) : null;
}

const by = (req) => ({ byUserId: req.user._id, byName: req.user.name || '' });

// POST /orders { quotationId } — from an accepted quotation, once.
async function create(req, { quotationId }) {
  let order;
  await mongoose.connection.transaction(async (session) => {
    const quotation = await Quotation.findOne({ _id: quotationId, organizationId: req.tenant.organizationId, ...visibilityFilter(req, MODULES) }).session(session);
    if (!quotation) throw httpError(404, 'NOT_FOUND', 'Quotation not found');
    if (quotation.orderId) throw httpError(409, 'ORDER_EXISTS', 'An order was already made from this quotation.', [{ field: 'quotationId', code: 'ORDER_EXISTS', message: String(quotation.orderId) }]);
    if (quotation.status !== 'Accepted') throw httpError(409, 'NOT_ACCEPTED', 'Mark the quotation as accepted by the customer first.');
    const organization = await Organization.findById(req.tenant.organizationId).session(session);
    const year = financialYear();
    const seq = await nextSequence(organization._id, `order:${year}`, { session });
    order = new Order({
      organizationId: organization._id,
      number: `${billingOf(organization).prefixes.order}/${year}/${String(seq).padStart(4, '0')}`,
      financialYear: year,
      quotationId: quotation._id,
      quotationNumber: quotation.number,
      leadId: quotation.leadId,
      contactId: quotation.contactId,
      ownerId: quotation.ownerId,
      billTo: plain(quotation.billTo),
      seller: plain(quotation.seller),
      supply: plain(quotation.supply),
      items: (quotation.items || []).map(plain),
      totals: plain(quotation.totals),
      history: [{ stage: 'Received', from: '', ...by(req), note: `From ${quotation.type.toLowerCase()} ${quotation.number}` }],
      createdById: req.user._id,
    });
    await order.save({ session });
    quotation.orderId = order._id;
    await quotation.save({ session });
    const lead = await leadOf(order, session);
    if (lead) await leadService.addActivity(req, lead, 'Order', `Order ${order.number} received (${formatRupees(order.totals.grandTotalPaise)}) from ${quotation.number}`, { session });
  });
  await audit(req, { action: 'order.created', entityType: 'Order', entityId: order._id, changes: { quotationId } });
  automationEvents.emit('order.created', { organizationId: order.organizationId, orderId: order._id, leadId: order.leadId || null, contactId: order.contactId, quotationId: order.quotationId, key: `order.created:${order._id}` }, req);
  return serializeOrder(order);
}

async function list(req, query) {
  const filter = {
    ...scope(req),
    ...(query.stage && { stage: query.stage }),
    ...(query.contactId && { contactId: query.contactId }),
    ...(query.leadId && { leadId: query.leadId }),
  };
  if (query.q) {
    const pattern = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: pattern }, { quotationNumber: pattern }, { 'billTo.name': pattern }, { 'billTo.company': pattern }, { 'dispatch.lrNumber': pattern }];
  }
  const page = toPage(query);
  const [items, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1, _id: -1 }).skip(page.skip).limit(page.limit),
    Order.countDocuments(filter),
  ]);
  return { items: items.map(serializeOrder), pagination: paginationMeta(page, total) };
}

// How many orders are at each stage (the tabs on the Orders page).
async function summary(req) {
  const rows = await Order.aggregate([{ $match: { ...scope(req), deletedAt: null } }, { $group: { _id: '$stage', count: { $sum: 1 } } }]);
  const counts = Object.fromEntries(ORDER_STAGES.map((stage) => [stage, 0]));
  for (const row of rows) counts[row._id] = row.count;
  return { counts, total: rows.reduce((sum, row) => sum + row.count, 0) };
}

const DISPATCH_FIELDS = ['transporter', 'lrNumber', 'vehicleNumber', 'expectedDeliveryDate'];
function applyDispatch(order, dispatch = {}) {
  for (const field of DISPATCH_FIELDS) if (dispatch[field] !== undefined) order.dispatch[field] = dispatch[field] || (field === 'expectedDeliveryDate' ? undefined : '');
}

// PATCH /orders/:id — dispatch details and notes.
async function update(req, id, { dispatch, notes }) {
  const order = await findVisible(req, id);
  if (dispatch) applyDispatch(order, dispatch);
  if (notes !== undefined) order.notes = notes;
  order.markModified('dispatch');
  await order.save();
  await audit(req, { action: 'order.updated', entityType: 'Order', entityId: order._id });
  return serializeOrder(order);
}

// Stock off when the order ships (never below 0, remembered), back when it is undone.
async function takeStock(order, session) {
  const moves = [];
  for (const item of order.items) {
    if (!item.productId) continue;
    const product = await Product.findOne({ _id: item.productId, organizationId: order.organizationId, stockQty: { $type: 'number' } }).session(session);
    if (!product) continue;
    const quantity = Math.min(product.stockQty, Number(item.quantity) || 0);
    if (quantity <= 0) continue;
    await Product.updateOne({ _id: product._id }, { $inc: { stockQty: -quantity } }, { session });
    moves.push({ productId: product._id, quantity });
  }
  order.stockMoves = moves;
  order.stockReduced = true;
}
async function returnStock(order, session) {
  for (const move of order.stockMoves || []) {
    await Product.updateOne({ _id: move.productId, organizationId: order.organizationId, stockQty: { $type: 'number' } }, { $inc: { stockQty: move.quantity } }, { session });
  }
  order.stockMoves = [];
  order.stockReduced = false;
}

// POST /orders/:id/stage { stage, note?, cancelReason?, dispatch? }
async function changeStage(req, id, { stage, note = '', cancelReason = '', dispatch }) {
  let order;
  let paid = false;
  let from;
  await mongoose.connection.transaction(async (session) => {
    order = await findVisible(req, id, session);
    from = order.stage;
    if (from === 'Cancelled') throw httpError(409, 'ORDER_CANCELLED', 'A cancelled order stays cancelled.');
    if (stage === from) throw httpError(409, 'SAME_STAGE', `The order is already at ${stage}.`);
    if (stage === 'Cancelled' && from === 'Payment Collected') throw httpError(409, 'ORDER_PAID', 'A paid order cannot be cancelled.');
    if (stage === 'Cancelled' && !String(cancelReason).trim()) throw httpError(422, 'CANCEL_REASON_REQUIRED', 'Please say why the order was cancelled.');
    if (dispatch) applyDispatch(order, dispatch);
    const now = new Date();
    if (stage === 'Dispatched' && !order.dispatch.dispatchedAt) order.dispatch.dispatchedAt = now;
    if (stage === 'Delivered' && !order.deliveredAt) order.deliveredAt = now;
    if (stage === 'Payment Collected') {
      order.paidAt = order.paidAt || now;
      paid = true;
    } else if (from === 'Payment Collected' && (order.amountPaidPaise || 0) < (order.totals?.grandTotalPaise || 0)) {
      order.paidAt = undefined; // "collected" undone, and the payments do not cover it
    }
    if (stage === 'Cancelled') {
      order.cancelledAt = now;
      order.cancelReason = String(cancelReason).trim();
    }
    const organization = await Organization.findById(order.organizationId).session(session);
    if (billingOf(organization).reduceStockOnDispatch && SHIPPED.includes(stage) && !order.stockReduced) await takeStock(order, session);
    if (order.stockReduced && (stage === 'Cancelled' || !SHIPPED.includes(stage))) await returnStock(order, session);
    order.stage = stage;
    order.history.push({ stage, from, at: now, ...by(req), note: String(stage === 'Cancelled' ? cancelReason : note || '').trim() });
    order.markModified('dispatch');
    await order.save({ session });
    const lead = await leadOf(order, session);
    if (lead) {
      const ship = stage === 'Dispatched' && (order.dispatch.transporter || order.dispatch.lrNumber)
        ? ` (${[order.dispatch.transporter, order.dispatch.lrNumber && `LR ${order.dispatch.lrNumber}`].filter(Boolean).join(', ')})` : '';
      await leadService.addActivity(req, lead, 'Order', `Order ${order.number}: ${from} → ${stage}${ship}${stage === 'Cancelled' ? `: ${order.cancelReason}` : ''}`, { session });
    }
  });
  // Payment collected: the deal is won (the lead converts, the contact becomes a customer).
  if (paid && order.leadId) {
    try {
      await leadService.convert(req, order.leadId);
    } catch (error) {
      if (error.statusCode !== 404) throw error; // the lead was deleted or is someone else's
    }
  }
  await audit(req, { action: 'order.stage_changed', entityType: 'Order', entityId: order._id, changes: { stage } });
  const facts = { organizationId: order.organizationId, orderId: order._id, leadId: order.leadId, contactId: order.contactId, quotationId: order.quotationId, orderNumber: order.number };
  automationEvents.emit('order.stage_changed', { ...facts, from, to: stage }, req);
  if (stage === 'Payment Collected') automationEvents.emit('payment.received', { ...facts, amountPaise: order.totals?.grandTotalPaise, key: `payment.received:${order._id}` }, req);
  return serializeOrder(order);
}

// --- payments ------------------------------------------------------------------------------
const METHOD_LABELS = { cash: 'cash', bank_transfer: 'bank transfer', upi: 'UPI', cheque: 'cheque', card: 'card', other: 'other', netbanking: 'net banking', wallet: 'wallet', emi: 'EMI' };

// Adds a payment to an order: from a payment link (once per gateway payment id) or by hand.
// The first payment wins the lead (D40); paid in full, a Delivered order moves on to Payment
// Collected. entry: { source, amountPaise, method, reference, paidAt, paymentLinkId, provider,
// providerPaymentId }. Returns { order, duplicate, completed }.
async function recordPayment(req, orderId, entry) {
  let order;
  let duplicate = false;
  let completed = false;
  let moved = null;
  let added;
  await mongoose.connection.transaction(async (session) => {
    duplicate = false;
    completed = false;
    moved = null;
    order = await Order.findOne({ _id: orderId, organizationId: req.tenant.organizationId }).session(session);
    if (!order) throw httpError(404, 'NOT_FOUND', 'Order not found');
    if (entry.providerPaymentId && order.payments.some((p) => p.providerPaymentId === entry.providerPaymentId)) {
      duplicate = true;
      return;
    }
    const wasPaid = paymentStatusOf(order) === 'paid';
    order.payments.push({ ...entry, recordedById: req.user._id, recordedByName: req.user.name || '' });
    added = order.payments[order.payments.length - 1];
    order.amountPaidPaise = order.payments.reduce((sum, p) => sum + (p.amountPaise || 0), 0);
    const now = new Date();
    if (!wasPaid && paymentStatusOf(order) === 'paid') {
      completed = true;
      order.paidAt = order.paidAt || now;
      if (order.stage === 'Delivered') {
        moved = { from: order.stage, to: 'Payment Collected' };
        order.stage = 'Payment Collected';
        order.history.push({ stage: moved.to, from: moved.from, at: now, ...by(req), note: 'Paid in full' });
      }
    }
    await order.save({ session });
    const lead = await leadOf(order, session);
    if (lead) {
      const how = entry.source === 'link' ? `by payment link${entry.method ? ` (${METHOD_LABELS[entry.method] || entry.method})` : ''}` : `by ${METHOD_LABELS[entry.method] || 'hand'}${entry.reference ? `, ref ${entry.reference}` : ''}`;
      const left = duePaise(order);
      await leadService.addActivity(req, lead, 'Payment', `${formatRupees(entry.amountPaise)} received for order ${order.number} ${how}${left ? ` — ${formatRupees(left)} still due` : ' — paid in full'}`, { session });
    }
  });
  if (duplicate) return { order: serializeOrder(order), duplicate, completed };
  // A payment wins the deal (the lead converts, the contact becomes a customer).
  if (order.leadId) {
    try {
      await leadService.convert(req, order.leadId);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
  }
  await audit(req, { action: 'order.payment_recorded', entityType: 'Order', entityId: order._id, changes: { amountPaise: entry.amountPaise, source: entry.source, method: entry.method } });
  const facts = { organizationId: order.organizationId, orderId: order._id, leadId: order.leadId, contactId: order.contactId, quotationId: order.quotationId, orderNumber: order.number };
  automationEvents.emit('payment.received', { ...facts, amountPaise: entry.amountPaise, key: `payment.received:${order._id}:${entry.providerPaymentId || added._id}` }, req);
  if (moved) automationEvents.emit('order.stage_changed', { ...facts, ...moved }, req);
  return { order: serializeOrder(order), duplicate, completed, paymentId: added._id };
}

// POST /orders/:id/payments — money received outside the CRM's links (cash, bank transfer …).
async function addManualPayment(req, id, { amountPaise, method, reference = '', paidAt }) {
  const order = await findVisible(req, id);
  if (order.stage === 'Cancelled') throw httpError(409, 'ORDER_CANCELLED', 'This order was cancelled.');
  const { order: result, completed } = await recordPayment(req, order._id, { source: 'manual', amountPaise, method, reference: String(reference || '').trim(), paidAt: paidAt || new Date() });
  // Paid in full outside the links: unpaid links of this order are cancelled, so the customer
  // cannot pay twice (a part-paid link cannot be cancelled at the gateway; it stays visible).
  if (completed) {
    const paymentLinks = require('./paymentLinkService'); // eslint-disable-line global-require -- it uses this service
    const open = await PaymentLink.find({ organizationId: order.organizationId, $or: [{ orderId: order._id }, ...(order.quotationId ? [{ quotationId: order.quotationId }] : [])], status: 'created' });
    for (const link of open) {
      await paymentLinks.cancel(req, link._id).catch((error) => logger.warn(`Could not cancel payment link ${link._id}: ${error.message}`));
    }
  }
  return result;
}

// DELETE /orders/:id/payments/:paymentId — undoes a payment entered by hand by mistake.
// Gateway payments stay (they are the gateway's record).
async function removeManualPayment(req, id, paymentId) {
  let order;
  await mongoose.connection.transaction(async (session) => {
    order = await findVisible(req, id, session);
    const payment = order.payments.id(paymentId);
    if (!payment) throw httpError(404, 'NOT_FOUND', 'Payment not found');
    if (payment.source !== 'manual') throw httpError(409, 'GATEWAY_PAYMENT', 'Payments made through a payment link cannot be removed here.');
    payment.deleteOne();
    order.amountPaidPaise = order.payments.reduce((sum, p) => sum + (p.amountPaise || 0), 0);
    if (paymentStatusOf(order) !== 'paid') order.paidAt = undefined;
    await order.save({ session });
    const lead = await leadOf(order, session);
    if (lead) await leadService.addActivity(req, lead, 'Payment', `${formatRupees(payment.amountPaise)} entered for order ${order.number} was removed`, { session });
  });
  await audit(req, { action: 'order.payment_removed', entityType: 'Order', entityId: order._id, changes: { paymentId } });
  return serializeOrder(order);
}

// GET /orders/dues — orders with money still to come (not cancelled, not marked collected), the
// oldest first, with their open payment link and how long they have been waiting.
const DUES_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
async function dues(req, { q, minDays = 0 } = {}) {
  const now = Date.now();
  const filter = {
    ...scope(req),
    stage: { $nin: ['Cancelled', 'Payment Collected'] },
    $expr: { $lt: [{ $ifNull: ['$amountPaidPaise', 0] }, { $ifNull: ['$totals.grandTotalPaise', 0] }] },
    ...(minDays > 0 && { orderDate: { $lte: new Date(now - minDays * DAY_MS) } }),
  };
  if (q) {
    const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: pattern }, { 'billTo.name': pattern }, { 'billTo.company': pattern }];
  }
  const orders = await Order.find(filter).select('-items -history -seller -supply -stockMoves').sort({ orderDate: 1, _id: 1 }).limit(DUES_LIMIT);
  const links = await PaymentLink.find({ organizationId: req.tenant.organizationId, orderId: { $in: orders.map((o) => o._id) }, status: { $in: ['created', 'partially_paid'] } })
    .select('orderId shortUrl sentAt status amountPaise amountPaidPaise createdAt').sort({ createdAt: -1 });
  const linkOf = new Map();
  for (const link of links) if (!linkOf.has(String(link.orderId))) linkOf.set(String(link.orderId), link);
  const BUCKETS = [['0-7', 7], ['8-30', 30], ['31-60', 60], ['60+', Infinity]];
  const summary = { count: 0, duePaise: 0, buckets: Object.fromEntries(BUCKETS.map(([name]) => [name, { count: 0, duePaise: 0 }])) };
  const items = orders.map((order) => {
    const due = duePaise(order);
    const days = Math.max(Math.floor((now - new Date(order.orderDate || order.createdAt).getTime()) / DAY_MS), 0);
    const [bucket] = BUCKETS.find(([, upTo]) => days <= upTo);
    summary.count += 1;
    summary.duePaise += due;
    summary.buckets[bucket].count += 1;
    summary.buckets[bucket].duePaise += due;
    const link = linkOf.get(String(order._id));
    return {
      id: order._id, number: order.number, stage: order.stage, orderDate: order.orderDate, deliveredAt: order.deliveredAt || null,
      customer: { name: order.billTo?.name || '', company: order.billTo?.company || '', phone: order.billTo?.phone || '' },
      contactId: order.contactId || null, ownerId: order.ownerId || null, leadId: order.leadId || null,
      totalPaise: order.totals?.grandTotalPaise || 0, amountPaidPaise: order.amountPaidPaise || 0, duePaise: due, paymentStatus: paymentStatusOf(order),
      daysOutstanding: days, bucket,
      openLink: link ? { id: link._id, shortUrl: link.shortUrl, status: link.status, sentAt: link.sentAt || null, createdAt: link.createdAt } : null,
    };
  });
  return { items, summary, truncated: orders.length === DUES_LIMIT };
}

// --- WhatsApp updates to the customer ---------------------------------------------------
const UPDATE_TEXT = {
  Received: (f) => `Namaste ${f.name}, we have received your order ${f.number}. Thank you!`,
  Processing: (f) => `Namaste ${f.name}, your order ${f.number} is being prepared.`,
  Dispatched: (f) => `Namaste ${f.name}, your order ${f.number} has been dispatched${f.transporter ? ` by ${f.transporter}` : ''}${f.lrNumber ? ` (LR no. ${f.lrNumber})` : ''}.`,
  Delivered: (f) => `Namaste ${f.name}, your order ${f.number} has been delivered. Thank you!`,
  'Payment Collected': (f) => `Namaste ${f.name}, we have received your payment of ${f.total} for order ${f.number}. Thank you!`,
  Cancelled: (f) => `Namaste ${f.name}, your order ${f.number} has been cancelled.`,
};

function factsOf(order, contact) {
  return {
    name: order.billTo?.name || contact?.name || '',
    number: order.number,
    stage: order.stage,
    total: formatRupees(order.totals?.grandTotalPaise),
    transporter: order.dispatch?.transporter || '',
    lrNumber: order.dispatch?.lrNumber || '',
    shipping: [order.dispatch?.transporter, order.dispatch?.lrNumber && `LR ${order.dispatch.lrNumber}`].filter(Boolean).join(', '),
  };
}

// Template values guessed from names (named) or places: name, order number, stage, shipping.
function suggest(template, facts) {
  const shape = templateService.shapeOf(template);
  const named = template.parameterFormat === 'NAMED';
  const byName = (name) => {
    const key = String(name).toLowerCase();
    if (/name/.test(key)) return facts.name;
    if (/transport|courier|lr|track|awb|docket|ship/.test(key)) return facts.shipping;
    if (/status|stage/.test(key)) return facts.stage;
    if (/amount|total|price|payment/.test(key)) return facts.total;
    if (/order|number|ref|id/.test(key)) return facts.number;
    return '';
  };
  const ORDER = [facts.name, facts.number, facts.stage, facts.shipping];
  const fill = (names) => Object.fromEntries(names.map((name, i) => [name, (named ? byName(name) : ORDER[Number(name) - 1] ?? ORDER[i]) || '']));
  return { header: fill(shape.header?.variables || []), body: fill(shape.body.variables), buttons: Object.fromEntries(shape.buttons.filter((b) => b.variables.length).map((b) => [String(b.index), ''])) };
}

async function chatFor(req, order, { open = false } = {}) {
  const contact = await Contact.findOne({ _id: order.contactId, organizationId: order.organizationId });
  let conversation = await Conversation.findOne({ organizationId: order.organizationId, contactId: order.contactId }).sort({ lastMessageAt: -1, updatedAt: -1 });
  const othersChat = conversation?.assigneeId && !conversationService.seesAll(req.member) && String(conversation.assigneeId) !== String(req.member._id);
  if (open && contact?.phoneE164 && !conversation) conversation = await Conversation.findById((await conversationService.start(req, { contactId: contact._id })).conversation.id);
  return { contact, conversation, othersChat };
}

// GET /orders/:id/notify-options — a text while the 24-hour window is open, else a template.
async function notifyOptions(req, id) {
  const order = await findVisible(req, id);
  const { contact, conversation, othersChat } = await chatFor(req, order);
  const account = conversation
    ? await WhatsAppAccount.findOne({ _id: conversation.whatsappAccountId, organizationId: order.organizationId })
    : await WhatsAppAccount.findOne({ organizationId: order.organizationId }).sort({ isDefault: -1, createdAt: 1 });
  let blocked = '';
  if (!contact?.phoneE164) blocked = `${contact?.name || 'The customer'} has no mobile number.`;
  else if (!account) blocked = 'Add a WhatsApp number in Settings → WhatsApp first.';
  else if (othersChat) blocked = 'A teammate is handling this customer\'s WhatsApp chat.';
  const facts = factsOf(order, contact);
  const templates = account
    ? (await MessageTemplate.find({ organizationId: order.organizationId, whatsappAccountId: account._id, status: 'APPROVED' }).sort({ name: 1 }))
      .filter((template) => templateService.shapeOf(template).sendable)
      .map((template) => ({ ...templateService.serializeTemplate(template), suggested: suggest(template, facts) }))
    : [];
  return {
    blocked,
    windowOpen: Boolean(conversation && conversationService.serviceWindow(conversation).open),
    text: UPDATE_TEXT[order.stage](facts),
    templates,
  };
}

// POST /orders/:id/notify { mode: text | template, text?, templateId?, variables? }
async function notify(req, id, { mode, text, templateId, variables }) {
  const order = await findVisible(req, id);
  const { contact, conversation, othersChat } = await chatFor(req, order, { open: mode === 'template' });
  if (!contact?.phoneE164) throw httpError(409, 'NO_PHONE', `${contact?.name || 'The customer'} has no mobile number.`);
  if (othersChat) throw httpError(409, 'CHAT_ASSIGNED', 'A teammate is handling this customer\'s WhatsApp chat.');
  if (mode === 'text' && !(conversation && conversationService.serviceWindow(conversation).open)) {
    throw httpError(422, 'WINDOW_CLOSED', 'The customer has not written in the last 24 hours. WhatsApp only allows an approved template now.');
  }
  const message = mode === 'text'
    ? await conversationService.sendText(req, conversation._id, { text })
    : await conversationService.sendTemplate(req, conversation._id, { templateId, variables });
  if (message.status === 'failed') throw httpError(502, 'WHATSAPP_REFUSED', `WhatsApp did not accept it: ${message.error?.message || 'unknown reason'}.`);
  const last = order.history[order.history.length - 1];
  if (last) last.notified = true;
  await order.save();
  return { order: serializeOrder(order), message, conversationId: conversation._id };
}

module.exports = {
  create, list, summary, update, changeStage, notifyOptions, notify, serializeOrder, findVisible, nextStages, get: async (req, id) => serializeOrder(await findVisible(req, id)),
  recordPayment, addManualPayment, removeManualPayment, paymentStatusOf, duePaise, chatFor, dues,
};
