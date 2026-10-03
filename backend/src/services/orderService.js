const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const MessageTemplate = require('../models/MessageTemplate');
const Order = require('../models/Order');
const Organization = require('../models/Organization');
const Product = require('../models/Product');
const Quotation = require('../models/Quotation');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const httpError = require('../utils/httpError');
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

// Orders (Phase 5): made from an accepted quotation, then moved through ORDER_FLOW (any step,
// forwards or back, except out of Cancelled; a paid order is not cancelled). Dispatch details
// (transporter, LR number) are kept; "Payment Collected" wins the lead. With "reduce stock on
// dispatch" the stock goes down once when the order reaches Dispatched or later and comes back
// if it is cancelled or moved back. A stage change can also send the customer a WhatsApp update.
const MODULES = leadService.MODULES;
const SHIPPED = ORDER_FLOW.slice(ORDER_FLOW.indexOf('Dispatched')); // Dispatched and after

const scope = (req) => ({ organizationId: req.tenant.organizationId, ...visibilityFilter(req, MODULES) });
const plain = (value) => (value?.toObject ? value.toObject() : value);

function nextStages(stage) {
  if (stage === 'Cancelled') return [];
  return [...ORDER_FLOW.filter((s) => s !== stage), ...(stage === 'Payment Collected' ? [] : ['Cancelled'])];
}

function serializeOrder(order) {
  return {
    id: order._id,
    number: order.number,
    financialYear: order.financialYear,
    quotationId: order.quotationId || null,
    quotationNumber: order.quotationNumber || '',
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
  await mongoose.connection.transaction(async (session) => {
    order = await findVisible(req, id, session);
    const from = order.stage;
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
  return serializeOrder(order);
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

module.exports = { create, list, summary, update, changeStage, notifyOptions, notify, serializeOrder, findVisible, nextStages, get: async (req, id) => serializeOrder(await findVisible(req, id)) };
