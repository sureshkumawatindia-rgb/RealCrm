const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const Order = require('../models/Order');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Product = require('../models/Product');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const WhatsAppForm = require('../models/WhatsAppForm');
const logger = require('../config/logger');
const bus = require('../realtime/bus');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { nextSequence } = require('../utils/counter');
const { financialYear, formatRupees } = require('../utils/money');
const { providerFor } = require('../integrations/whatsapp');
const accounts = require('./whatsappAccountService');
const { billingOf } = require('./organizationService');
const automationEvents = require('./automation/events');
const quotationService = require('./quotationService');
const conversationService = require('./conversationService');
const leadService = require('./leadService');
const notificationService = require('./notificationService');
const { leadOfContact } = require('./automation/context');

// WhatsApp forms (G6, D110: Meta's WhatsApp Flows). Owners and admins make an enquiry form (name,
// email, company, city, what they need, quantity, budget, a time to call) or an order form (one of
// the company's products, the quantity, a delivery address and date, a note) in Settings →
// WhatsApp, with their own labels, and publish it: the CRM writes the Flow JSON (version 7.3, one
// screen ending in a Footer that completes) and makes a published Flow on each WhatsApp Business
// Account of the company. Teammates send it in a chat inside the 24-hour window (an interactive
// "flow" message with a flow_token of ours). The customer's answers come back as a message
// (nfm_reply); a job then fills what the CRM did not know about the customer and their open lead
// (or makes a lead), or makes an order at Received priced from the product, like a cart from the
// catalog — then thanks the customer if the form says so, and tells the chat's teammate under the
// bell. Private numbers' answers are kept and nothing more.
const JOB = 'forms.answer';
const FLOW_VERSION = '7.3';
const SCREEN = Object.freeze({ enquiry: 'ENQUIRY', order: 'ORDER' });
const CATEGORY = Object.freeze({ enquiry: 'LEAD_GENERATION', order: 'OTHER' });
const MAX_PRODUCTS = 100;
const FORM_SOURCE = 'WhatsApp form';
const LIMITS = Object.freeze({ name: 60, intro: 1024, cta: 30, heading: 80, submitLabel: 35, thanks: 1024, label: 20, dateLabel: 40 });

// The fields of each kind: the input, the default label, on and required by default; fixed ones
// are always on and required.
const FIELDS = Object.freeze({
  enquiry: [
    { key: 'name', type: 'text', label: 'Your name', on: true, required: true },
    { key: 'email', type: 'email', label: 'Email', on: true, required: false },
    { key: 'company', type: 'text', label: 'Company', on: false, required: false },
    { key: 'city', type: 'text', label: 'City', on: true, required: false },
    { key: 'requirement', type: 'area', label: 'What do you need?', on: true, required: true },
    { key: 'quantity', type: 'number', label: 'Quantity', on: true, required: false },
    { key: 'budget', type: 'number', label: 'Budget (₹)', on: false, required: false },
    { key: 'callTime', type: 'choice', label: 'Best time to call', on: false, required: false, options: ['Morning', 'Afternoon', 'Evening'] },
  ],
  order: [
    { key: 'product', type: 'product', label: 'Product', on: true, required: true, fixed: true },
    { key: 'quantity', type: 'number', label: 'Quantity', on: true, required: true, fixed: true },
    { key: 'address', type: 'area', label: 'Delivery address', on: true, required: true },
    { key: 'date', type: 'date', label: 'Delivery date', on: false, required: false },
    { key: 'note', type: 'area', label: 'Note', on: true, required: false },
  ],
});
const DEFAULTS = Object.freeze({
  enquiry: { cta: 'Fill the form', heading: 'Tell us what you need', submitLabel: 'Send', intro: 'Please fill this short form and we will get back to you.' },
  order: { cta: 'Place an order', heading: 'Your order', submitLabel: 'Send order', intro: 'Order here: choose the product and the quantity.' },
});

const definitionOf = (kind, key) => FIELDS[kind].find((field) => field.key === key);
const credentialsOf = (account) => ({ ...accounts.credentials(account), wabaId: account.wabaId });
const wabaOf = (account) => account.wabaId || account.phoneNumberId;
const priceText = (product) => `${formatRupees(product.pricePaise || 0)}${product.unit ? ` / ${product.unit}` : ''}${product.gstRatePct ? ` + ${product.gstRatePct}% GST` : ''}`;

// The form's fields: every field of its kind, in order, with the company's labels and choices.
function fieldsOf(kind, saved = []) {
  return FIELDS[kind].map((definition) => {
    const own = saved.find((field) => field.key === definition.key) || {};
    return {
      key: definition.key,
      label: own.label || definition.label,
      on: definition.fixed ? true : own.on ?? definition.on,
      required: definition.fixed ? true : own.required ?? definition.required,
    };
  });
}

function serialize(form) {
  return {
    id: form._id,
    kind: form.kind,
    name: form.name,
    intro: form.intro,
    cta: form.cta,
    heading: form.heading,
    submitLabel: form.submitLabel,
    thanks: form.thanks,
    fields: fieldsOf(form.kind, form.fields),
    productIds: form.productIds || [],
    status: form.status,
    dirty: Boolean(form.dirty),
    sendable: (form.flows || []).some((flow) => flow.status === 'PUBLISHED'),
    flows: (form.flows || []).map((flow) => ({ accountId: flow.accountId || null, status: flow.status, error: flow.error || '', publishedAt: flow.publishedAt || null })),
    error: form.error || '',
    version: form.version || 0,
    publishedAt: form.publishedAt || null,
    sentCount: form.sentCount || 0,
    answerCount: form.answerCount || 0,
    lastAnswerAt: form.lastAnswerAt || null,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
  };
}

// --- the Flow JSON --------------------------------------------------------------------------------
// One screen: the heading, the fields that are on, and a Footer that completes with every answer.
function flowJsonOf(form, products) {
  const fields = fieldsOf(form.kind, form.fields).filter((field) => field.on);
  const children = [{ type: 'TextHeading', text: form.heading || form.name }];
  for (const field of fields) {
    const { type, options } = definitionOf(form.kind, field.key);
    const base = { name: field.key, label: field.label, required: Boolean(field.required) };
    if (type === 'text' || type === 'email' || type === 'number') children.push({ type: 'TextInput', ...base, 'input-type': type });
    else if (type === 'area') children.push({ type: 'TextArea', ...base });
    else if (type === 'choice') children.push({ type: 'Dropdown', ...base, 'data-source': options.map((title) => ({ id: title.toLowerCase(), title })) });
    else if (type === 'product') children.push({ type: 'Dropdown', ...base, 'data-source': products.map((p) => ({ id: String(p._id), title: p.name.slice(0, 30), description: priceText(p).slice(0, 300) })) });
    else if (type === 'date') children.push({ type: 'DatePicker', ...base });
  }
  children.push({
    type: 'Footer',
    label: form.submitLabel || DEFAULTS[form.kind].submitLabel,
    'on-click-action': { name: 'complete', payload: Object.fromEntries(fields.map((field) => [field.key, `\${form.${field.key}}`])) },
  });
  return { version: FLOW_VERSION, screens: [{ id: SCREEN[form.kind], title: form.name.slice(0, 30), terminal: true, success: true, layout: { type: 'SingleColumnLayout', children } }] };
}

// --- owners and admins (Settings → WhatsApp → Forms) ----------------------------------------------
const findOwn = async (req, id) => {
  const form = await WhatsAppForm.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!form) throw httpError(404, 'NOT_FOUND', 'Form not found');
  return form;
};

async function productsOf(organizationId, productIds) {
  if (!productIds?.length) return [];
  const products = await Product.find({ _id: { $in: productIds }, organizationId, active: { $ne: false } }).select('name pricePaise unit gstRatePct').lean();
  const order = productIds.map(String);
  return products.sort((a, b) => order.indexOf(String(a._id)) - order.indexOf(String(b._id)));
}

// GET /whatsapp-forms: owners and admins see every form; teammates the ones they can send.
async function list(req) {
  const manager = ['owner', 'admin'].includes(req.member.role);
  const forms = await WhatsAppForm.find({ organizationId: req.tenant.organizationId }).sort({ createdAt: -1 });
  const items = forms.map(serialize).filter((form) => manager || form.sendable);
  return { items, fields: FIELDS, defaults: DEFAULTS, limits: LIMITS };
}

function applyBody(form, body) {
  for (const key of ['name', 'intro', 'cta', 'heading', 'submitLabel', 'thanks']) if (key in body) form[key] = body[key];
  if (body.fields) {
    // WhatsApp's limits: 20 characters for a label, 40 for a date's.
    for (const field of body.fields) {
      const definition = definitionOf(form.kind, field.key);
      const max = definition?.type === 'date' ? LIMITS.dateLabel : LIMITS.label;
      if (definition && field.label && field.label.length > max) {
        throw httpError(400, 'VALIDATION_ERROR', 'A label is too long.', [{ field: `fields.${field.key}`, code: 'LABEL_TOO_LONG', message: `At most ${max} characters.` }]);
      }
    }
    form.fields = fieldsOf(form.kind, body.fields);
  }
  if (body.productIds) form.productIds = [...new Set(body.productIds.map(String))].slice(0, MAX_PRODUCTS);
}

// POST /whatsapp-forms { kind, name, … }: a draft with the kind's defaults.
async function create(req, body) {
  const form = new WhatsAppForm({ organizationId: req.tenant.organizationId, kind: body.kind, name: body.name, ...DEFAULTS[body.kind], fields: fieldsOf(body.kind), createdById: req.user._id });
  applyBody(form, body);
  await form.save();
  await audit(req, { action: 'whatsapp_form.created', entityType: 'WhatsAppForm', entityId: form._id, changes: { kind: form.kind, name: form.name } });
  return serialize(form);
}

// PATCH /whatsapp-forms/:id: a published form keeps going out as it was until it is published again.
async function update(req, id, body) {
  const form = await findOwn(req, id);
  applyBody(form, body);
  if (form.status !== 'draft') form.dirty = true;
  await form.save();
  await audit(req, { action: 'whatsapp_form.updated', entityType: 'WhatsAppForm', entityId: form._id, changes: Object.keys(body) });
  return serialize(form);
}

// POST /whatsapp-forms/:id/publish: a new Flow on each WhatsApp Business Account; when at least
// one is published, the previous version's Flows are retired. Meta's refusal is kept as the error.
async function publish(req, id) {
  const form = await findOwn(req, id);
  const organizationId = req.tenant.organizationId;
  const products = form.kind === 'order' ? await productsOf(organizationId, form.productIds) : [];
  if (form.kind === 'order' && !products.length) throw httpError(400, 'NO_PRODUCTS', 'Choose at least one product for the order form.');
  const numbers = await WhatsAppAccount.find({ organizationId, status: 'connected' });
  if (!numbers.length) throw httpError(409, 'NO_WHATSAPP', 'Connect a WhatsApp number first (Settings → WhatsApp).');
  const flowJson = flowJsonOf(form, products);
  const byWaba = new Map();
  for (const account of numbers) if (!byWaba.has(wabaOf(account))) byWaba.set(wabaOf(account), account);
  const version = (form.version || 0) + 1;
  const flows = [];
  for (const [wabaId, account] of byWaba) {
    const provider = providerFor(account);
    try {
      const made = await provider.createFlow(credentialsOf(account), { name: `${form.name} (${String(form._id).slice(-6)} v${version})`, categories: [CATEGORY[form.kind]], flowJson });
      if (made.status === 'PUBLISHED') {
        flows.push({ wabaId, accountId: account._id, flowId: made.flowId, status: 'PUBLISHED', publishedAt: new Date() });
      } else {
        flows.push({ wabaId, accountId: account._id, status: 'ERROR', error: (made.problems.join(' · ') || `Meta kept it as ${made.status}.`).slice(0, 1000) });
        if (made.flowId) await provider.deleteFlow(credentialsOf(account), made.flowId).catch(() => {});
      }
    } catch (error) {
      flows.push({ wabaId, accountId: account._id, status: 'ERROR', error: String(error.message).slice(0, 1000) });
    }
  }
  const live = flows.filter((flow) => flow.status === 'PUBLISHED');
  const problem = flows.find((flow) => flow.error)?.error || '';
  if (live.length) {
    for (const old of form.flows.filter((flow) => flow.status === 'PUBLISHED' && flow.flowId)) {
      const account = numbers.find((a) => String(a._id) === String(old.accountId)) || byWaba.get(old.wabaId);
      if (account) await providerFor(account).deprecateFlow(credentialsOf(account), old.flowId).catch((error) => logger.warn(`Form ${form._id}: an old Flow was not retired: ${error.message}`));
    }
    Object.assign(form, { flows, status: 'published', dirty: false, version, publishedAt: new Date(), error: problem });
  } else {
    // Nothing published: the previous version (if any) keeps going out.
    form.status = form.flows.some((flow) => flow.status === 'PUBLISHED') ? 'published' : 'error';
    form.error = problem || 'Meta did not publish the form.';
  }
  await form.save();
  await audit(req, { action: 'whatsapp_form.published', entityType: 'WhatsAppForm', entityId: form._id, changes: { version: form.version, published: live.length, error: form.error } });
  return serialize(form);
}

// DELETE /whatsapp-forms/:id: its Flows are retired; answers still coming find it.
async function remove(req, id) {
  const form = await findOwn(req, id);
  const numbers = await WhatsAppAccount.find({ organizationId: req.tenant.organizationId });
  for (const flow of form.flows.filter((f) => f.status === 'PUBLISHED' && f.flowId)) {
    const account = numbers.find((a) => String(a._id) === String(flow.accountId));
    if (account) await providerFor(account).deprecateFlow(credentialsOf(account), flow.flowId).catch(() => {});
  }
  await form.softDelete();
  await audit(req, { action: 'whatsapp_form.deleted', entityType: 'WhatsAppForm', entityId: form._id, changes: { name: form.name } });
  return { deleted: true };
}

// POST /conversations/:id/form { formId }: a teammate sends it in a chat.
async function send(req, conversationId, { formId }) {
  const form = await WhatsAppForm.findOne({ _id: formId, organizationId: req.tenant.organizationId });
  if (!form) throw httpError(404, 'NOT_FOUND', 'Form not found');
  const message = await conversationService.sendForm(req, conversationId, {
    formId: form._id, name: form.name, intro: form.intro, cta: form.cta || DEFAULTS[form.kind].cta, screen: SCREEN[form.kind], flows: form.flows,
  });
  if (message.status !== 'failed') await WhatsAppForm.updateOne({ _id: form._id }, { $inc: { sentCount: 1 } });
  return message;
}

// --- the answers ------------------------------------------------------------------------------
const systemReq = (organizationId) => ({
  tenant: { organizationId },
  member: { _id: undefined, role: 'owner', modules: [], permissions: [], status: 'active' },
  user: { _id: undefined, name: FORM_SOURCE },
  automation: { chain: [] },
  id: `whatsapp-form:${organizationId}`,
  ip: '',
  get: () => '',
});
const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const amountOf = (value) => {
  const number = Number(String(value ?? '').replace(/[,₹\s]/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The answers to a form (Mongoose gives every message an empty form object).
const hasAnswers = (message) => Boolean(message?.form?.values || message?.form?.token);

// The answers as the chat shows them: the form's labels (the product's name, a readable date).
function answersOf(form, values, products) {
  if (!form) return Object.entries(values).filter(([, v]) => clean(v)).map(([key, value]) => ({ label: key, value: clean(value, 2000) }));
  return fieldsOf(form.kind, form.fields).filter((field) => field.on && clean(values[field.key])).map((field) => {
    const type = definitionOf(form.kind, field.key).type;
    let value = clean(values[field.key], 2000);
    if (type === 'product') value = products.find((p) => String(p._id) === value)?.name || value;
    if (type === 'choice') value = definitionOf(form.kind, field.key).options.find((o) => o.toLowerCase() === value) || value;
    return { label: field.label, value };
  });
}

// An enquiry: what the CRM did not know about the customer, and their open lead (or a new one).
async function leadFromAnswers({ message, form, values, answers, conversation }) {
  const { organizationId } = message;
  const req = systemReq(organizationId);
  const contact = await Contact.findOne({ _id: message.contactId, organizationId });
  if (!contact) return null;
  const set = {};
  const name = clean(values.name);
  if (name && (!contact.name || contact.name === contact.phoneE164 || contact.name === contact.phone)) set.name = name;
  const email = clean(values.email).toLowerCase();
  if (email && EMAIL.test(email) && !contact.email) set.email = email;
  for (const key of ['company', 'city']) if (clean(values[key]) && !contact[key]) set[key] = clean(values[key]);
  if (Object.keys(set).length) await Contact.updateOne({ _id: contact._id }, { $set: set });

  const requirement = clean(values.requirement, 2000);
  const quantity = amountOf(values.quantity);
  const budget = amountOf(values.budget);
  const text = `Filled the WhatsApp form "${form.name}": ${answers.map((a) => `${a.label}: ${a.value}`).join('; ')}`.slice(0, 5000);
  const lead = await leadOfContact(organizationId, contact._id);
  if (lead && !['Won', 'Lost'].includes(lead.stage)) {
    const patch = { lastActivityAt: new Date() };
    if (requirement && !lead.title) patch.title = requirement.slice(0, 120);
    if (quantity && !lead.quantity) patch.quantity = quantity;
    if (budget && !lead.expectedValuePaise) patch.expectedValuePaise = Math.round(budget * 100);
    await Lead.updateOne({ _id: lead._id }, { $set: patch, $inc: { version: 1 } });
    await leadService.addActivity(req, lead, FORM_SOURCE, text);
    return lead._id;
  }
  const created = await leadService.create(req, {
    contactId: contact._id, title: requirement.slice(0, 120) || form.name, source: 'WhatsApp', ...(quantity && { quantity }), ...(budget && { expectedValuePaise: Math.round(budget * 100) }),
    ownerId: conversation?.assigneeId || contact.ownerId || null,
  });
  await leadService.addActivity(req, { _id: created.id, organizationId }, FORM_SOURCE, text);
  return created.id;
}

// An order form: the product and the quantity become an order at Received, priced as usual.
async function orderFromAnswers({ message, form, values, conversation }) {
  const { organizationId } = message;
  const existing = await Order.findOne({ organizationId, 'formOrder.messageId': message._id }).select('_id');
  if (existing) return existing._id;
  const product = mongoose.isValidObjectId(values.product) ? await Product.findOne({ _id: values.product, organizationId }) : null;
  const quantity = amountOf(values.quantity);
  if (!product || !quantity) return null;
  const req = systemReq(organizationId);
  const [organization, contact] = await Promise.all([Organization.findById(organizationId), Contact.findOne({ _id: message.contactId, organizationId })]);
  const billing = billingOf(organization);
  const billTo = quotationService.partyFromContact(contact);
  const lead = await leadOfContact(organizationId, message.contactId);
  const openLead = lead && !['Won', 'Lost'].includes(lead.stage) ? lead : null;
  const ownerId = openLead?.ownerId || conversation?.assigneeId || contact?.ownerId || undefined;
  const address = clean(values.address, 1000);
  const note = clean(values.note, 1000);
  // The day as orders keep a date typed in (UTC midnight), so the Orders page shows the day chosen.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(clean(values.date)) ? new Date(`${clean(values.date)}T00:00:00.000Z`) : null;
  let order;
  try {
    await mongoose.connection.transaction(async (session) => {
      const priced = await quotationService.priceFor(organization, { items: [{ productId: product._id, quantity }], billTo, roundOff: billing.roundOff }, session);
      const year = financialYear();
      const seq = await nextSequence(organizationId, `order:${year}`, { session });
      order = new Order({
        organizationId,
        number: `${billing.prefixes.order}/${year}/${String(seq).padStart(4, '0')}`,
        financialYear: year,
        source: 'form',
        formOrder: { messageId: message._id, conversationId: message.conversationId, formId: form._id, formName: form.name },
        leadId: openLead?._id,
        contactId: message.contactId,
        ownerId,
        billTo,
        seller: quotationService.sellerOf(organization),
        supply: priced.supply,
        items: priced.items,
        totals: priced.totals,
        notes: [address && `Delivery address: ${address}`, note && `Customer's note: ${note}`].filter(Boolean).join('\n'),
        ...(date && { dispatch: { expectedDeliveryDate: date } }),
        history: [{ stage: 'Received', from: '', byName: FORM_SOURCE, note: `Sent with the WhatsApp form "${form.name}"` }],
      });
      await order.save({ session });
      if (openLead) await leadService.addActivity(req, openLead, 'Order', `Order ${order.number} from the WhatsApp form "${form.name}" (${formatRupees(order.totals.grandTotalPaise)})`, { session });
    });
    automationEvents.emit('order.created', { organizationId, orderId: order._id, leadId: order.leadId || null, contactId: order.contactId, key: `order.created:${order._id}` });
  } catch (error) {
    if (error.code !== 11000) throw error;
    order = await Order.findOne({ organizationId, 'formOrder.messageId': message._id });
  }
  return order?._id || null;
}

// The job: the answers of one message (once).
async function answerFromMessage({ messageId }) {
  const message = await Message.findById(messageId);
  if (!message || message.direction !== 'in' || !hasAnswers(message) || message.form.done || message.private) return null;
  const { organizationId } = message;
  // The form: by the token we sent with it, else the message the answers reply to.
  let sent = message.form.token ? await Message.findOne({ organizationId, direction: 'out', 'form.token': message.form.token }).select('form') : null;
  if (!sent && message.replyToProviderMessageId) sent = await Message.findOne({ organizationId, direction: 'out', providerMessageId: message.replyToProviderMessageId }).select('form');
  const formId = sent?.form?.formId;
  const form = formId ? await WhatsAppForm.findOne({ _id: formId, organizationId, $or: [{ deletedAt: null }, { deletedAt: { $ne: null } }] }) : null;
  const values = message.form.values || {};
  const products = form?.kind === 'order' && mongoose.isValidObjectId(values.product) ? await Product.find({ _id: values.product, organizationId }).select('name').lean() : [];
  const answers = answersOf(form, values, products);
  const conversation = await Conversation.findOne({ _id: message.conversationId, organizationId });
  let leadId = null;
  let orderId = null;
  if (form?.kind === 'enquiry') leadId = await leadFromAnswers({ message, form, values, answers, conversation });
  if (form?.kind === 'order') orderId = await orderFromAnswers({ message, form, values, conversation });
  const updated = await Message.findByIdAndUpdate(message._id, {
    $set: { 'form.formId': form?._id, 'form.name': form?.name || '', 'form.answers': answers, 'form.leadId': leadId, 'form.orderId': orderId, 'form.done': true },
  }, { returnDocument: 'after' });
  bus.emit('message:status', { organizationId, message: updated }); // the open chat shows the answers
  if (!form) return { answers };
  await WhatsAppForm.updateOne({ _id: form._id }, { $inc: { answerCount: 1 }, $set: { lastAnswerAt: new Date() } });

  // Thank the customer (they just wrote, so the window is open).
  if (form.thanks && conversation && conversationService.serviceWindow(conversation).open) {
    await conversationService.sendTextAutomatically({ conversation, text: form.thanks, automation: { kind: 'form', ruleId: form._id } })
      .catch((error) => logger.warn(`Form ${form._id}: the thank-you message failed: ${error.message}`));
  }
  // The bell: the chat's teammate, else the owners and admins.
  const contact = await Contact.findOne({ _id: message.contactId, organizationId }).select('name phoneE164');
  const people = conversation?.assigneeId ? [conversation.assigneeId] : (await OrganizationMember.find({ organizationId, status: 'active', role: { $in: ['owner', 'admin'] } }).select('_id')).map((m) => m._id);
  const missing = form.kind === 'order' && !orderId;
  await notificationService.notify(organizationId, people, {
    title: `WhatsApp form answered: ${form.name}`,
    body: `${contact?.name || contact?.phoneE164 || 'A customer'}: ${answers.slice(0, 3).map((a) => `${a.label}: ${a.value}`).join('; ')}${missing ? ' — no order was made: the product or the quantity is missing.' : ''}`,
    link: orderId ? `Orders.html?id=${orderId}` : `Inbox.html?c=${message.conversationId}`,
    source: 'forms',
  });
  return { answers, leadId, orderId };
}

let listener = null;
function register(queue) {
  queue.define(JOB, answerFromMessage, { maxAttempts: 5 });
  if (listener) bus.off('message:new', listener);
  listener = ({ message }) => {
    if (message?.direction !== 'in' || !hasAnswers(message) || message.private) return;
    queue.enqueue(JOB, { messageId: String(message._id) }, { uniqueKey: `form-answer:${message._id}`, organizationId: message.organizationId })
      .catch((error) => logger.error(`Form answers of message ${message._id} could not be queued: ${error.message}`));
  };
  bus.on('message:new', listener);
}

module.exports = { JOB, FIELDS, DEFAULTS, LIMITS, flowJsonOf, list, create, update, publish, remove, send, answerFromMessage, register };
