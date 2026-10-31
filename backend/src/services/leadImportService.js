const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const LeadStageEvent = require('../models/LeadStageEvent');
const OrganizationMember = require('../models/OrganizationMember');
const PrivateNumber = require('../models/PrivateNumber');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { parseCsv } = require('../utils/csv');
const xlsx = require('../utils/xlsx');
const { normalizePhone } = require('../utils/phone');
const { LEAD_SOURCES, OPEN_STAGES, STAGE_PROBABILITY, LEAD_IMPORT_FIELDS } = require('../constants/crm');
const { isManager } = require('../constants/permissions');
const planService = require('./planService');
const pipelineService = require('./pipelineService');
const customFieldService = require('./customFieldService');
const automationEvents = require('./automation/events');

// Leads from a CSV or Excel file (G1, D105). Each row is a lead for a customer — found by phone,
// else email, or added — with its title, stage (a fixed stage, a common word for it, or the
// pipeline's own stage name), owner (a teammate's email or name), value (₹, Indian numbers,
// lakh, crore), source, expected close date, notes and the company's own lead fields. A customer
// who already has an open lead gets no second open one (unless asked); Won and Lost rows are
// history and always added. Private numbers (D61), blocked customers (D103) and numbers of
// deleted customers are left out. No automation runs unless "Run automations too" is ticked (as
// for bulk stage changes, D100). Everything is written in bulk; a dry run reports without saving.
const MAX_ROWS = 5000;
const REPORT_LIMIT = 200;
const MAX_VALUE_RUPEES = 1e11;
const FIELDS = LEAD_IMPORT_FIELDS;
const GUESSES = {
  name: ['name', 'full name', 'customer', 'customer name', 'contact', 'contact name', 'contact person', 'naam', 'party', 'party name', 'client', 'client name', 'lead name'],
  phone: ['phone', 'mobile', 'mobile no', 'mobile number', 'phone number', 'phone no', 'whatsapp', 'whatsapp number', 'contact number', 'number', 'cell'],
  email: ['email', 'e mail', 'email id', 'mail', 'email address'],
  company: ['company', 'company name', 'firm', 'firm name', 'business', 'shop', 'organisation', 'organization'],
  city: ['city', 'town', 'district', 'location'],
  state: ['state', 'region'],
  tags: ['tags', 'tag', 'labels', 'group', 'groups'],
  title: ['title', 'lead title', 'deal', 'deal name', 'opportunity', 'requirement', 'enquiry', 'inquiry', 'product', 'subject', 'interest'],
  stage: ['stage', 'status', 'lead status', 'lead stage', 'deal stage', 'pipeline stage'],
  owner: ['owner', 'lead owner', 'assigned to', 'assignee', 'salesperson', 'sales person', 'sales executive', 'executive', 'agent', 'rep', 'handled by'],
  value: ['value', 'deal value', 'lead value', 'amount', 'expected value', 'budget', 'deal amount', 'order value', 'price'],
  source: ['source', 'lead source', 'channel'],
  closeDate: ['close date', 'expected close date', 'closing date', 'expected close', 'expected closing'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comment', 'comments', 'description', 'details'],
  lostReason: ['lost reason', 'reason lost', 'reason for loss', 'loss reason'],
};
// What people write for the fixed stages (the Hindi words are the CRM's own, i18n stage.*).
const STAGE_WORDS = {
  New: ['new', 'new lead', 'fresh', 'open', 'not contacted', 'untouched', 'नई', 'naya', 'nayi'],
  Contacted: ['contacted', 'called', 'in touch', 'follow up', 'followup', 'qualified', 'interested', 'warm', 'in progress', 'working', 'संपर्क हुआ'],
  'Quote Sent': ['quote sent', 'quotation sent', 'quoted', 'quote', 'quotation', 'proposal', 'proposal sent', 'कोटेशन भेजा'],
  Negotiation: ['negotiation', 'negotiating', 'discussion', 'in discussion', 'बातचीत जारी'],
  Won: ['won', 'closed won', 'converted', 'order', 'order received', 'sale', 'sold', 'deal done', 'जीती'],
  Lost: ['lost', 'closed lost', 'dead', 'junk', 'not interested', 'rejected', 'cancelled', 'canceled', 'हारी'],
};
const SOURCE_WORDS = {
  WhatsApp: ['whatsapp', 'wa'],
  IndiaMART: ['indiamart', 'india mart', 'im'],
  JustDial: ['justdial', 'just dial', 'jd'],
  TradeIndia: ['tradeindia', 'trade india'],
  Facebook: ['facebook', 'fb', 'instagram', 'meta'],
  'Google Ads': ['google', 'google ads', 'adwords'],
  Website: ['website', 'web', 'site', 'web form'],
  Manual: ['manual', 'walk in', 'walkin', 'reference', 'referral', 'call', 'phone call'],
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const { loose } = customFieldService;
const blank = (row) => !row.some((cell) => String(cell ?? '').trim());
const words = (map) => new Map(Object.entries(map).flatMap(([key, list]) => [key, ...list].map((word) => [loose(word), key])));
const STAGES_BY_WORD = words(STAGE_WORDS);
const SOURCES_BY_WORD = words({ ...SOURCE_WORDS, ...Object.fromEntries(LEAD_SOURCES.map((s) => [s, SOURCE_WORDS[s] || []])) });

function readFile(file) {
  if (!file) throw httpError(400, 'VALIDATION_ERROR', 'Choose a CSV or Excel file.', [{ field: 'file', code: 'FILE_REQUIRED', message: 'Choose a CSV or Excel file.' }]);
  const name = String(file.originalname || '').toLowerCase();
  if (/\.(xls|ods)$/.test(name)) {
    throw httpError(400, 'UNSUPPORTED_FILE', 'This is an older spreadsheet type. In Excel use File → Save as → "Excel Workbook (.xlsx)" or "CSV UTF-8", then import that file.');
  }
  const rows = name.endsWith('.xlsx') ? xlsx.read(file.buffer).rows : parseCsv(file.buffer.toString('utf8'));
  // Empty rows (often at the end of a sheet) are passed over; the others keep their row numbers.
  const filled = rows.slice(1).filter((row) => !blank(row)).length;
  if (rows.length < 2 || !filled) throw httpError(400, 'EMPTY_FILE', 'The file needs a header row and at least one lead.');
  if (filled > MAX_ROWS) throw httpError(400, 'TOO_MANY_ROWS', `Import at most ${MAX_ROWS.toLocaleString('en-IN')} leads at a time (this file has ${filled.toLocaleString('en-IN')}).`);
  return { headers: rows[0], data: rows.slice(1), filled };
}

// Column index → field, from the header names (each field once); a column left over goes to a
// lead field of the company with the same name or key.
function suggestMapping(headers, customTargets = []) {
  const taken = new Set();
  const guesses = Object.fromEntries(Object.entries(GUESSES).map(([field, list]) => [field, list.map(loose)]));
  const mapping = headers.map((header) => {
    const name = loose(header);
    const field = FIELDS.find((f) => !taken.has(f) && (guesses[f].includes(name) || name === loose(f)));
    if (field) taken.add(field);
    return field || '';
  });
  return mapping.map((field, index) => {
    if (field) return field;
    const name = loose(headers[index]);
    const target = customTargets.find((t) => !taken.has(t.value) && name && (loose(t.label) === name || loose(t.key) === name));
    if (target) taken.add(target.value);
    return target ? target.value : '';
  });
}

// The company's active lead fields as import targets: those this member may change (D77).
async function customTargetsOf(req) {
  const fields = await customFieldService.fieldsEditableBy(req, 'lead');
  return fields
    .filter((field) => field.status === 'active' && field.type !== 'lookup')
    .sort((a, b) => a.order - b.order)
    .map((field) => ({ value: `cf:${field.key}`, key: field.key, label: field.label, type: field.type }));
}

// POST /leads/import/preview — the columns, five rows, the guessed mapping and the choices.
async function preview(req, file) {
  const { headers, data, filled } = readFile(file);
  const customTargets = await customTargetsOf(req);
  const pipelines = await pipelineService.pipelinesOf(req.tenant.organizationId);
  return {
    headers,
    rows: data.filter((row) => !blank(row)).slice(0, 5),
    totalRows: filled,
    mapping: suggestMapping(headers, customTargets),
    fields: FIELDS,
    customFields: customTargets.map(({ value, label, type }) => ({ value, label, type })),
    pipelines: pipelines.map((p) => ({ id: p._id, name: p.name, isDefault: Boolean(p.isDefault), stages: p.stages.map((s) => s.name) })),
    canChooseOwners: isManager(req.member),
  };
}

// "₹1,20,000", "1.2 lakh", "2.5L", "1 crore", "50k", "Rs. 99.50/-" → rupees; NaN when not a sum.
function rupeesOf(raw) {
  if (typeof raw === 'number') return raw >= 0 ? raw : NaN;
  const text = String(raw ?? '').trim().toLowerCase()
    .replace(/^(₹|rs\.?|inr)\s*/, '').replace(/\s*\/-$/, '').replace(/,/g, '').replace(/\s+/g, ' ');
  const match = /^(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|l|crores?|cr|k|thousand)?$/.exec(text);
  if (!match) return NaN;
  const unit = match[2] || '';
  const times = /^(lakh|lac|l)/.test(unit) ? 1e5 : /^(crore|cr)/.test(unit) ? 1e7 : /^(k|thousand)/.test(unit) ? 1e3 : 1;
  return Number(match[1]) * times;
}

// The team, to find a lead's owner by email, full name or (when only one has it) first name.
async function teamOf(organizationId) {
  const members = await OrganizationMember.find({ organizationId, status: 'active' }).select('displayName userId').populate({ path: 'userId', select: 'name email' }).lean();
  const byEmail = new Map();
  const byName = new Map();
  const add = (map, key, member) => {
    if (!key) return;
    map.set(key, map.has(key) && String(map.get(key)._id) !== String(member._id) ? 'ambiguous' : member);
  };
  for (const member of members) {
    const email = String(member.userId?.email || '').toLowerCase();
    if (email) byEmail.set(email, member);
    for (const name of new Set([member.displayName, member.userId?.name].map(loose).filter(Boolean))) {
      add(byName, name, member);
      add(byName, `first:${name.split(' ')[0]}`, member);
    }
  }
  // A member, 'ambiguous' (two teammates share the name) or null.
  const find = (text) => {
    const raw = String(text || '').trim();
    if (!raw) return null;
    return byEmail.get(raw.toLowerCase()) || byName.get(loose(raw)) || byName.get(`first:${loose(raw)}`) || null;
  };
  return { find };
}

// The stage a row asks for, in this pipeline: { kind, stage } (stage: the pipeline's own stage,
// null for Won and Lost), or null when the text is not a stage.
function stageMatcher(pipeline) {
  const byName = new Map(pipeline.stages.map((stage) => [loose(stage.name), stage]));
  return (text) => {
    const name = loose(text);
    if (!name) return { kind: 'New', stage: pipelineService.stageForKind(pipeline, 'New') };
    const own = byName.get(name);
    if (own) return { kind: own.kind, stage: own };
    const kind = STAGES_BY_WORD.get(name);
    if (!kind) return null;
    return { kind, stage: OPEN_STAGES.includes(kind) ? pipelineService.stageForKind(pipeline, kind) : null };
  };
}

// One row → { contact, lead, warnings } or { reject }.
function recordOf(row, mapping, ctx) {
  const value = (field) => {
    const index = mapping.indexOf(field);
    return index === -1 ? '' : String(row[index] ?? '').trim();
  };
  const warnings = [];
  const phoneText = value('phone');
  const phoneE164 = normalizePhone(phoneText);
  if (phoneE164 === null) return { reject: `"${phoneText}" is not a phone number` };
  const emailText = value('email').toLowerCase();
  const email = EMAIL.test(emailText) ? emailText : '';
  if (emailText && !email) warnings.push(`email "${emailText}" was left out`);
  if (!phoneE164 && !email) return { reject: 'no phone number or email' };

  const sourceText = value('source');
  const source = sourceText ? SOURCES_BY_WORD.get(loose(sourceText)) : '';
  if (sourceText && !source) warnings.push(`source "${sourceText}" is not one the CRM knows: kept as Import`);

  let stage = ctx.matchStage(value('stage'));
  if (!stage) {
    warnings.push(`stage "${value('stage')}" is not a stage: the lead is New`);
    stage = ctx.matchStage('');
  }
  let lostReason = '';
  if (stage.kind === 'Lost') lostReason = (value('lostReason') || 'Imported as lost').slice(0, 500);

  let ownerId = ctx.defaultOwnerId;
  const ownerText = value('owner');
  if (ownerText && ctx.manager) {
    const member = ctx.team.find(ownerText);
    if (member && member !== 'ambiguous') ownerId = member._id;
    else warnings.push(`owner "${ownerText}" ${member === 'ambiguous' ? 'matches more than one teammate' : 'is not in the team'}: ${ctx.fallbackText}`);
  }

  let expectedValuePaise;
  const valueText = value('value');
  if (valueText) {
    const rupees = rupeesOf(valueText);
    if (Number.isFinite(rupees) && rupees <= MAX_VALUE_RUPEES) expectedValuePaise = Math.round(rupees * 100);
    else warnings.push(`value "${valueText}" is not an amount: left out`);
  }
  let expectedCloseDate;
  const dateText = value('closeDate');
  if (dateText) {
    const iso = customFieldService.readDate(dateText);
    if (iso) expectedCloseDate = new Date(iso);
    else warnings.push(`close date "${dateText}" is not a date (use 20/11/2026 or 2026-11-20): left out`);
  }

  const customFields = {};
  let leftOut = 0;
  mapping.forEach((target, index) => {
    const field = target.startsWith('cf:') && mapping.indexOf(target) === index ? ctx.customFields.get(target.slice(3)) : null;
    if (!field) return;
    const read = customFieldService.readImportValue(field, row[index]);
    if (read.warning) warnings.push(read.warning);
    if (read.warning && read.value === undefined) leftOut += 1;
    if (read.value !== undefined) customFields[field.key] = read.value;
  });

  return {
    key: phoneE164 || `email:${email}`,
    contact: {
      name: (value('name') || value('company') || phoneText || email).slice(0, 200),
      phone: phoneText.slice(0, 30),
      phoneE164: phoneE164 || undefined,
      email: email.slice(0, 254),
      company: value('company').slice(0, 200),
      city: value('city').slice(0, 100),
      state: value('state').slice(0, 100),
      tags: value('tags').split(/[,;|]/).map((t) => t.trim().slice(0, 50)).filter(Boolean),
    },
    lead: {
      title: value('title').slice(0, 200),
      stage,
      lostReason,
      source: source || 'Import',
      ownerId,
      expectedValuePaise,
      expectedCloseDate,
      notes: value('notes').slice(0, 5000),
      customFields,
    },
    warnings,
    leftOut,
  };
}

// POST /leads/import — mapping (one target per column), pipelineId?, ownerFallback me | none,
// openLeads skip | add, tags, runAutomations, dryRun → the report.
async function run(req, file, options) {
  const { mapping, pipelineId, ownerFallback = 'me', openLeads = 'skip', tags: extraTags = [], runAutomations = false, dryRun = false } = options;
  const { headers, data, filled } = readFile(file);
  if (mapping.length !== headers.length) throw httpError(400, 'VALIDATION_ERROR', 'The column choices do not match the file; open the file again.');
  if (!mapping.includes('phone') && !mapping.includes('email')) {
    throw httpError(400, 'VALIDATION_ERROR', 'Choose which column has the phone number (or the email).', [{ field: 'mapping', code: 'PHONE_REQUIRED', message: 'Choose which column has the phone number (or the email).' }]);
  }
  const organizationId = req.tenant.organizationId;
  const customFields = new Map((await customFieldService.fieldsEditableBy(req, 'lead')).map((field) => [field.key, field]));
  const unknown = mapping.find((target) => target.startsWith('cf:') && customFields.get(target.slice(3))?.status !== 'active');
  if (unknown) throw httpError(400, 'VALIDATION_ERROR', 'A column goes to a field that no longer exists; open the file again.', [{ field: 'mapping', code: 'UNKNOWN_FIELD', message: unknown }]);
  const pipeline = pipelineId ? await pipelineService.findOwn(req, pipelineId) : await pipelineService.ensureDefault(organizationId);
  const manager = isManager(req.member);
  const team = manager ? await teamOf(organizationId) : null;
  const ctx = {
    manager,
    team,
    customFields,
    matchStage: stageMatcher(pipeline),
    defaultOwnerId: manager && ownerFallback === 'none' ? null : req.member._id,
    fallbackText: manager && ownerFallback === 'none' ? 'left without an owner' : 'given to you',
  };
  const report = {
    totalRows: filled, created: 0, contactsCreated: 0, contactsFound: 0, skippedOpen: 0, rejected: 0, rejectedRows: [], warnings: [], customLeftOut: 0,
    byStage: Object.fromEntries(Object.keys(STAGE_PROBABILITY).map((s) => [s, 0])), valuePaise: 0, pipeline: pipeline.name, ownersIgnored: false, automations: Boolean(runAutomations), dryRun,
  };
  const note = (list, row, text) => {
    if (report[list].length < REPORT_LIMIT) report[list].push({ row, text });
  };
  if (!manager && mapping.includes('owner')) report.ownersIgnored = true; // only owners and admins give leads to others

  // 1. The rows.
  const rows = [];
  data.forEach((row, index) => {
    if (blank(row)) return;
    const rowNumber = index + 2; // as in the spreadsheet (row 1 is the header)
    const parsed = recordOf(row, mapping, ctx);
    if (parsed.reject) {
      report.rejected += 1;
      note('rejectedRows', rowNumber, parsed.reject);
      return;
    }
    parsed.warnings.forEach((w) => note('warnings', rowNumber, w));
    report.customLeftOut += parsed.leftOut;
    rows.push({ ...parsed, rowNumber });
  });

  // 2. Who is already here (deleted customers too: their number cannot be used again), private
  // numbers, and the customers with an open lead.
  const phones = [...new Set(rows.map((r) => r.contact.phoneE164).filter(Boolean))];
  const emails = [...new Set(rows.filter((r) => !r.contact.phoneE164).map((r) => r.contact.email))];
  const [known, privateNumbers] = await Promise.all([
    Contact.find({ organizationId, deletedAt: { $exists: true }, $or: [{ phoneE164: { $in: phones } }, { email: { $in: emails } }] }),
    PrivateNumber.find({ organizationId, phoneE164: { $in: phones } }).select('phoneE164').lean(),
  ]);
  const hidden = new Set(privateNumbers.map((p) => p.phoneE164));
  const byKey = new Map();
  for (const contact of known) {
    if (contact.phoneE164 && phones.includes(contact.phoneE164)) byKey.set(contact.phoneE164, contact);
    else if (contact.email && !byKey.has(`email:${contact.email}`) && !contact.deletedAt) byKey.set(`email:${contact.email}`, contact);
  }
  const liveIds = known.filter((c) => !c.deletedAt).map((c) => c._id);
  const withOpenLead = new Set((await Lead.distinct('contactId', { organizationId, deletedAt: null, contactId: { $in: liveIds }, stage: { $in: OPEN_STAGES } })).map(String));

  // 3. Leads, and the customers to add.
  const now = new Date();
  const newContacts = new Map(); // key → contact document
  const contactUpdates = new Map(); // id → { tags, customer }
  const leads = [];
  const openInFile = new Set();
  for (const row of rows) {
    const { contact, lead, rowNumber, key } = row;
    if (contact.phoneE164 && hidden.has(contact.phoneE164)) {
      report.rejected += 1;
      note('rejectedRows', rowNumber, 'a private number (Settings → WhatsApp): not imported');
      continue;
    }
    const existing = byKey.get(key);
    if (existing?.deletedAt) {
      report.rejected += 1;
      note('rejectedRows', rowNumber, `${existing.name || 'a deleted customer'} had this number and was deleted: restore them first`);
      continue;
    }
    if (existing?.blocked?.at) {
      report.rejected += 1;
      note('rejectedRows', rowNumber, 'the customer is blocked');
      continue;
    }
    const open = OPEN_STAGES.includes(lead.stage.kind);
    const customerKey = existing ? String(existing._id) : key;
    if (open && openLeads === 'skip' && (withOpenLead.has(customerKey) || openInFile.has(customerKey))) {
      report.skippedOpen += 1;
      note('warnings', rowNumber, 'the customer already has an open lead: skipped');
      continue;
    }
    if (open) openInFile.add(customerKey);

    let contactId;
    const tags = [...new Set([...contact.tags, ...extraTags])];
    if (existing) {
      contactId = existing._id;
      const update = contactUpdates.get(String(existing._id)) || { contact: existing, tags: new Set(), customer: false };
      tags.forEach((t) => update.tags.add(t));
      if (lead.stage.kind === 'Won') update.customer = true;
      contactUpdates.set(String(existing._id), update);
    } else if (newContacts.has(key)) {
      const made = newContacts.get(key);
      contactId = made._id;
      made.tags = [...new Set([...made.tags, ...tags])];
      if (lead.stage.kind === 'Won') Object.assign(made, { lifecycle: 'customer', becameCustomerAt: now });
    } else {
      contactId = new mongoose.Types.ObjectId();
      newContacts.set(key, {
        _id: contactId, organizationId, ...contact, tags, source: lead.source, status: 'Active', ownerId: lead.ownerId ?? req.member._id, createdById: req.user._id,
        lifecycle: lead.stage.kind === 'Won' ? 'customer' : 'lead', ...(lead.stage.kind === 'Won' && { becameCustomerAt: now }), consent: { marketing: 'unknown' },
      });
    }
    const { kind, stage } = lead.stage;
    leads.push({
      _id: new mongoose.Types.ObjectId(),
      organizationId,
      contactId,
      title: lead.title,
      stage: kind,
      probability: stage && stage.kind === kind ? stage.probability : STAGE_PROBABILITY[kind],
      lostReason: lead.lostReason,
      source: lead.source,
      ...(lead.expectedValuePaise !== undefined && { expectedValuePaise: lead.expectedValuePaise }),
      ...(lead.expectedCloseDate && { expectedCloseDate: lead.expectedCloseDate }),
      notes: lead.notes,
      ownerId: lead.ownerId,
      pipelineId: pipeline._id,
      // Won and Lost keep the pipeline's last stage, as a lead made by hand (leadService.create).
      pipelineStageId: stage?._id || pipeline.stages[pipeline.stages.length - 1]?._id,
      pipelineStageAt: now,
      stageChangedAt: now,
      ...(kind === 'Won' && { convertedAt: now }),
      lastActivityAt: now,
      createdById: req.user._id,
      ...(Object.keys(lead.customFields).length && { customFields: lead.customFields }),
      openStage: stage, // for the stage history below, not stored
    });
    report.byStage[kind] += 1;
    report.valuePaise += lead.expectedValuePaise || 0;
  }
  report.created = leads.length;
  report.contactsCreated = newContacts.size;
  report.contactsFound = contactUpdates.size;
  report.warnings.sort((a, b) => a.row - b.row); // the notes in the file's order
  if (dryRun || !leads.length) return report;

  // 4. Written together: new customers must fit the plan (the whole file, D81), then the leads,
  // their first stage in the stage history and a note in their activity.
  const fileName = String(file.originalname || 'a file').slice(0, 120);
  await planService.withRoom(organizationId, [['contacts', { adding: newContacts.size, action: 'import leads' }]], async () => {
    if (newContacts.size) {
      try {
        await Contact.insertMany([...newContacts.values()], { ordered: false });
      } catch (error) {
        // Someone added the same number meanwhile: those leads go to that customer.
        if (!(error.writeErrors || []).every((e) => (e.code ?? e.err?.code) === 11000)) throw error;
        const clashing = [...newContacts.values()].filter((c) => c.phoneE164 && !error.insertedDocs?.some((d) => String(d._id) === String(c._id)));
        const found = await Contact.find({ organizationId, phoneE164: { $in: clashing.map((c) => c.phoneE164) } }).select('_id phoneE164');
        const moved = new Map(clashing.map((c) => [String(c._id), found.find((f) => f.phoneE164 === c.phoneE164)?._id]));
        for (const lead of leads) if (moved.has(String(lead.contactId)) && moved.get(String(lead.contactId))) lead.contactId = moved.get(String(lead.contactId));
        report.contactsCreated -= clashing.length;
        report.contactsFound += clashing.length;
      }
    }
    const stored = leads.map(({ openStage, ...lead }) => lead);
    await Lead.insertMany(stored, { ordered: true });
    const actor = { memberId: req.member._id, actorName: req.user.name || '' };
    await LeadStageEvent.insertMany(leads.map((lead) => ({
      organizationId, leadId: lead._id, pipelineId: pipeline._id, pipelineName: pipeline.name,
      from: { stageId: null, name: '', kind: '' },
      to: lead.openStage && OPEN_STAGES.includes(lead.stage) ? { stageId: lead.openStage._id, name: lead.openStage.name, kind: lead.stage } : { stageId: null, name: lead.stage, kind: lead.stage },
      at: now, msInFrom: null, ...actor, source: 'create',
    })));
    await LeadActivity.insertMany(leads.map((lead) => ({
      organizationId, leadId: lead._id, contactId: lead.contactId, type: 'Lead created', text: `Imported from ${fileName}`,
      actorUserId: req.user._id, actorName: req.user.name || '', meta: { import: true },
    })));
  }, { leaseMs: 120000 });

  // Customers already here: the file's tags, and customers again when a Won lead came in.
  const updates = [];
  for (const [id, { contact, tags, customer }] of contactUpdates) {
    const newTags = [...tags].filter((t) => !(contact.tags || []).some((x) => x.toLowerCase() === t.toLowerCase()));
    const set = customer && contact.lifecycle !== 'customer' ? { lifecycle: 'customer', becameCustomerAt: now } : null;
    if (newTags.length || set) updates.push({ updateOne: { filter: { _id: id }, update: { ...(set && { $set: set }), ...(newTags.length && { $addToSet: { tags: { $each: newTags } } }) } } });
  }
  if (updates.length) await Contact.bulkWrite(updates, { ordered: false });

  await audit(req, { action: 'leads.imported', entityType: 'Lead', changes: { created: report.created, contactsCreated: report.contactsCreated, rows: filled, file: fileName, automations: Boolean(runAutomations) } });
  if (runAutomations) {
    for (const lead of leads) {
      automationEvents.emit('lead.created', { organizationId, leadId: lead._id, contactId: lead.contactId, source: lead.source, key: `lead.created:${lead._id}` }, req);
    }
  }
  return report;
}

module.exports = { preview, run, suggestMapping, rupeesOf, FIELDS, MAX_ROWS };
