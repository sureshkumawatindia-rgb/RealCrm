const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const InboundEvent = require('../models/InboundEvent');
const MessageTemplate = require('../models/MessageTemplate');
const Order = require('../models/Order');
const Organization = require('../models/Organization');
const PaymentConnection = require('../models/PaymentConnection');
const PaymentLink = require('../models/PaymentLink');
const Quotation = require('../models/Quotation');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { formatRupees } = require('../utils/money');
const { PAYMENT_PROVIDERS, OPEN_LINK_STATUSES, MIN_LINK_PAISE } = require('../constants/payments');
const { toPage, paginationMeta } = require('../utils/pagination');
const { visibilityFilter, privacyFilter } = require('./access');
const { gatewayFor } = require('../integrations/payments');
const gateways = require('./paymentGatewayService');
const leadService = require('./leadService');
const orderService = require('./orderService');
const conversationService = require('./conversationService');
const templateService = require('./templateService');
const notificationService = require('./notificationService');
const automationEvents = require('./automation/events');
const { leadOfContact } = require('./automation/context');
const planService = require('./planService');

// Payment links (Phase 8): made through the organization's gateway for an order, a quotation or
// an amount, then followed until they are paid. Two ways a payment reaches the CRM — the
// gateway's signed webhook (a "payment.webhook" job), and a status check every 10 minutes
// ("payment.links.sync", D42) for when the CRM has no public address — both end in applyState,
// which records each gateway payment once: on the order (a quotation's payment accepts it and
// makes the order), the lead is won (D40), the customer gets a receipt (D41) and the team a bell.
const JOBS = { WEBHOOK: 'payment.webhook', SYNC: 'payment.links.sync' };
const SYNC_EVERY_MS = 10 * 60 * 1000;
const SYNC_BATCH = 50;
const DAY = 24 * 60 * 60 * 1000;
const MODULES = leadService.MODULES;

const scope = (req) => ({ organizationId: req.tenant.organizationId, ...visibilityFilter(req, MODULES) });
const newReferenceId = () => `ycrm_${new mongoose.Types.ObjectId().toHexString()}`;

function serializeLink(link) {
  return {
    id: link._id,
    provider: link.provider,
    providerName: PAYMENT_PROVIDERS[link.provider],
    mode: link.mode,
    referenceId: link.referenceId,
    providerLinkId: link.providerLinkId,
    shortUrl: link.shortUrl,
    purpose: link.purpose,
    orderId: link.orderId || null,
    quotationId: link.quotationId || null,
    contactId: link.contactId || null,
    leadId: link.leadId || null,
    documentNumber: link.documentNumber || '',
    description: link.description,
    customerName: link.customerName,
    amountPaise: link.amountPaise,
    amountPaidPaise: link.amountPaidPaise || 0,
    acceptPartial: Boolean(link.acceptPartial),
    minPartialPaise: link.minPartialPaise || null,
    status: link.status,
    expiresAt: link.expiresAt || null,
    paidAt: link.paidAt || null,
    cancelledAt: link.cancelledAt || null,
    payments: (link.payments || []).map((p) => ({ providerPaymentId: p.providerPaymentId, amountPaise: p.amountPaise, method: p.method, paidAt: p.paidAt })),
    sentAt: link.sentAt || null,
    sentMessageId: link.sentMessageId || null,
    receipts: (link.receipts || []).map((r) => ({ providerPaymentId: r.providerPaymentId, status: r.status, reason: r.reason || '', messageId: r.messageId || null, at: r.at })),
    lastSyncedAt: link.lastSyncedAt || null,
    lastSyncError: link.lastSyncError || '',
    createdAt: link.createdAt,
  };
}

async function findVisible(req, id) {
  const link = await PaymentLink.findOne({ _id: id, ...scope(req) });
  if (!link) throw httpError(404, 'NOT_FOUND', 'Payment link not found');
  return link;
}

// --- making a link ------------------------------------------------------------------------
// What the link is for: the order's due amount, the quotation's total, or an amount for a customer.
async function subjectOf(req, body) {
  if (body.orderId) {
    const order = await orderService.findVisible(req, body.orderId);
    if (order.stage === 'Cancelled') throw httpError(409, 'ORDER_CANCELLED', 'This order was cancelled.');
    const due = orderService.duePaise(order);
    if (due <= 0) throw httpError(409, 'NOTHING_DUE', `Order ${order.number} is already paid.`);
    return {
      purpose: 'order', order, maxPaise: due, contactId: order.contactId, leadId: order.leadId, ownerId: order.ownerId,
      documentNumber: order.number, customerName: order.billTo?.name || '', description: `Order ${order.number}`,
      // A link still open for its quotation counts too: the customer must not pay twice.
      filter: order.quotationId ? { $or: [{ orderId: order._id }, { quotationId: order.quotationId }] } : { orderId: order._id },
    };
  }
  if (body.quotationId) {
    const quotation = await Quotation.findOne({ _id: body.quotationId, ...scope(req) });
    if (!quotation) throw httpError(404, 'NOT_FOUND', 'Quotation not found');
    // Once an order exists, the order is what gets paid.
    if (quotation.orderId) return subjectOf(req, { orderId: quotation.orderId });
    if (['Rejected', 'Expired'].includes(quotation.status)) {
      throw httpError(409, 'REVISE_FIRST', `This ${quotation.type.toLowerCase()} was ${quotation.status.toLowerCase()}: revise it first.`);
    }
    const label = `${quotation.type} ${quotation.number}`;
    return {
      purpose: 'quotation', quotation, maxPaise: quotation.totals?.grandTotalPaise || 0, contactId: quotation.contactId, leadId: quotation.leadId, ownerId: quotation.ownerId,
      documentNumber: quotation.number, customerName: quotation.billTo?.name || '', description: label, filter: { quotationId: quotation._id },
    };
  }
  const contact = await Contact.findOne({ _id: body.contactId, organizationId: req.tenant.organizationId, ...visibilityFilter(req, ['customers', 'leads', 'inbox']), ...privacyFilter(req) });
  if (!contact) throw httpError(404, 'NOT_FOUND', 'Customer not found');
  const lead = await leadOfContact(req.tenant.organizationId, contact._id);
  return {
    purpose: 'amount', maxPaise: Infinity, contactId: contact._id, leadId: lead?._id, ownerId: contact.ownerId || lead?.ownerId,
    documentNumber: '', customerName: contact.name || '', description: '', filter: null,
  };
}

// POST /payment-links { orderId | quotationId | contactId, amountPaise?, description?, acceptPartial?,
// minPartialPaise?, expiresInDays?, connectionId? }
async function create(req, body) {
  const organization = await Organization.findById(req.tenant.organizationId);
  await planService.assertFeature(organization, 'paymentLinks');
  const subject = await subjectOf(req, body);
  const amountPaise = body.amountPaise || (Number.isFinite(subject.maxPaise) ? subject.maxPaise : 0);
  if (!amountPaise) throw httpError(400, 'VALIDATION_ERROR', 'Enter the amount to collect.', [{ field: 'amountPaise', code: 'REQUIRED', message: 'Enter the amount to collect.' }]);
  if (amountPaise < MIN_LINK_PAISE) throw httpError(400, 'VALIDATION_ERROR', 'A payment link must be for at least ₹1.', [{ field: 'amountPaise', code: 'TOO_SMALL', message: 'At least ₹1.' }]);
  if (amountPaise > subject.maxPaise) {
    throw httpError(400, 'VALIDATION_ERROR', `That is more than the ${formatRupees(subject.maxPaise)} ${subject.purpose === 'order' ? 'still due' : 'of the quotation'}.`, [{ field: 'amountPaise', code: 'MORE_THAN_DUE', message: `At most ${formatRupees(subject.maxPaise)}.` }]);
  }
  if (body.acceptPartial && body.minPartialPaise && body.minPartialPaise > amountPaise) {
    throw httpError(400, 'VALIDATION_ERROR', 'The smallest part payment cannot be more than the amount.', [{ field: 'minPartialPaise', code: 'TOO_LARGE', message: `At most ${formatRupees(amountPaise)}.` }]);
  }
  // One open link per order or quotation, so a customer cannot pay the same thing twice.
  if (subject.filter) {
    const open = await PaymentLink.findOne({ organizationId: req.tenant.organizationId, ...subject.filter, status: { $in: OPEN_LINK_STATUSES } });
    if (open) {
      const message = `A link for ${formatRupees(open.amountPaise)} is still open for ${open.documentNumber || subject.documentNumber}. Send it again, or cancel it first.`;
      const error = httpError(409, 'OPEN_LINK_EXISTS', message, [{ field: 'paymentLinkId', code: 'OPEN_LINK_EXISTS', message }]);
      error.paymentLinkId = String(open._id);
      throw error;
    }
  }
  const connection = await gateways.connectionFor(req.tenant.organizationId, body.connectionId);
  const contact = subject.contactId ? await Contact.findOne({ _id: subject.contactId, organizationId: req.tenant.organizationId }) : null;
  const settings = gateways.settingsOf(organization);
  const expiresAt = new Date(Date.now() + (body.expiresInDays || settings.expiryDays) * DAY);
  const referenceId = newReferenceId();
  const description = String(body.description || subject.description || `Payment to ${organization.name}`).trim().slice(0, 500);
  const customerName = subject.customerName || contact?.name || '';
  const created = await gatewayFor(connection.provider).createLink(gateways.credentialsOf(connection), {
    referenceId,
    amountPaise,
    description,
    customer: { name: customerName, phone: contact?.phoneE164 || '', email: contact?.email || '' },
    expiresAt,
    acceptPartial: Boolean(body.acceptPartial),
    minPartialPaise: body.acceptPartial ? body.minPartialPaise || MIN_LINK_PAISE : undefined,
    notes: { crm_reference: referenceId, ...(subject.documentNumber && { document: subject.documentNumber }) },
  });
  const link = await PaymentLink.create({
    organizationId: req.tenant.organizationId,
    connectionId: connection._id,
    provider: connection.provider,
    mode: connection.mode,
    referenceId,
    providerLinkId: created.providerLinkId,
    shortUrl: created.shortUrl,
    purpose: subject.purpose,
    orderId: subject.order?._id,
    quotationId: subject.quotation?._id,
    contactId: subject.contactId,
    leadId: subject.leadId,
    ownerId: subject.ownerId || undefined,
    documentNumber: subject.documentNumber,
    description,
    customerName,
    amountPaise,
    acceptPartial: Boolean(body.acceptPartial),
    minPartialPaise: body.acceptPartial ? body.minPartialPaise || MIN_LINK_PAISE : undefined,
    status: created.status || 'created',
    expiresAt: created.expiresAt || expiresAt,
    createdById: req.user._id,
    createdByMemberId: req.member._id,
  });
  if (link.leadId) {
    const lead = await leadService.findVisible(req, link.leadId).catch(() => null);
    if (lead) await leadService.addActivity(req, lead, 'Payment', `Payment link for ${formatRupees(amountPaise)}${link.documentNumber ? ` (${link.documentNumber})` : ''} made through ${PAYMENT_PROVIDERS[link.provider]}`);
  }
  await audit(req, { action: 'payment_link.created', entityType: 'PaymentLink', entityId: link._id, changes: { purpose: link.purpose, amountPaise, provider: link.provider } });
  return serializeLink(link);
}

async function list(req, query) {
  const filter = {
    ...scope(req),
    ...(query.status && { status: query.status }),
    ...(query.orderId && { orderId: query.orderId }),
    ...(query.quotationId && { quotationId: query.quotationId }),
    ...(query.contactId && { contactId: query.contactId }),
  };
  const page = toPage(query);
  const [items, total] = await Promise.all([
    PaymentLink.find(filter).sort({ createdAt: -1, _id: -1 }).skip(page.skip).limit(page.limit),
    PaymentLink.countDocuments(filter),
  ]);
  return { items: items.map(serializeLink), pagination: paginationMeta(page, total) };
}

const get = async (req, id) => serializeLink(await findVisible(req, id));

// GET /payment-links/options?orderId=|quotationId=|contactId= — what the "Payment link" dialog
// needs: the gateways, the suggested amount, the open link (if any) and the earlier links.
async function options(req, query) {
  const organization = await Organization.findById(req.tenant.organizationId);
  const connections = await PaymentConnection.find({ organizationId: organization._id }).sort({ isDefault: -1, createdAt: 1 });
  let blocked = '';
  let subject = null;
  try {
    subject = await subjectOf(req, query);
  } catch (error) {
    if (error.statusCode === 404) throw error;
    blocked = error.message; // paid already, cancelled, rejected …
  }
  const planBlock = planService.featureBlock(organization, 'paymentLinks');
  if (planBlock) blocked = planBlock;
  else if (!connections.length) blocked = ['owner', 'admin'].includes(req.member.role) ? 'Connect Razorpay or Cashfree in Settings → Payments first.' : 'Ask an owner or admin to connect Razorpay or Cashfree in Settings → Payments.';
  // The subject's links: an order's (also those made for its quotation), a quotation's, a customer's.
  let filter = { contactId: query.contactId };
  if (query.orderId) {
    const order = await Order.findById(query.orderId).select('quotationId');
    filter = { $or: [{ orderId: query.orderId }, ...(order?.quotationId ? [{ quotationId: order.quotationId }] : [])] };
  } else if (query.quotationId) {
    const quotation = await Quotation.findById(query.quotationId).select('orderId');
    filter = { $or: [{ quotationId: query.quotationId }, ...(quotation?.orderId ? [{ orderId: quotation.orderId }] : [])] };
  }
  const links = await PaymentLink.find({ ...scope(req), ...filter }).sort({ createdAt: -1 }).limit(10);
  // An order or quotation has at most one open link; a customer may have several for amounts.
  const open = (query.orderId || query.quotationId) ? links.find((link) => OPEN_LINK_STATUSES.includes(link.status)) : null;
  return {
    blocked,
    gateways: connections.map((c) => ({ id: c._id, provider: c.provider, name: c.name || PAYMENT_PROVIDERS[c.provider], mode: c.mode, isDefault: c.isDefault, status: c.status })),
    expiryDays: gateways.settingsOf(organization).expiryDays,
    purpose: subject?.purpose || null,
    documentNumber: subject?.documentNumber || '',
    customerName: subject?.customerName || '',
    amountPaise: subject && Number.isFinite(subject.maxPaise) ? subject.maxPaise : null,
    maxPaise: subject && Number.isFinite(subject.maxPaise) ? subject.maxPaise : null,
    openLink: open ? serializeLink(open) : null,
    links: links.map(serializeLink),
  };
}

// --- sending a link on WhatsApp ------------------------------------------------------------
const indiaDay = (date) => new Date(date).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

function linkFacts(link, organization) {
  const left = Math.max(link.amountPaise - (link.amountPaidPaise || 0), 0);
  return {
    name: link.customerName || 'Customer', amount: formatRupees(left), number: link.documentNumber || '', link: link.shortUrl,
    due: formatRupees(left), paymentId: '', validTill: link.expiresAt ? indiaDay(link.expiresAt) : '', org: organization?.name || '',
  };
}

function linkText(link, organization) {
  const f = linkFacts(link, organization);
  const what = link.purpose === 'order' ? ` for order ${f.number}` : link.purpose === 'quotation' ? ` for ${link.description || f.number}` : link.description ? ` for ${link.description}` : '';
  return [
    `Namaste ${f.name}, please pay ${f.amount}${what} using this secure link:`,
    link.shortUrl,
    ...(f.validTill ? [`The link is valid till ${f.validTill}.`] : []),
    ...(f.org ? [`– ${f.org}`] : []),
  ].join('\n');
}

// The customer's latest chat and the number to write from (their chat's, else the default one).
async function chatAndNumber(link) {
  const conversation = await Conversation.findOne({ organizationId: link.organizationId, contactId: link.contactId }).sort({ lastMessageAt: -1, updatedAt: -1 });
  const accountId = conversation?.whatsappAccountId;
  return { conversation, accountId };
}

// GET /payment-links/:id/send-options
async function sendOptions(req, id) {
  const link = await findVisible(req, id);
  const organization = await Organization.findById(link.organizationId);
  const contact = link.contactId ? await Contact.findOne({ _id: link.contactId, organizationId: link.organizationId }) : null;
  const { conversation } = await chatAndNumber(link);
  const accounts = await WhatsAppAccount.find({ organizationId: link.organizationId }).sort({ isDefault: -1, createdAt: 1 });
  const account = conversation ? accounts.find((a) => String(a._id) === String(conversation.whatsappAccountId)) : accounts[0];
  let blocked = '';
  if (!OPEN_LINK_STATUSES.includes(link.status)) blocked = `This link is ${link.status.replace('_', ' ')}.`;
  else if (!contact?.phoneE164) blocked = `${contact?.name || 'The customer'} has no mobile number.`;
  else if (!account) blocked = 'Add a WhatsApp number in Settings → WhatsApp first.';
  else if (conversation?.assigneeId && !conversationService.seesAll(req.member) && String(conversation.assigneeId) !== String(req.member._id)) blocked = 'A teammate is handling this customer\'s WhatsApp chat.';
  const facts = linkFacts(link, organization);
  const settings = gateways.settingsOf(organization);
  const templates = account
    ? (await MessageTemplate.find({ organizationId: link.organizationId, whatsappAccountId: account._id, status: 'APPROVED' }).sort({ name: 1 }))
      .filter((template) => templateService.shapeOf(template).sendable)
      .map((template) => ({ ...templateService.serializeTemplate(template), suggested: fillTemplate(template, facts, [facts.name, facts.amount, facts.number || facts.link, facts.link]) }))
    : [];
  return {
    blocked,
    windowOpen: Boolean(conversation && conversationService.serviceWindow(conversation).open),
    text: linkText(link, organization),
    templates,
    preferredTemplateId: templates.some((t) => String(t.id) === String(settings.linkTemplateId)) ? settings.linkTemplateId : null,
    link: serializeLink(link),
  };
}

async function markSent(req, link, message) {
  await PaymentLink.updateOne({ _id: link._id }, { $set: { sentMessageId: message.id, sentAt: new Date() } });
  if (link.leadId) {
    const lead = await leadService.findVisible(req, link.leadId).catch(() => null);
    if (lead) await leadService.addActivity(req, lead, 'Payment', `Payment link for ${formatRupees(link.amountPaise - (link.amountPaidPaise || 0))}${link.documentNumber ? ` (${link.documentNumber})` : ''} sent on WhatsApp`);
  }
}

// POST /payment-links/:id/send { mode: text | template, text?, templateId?, variables? }
async function send(req, id, { mode, text, templateId, variables }) {
  const link = await findVisible(req, id);
  if (!OPEN_LINK_STATUSES.includes(link.status)) throw httpError(409, 'LINK_CLOSED', `This link is ${link.status.replace('_', ' ')}.`);
  const contact = link.contactId ? await Contact.findOne({ _id: link.contactId, organizationId: link.organizationId }) : null;
  if (!contact?.phoneE164) throw httpError(409, 'NO_PHONE', `${contact?.name || 'The customer'} has no mobile number.`);
  let { conversation } = await chatAndNumber(link);
  if (conversation?.assigneeId && !conversationService.seesAll(req.member) && String(conversation.assigneeId) !== String(req.member._id)) {
    throw httpError(409, 'CHAT_ASSIGNED', 'A teammate is handling this customer\'s WhatsApp chat.');
  }
  if (mode === 'text' && !(conversation && conversationService.serviceWindow(conversation).open)) {
    throw httpError(422, 'WINDOW_CLOSED', 'The customer has not written in the last 24 hours. WhatsApp only allows an approved template now.');
  }
  if (!conversation) conversation = await Conversation.findById((await conversationService.start(req, { contactId: contact._id })).conversation.id);
  const message = mode === 'text'
    ? await conversationService.sendText(req, conversation._id, { text })
    : await conversationService.sendTemplate(req, conversation._id, { templateId, variables });
  if (message.status === 'failed') throw httpError(502, 'WHATSAPP_REFUSED', `WhatsApp did not accept it: ${message.error?.message || 'unknown reason'}.`);
  await markSent(req, link, message);
  await audit(req, { action: 'payment_link.sent', entityType: 'PaymentLink', entityId: link._id, changes: { mode } });
  return { link: serializeLink(await PaymentLink.findById(link._id)), message, conversationId: conversation._id };
}

// The CRM sends a link itself (a workflow's "send the payment link" step): a text inside the
// 24-hour window, else the link template from Settings → Payments. Returns the message.
async function sendAutomatically(req, link, { automation }) {
  const organization = await Organization.findById(link.organizationId);
  const contact = link.contactId ? await Contact.findOne({ _id: link.contactId, organizationId: link.organizationId }) : null;
  if (!contact?.phoneE164) throw httpError(422, 'NO_PHONE', 'The customer has no mobile number.');
  const { conversation } = await chatAndNumber(link);
  let message;
  if (conversation && conversationService.serviceWindow(conversation).open) {
    message = await conversationService.sendTextAutomatically({ conversation, text: linkText(link, organization), automation });
  } else {
    const { linkTemplateId } = gateways.settingsOf(organization);
    const template = linkTemplateId ? await MessageTemplate.findOne({ _id: linkTemplateId, organizationId: link.organizationId, status: 'APPROVED' }) : null;
    if (!template) throw httpError(422, 'NO_LINK_TEMPLATE', 'The customer has not written in 24 hours and no approved payment-link template is chosen in Settings → Payments.');
    const facts = linkFacts(link, organization);
    const chat = await chatOf(link, template.whatsappAccountId);
    message = await conversationService.sendTemplateAutomatically({ conversation: chat, template, variables: fillTemplate(template, facts, [facts.name, facts.amount, facts.number || facts.link, facts.link]), automation });
  }
  if (message.status === 'failed') throw httpError(422, 'WHATSAPP_REFUSED', `WhatsApp refused it: ${message.error?.message || 'unknown reason'}`);
  await markSent(req, link, message);
  return message;
}

// The open link of an order, or a new one for what is due (workflows; req acts as the system).
async function openLinkForOrder(req, orderId) {
  const open = await PaymentLink.findOne({ organizationId: req.tenant.organizationId, orderId, status: { $in: OPEN_LINK_STATUSES } });
  if (open) return open;
  const order = await Order.findOne({ _id: orderId, organizationId: req.tenant.organizationId }).select('quotationId');
  const quotationLink = order?.quotationId ? await PaymentLink.findOne({ organizationId: req.tenant.organizationId, quotationId: order.quotationId, status: { $in: OPEN_LINK_STATUSES } }) : null;
  if (quotationLink) return quotationLink;
  const created = await create(req, { orderId });
  return PaymentLink.findById(created.id);
}

// --- following a link ---------------------------------------------------------------------
// A request-like actor for what the gateway does (payments are not made by a member).
function gatewayReq(link) {
  const name = PAYMENT_PROVIDERS[link.provider];
  return {
    tenant: { organizationId: link.organizationId },
    member: { _id: undefined, role: 'owner', modules: [], permissions: [], status: 'active' },
    user: { _id: undefined, name },
    automation: { chain: [] },
    id: `payment:${link._id}`,
    ip: '',
    get: () => '',
  };
}

// The order a payment belongs to: the link's order, or the one made from its quotation (the
// payment accepts the quotation first). null for a link for an amount.
async function orderFor(req, link) {
  if (link.orderId) return link.orderId;
  if (!link.quotationId) return null;
  const quotation = await Quotation.findOne({ _id: link.quotationId, organizationId: link.organizationId });
  if (!quotation) return null;
  if (!quotation.orderId) {
    if (quotation.status !== 'Accepted') {
      let accepted = null;
      await mongoose.connection.transaction(async (session) => {
        accepted = null;
        const fresh = await Quotation.findById(quotation._id).session(session);
        if (fresh.status === 'Accepted') return;
        accepted = { quotation: fresh, change: { from: fresh.status, to: 'Accepted' } };
        fresh.status = 'Accepted';
        fresh.acceptedAt = new Date();
        await fresh.save({ session });
        const lead = fresh.leadId ? await leadService.findVisible(req, fresh.leadId, session).catch(() => null) : null;
        if (lead) await leadService.addActivity(req, lead, 'Quotation', `${fresh.type} ${fresh.number} accepted: the customer paid`, { session });
      });
      if (accepted) require('./quotationService').emitStatusChange(accepted.quotation, accepted.change, req); // eslint-disable-line global-require
    }
    try {
      await orderService.create(req, { quotationId: quotation._id });
    } catch (error) {
      if (error.code !== 'ORDER_EXISTS' && error.code !== 11000) throw error; // made by the other payment at the same moment
    }
  }
  const orderId = (await Quotation.findById(quotation._id).select('orderId')).orderId;
  if (orderId) await PaymentLink.updateOne({ _id: link._id }, { $set: { orderId } });
  return orderId;
}

// A URL button "https://rzp.io/i/{{1}}" gets the end of the link after its fixed start.
function buttonSuffix(buttonUrl, link) {
  const start = String(buttonUrl || '').split('{{')[0];
  return start && String(link || '').startsWith(start) ? String(link).slice(start.length) : '';
}

// What a template's variables get in a receipt or a link message: the customer's name, the
// amount, the document, the payment id (by name, else in that order).
function fillTemplate(template, facts, order) {
  const shape = templateService.shapeOf(template);
  const named = template.parameterFormat === 'NAMED';
  const byName = (name) => {
    const key = String(name).toLowerCase();
    if (/name/.test(key)) return facts.name;
    if (/due|balance|pending/.test(key)) return facts.due;
    if (/amount|total|paid|price|sum/.test(key)) return facts.amount;
    if (/link|url/.test(key)) return facts.link;
    if (/payment|txn|transaction|utr/.test(key)) return facts.paymentId;
    if (/order|invoice|number|ref|doc|quot/.test(key)) return facts.number;
    return '';
  };
  const fill = (names) => Object.fromEntries(names.map((name, i) => [name, (named ? byName(name) : order[Number(name) - 1] ?? order[i]) || '-']));
  return {
    header: fill(shape.header?.variables || []),
    body: fill(shape.body.variables),
    buttons: Object.fromEntries(shape.buttons.filter((b) => b.variables.length).map((b) => [String(b.index), buttonSuffix(b.url, facts.link) || facts.paymentId || '-'])),
  };
}

// The customer's chat for a receipt: their latest one, else a new one on the template's number.
async function chatOf(link, accountId) {
  const conversation = await Conversation.findOne({ organizationId: link.organizationId, contactId: link.contactId, ...(accountId && { whatsappAccountId: accountId }) }).sort({ lastMessageAt: -1, updatedAt: -1 });
  if (conversation || !accountId) return conversation;
  return conversationService.ensureConversation({ organizationId: link.organizationId, contactId: link.contactId, accountId, assigneeId: link.ownerId || null });
}

// D41: a text inside the 24-hour window, else the receipt template from Settings → Payments, else
// nothing (the bell says so). Never throws: the payment is recorded either way.
async function sendReceipt(link, payment, { organization, order }) {
  const settings = gateways.settingsOf(organization);
  const contact = link.contactId ? await Contact.findOne({ _id: link.contactId, organizationId: link.organizationId }) : null;
  const due = order ? orderService.duePaise(order) : Math.max(link.amountPaise - link.amountPaidPaise, 0);
  const label = order ? `order ${order.number}` : link.documentNumber || '';
  const facts = {
    name: link.customerName || contact?.name || 'Customer', amount: formatRupees(payment.amountPaise), number: order?.number || link.documentNumber || '',
    paymentId: payment.providerPaymentId, due: formatRupees(due), link: link.shortUrl,
  };
  let result;
  try {
    if (!settings.sendReceipt) result = { status: 'skipped', reason: 'Receipts are turned off in Settings → Payments.' };
    else if (!contact?.phoneE164) result = { status: 'skipped', reason: 'The customer has no WhatsApp number.' };
    else {
      const conversation = await chatOf(link);
      if (conversation && conversationService.serviceWindow(conversation).open) {
        const text = [
          `Namaste ${facts.name}, we have received your payment of ${facts.amount}${label ? ` for ${label}` : ''}. Thank you!`,
          `Payment ID: ${payment.providerPaymentId}`,
          ...(due > 0 ? [`Balance due: ${facts.due}`] : []),
          `– ${organization.name}`,
        ].join('\n');
        const message = await conversationService.sendTextAutomatically({ conversation, text, automation: { kind: 'receipt', ruleId: link._id } });
        result = { status: message.status === 'failed' ? 'failed' : 'sent', messageId: message.id, reason: message.error?.message || '' };
      } else if (settings.receiptTemplateId) {
        const template = await MessageTemplate.findOne({ _id: settings.receiptTemplateId, organizationId: link.organizationId, status: 'APPROVED' });
        if (!template) result = { status: 'skipped', reason: 'The receipt template in Settings → Payments is no longer approved.' };
        else {
          const chat = await chatOf(link, template.whatsappAccountId);
          const variables = fillTemplate(template, facts, [facts.name, facts.amount, facts.number || facts.paymentId, facts.paymentId]);
          const message = await conversationService.sendTemplateAutomatically({ conversation: chat, template, variables, automation: { kind: 'receipt', ruleId: link._id } });
          result = { status: message.status === 'failed' ? 'failed' : 'sent', messageId: message.id, reason: message.error?.message || '' };
        }
      } else {
        result = { status: 'skipped', reason: 'The customer has not written in 24 hours and no receipt template is chosen in Settings → Payments.' };
      }
    }
  } catch (error) {
    logger.warn(`Payment receipt for link ${link._id} failed: ${error.message}`);
    result = { status: 'failed', reason: String(error.message || 'Sending failed').slice(0, 300) };
  }
  await PaymentLink.updateOne({ _id: link._id }, { $push: { receipts: { providerPaymentId: payment.providerPaymentId, ...result, at: new Date() } } });
  return result;
}

// One new gateway payment: on the order (or the quotation's new order), the lead, a receipt, the bell.
async function onPayment(link, payment) {
  const req = gatewayReq(link);
  const organization = await Organization.findById(link.organizationId);
  const orderId = await orderFor(req, link);
  let order = null;
  if (orderId) {
    await orderService.recordPayment(req, orderId, {
      source: 'link', amountPaise: payment.amountPaise, method: payment.method || '', paidAt: payment.paidAt || new Date(),
      paymentLinkId: link._id, provider: link.provider, providerPaymentId: payment.providerPaymentId,
    });
    order = await Order.findById(orderId);
  } else {
    if (link.leadId) {
      await leadService.convert(req, link.leadId).catch((error) => {
        if (error.statusCode !== 404) throw error;
      });
    }
    automationEvents.emit('payment.received', {
      organizationId: link.organizationId, leadId: link.leadId, contactId: link.contactId, amountPaise: payment.amountPaise, key: `payment.received:link:${payment.providerPaymentId}`,
    }, req);
  }
  const fresh = await PaymentLink.findById(link._id);
  const receipt = await sendReceipt(fresh, payment, { organization, order });
  const due = order ? orderService.duePaise(order) : 0;
  const people = [...new Set([link.createdByMemberId, order?.ownerId || link.ownerId].filter(Boolean).map(String))];
  await notificationService.notify(link.organizationId, people, {
    title: `Payment received: ${formatRupees(payment.amountPaise)}`,
    body: [
      `${link.customerName || 'A customer'} paid ${formatRupees(payment.amountPaise)}${order ? ` for order ${order.number}` : link.documentNumber ? ` for ${link.documentNumber}` : ''} through ${PAYMENT_PROVIDERS[link.provider]}.`,
      order ? (due ? `${formatRupees(due)} is still due.` : 'The order is paid in full.') : '',
      receipt.status === 'sent' ? 'A receipt went to the customer on WhatsApp.' : `No receipt was sent: ${receipt.reason}`,
    ].filter(Boolean).join(' '),
    link: order ? `Orders.html?id=${order._id}` : '',
    source: 'payment',
  });
}

// What the gateway says about a link (a webhook or a status check), applied once:
// state { status, amountPaidPaise, payments? | payment?, expiresAt? }.
async function applyState(linkId, state) {
  let link = await PaymentLink.findById(linkId);
  if (!link) return null;
  const payments = state.payments || (state.payment ? [state.payment] : []);
  for (const payment of payments) {
    if (!payment?.providerPaymentId || !(payment.amountPaise > 0)) continue;
    // Only the first to add a payment acts on it (a webhook and a status check can race).
    const added = await PaymentLink.findOneAndUpdate(
      { _id: link._id, 'payments.providerPaymentId': { $ne: payment.providerPaymentId } },
      { $push: { payments: payment }, $inc: { amountPaidPaise: payment.amountPaise } },
      { returnDocument: 'after' },
    );
    if (!added) continue;
    link = added;
    if (link.amountPaidPaise >= link.amountPaise) {
      link = await PaymentLink.findByIdAndUpdate(link._id, { $set: { status: 'paid', paidAt: link.paidAt || payment.paidAt || new Date() } }, { returnDocument: 'after' });
    } else if (link.status === 'created') {
      link = await PaymentLink.findByIdAndUpdate(link._id, { $set: { status: 'partially_paid' } }, { returnDocument: 'after' });
    }
    await onPayment(link, payment);
  }
  // The gateway's status (never backwards from paid; a cancel we asked for stays unless money came).
  const set = { lastSyncedAt: new Date(), lastSyncError: '' };
  const current = await PaymentLink.findById(link._id);
  if (state.status && current.status !== 'paid' && state.status !== current.status) {
    if (state.status === 'paid') {
      set.status = 'paid';
      set.paidAt = current.paidAt || new Date();
    } else if (!(current.status === 'cancelled' && state.status === 'created')) {
      set.status = state.status;
      if (state.status === 'cancelled') set.cancelledAt = current.cancelledAt || new Date();
    }
  }
  if (Number.isFinite(state.amountPaidPaise) && state.amountPaidPaise > current.amountPaidPaise) set.amountPaidPaise = state.amountPaidPaise;
  return PaymentLink.findByIdAndUpdate(current._id, { $set: set }, { returnDocument: 'after' });
}

// POST /payment-links/:id/refresh — asks the gateway now.
async function refresh(req, id) {
  const link = await findVisible(req, id);
  return serializeLink(await syncOne(link, { throwErrors: true }));
}

async function syncOne(link, { throwErrors = false } = {}) {
  const connection = await PaymentConnection.findOne({ _id: link.connectionId, organizationId: link.organizationId });
  if (!connection) {
    await PaymentLink.updateOne({ _id: link._id }, { $set: { lastSyncedAt: new Date(), lastSyncError: 'The payment gateway was removed from Settings → Payments.' } });
    if (throwErrors) throw httpError(409, 'GATEWAY_REMOVED', 'The payment gateway of this link was removed from Settings → Payments.');
    return PaymentLink.findById(link._id);
  }
  try {
    const state = await gatewayFor(link.provider).fetchLink(gateways.credentialsOf(connection), link.providerLinkId);
    if (!state) {
      // The test gateway keeps nothing: only the expiry date can change.
      const expired = OPEN_LINK_STATUSES.includes(link.status) && link.expiresAt && link.expiresAt < new Date();
      return PaymentLink.findByIdAndUpdate(link._id, { $set: { lastSyncedAt: new Date(), ...(expired && { status: 'expired' }) } }, { returnDocument: 'after' });
    }
    return await applyState(link._id, state);
  } catch (error) {
    await PaymentLink.updateOne({ _id: link._id }, { $set: { lastSyncedAt: new Date(), lastSyncError: String(error.message || 'Check failed').slice(0, 300) } });
    if (throwErrors) throw error;
    logger.warn(`Payment link ${link._id} check failed: ${error.message}`);
    return PaymentLink.findById(link._id);
  }
}

// Every 10 minutes: the open links checked longest ago (D42).
async function syncOpenLinks({ limit = SYNC_BATCH } = {}) {
  const links = await PaymentLink.find({ status: { $in: OPEN_LINK_STATUSES }, createdAt: { $gte: new Date(Date.now() - 200 * DAY) } })
    .sort({ lastSyncedAt: 1, createdAt: 1 }).limit(limit);
  for (const link of links) await syncOne(link);
  return links.length;
}

// POST /payment-links/:id/cancel — the customer can no longer pay it.
async function cancel(req, id) {
  const link = await findVisible(req, id);
  if (!OPEN_LINK_STATUSES.includes(link.status)) throw httpError(409, 'LINK_CLOSED', `This link is already ${link.status.replace('_', ' ')}.`);
  if (link.status === 'partially_paid') throw httpError(409, 'PARTLY_PAID', 'Part of this link is paid already; it cannot be cancelled.');
  const connection = await PaymentConnection.findOne({ _id: link.connectionId, organizationId: link.organizationId });
  if (!connection) throw httpError(409, 'GATEWAY_REMOVED', 'The payment gateway of this link was removed from Settings → Payments.');
  let state;
  try {
    state = await gatewayFor(link.provider).cancelLink(gateways.credentialsOf(connection), link.providerLinkId);
  } catch (error) {
    // Perhaps paid meanwhile: find out before saying no.
    await syncOne(link);
    throw error;
  }
  const updated = await applyState(link._id, { ...state, status: state.status === 'created' ? 'cancelled' : state.status });
  await audit(req, { action: 'payment_link.cancelled', entityType: 'PaymentLink', entityId: link._id });
  return serializeLink(updated);
}

// --- webhooks ---------------------------------------------------------------------------
// POST /api/v1/webhooks/payments/<provider>/<key>: signature first, then stored once per gateway
// event and answered 200; the job does the work.
async function receiveWebhook(provider, webhookKey, rawBody, headers, queue = require('../jobs/queue')) {
  if (!['razorpay', 'cashfree'].includes(provider)) return { status: 404 };
  const connection = await gateways.findByWebhookKey(provider, webhookKey);
  if (!connection) return { status: 404 };
  const gateway = gatewayFor(provider);
  if (!gateway.verifyWebhook({ rawBody, headers, secrets: gateways.secretsOf(connection) })) return { status: 401 };
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400 };
  }
  await PaymentConnection.updateOne({ _id: connection._id }, { $set: { lastWebhookAt: new Date() } });
  const parsed = gateway.parseWebhook(payload, headers);
  if (!parsed) return { status: 200 }; // another kind of event (we only follow payment links)
  return { status: 200, queued: await storeEvent(connection, parsed, queue) };
}

async function storeEvent(connection, parsed, queue) {
  let event;
  try {
    event = await InboundEvent.create({
      provider: connection.provider, eventId: parsed.eventId, kind: 'payment_link', organizationId: connection.organizationId, sourceId: connection._id, payload: parsed,
    });
  } catch (error) {
    if (error.code === 11000) return false; // the gateway sent it again
    throw error;
  }
  await queue.enqueue(JOBS.WEBHOOK, { eventId: String(event._id) }, { uniqueKey: `payment.webhook:${event._id}`, organizationId: connection.organizationId });
  return true;
}

async function processWebhook({ eventId }) {
  const event = await InboundEvent.findOneAndUpdate({ _id: eventId }, { $inc: { attempts: 1 } }, { returnDocument: 'after' });
  if (!event || event.status === 'processed') return;
  const { payload } = event;
  const link = await PaymentLink.findOne({ organizationId: event.organizationId, provider: event.provider, providerLinkId: payload.providerLinkId });
  if (!link) {
    // A link made in the gateway's own dashboard, not in the CRM.
    await InboundEvent.updateOne({ _id: event._id }, { status: 'ignored', processedAt: new Date() });
    return;
  }
  try {
    await applyState(link._id, payload);
    await InboundEvent.updateOne({ _id: event._id }, { status: 'processed', processedAt: new Date(), error: '' });
  } catch (error) {
    await InboundEvent.updateOne({ _id: event._id }, { status: 'failed', error: String(error.message).slice(0, 500) });
    throw error;
  }
}

// --- the test gateway's payment page (development only) -----------------------------------
async function testLink(providerLinkId) {
  if (!/^mock_plink_[a-f0-9]{24}$/.test(String(providerLinkId || ''))) return null;
  return PaymentLink.findOne({ provider: 'mock', providerLinkId });
}

// Pays (part of) a test link the way a gateway would report it.
async function payTestLink(providerLinkId, amountPaise, queue = require('../jobs/queue')) {
  const link = await testLink(providerLinkId);
  if (!link) throw httpError(404, 'NOT_FOUND', 'Payment link not found');
  if (!OPEN_LINK_STATUSES.includes(link.status)) throw httpError(409, 'LINK_CLOSED', `This link is ${link.status.replace('_', ' ')}.`);
  const left = link.amountPaise - link.amountPaidPaise;
  const amount = Math.min(amountPaise || left, left);
  if (!link.acceptPartial && amount !== left) throw httpError(400, 'VALIDATION_ERROR', 'This link must be paid in full.');
  if (amount < Math.min(link.minPartialPaise || MIN_LINK_PAISE, left)) throw httpError(400, 'VALIDATION_ERROR', `Pay at least ${formatRupees(Math.min(link.minPartialPaise || MIN_LINK_PAISE, left))}.`);
  const mock = gatewayFor('mock');
  const connection = await PaymentConnection.findOne({ _id: link.connectionId });
  if (!connection) throw httpError(409, 'GATEWAY_REMOVED', 'The test gateway was removed.');
  const parsed = mock.parseWebhook(mock.paymentEvent(link, amount));
  await storeEvent(connection, parsed, queue);
  return { link: serializeLink(link), amountPaise: amount };
}

function register(queue) {
  queue.define(JOBS.WEBHOOK, processWebhook, { maxAttempts: 6 });
  queue.define(JOBS.SYNC, () => syncOpenLinks(), { maxAttempts: 2 });
  queue.every(JOBS.SYNC, SYNC_EVERY_MS).catch((error) => logger.error(`Scheduling ${JOBS.SYNC} failed: ${error.message}`));
}

module.exports = {
  JOBS, create, list, get, options, cancel, refresh, sendOptions, send, sendAutomatically, openLinkForOrder,
  receiveWebhook, processWebhook, applyState, syncOpenLinks, syncOne, register,
  testLink, payTestLink, serializeLink, findVisible, fillTemplate, buttonSuffix, chatOf,
};
