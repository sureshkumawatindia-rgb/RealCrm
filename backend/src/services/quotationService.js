const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const MessageTemplate = require('../models/MessageTemplate');
const OrganizationMember = require('../models/OrganizationMember');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Organization = require('../models/Organization');
const Product = require('../models/Product');
const Quotation = require('../models/Quotation');
const httpError = require('../utils/httpError');
const logger = require('../config/logger');
const env = require('../config/env');
const signedLink = require('../utils/signedLink');
const { renderQuotationPdf, fileNameOf } = require('./quotationPdf');
const { audit } = require('../utils/audit');
const { nextSequence } = require('../utils/counter');
const { financialYear, formatRupees } = require('../utils/money');
const { indiaDate } = require('../utils/dates');
const { stateCodeFromGstin, normalizeGstin } = require('../utils/gstin');
const { supplyFor, priceDocument } = require('../utils/gst');
const { stateCodeFor, stateName } = require('../constants/gst');
const { OPEN_STAGES } = require('../constants/crm');
const { billingOf, sellerStateCode, DEFAULT_PREFIXES: DEFAULT_PREFIX } = require('./organizationService');
const { toPage, paginationMeta } = require('../utils/pagination');
const { visibilityFilter } = require('./access');
const leadService = require('./leadService');
const contactService = require('./contactService');
const conversationService = require('./conversationService');
const templateService = require('./templateService');

// Quotations, estimates and proforma invoices (Phase 5). The browser sends quantities,
// prices, discounts and rates; every amount is computed here (utils/gst). A draft is edited
// in place; a sent one gets a new revision (the old one is kept). Sending moves a New or
// Contacted lead to Quote Sent. An hourly job marks sent quotations past their validity Expired.
const MODULES = leadService.MODULES;
const EXPIRE_JOB = 'quotations.expire';
const PREFIX_KEY = { Quotation: 'quotation', Estimate: 'estimate', 'Proforma Invoice': 'proforma' };
const COUNTER_KEY = { Quotation: 'quotation', Estimate: 'estimate', 'Proforma Invoice': 'proforma' };
// Which status changes a person may make (Viewed and Expired are set by the CRM itself).
const NEXT = {
  Draft: ['Sent', 'Accepted', 'Rejected'],
  Sent: ['Accepted', 'Rejected'],
  Viewed: ['Accepted', 'Rejected'],
  Expired: ['Accepted', 'Rejected'],
  Rejected: [],
  Accepted: ['Sent'], // undo, while no order was made from it
};
const REVISABLE = ['Sent', 'Viewed', 'Rejected', 'Expired'];
const PARTY_FIELDS = ['name', 'company', 'phone', 'email', 'gstin', 'address', 'city', 'state', 'stateCode', 'postalCode'];

const scope = (req) => ({ organizationId: req.tenant.organizationId, ...visibilityFilter(req, MODULES) });
const calendarDate = (value) => (value ? new Date(`${new Date(value).toISOString().slice(0, 10)}T00:00:00.000Z`) : undefined);
const today = () => new Date(`${indiaDate(0)}T00:00:00.000Z`);
// The customer's link: /q/<id>.<signature> (no sign-in; opening it marks the quotation Viewed).
const LINK_PURPOSE = 'quotation';
const shareUrlOf = (quotation) => `${env.publicUrl}/q/${signedLink.sign(LINK_PURPOSE, quotation._id)}`;

// --- the seller and the customer ------------------------------------------------------------

function sellerOf(org) {
  const code = sellerStateCode(org);
  return {
    name: org?.name || '', gstin: org?.gstin || '', address: org?.address || '', city: org?.city || '',
    state: stateName(code) || org?.state || '', stateCode: code, postalCode: org?.postalCode || '', phone: org?.phone || '', email: org?.email || '',
  };
}

function partyFromContact(contact) {
  const code = stateCodeFromGstin(contact?.gstin) || contact?.stateCode || stateCodeFor(contact?.state);
  return {
    name: contact?.name || '', company: contact?.company || '', phone: contact?.phone || contact?.phoneE164 || '', email: contact?.email || '',
    gstin: contact?.gstin || '', address: contact?.address || '', city: contact?.city || '', state: contact?.state || stateName(code), stateCode: code, postalCode: '',
  };
}

// The editor may correct the customer's details on the document (address, GSTIN, state).
function mergeParty(base, override = {}) {
  const party = { ...base };
  for (const field of PARTY_FIELDS) if (typeof override[field] === 'string') party[field] = override[field].trim();
  party.gstin = normalizeGstin(party.gstin);
  // The GSTIN decides the state; otherwise a chosen code or the typed state name.
  const typed = override.state !== undefined || override.stateCode !== undefined;
  party.stateCode = stateCodeFromGstin(party.gstin) || stateCodeFor(override.stateCode) || stateCodeFor(party.state) || (typed ? '' : base.stateCode || '');
  if (party.stateCode && (!party.state || stateCodeFor(party.state) !== party.stateCode)) party.state = stateName(party.stateCode);
  return party;
}

// A quotation is for a lead, a contact or a WhatsApp chat's customer (and its newest open lead).
async function resolveCustomer(req, { leadId, contactId, conversationId }, session) {
  if (leadId) {
    const lead = await leadService.findVisible(req, leadId, session);
    const contact = await Contact.findOne({ _id: lead.contactId, organizationId: req.tenant.organizationId }).session(session || null);
    return { lead, contact, ownerId: lead.ownerId || contact?.ownerId || req.member._id };
  }
  let contact;
  if (conversationId) {
    const conversation = await conversationService.findVisible(req, conversationId);
    contact = await Contact.findOne({ _id: conversation.contactId, organizationId: req.tenant.organizationId }).session(session || null);
  } else if (contactId) {
    contact = await contactService.findVisible(req, contactId, session);
  }
  if (!contact) {
    throw httpError(400, 'VALIDATION_ERROR', 'Choose the customer (a lead, contact or chat).', [{ field: 'leadId', code: 'CUSTOMER_REQUIRED', message: 'Choose the customer.' }]);
  }
  const lead = await Lead.findOne({ organizationId: req.tenant.organizationId, contactId: contact._id, stage: { $in: OPEN_STAGES }, ...visibilityFilter(req, MODULES) })
    .sort({ createdAt: -1 }).session(session || null);
  return { lead, contact, ownerId: lead?.ownerId || contact.ownerId || req.member._id };
}

// --- lines ------------------------------------------------------------------------------------
// Missing names, units, HSN codes, prices and rates come from the product. Older clients send
// discountPaise and taxRatePct.
async function linesFrom(organizationId, items, session) {
  const ids = items.map((item) => item.productId).filter(Boolean);
  const products = await Product.find({ _id: { $in: ids }, organizationId }).session(session || null);
  const byId = new Map(products.map((product) => [String(product._id), product]));
  return items.map((item) => {
    const product = item.productId ? byId.get(String(item.productId)) : null;
    if (item.productId && !product) {
      throw httpError(400, 'VALIDATION_ERROR', 'Unknown product in the quotation.', [{ field: 'items', code: 'INVALID_PRODUCT', message: 'Pick products from your catalog.' }]);
    }
    const legacyDiscount = item.discountPaise !== undefined && item.discountValue === undefined;
    return {
      productId: product?._id,
      name: item.name || product?.name || 'Item',
      description: item.description ?? product?.description ?? '',
      hsnSac: item.hsnSac ?? product?.hsnSac ?? '',
      unit: item.unit || product?.unit || '',
      quantity: item.quantity,
      unitPricePaise: item.unitPricePaise ?? product?.pricePaise ?? 0,
      discountType: legacyDiscount ? 'amount' : item.discountType || 'amount',
      discountValue: legacyDiscount ? item.discountPaise : item.discountValue || 0,
      gstRatePct: item.gstRatePct ?? item.taxRatePct ?? product?.gstRatePct ?? 0,
    };
  });
}

// Everything a document's amounts depend on, priced.
async function priceFor(org, { items, billTo, placeOfSupplyCode, zeroRated, roundOff }, session) {
  const supply = supplyFor({ sellerStateCode: sellerStateCode(org), buyerGstin: billTo.gstin, buyerStateCode: billTo.stateCode, buyerState: billTo.state, placeOfSupplyCode, zeroRated });
  const lines = await linesFrom(org._id, items, session);
  return { supply, ...priceDocument(lines, supply, { roundOff }) };
}

// --- serializing --------------------------------------------------------------------------
function serializeQuotation(quotation, { full = true } = {}) {
  const plain = (value) => (value?.toObject ? value.toObject() : value);
  return {
    id: quotation._id,
    type: quotation.type || 'Quotation',
    number: quotation.number,
    financialYear: quotation.financialYear,
    revision: quotation.revision || 0,
    leadId: quotation.leadId || null,
    contactId: quotation.contactId || null,
    ownerId: quotation.ownerId || null,
    status: quotation.status,
    quotationDate: quotation.quotationDate,
    validUntil: quotation.validUntil || null,
    billTo: plain(quotation.billTo) || {},
    seller: plain(quotation.seller) || {},
    supply: { ...(plain(quotation.supply) || {}), placeOfSupply: stateName(quotation.supply?.placeOfSupplyCode) },
    placeOfSupplyCode: quotation.placeOfSupplyCode || '', // chosen by hand ('' = from the customer)
    roundOff: quotation.roundOff !== false,
    items: plain(quotation.items) || [],
    totals: plain(quotation.totals) || {},
    terms: quotation.terms || '',
    notes: quotation.notes || '',
    sentAt: quotation.sentAt || null,
    sentVia: quotation.sentVia || null,
    viewedAt: quotation.viewedAt || null,
    lastViewedAt: quotation.lastViewedAt || null,
    viewCount: quotation.viewCount || 0,
    acceptedAt: quotation.acceptedAt || null,
    rejectedAt: quotation.rejectedAt || null,
    rejectedReason: quotation.rejectedReason || '',
    expiredAt: quotation.expiredAt || null,
    orderId: quotation.orderId || null,
    legacyNumber: quotation.legacyNumber || '',
    shareUrl: shareUrlOf(quotation),
    ...(full && { revisions: (quotation.revisions || []).map(plain) }),
    revisionCount: (quotation.revisions || []).length,
    createdAt: quotation.createdAt,
    updatedAt: quotation.updatedAt,
  };
}

// --- numbering ------------------------------------------------------------------------------
// Each type has its own counter per financial year (Quotation keeps the Phase 2 counter).
async function nextNumber(organizationId, session, { type = 'Quotation', prefixes } = {}) {
  const year = financialYear();
  const seq = await nextSequence(organizationId, `${COUNTER_KEY[type]}:${year}`, { session });
  const prefix = (prefixes || DEFAULT_PREFIX)[PREFIX_KEY[type]] || DEFAULT_PREFIX[PREFIX_KEY[type]];
  return { number: `${prefix}/${year}/${String(seq).padStart(4, '0')}`, financialYear: year };
}

async function loadOrg(req, session) {
  return Organization.findById(req.tenant.organizationId).session(session || null);
}

// Details the editor filled in (GSTIN, state, city, address) complete a contact's blank fields.
async function fillContact(contact, billTo, session) {
  if (!contact) return;
  const set = {};
  for (const field of ['gstin', 'state', 'city', 'address']) if (billTo[field] && !contact[field]) set[field] = billTo[field];
  if (set.gstin || (!contact.stateCode && billTo.stateCode)) set.stateCode = stateCodeFromGstin(set.gstin || contact.gstin) || billTo.stateCode;
  if (Object.keys(set).length) await Contact.updateOne({ _id: contact._id }, { $set: set }, { session });
}

async function findVisible(req, id, session) {
  const quotation = await Quotation.findOne({ _id: id, ...scope(req) }).session(session || null);
  if (!quotation) throw httpError(404, 'NOT_FOUND', 'Quotation not found');
  return quotation;
}

async function leadOf(quotation, session) {
  return quotation.leadId ? Lead.findById(quotation.leadId).session(session || null) : null;
}

// --- the API -------------------------------------------------------------------------------
// POST /pricing/preview — the editor's live totals, without saving anything.
async function preview(req, body) {
  const org = await loadOrg(req);
  let base = {};
  if (body.leadId || body.contactId || body.conversationId) base = partyFromContact((await resolveCustomer(req, body)).contact);
  const billTo = mergeParty(base, body.billTo);
  const billing = billingOf(org);
  const priced = await priceFor(org, { ...body, billTo, roundOff: body.roundOff ?? billing.roundOff });
  return {
    items: priced.items,
    totals: priced.totals,
    supply: { ...priced.supply, placeOfSupply: stateName(priced.supply.placeOfSupplyCode) },
    billTo,
    // What a new document starts with (Settings → Billing).
    defaults: { terms: billing.terms, validUntil: indiaDate(billing.validityDays) },
  };
}

async function create(req, body) {
  let quotation;
  await mongoose.connection.transaction(async (session) => {
    const org = await loadOrg(req, session);
    const billing = billingOf(org);
    const { lead, contact, ownerId } = await resolveCustomer(req, body, session);
    const billTo = mergeParty(partyFromContact(contact), body.billTo);
    const roundOff = billing.roundOff;
    const priced = await priceFor(org, { ...body, billTo, roundOff }, session);
    const type = body.type || 'Quotation';
    quotation = new Quotation({
      organizationId: org._id,
      type,
      ...(await nextNumber(org._id, session, { type, prefixes: billing.prefixes })),
      leadId: lead?._id,
      contactId: contact._id,
      ownerId,
      quotationDate: new Date(),
      validUntil: body.validUntil ? calendarDate(body.validUntil) : new Date(`${indiaDate(billing.validityDays)}T00:00:00.000Z`),
      billTo,
      seller: sellerOf(org),
      supply: priced.supply,
      placeOfSupplyCode: body.placeOfSupplyCode || '',
      roundOff,
      items: priced.items,
      totals: priced.totals,
      terms: body.terms ?? billing.terms,
      notes: body.notes || '',
      createdById: req.user._id,
    });
    await quotation.save({ session });
    await fillContact(contact, billTo, session);
    if (lead) await leadService.addActivity(req, lead, 'Quotation', `${type} ${quotation.number} created (₹${(quotation.totals.grandTotalPaise / 100).toLocaleString('en-IN')})`, { session });
  });
  await audit(req, { action: 'quotation.created', entityType: 'Quotation', entityId: quotation._id });
  return serializeQuotation(quotation);
}

function assertDraft(quotation) {
  if (quotation.status !== 'Draft') {
    throw httpError(409, 'NOT_DRAFT', `This ${quotation.type.toLowerCase()} was ${quotation.status.toLowerCase()}; revise it to change it.`);
  }
}

// PATCH /quotations/:id — content (drafts only) and/or a status change.
async function update(req, id, body) {
  const { status, rejectedReason, ...content } = body;
  let quotation;
  let events = [];
  await mongoose.connection.transaction(async (session) => {
    events = [];
    quotation = await findVisible(req, id, session);
    if (Object.keys(content).length) {
      assertDraft(quotation);
      const org = await loadOrg(req, session);
      const billTo = content.billTo ? mergeParty(quotation.billTo?.toObject?.() || {}, content.billTo) : quotation.billTo.toObject();
      if (content.placeOfSupplyCode !== undefined) quotation.placeOfSupplyCode = content.placeOfSupplyCode;
      const input = {
        items: content.items || quotation.items.map((item) => item.toObject()),
        billTo,
        placeOfSupplyCode: quotation.placeOfSupplyCode,
        zeroRated: content.zeroRated ?? quotation.supply?.zeroRated,
        roundOff: quotation.roundOff !== false,
      };
      const priced = await priceFor(org, input, session);
      Object.assign(quotation, { billTo, supply: priced.supply, items: priced.items, totals: priced.totals, seller: sellerOf(org) });
      if (content.validUntil !== undefined) quotation.validUntil = content.validUntil ? calendarDate(content.validUntil) : undefined;
      for (const field of ['terms', 'notes']) if (content[field] !== undefined) quotation[field] = content[field];
      if (content.type && content.type !== quotation.type) {
        throw httpError(409, 'TYPE_FIXED', 'The document type cannot change after it is numbered. Make a new one instead.');
      }
      await fillContact(await Contact.findById(quotation.contactId).session(session), billTo, session);
      events.push(['Quotation', `${quotation.type} ${quotation.number} updated (₹${(quotation.totals.grandTotalPaise / 100).toLocaleString('en-IN')})`]);
    }
    if (status && status !== quotation.status) events.push(...(await changeStatus(req, quotation, status, { rejectedReason, session })));
    await quotation.save({ session });
    const lead = events.length ? await leadOf(quotation, session) : null;
    if (lead) for (const [type, text] of events) await leadService.addActivity(req, lead, type, text, { session });
  });
  await audit(req, { action: status ? 'quotation.status_changed' : 'quotation.updated', entityType: 'Quotation', entityId: quotation._id, changes: status ? { status } : Object.keys(content) });
  if (quotation.$locals.stageChange) await leadService.emitStageChange(req, quotation.$locals.stageChange.leadId, quotation.$locals.stageChange);
  return serializeQuotation(quotation);
}

// Applies a status change a person asked for; returns the lead timeline entries.
async function changeStatus(req, quotation, status, { rejectedReason, session, via = 'manual' }) {
  if (!NEXT[quotation.status].includes(status)) {
    throw httpError(409, 'INVALID_STATUS', `A ${quotation.status.toLowerCase()} ${quotation.type.toLowerCase()} cannot be marked ${status.toLowerCase()}.`);
  }
  if (quotation.status === 'Accepted' && quotation.orderId) {
    throw httpError(409, 'HAS_ORDER', 'An order was made from this quotation; cancel the order first.');
  }
  const events = [];
  const label = `${quotation.type} ${quotation.number}`;
  quotation.status = status;
  if (status === 'Sent' && quotation.acceptedAt) {
    quotation.acceptedAt = undefined; // "accepted" undone
    events.push(['Quotation', `${label}: acceptance undone`]);
  } else if (status === 'Sent') {
    quotation.sentAt = quotation.sentAt || new Date();
    quotation.sentVia = via;
    events.push(['Quotation', `${label} sent${via === 'whatsapp' ? ' on WhatsApp' : ''}`]);
    const lead = await leadOf(quotation, session);
    // Sending a quote moves an early lead forward (never back from Negotiation, Won or Lost).
    if (lead && ['New', 'Contacted'].includes(lead.stage)) {
      const from = lead.stage;
      leadService.applyStage(lead, 'Quote Sent');
      lead.version += 1;
      lead.lastActivityAt = new Date();
      await lead.save({ session });
      events.push(['Stage changed', `${from} → Quote Sent`]);
      quotation.$locals.stageChange = { leadId: lead._id, from, to: 'Quote Sent' };
    }
  } else if (status === 'Accepted') {
    quotation.acceptedAt = new Date();
    events.push(['Quotation', `${label} accepted`]);
  } else if (status === 'Rejected') {
    quotation.rejectedAt = new Date();
    quotation.rejectedReason = String(rejectedReason || '').trim();
    events.push(['Quotation', `${label} rejected${quotation.rejectedReason ? `: ${quotation.rejectedReason}` : ''}`]);
  }
  return events;
}

// POST /quotations/:id/revise — keeps the current version and reopens the document as a draft.
async function revise(req, id) {
  let quotation;
  await mongoose.connection.transaction(async (session) => {
    quotation = await findVisible(req, id, session);
    if (!REVISABLE.includes(quotation.status)) {
      throw httpError(409, 'NOT_REVISABLE', quotation.status === 'Draft' ? 'This is still a draft: change it directly.' : 'An accepted quotation cannot be revised; make a new one.');
    }
    const org = await loadOrg(req, session);
    const snapshot = {
      revision: quotation.revision, status: quotation.status, quotationDate: quotation.quotationDate, validUntil: quotation.validUntil,
      items: quotation.items, totals: quotation.totals, supply: quotation.supply, billTo: quotation.billTo, terms: quotation.terms, notes: quotation.notes,
      replacedAt: new Date(), replacedById: req.user._id,
    };
    quotation.revisions.push(snapshot);
    quotation.revision += 1;
    quotation.status = 'Draft';
    quotation.quotationDate = new Date();
    if (!quotation.validUntil || quotation.validUntil < today()) quotation.validUntil = new Date(`${indiaDate(billingOf(org).validityDays)}T00:00:00.000Z`);
    for (const field of ['sentAt', 'sentVia', 'viewedAt', 'lastViewedAt', 'acceptedAt', 'rejectedAt', 'expiredAt']) quotation[field] = undefined;
    quotation.viewCount = 0;
    quotation.rejectedReason = '';
    quotation.seller = sellerOf(org);
    await quotation.save({ session });
    const lead = await leadOf(quotation, session);
    if (lead) await leadService.addActivity(req, lead, 'Quotation', `${quotation.type} ${quotation.number} revised (revision ${quotation.revision})`, { session });
  });
  await audit(req, { action: 'quotation.revised', entityType: 'Quotation', entityId: quotation._id, changes: { revision: quotation.revision } });
  return serializeQuotation(quotation);
}

async function list(req, query) {
  const filter = {
    ...scope(req),
    ...(query.leadId && { leadId: query.leadId }),
    ...(query.contactId && { contactId: query.contactId }),
    ...(query.status && { status: query.status }),
    ...(query.type && { type: query.type }),
  };
  if (query.q) {
    const pattern = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: pattern }, { 'billTo.name': pattern }, { 'billTo.company': pattern }, { legacyNumber: pattern }];
  }
  const page = toPage(query);
  const [items, total] = await Promise.all([
    Quotation.find(filter).select('-revisions').sort({ createdAt: -1, _id: -1 }).skip(page.skip).limit(page.limit),
    Quotation.countDocuments(filter),
  ]);
  return { items: items.map((q) => serializeQuotation(q, { full: false })), pagination: paginationMeta(page, total) };
}

async function remove(req, id) {
  const quotation = await findVisible(req, id);
  if (quotation.orderId) throw httpError(409, 'HAS_ORDER', 'An order was made from this quotation; it cannot be deleted.');
  await quotation.softDelete();
  await audit(req, { action: 'quotation.deleted', entityType: 'Quotation', entityId: quotation._id });
}

// POST /leads/:id/quotations (Phase 2 lead form): the lead's draft quotation, created or updated.
async function saveDraftForLead(req, leadId, { items, validUntil }) {
  const lead = await leadService.findVisible(req, leadId);
  const draft = await Quotation.findOne({ organizationId: lead.organizationId, leadId: lead._id, status: 'Draft' }).select('_id');
  const body = { items, ...(validUntil !== undefined && { validUntil }) };
  if (draft) return { ...(await update(req, draft._id, body)), action: 'updated' };
  return { ...(await create(req, { ...body, leadId })), action: 'created' };
}

// Importing old browser data: the same maths, amounts kept exact (no round-off).
async function buildImported(organizationId, contact, items) {
  const org = await Organization.findById(organizationId);
  const billTo = partyFromContact(contact);
  const priced = await priceFor(org, { items, billTo, roundOff: false });
  return { billTo, seller: sellerOf(org), supply: priced.supply, roundOff: false, items: priced.items, totals: priced.totals };
}

// Sent quotations past their last valid day become Expired (hourly).
async function expireDue() {
  const result = await Quotation.updateMany(
    { status: { $in: ['Sent', 'Viewed'] }, validUntil: { $lt: today() }, deletedAt: null },
    { $set: { status: 'Expired', expiredAt: new Date() } },
  );
  if (result.modifiedCount) logger.info(`Quotations expired: ${result.modifiedCount}`);
  return result.modifiedCount;
}

function register(queue) {
  queue.define(EXPIRE_JOB, expireDue, { maxAttempts: 3 });
  queue.every(EXPIRE_JOB, 60 * 60 * 1000).catch((error) => logger.error(`Scheduling ${EXPIRE_JOB} failed: ${error.message}`));
}

// --- the PDF and the customer's link -------------------------------------------------------
async function pdfFor(quotation) {
  const organization = await Organization.findById(quotation.organizationId);
  const buffer = await renderQuotationPdf({ quotation, organization, shareUrl: shareUrlOf(quotation) });
  return { buffer, fileName: fileNameOf(quotation) };
}

// GET /quotations/:id/pdf (signed-in members who may see it).
async function pdf(req, id) {
  return pdfFor(await findVisible(req, id));
}

// A customer opened the link: count it; the first view of a sent quotation makes it Viewed
// and says so on the lead's timeline.
async function recordView(quotation) {
  const now = new Date();
  await Quotation.updateOne({ _id: quotation._id }, { $inc: { viewCount: 1 }, $set: { lastViewedAt: now } });
  await Quotation.updateOne({ _id: quotation._id, viewedAt: null }, { $set: { viewedAt: now } });
  const turned = await Quotation.findOneAndUpdate({ _id: quotation._id, status: 'Sent' }, { $set: { status: 'Viewed' } });
  if (turned?.leadId) {
    await LeadActivity.create({
      organizationId: turned.organizationId, leadId: turned.leadId, contactId: turned.contactId, type: 'Quotation',
      text: `${turned.type} ${turned.number} opened by the customer`, actorName: 'Customer',
    });
  }
}

// /q/<token>: → { quotation, organization } or null (bad link, deleted). Drafts are not shown
// and not counted; preview (the CRM's own "open customer view") is not counted either.
async function openShared(token, { count = true } = {}) {
  const id = signedLink.verify(LINK_PURPOSE, token);
  if (!id) return null;
  const quotation = await Quotation.findById(id);
  if (!quotation) return null;
  if (count && quotation.status !== 'Draft') {
    await recordView(quotation);
    return { quotation: await Quotation.findById(id), organization: await Organization.findById(quotation.organizationId) };
  }
  return { quotation, organization: await Organization.findById(quotation.organizationId) };
}

// --- sending in the WhatsApp chat (Phase 5D) ---------------------------------------------
const SENDABLE_STATUSES = ['Draft', 'Sent', 'Viewed', 'Accepted'];

async function contactOf(quotation) {
  return Contact.findOne({ _id: quotation.contactId, organizationId: quotation.organizationId });
}

// The customer's chat: their latest one, or none yet (it is opened on the default number).
async function chatOf(quotation) {
  return Conversation.findOne({ organizationId: quotation.organizationId, contactId: quotation.contactId }).sort({ lastMessageAt: -1, updatedAt: -1 });
}

async function memberLabel(id) {
  const member = id ? await OrganizationMember.findById(id).populate('userId', 'name') : null;
  return member?.displayName || member?.userId?.name || 'a teammate';
}

// What fills a template variable, guessed from its name (named) or its place (positional):
// the customer's name, the document, the total, the link.
function suggestions(quotation, contact) {
  const token = signedLink.sign(LINK_PURPOSE, quotation._id);
  const facts = {
    name: quotation.billTo?.name || contact?.name || '',
    number: quotation.number,
    total: formatRupees(quotation.totals?.grandTotalPaise),
    link: shareUrlOf(quotation),
  };
  const byName = (name) => {
    const key = String(name).toLowerCase();
    if (/name/.test(key)) return facts.name;
    if (/amount|total|price|value/.test(key)) return facts.total;
    if (/link|url/.test(key)) return facts.link;
    if (/number|quot|ref|estimate|invoice|doc/.test(key)) return facts.number;
    return '';
  };
  // Templates usually say "our quotation {{2}}": the number alone reads right there.
  const ORDER = [facts.name, facts.number, facts.total, facts.link];
  return (template) => {
    const shape = templateService.shapeOf(template, { withDocument: true });
    const named = template.parameterFormat === 'NAMED';
    const fill = (names) => Object.fromEntries(names.map((name, i) => [name, (named ? byName(name) : ORDER[Number(name) - 1] ?? ORDER[i]) || '']));
    return {
      header: fill(shape.header?.variables || []),
      body: fill(shape.body.variables),
      buttons: Object.fromEntries(shape.buttons.filter((b) => b.variables.length).map((b) => [String(b.index), /\/q\/\{\{/.test(b.url) ? token : facts.link])),
    };
  };
}

// GET /quotations/:id/send-options — can it go now, as a document or only as a template?
async function sendOptions(req, id) {
  const quotation = await findVisible(req, id);
  const contact = await contactOf(quotation);
  const conversation = await chatOf(quotation);
  const account = conversation
    ? await WhatsAppAccount.findOne({ _id: conversation.whatsappAccountId, organizationId: quotation.organizationId })
    : await WhatsAppAccount.findOne({ organizationId: quotation.organizationId }).sort({ isDefault: -1, createdAt: 1 });
  let blocked = '';
  if (!SENDABLE_STATUSES.includes(quotation.status)) blocked = `This ${quotation.type.toLowerCase()} was ${quotation.status.toLowerCase()}: revise it first.`;
  else if (!contact?.phoneE164) blocked = `${contact?.name || 'The customer'} has no mobile number. Add it to the customer first.`;
  else if (!account) blocked = 'Add a WhatsApp number in Settings → WhatsApp first.';
  else if (conversation?.assigneeId && !conversationService.seesAll(req.member) && String(conversation.assigneeId) !== String(req.member._id)) {
    blocked = `${await memberLabel(conversation.assigneeId)} is handling this customer's WhatsApp chat.`;
  }
  const suggest = suggestions(quotation, contact);
  const templates = account
    ? (await MessageTemplate.find({ organizationId: quotation.organizationId, whatsappAccountId: account._id, status: 'APPROVED' }).sort({ name: 1 }))
      .filter((template) => templateService.shapeOf(template, { withDocument: true }).sendable)
      .map((template) => ({ ...templateService.serializeTemplate(template), suggested: suggest(template) }))
    : [];
  const name = quotation.billTo?.name || contact?.name || '';
  return {
    blocked,
    phone: contact?.phoneE164 || '',
    account: account ? { id: account._id, name: account.name || account.verifiedName || '', phone: account.displayPhone || '' } : null,
    conversation: conversation ? { id: conversation._id, windowOpen: conversationService.serviceWindow(conversation).open } : null,
    caption: [`Namaste ${name}, please find our ${quotation.type.toLowerCase()} ${quotation.number} for ${formatRupees(quotation.totals?.grandTotalPaise)}.`, `View online: ${shareUrlOf(quotation)}`].join('\n').slice(0, 1024),
    templates,
  };
}

// POST /quotations/:id/send — the PDF into the customer's chat; a draft becomes Sent and an
// early lead moves to Quote Sent. { mode: document | template, caption?, templateId?, variables? }
async function sendOnWhatsApp(req, id, { mode, caption = '', templateId, variables }) {
  let quotation = await findVisible(req, id);
  if (!SENDABLE_STATUSES.includes(quotation.status)) {
    throw httpError(409, 'REVISE_FIRST', `This ${quotation.type.toLowerCase()} was ${quotation.status.toLowerCase()}: revise it first.`);
  }
  const contact = await contactOf(quotation);
  if (!contact?.phoneE164) throw httpError(409, 'NO_PHONE', `${contact?.name || 'The customer'} has no mobile number. Add it to the customer first.`);
  let conversation = await chatOf(quotation);
  if (mode === 'document' && !(conversation && conversationService.serviceWindow(conversation).open)) {
    throw httpError(422, 'WINDOW_CLOSED', 'The customer has not written in the last 24 hours. WhatsApp only allows an approved template now.');
  }
  if (!conversation) {
    const started = await conversationService.start(req, { contactId: contact._id });
    conversation = await Conversation.findById(started.conversation.id);
  } else if (conversation.assigneeId && !conversationService.seesAll(req.member) && String(conversation.assigneeId) !== String(req.member._id)) {
    throw httpError(409, 'CHAT_ASSIGNED', `${await memberLabel(conversation.assigneeId)} is handling this customer's WhatsApp chat.`);
  }
  const { buffer, fileName } = await pdfFor(quotation);
  const message = await conversationService.sendGeneratedDocument(req, conversation._id, {
    buffer, fileName, caption: mode === 'document' ? caption : '', templateId: mode === 'template' ? templateId : undefined, variables,
  });
  if (message.status === 'failed') {
    throw httpError(502, 'WHATSAPP_REFUSED', `WhatsApp did not accept it: ${message.error?.message || 'unknown reason'}. The attempt shows in the chat.`);
  }
  await mongoose.connection.transaction(async (session) => {
    quotation = await Quotation.findById(quotation._id).session(session);
    const events = quotation.status === 'Draft'
      ? await changeStatus(req, quotation, 'Sent', { session, via: 'whatsapp' })
      : [['Quotation', `${quotation.type} ${quotation.number} sent again on WhatsApp`]];
    await quotation.save({ session });
    const lead = await leadOf(quotation, session);
    if (lead) for (const [type, text] of events) await leadService.addActivity(req, lead, type, text, { session });
  });
  await audit(req, { action: 'quotation.sent_whatsapp', entityType: 'Quotation', entityId: quotation._id, changes: { mode, templateId: templateId || null } });
  if (quotation.$locals.stageChange) await leadService.emitStageChange(req, quotation.$locals.stageChange.leadId, quotation.$locals.stageChange);
  return { quotation: serializeQuotation(quotation), message, conversationId: conversation._id };
}

// GET /quotations/awaiting-reply?days=N — leads at Quote Sent whose latest sent quotation is at
// least N days old and the customer has not written on WhatsApp since. Oldest wait first.
async function awaitingReply(req, { days = 3 } = {}) {
  const now = Date.now();
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);
  const quotations = await Quotation.find({ ...scope(req), status: { $in: ['Sent', 'Viewed'] }, sentAt: { $lte: cutoff }, leadId: { $ne: null } })
    .select('-revisions').sort({ sentAt: -1 }).limit(1000);
  const latest = new Map();
  for (const quotation of quotations) if (!latest.has(String(quotation.leadId))) latest.set(String(quotation.leadId), quotation);
  if (!latest.size) return [];
  const leads = await Lead.find({ _id: { $in: [...latest.keys()] }, organizationId: req.tenant.organizationId, stage: 'Quote Sent', ...visibilityFilter(req, MODULES) })
    .populate({ path: 'contactId', select: 'name email phone company lifecycle' });
  const contactIds = leads.map((lead) => lead.contactId?._id || lead.contactId);
  const chats = await Conversation.find({ organizationId: req.tenant.organizationId, contactId: { $in: contactIds } }).select('contactId lastInboundAt lastMessageAt');
  const chatOfContact = new Map();
  for (const chat of chats) {
    const key = String(chat.contactId);
    const known = chatOfContact.get(key);
    if (!known || (chat.lastInboundAt || 0) > (known.lastInboundAt || 0)) chatOfContact.set(key, chat);
  }
  return leads
    .map((lead) => {
      const quotation = latest.get(String(lead._id));
      const chat = chatOfContact.get(String(lead.contactId?._id || lead.contactId));
      if (chat?.lastInboundAt && chat.lastInboundAt > quotation.sentAt) return null; // they replied
      return {
        lead: leadService.serializeLead(lead),
        quotation: {
          id: quotation._id, type: quotation.type, number: quotation.number, status: quotation.status, sentAt: quotation.sentAt,
          viewCount: quotation.viewCount || 0, lastViewedAt: quotation.lastViewedAt || null, grandTotalPaise: quotation.totals?.grandTotalPaise || 0,
        },
        conversationId: chat?._id || null,
        waitingDays: Math.floor((now - quotation.sentAt.getTime()) / (24 * 60 * 60 * 1000)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.waitingDays - a.waitingDays);
}

module.exports = {
  awaitingReply, sendOptions, sendOnWhatsApp,
  pdf, pdfFor, openShared, recordView, shareUrlOf,
  preview, create, update, revise, list, remove, saveDraftForLead, buildImported, expireDue, register, nextNumber,
  serializeQuotation, sellerOf, partyFromContact, priceFor, changeStatus, findVisible, EXPIRE_JOB,
  get: async (req, id) => serializeQuotation(await findVisible(req, id)),
};
