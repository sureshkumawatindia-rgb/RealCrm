const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Product = require('../models/Product');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Quotation = require('../models/Quotation');
const Task = require('../models/Task');
const CalendarEvent = require('../models/CalendarEvent');
const OrganizationMember = require('../models/OrganizationMember');
const Import = require('../models/Import');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { normalizePhone } = require('../utils/phone');
const { rupeesToPaise } = require('../utils/money');
const { STAGE_PROBABILITY, TASK_STATUSES, TASK_PRIORITIES, EVENT_TYPES, RELATED_TYPES } = require('../constants/crm');
const { computeItem, totalsOf, nextNumber } = require('./quotationService');

// "Move my browser data to server": imports the localStorage keys of the old browser-only CRM.
// - dryRun runs the same mapping without writing and reports what would happen.
// - Every created record keeps its old browser id in legacyIds, so running again skips
//   what was already imported. Browser data is never changed by the server.
// Keys handled here move to the server in this phase; the others are reported for later.
const SUPPORTED_KEYS = [
  'crm_products', 'crm_customers', 'crm_accounts', 'crm_leads', 'crm_deals', 'crm_lead_activities', 'crm_quotations',
  'crm_tasks', 'crm_deal_tasks', 'crm_calendar_events',
];
const LATER_KEYS = [
  'crm_agents', 'crm_tickets', 'crm_documents',
  'crm_campaigns', 'crm_workflows', 'crm_sequences', 'crm_customer_notes',
];

const LEAD_STAGE_MAP = { New: 'New', 'In Progress': 'Contacted', Contacted: 'Contacted', Qualified: 'Quote Sent', Proposal: 'Quote Sent', Negotiation: 'Negotiation', Won: 'Won', Lost: 'Lost' };
const DEAL_STAGE_MAP = { Lead: 'New', Qualified: 'Quote Sent', Proposal: 'Quote Sent', Negotiation: 'Negotiation', Won: 'Won', Lost: 'Lost' };
const IMPORTED_LOST_REASON = 'Imported from the browser (no reason recorded)';
const REPORT_LIMIT = 50;

const str = (value, max = 500) => (value == null ? '' : String(value).trim().slice(0, max));
const lower = (value) => str(value).toLowerCase();
const validDate = (value) => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};
// A calendar day "YYYY-MM-DD" (the old pages stored dates as strings), else undefined.
const calendarDay = (value) => {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(str(value, 40));
  return match && !Number.isNaN(new Date(match[1]).getTime()) ? match[1] : undefined;
};
const clockTime = (value) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(str(value, 10)) ? str(value, 10) : '');
const nonNegativeInt = (value) => {
  if (value === '' || value == null) return undefined;
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

function readList(data, key, report) {
  const raw = data[key];
  if (raw == null || raw === '') return [];
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      report.problems.push({ key, reason: 'Not valid JSON' });
      return [];
    }
  }
  if (!Array.isArray(value)) {
    report.problems.push({ key, reason: 'Expected a list' });
    return [];
  }
  return value.filter((item) => item && typeof item === 'object');
}

function newSection() {
  return { found: 0, created: 0, alreadyImported: 0, merged: 0, rejected: 0, rejectedRows: [] };
}

class ImportRun {
  constructor(req, dryRun) {
    this.req = req;
    this.dryRun = dryRun;
    this.organizationId = req.tenant.organizationId;
    this.report = { dryRun, sections: {}, unresolved: [], problems: [], later: {} };
    this.ids = { products: new Map(), contacts: new Map(), leads: new Map() };
    this.contactByPhone = new Map();
    this.contactByEmail = new Map();
    this.contactByNameCompany = new Map();
    this.leadContact = new Map();
    this.memberByName = new Map();
    // For tasks and events that name what they are about.
    this.contactByName = new Map();
    this.leadByName = new Map();
    this.dealByTitle = new Map();
    this.reportedAssignees = new Set();
  }

  section(name) {
    this.report.sections[name] = this.report.sections[name] || newSection();
    return this.report.sections[name];
  }

  reject(section, legacyId, reason) {
    section.rejected += 1;
    if (section.rejectedRows.length < REPORT_LIMIT) section.rejectedRows.push({ legacyId: str(legacyId, 60), reason });
  }

  unresolved(message) {
    if (this.report.unresolved.length < REPORT_LIMIT) this.report.unresolved.push(message);
  }

  // Writes (or, in a dry run, pretends to write) one document and returns its id.
  async insert(Model, doc) {
    if (this.dryRun) return new mongoose.Types.ObjectId();
    const [created] = await Model.create([{ ...doc, organizationId: this.organizationId }]);
    return created._id;
  }

  async preload() {
    const org = { organizationId: this.organizationId };
    const [contacts, products, leads, members] = await Promise.all([
      Contact.find(org).select('name company email phoneE164 legacyIds lifecycle'),
      Product.find({ ...org, legacyIds: { $exists: true } }).select('legacyIds'),
      Lead.find(org).select('legacyIds contactId title').populate({ path: 'contactId', select: 'name' }),
      OrganizationMember.find({ ...org, status: 'active' }).populate({ path: 'userId', select: 'name' }),
    ]);
    contacts.forEach((contact) => this.indexContact(contact._id, contact));
    products.forEach((product) => product.legacyIds.forEach((id) => this.ids.products.set(id, product._id)));
    leads.forEach((lead) => {
      const contactId = lead.contactId?._id || lead.contactId;
      (lead.legacyIds || []).forEach((id) => this.ids.leads.set(id, lead._id));
      this.leadContact.set(String(lead._id), contactId);
      if (lead.contactId?.name) this.leadByName.set(lower(lead.contactId.name), lead._id);
      if (lead.title) this.dealByTitle.set(lower(lead.title), lead._id);
    });
    members.forEach((member) => {
      [member.displayName, member.userId?.name].filter(Boolean).forEach((name) => this.memberByName.set(lower(name), member._id));
    });
  }

  indexContact(id, { name, company, email, phoneE164, legacyIds }) {
    if (phoneE164) this.contactByPhone.set(phoneE164, id);
    if (email) this.contactByEmail.set(lower(email), id);
    if (name) this.contactByNameCompany.set(`${lower(name)}|${lower(company)}`, id);
    if (name && !this.contactByName.has(lower(name))) this.contactByName.set(lower(name), id);
    (legacyIds || []).forEach((legacyId) => this.ids.contacts.set(legacyId, id));
  }

  // Same phone, else same email, else (for deals, which have no phone) same name + company.
  findContact({ phoneE164, email, name, company }, { byName = false } = {}) {
    if (phoneE164 && this.contactByPhone.has(phoneE164)) return this.contactByPhone.get(phoneE164);
    if (email && this.contactByEmail.has(lower(email))) return this.contactByEmail.get(lower(email));
    if (byName && name) return this.contactByNameCompany.get(`${lower(name)}|${lower(company)}`) || null;
    return null;
  }

  // Finds or creates a contact. Returns { id, created }.
  async upsertContact(input, { legacyId, lifecycle = 'lead', byName = false } = {}) {
    const phoneE164 = normalizePhone(input.phone) || undefined;
    const data = {
      name: str(input.name, 200) || str(input.company, 200) || str(input.email, 200) || 'Unnamed contact',
      email: lower(input.email).slice(0, 254),
      phone: str(input.phone, 30),
      phoneE164,
      company: str(input.company, 200),
      address: str(input.address),
      notes: str(input.notes, 5000),
      status: input.status === 'Inactive' ? 'Inactive' : 'Active',
      productIds: input.productIds || [],
    };
    const existing = this.findContact(data, { byName });
    if (existing) {
      if (!this.dryRun) {
        const update = { ...(legacyId && { $addToSet: { legacyIds: legacyId } }) };
        if (lifecycle === 'customer') Object.assign(update, { $set: { lifecycle: 'customer' } });
        if (Object.keys(update).length) await Contact.updateOne({ _id: existing, organizationId: this.organizationId }, update);
      }
      if (legacyId) this.ids.contacts.set(legacyId, existing);
      return { id: existing, created: false };
    }
    const id = await this.insert(Contact, {
      ...data,
      lifecycle,
      becameCustomerAt: lifecycle === 'customer' ? new Date() : undefined,
      source: 'Import',
      ownerId: this.req.member._id,
      legacyIds: legacyId ? [legacyId] : undefined,
      createdById: this.req.user._id,
    });
    this.indexContact(id, { ...data, legacyIds: legacyId ? [legacyId] : [] });
    return { id, created: true };
  }

  async importProducts(list) {
    const section = this.section('products');
    for (const item of list) {
      section.found += 1;
      if (this.ids.products.has(item.id)) { section.alreadyImported += 1; continue; }
      if (!str(item.name)) { this.reject(section, item.id, 'Product has no name'); continue; }
      const id = await this.insert(Product, {
        name: str(item.name, 200),
        category: str(item.category, 100),
        description: str(item.description, 2000),
        pricePaise: rupeesToPaise(item.basePrice ?? item.price) ?? 0,
        gstRatePct: Math.min(Math.max(Number(item.gstPercentage ?? item.gst) || 0, 0), 100),
        stockQty: nonNegativeInt(item.quantity),
        legacyIds: item.id ? [String(item.id)] : undefined,
        createdById: this.req.user._id,
        createdAt: validDate(item.createdAt),
      });
      if (item.id) this.ids.products.set(String(item.id), id);
      section.created += 1;
    }
  }

  async importContacts(list, name, lifecycleOf) {
    const section = this.section(name);
    for (const item of list) {
      section.found += 1;
      if (item.id && this.ids.contacts.has(item.id)) { section.alreadyImported += 1; continue; }
      if (!str(item.name) && !str(item.email) && !str(item.phone)) { this.reject(section, item.id, 'No name, email or phone'); continue; }
      if (str(item.phone) && normalizePhone(item.phone) === null) this.unresolved(`${name} "${str(item.name, 60)}": phone "${str(item.phone, 30)}" was kept as text but is not a valid number`);
      const productId = item.product ? this.ids.products.get(item.product) : undefined;
      const { created } = await this.upsertContact(
        { ...item, company: item.company || (name === 'accounts' ? item.name : ''), productIds: productId ? [productId] : [] },
        { legacyId: item.id ? String(item.id) : undefined, lifecycle: lifecycleOf(item) },
      );
      section[created ? 'created' : 'merged'] += 1;
    }
  }

  ownerFor(name) {
    const id = name && this.memberByName.get(lower(name));
    if (name && !id) this.unresolved(`Owner "${str(name, 60)}" is not a team member yet; the record is assigned to you`);
    return id || this.req.member._id;
  }

  async createLead(doc, { legacyId, activities = [], contactName }) {
    const stage = doc.stage;
    const leadDoc = {
      ...doc,
      probability: STAGE_PROBABILITY[stage],
      lostReason: stage === 'Lost' ? IMPORTED_LOST_REASON : '',
      convertedAt: stage === 'Won' ? (doc.updatedAt || new Date()) : undefined,
      source: 'Import',
      legacyIds: legacyId ? [legacyId] : undefined,
      lastActivityAt: new Date(),
      createdById: this.req.user._id,
    };
    const id = await this.insert(Lead, leadDoc);
    if (stage === 'Won' && !this.dryRun) {
      await Contact.updateOne({ _id: doc.contactId, organizationId: this.organizationId, lifecycle: { $ne: 'customer' } }, { $set: { lifecycle: 'customer', becameCustomerAt: new Date() } });
    }
    for (const activity of [{ type: 'Imported', text: 'Imported from the browser' }, ...activities]) {
      await this.insert(LeadActivity, { leadId: id, contactId: doc.contactId, actorUserId: this.req.user._id, ...activity });
    }
    if (legacyId) this.ids.leads.set(legacyId, id);
    this.leadContact.set(String(id), doc.contactId);
    if (contactName) this.leadByName.set(lower(contactName), id);
    if (doc.title) this.dealByTitle.set(lower(doc.title), id);
    return id;
  }

  async importLeads(list) {
    const section = this.section('leads');
    for (const item of list) {
      section.found += 1;
      if (item.id && this.ids.leads.has(item.id)) { section.alreadyImported += 1; continue; }
      if (!str(item.name) && !str(item.email) && !str(item.phone)) { this.reject(section, item.id, 'Lead has no name, email or phone'); continue; }
      const convertedContact = item.convertedCustomerId && this.ids.contacts.get(item.convertedCustomerId);
      const contactId = convertedContact || (await this.upsertContact(item)).id;
      const stage = LEAD_STAGE_MAP[item.status] || 'New';
      if (item.status && !LEAD_STAGE_MAP[item.status]) this.unresolved(`Lead "${str(item.name, 60)}": status "${str(item.status, 30)}" became New`);
      const productId = item.product ? this.ids.products.get(item.product) : undefined;
      if (item.product && !productId) this.unresolved(`Lead "${str(item.name, 60)}": its product no longer exists`);
      await this.createLead({
        contactId,
        stage,
        productId,
        quantity: nonNegativeInt(item.quantity),
        expectedValuePaise: rupeesToPaise(item.value) ?? undefined,
        followUpAt: validDate(item.followUp),
        notes: str(item.notes, 5000),
        noteEntries: (Array.isArray(item.noteEntries) ? item.noteEntries : []).slice(0, 200).map((note, index) => ({
          id: str(note.id, 60) || `imported-${index}`, title: str(note.title, 200), text: str(note.text, 5000), createdAt: validDate(note.createdAt) || new Date(),
        })),
        ownerId: this.req.member._id,
        createdAt: validDate(item.createdAt),
      }, { legacyId: item.id ? String(item.id) : undefined, contactName: item.name });
      section.created += 1;
    }
  }

  async importDeals(list) {
    const section = this.section('deals');
    for (const item of list) {
      section.found += 1;
      if (item.id && this.ids.leads.has(item.id)) { section.alreadyImported += 1; continue; }
      if (!str(item.name) && !str(item.account) && !str(item.contact)) { this.reject(section, item.id, 'Deal has no name, account or contact'); continue; }
      const convertedContact = item.convertedCustomerId && this.ids.contacts.get(item.convertedCustomerId);
      const contactId = convertedContact || (await this.upsertContact({ name: item.contact || item.account || item.name, company: item.account }, { byName: true })).id;
      const stage = DEAL_STAGE_MAP[item.stage] || 'New';
      const timeline = (Array.isArray(item.notes) ? item.notes : []).slice(0, 200).map((note) => ({
        type: 'Note', text: str(note.text, 5000), actorName: str(note.author, 100), createdAt: validDate(note.at),
      }));
      await this.createLead({
        contactId,
        title: str(item.name, 200),
        stage,
        expectedValuePaise: rupeesToPaise(item.value) ?? undefined,
        expectedCloseDate: validDate(item.closeDate),
        ownerId: this.ownerFor(item.owner),
        createdAt: validDate(item.createdAt),
      }, { legacyId: item.id ? String(item.id) : undefined, activities: timeline, contactName: item.contact || item.account });
      section.created += 1;
    }
  }

  async importLeadActivities(list) {
    const section = this.section('leadActivities');
    const existing = this.dryRun ? new Set() : new Set((await LeadActivity.find({ organizationId: this.organizationId, legacyIds: { $exists: true } }).select('legacyIds')).flatMap((activity) => activity.legacyIds));
    for (const item of list) {
      section.found += 1;
      if (item.id && existing.has(item.id)) { section.alreadyImported += 1; continue; }
      const leadId = this.ids.leads.get(item.leadId);
      if (!leadId) { this.reject(section, item.id, 'Its lead was not imported'); continue; }
      await this.insert(LeadActivity, {
        leadId,
        contactId: this.leadContact.get(String(leadId)),
        type: str(item.type, 40) || 'Note',
        text: str(item.text, 5000),
        actorUserId: this.req.user._id,
        legacyIds: item.id ? [String(item.id)] : undefined,
        createdAt: validDate(item.createdAt),
      });
      section.created += 1;
    }
  }

  async importQuotations(list) {
    const section = this.section('quotations');
    const existing = this.dryRun ? new Set() : new Set((await Quotation.find({ organizationId: this.organizationId, legacyIds: { $exists: true } }).select('legacyIds')).flatMap((quotation) => quotation.legacyIds));
    for (const item of list) {
      section.found += 1;
      if (item.id && existing.has(item.id)) { section.alreadyImported += 1; continue; }
      const leadId = this.ids.leads.get(item.leadId);
      if (!leadId) { this.reject(section, item.id, 'Its lead was not imported'); continue; }
      const items = (Array.isArray(item.items) ? item.items : []).slice(0, 100).map((line) => computeItem({
        productId: line.productId ? this.ids.products.get(line.productId) : undefined,
        quantity: Number(line.quantity) || 1,
        unitPricePaise: rupeesToPaise(line.unitPrice) ?? 0,
        discountPaise: rupeesToPaise(line.discount) ?? 0,
        taxRatePct: Math.min(Math.max(Number(line.tax) || 0, 0), 100),
      }));
      if (!items.length) { this.reject(section, item.id, 'Quotation has no items'); continue; }
      const numbering = this.dryRun ? { number: 'preview', financialYear: '' } : await nextNumber(this.organizationId);
      await this.insert(Quotation, {
        ...numbering,
        leadId,
        contactId: this.leadContact.get(String(leadId)),
        ownerId: this.req.member._id,
        status: ['Draft', 'Sent', 'Viewed', 'Accepted', 'Rejected', 'Expired'].includes(item.status) ? item.status : 'Draft',
        quotationDate: validDate(item.quotationDate) || new Date(),
        validUntil: validDate(item.validUntil),
        items,
        totals: totalsOf(items),
        legacyNumber: str(item.quotationNumber || item.number, 60),
        legacyIds: item.id ? [String(item.id)] : undefined,
        createdById: this.req.user._id,
      });
      section.created += 1;
    }
  }

  // Assignee names become team members when they match one; otherwise the name is kept.
  assigneeFor(name) {
    const clean = str(name, 100);
    if (!clean) return { assigneeId: undefined, assigneeName: '' };
    const id = this.memberByName.get(lower(clean));
    if (id) return { assigneeId: id, assigneeName: '' };
    if (!this.reportedAssignees.has(lower(clean))) {
      this.reportedAssignees.add(lower(clean));
      this.unresolved(`Assignee "${clean}" is not a team member yet; the name is kept on their tasks and events`);
    }
    return { assigneeId: undefined, assigneeName: clean };
  }

  relatedFor(type, name) {
    const relatedType = RELATED_TYPES.includes(type) ? type : '';
    const relatedName = relatedType ? str(name, 200) : '';
    if (!relatedType || !relatedName) return { relatedType: relatedName ? relatedType : '', relatedName, relatedId: undefined };
    const key = lower(relatedName);
    const index = { Customer: this.contactByName, Contact: this.contactByName, Lead: this.leadByName, Deal: this.dealByTitle }[relatedType];
    return { relatedType, relatedName, relatedId: index ? index.get(key) : undefined };
  }

  async existingLegacyIds(Model) {
    if (this.dryRun) return new Set();
    const docs = await Model.find({ organizationId: this.organizationId, legacyIds: { $exists: true } }).select('legacyIds');
    return new Set(docs.flatMap((doc) => doc.legacyIds));
  }

  // crm_tasks, and crm_deal_tasks (the quick follow-ups on the Deals page: { text, done, due }).
  async importTasks(list, name, { followUps = false } = {}) {
    const section = this.section(name);
    const existing = await this.existingLegacyIds(Task);
    for (const item of list) {
      section.found += 1;
      if (item.id && existing.has(String(item.id))) { section.alreadyImported += 1; continue; }
      const title = str(followUps ? item.text : item.title, 300);
      if (!title) { this.reject(section, item.id, 'Task has no title'); continue; }
      const status = followUps ? (item.done ? 'Done' : 'To Do') : (TASK_STATUSES.includes(item.status) ? item.status : 'To Do');
      await this.insert(Task, {
        title,
        description: str(item.description, 5000),
        ...this.assigneeFor(item.assignee),
        dueDate: calendarDay(followUps ? item.due : item.dueDate),
        priority: TASK_PRIORITIES.includes(item.priority) ? item.priority : 'Medium',
        status,
        completedAt: status === 'Done' ? validDate(item.completedAt) || new Date() : undefined,
        ...this.relatedFor(item.relatedType, item.relatedName),
        origin: followUps ? 'deal_followup' : 'manual',
        legacyIds: item.id ? [String(item.id)] : undefined,
        createdById: this.req.user._id,
        createdByMemberId: this.req.member._id,
        createdAt: validDate(item.createdAt),
      });
      section.created += 1;
    }
  }

  async importEvents(list) {
    const section = this.section('events');
    const existing = await this.existingLegacyIds(CalendarEvent);
    for (const item of list) {
      section.found += 1;
      if (item.id && existing.has(String(item.id))) { section.alreadyImported += 1; continue; }
      const title = str(item.title, 300);
      const date = calendarDay(item.date);
      if (!title || !date) { this.reject(section, item.id, 'Event needs a title and a date'); continue; }
      const startTime = clockTime(item.startTime);
      const endTime = startTime && clockTime(item.endTime) > startTime ? clockTime(item.endTime) : '';
      await this.insert(CalendarEvent, {
        title,
        type: EVENT_TYPES.includes(item.type) ? item.type : 'Meeting',
        date,
        startTime,
        endTime,
        ...this.assigneeFor(item.assignee),
        ...this.relatedFor(item.relatedType, item.relatedName),
        description: str(item.description, 5000),
        legacyIds: item.id ? [String(item.id)] : undefined,
        createdById: this.req.user._id,
        createdByMemberId: this.req.member._id,
        createdAt: validDate(item.createdAt),
      });
      section.created += 1;
    }
  }

  async run(data) {
    await this.preload();
    const list = (key) => readList(data, key, this.report);
    await this.importProducts(list('crm_products'));
    await this.importContacts(list('crm_customers'), 'customers', () => 'customer');
    await this.importContacts(list('crm_accounts'), 'accounts', (account) => (account.status === 'Customer' ? 'customer' : 'lead'));
    await this.importLeads(list('crm_leads'));
    await this.importDeals(list('crm_deals'));
    await this.importLeadActivities(list('crm_lead_activities'));
    await this.importQuotations(list('crm_quotations'));
    await this.importTasks(list('crm_tasks'), 'tasks');
    await this.importTasks(list('crm_deal_tasks'), 'dealFollowUps', { followUps: true });
    await this.importEvents(list('crm_calendar_events'));
    for (const key of LATER_KEYS) {
      const count = list(key).length;
      if (count) this.report.later[key] = count;
    }
    return this.report;
  }
}

async function importLocalStorage(req, { data, dryRun }) {
  const keys = Object.keys(data || {});
  if (!keys.some((key) => SUPPORTED_KEYS.includes(key) || LATER_KEYS.includes(key))) {
    throw httpError(400, 'VALIDATION_ERROR', 'No CRM data found. Open this page in the browser where you used the CRM before.');
  }
  const record = await Import.create({ organizationId: req.tenant.organizationId, dryRun, createdById: req.user._id });
  try {
    const report = await new ImportRun(req, dryRun).run(data);
    record.status = 'completed';
    record.report = report;
    await record.save();
    if (!dryRun) await audit(req, { action: 'import.localstorage', entityType: 'Import', entityId: record._id });
    return { id: record._id, status: record.status, report };
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    await record.save();
    throw error;
  }
}

async function get(req, id) {
  const record = await Import.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!record) throw httpError(404, 'NOT_FOUND', 'Import not found');
  return { id: record._id, dryRun: record.dryRun, status: record.status, report: record.report, error: record.error, createdAt: record.createdAt };
}

module.exports = { importLocalStorage, get, SUPPORTED_KEYS, LATER_KEYS };
