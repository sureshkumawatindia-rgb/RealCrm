const Contact = require('../models/Contact');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { parseCsv } = require('../utils/csv');
const xlsx = require('../utils/xlsx');
const { normalizePhone } = require('../utils/phone');
const { normalizeGstin, stateCodeFromGstin } = require('../utils/gstin');
const { LEAD_SOURCES } = require('../constants/crm');
const { visibilityFilter, resolveOwnerId } = require('./access');
const planService = require('./planService');
const customFieldService = require('./customFieldService');
const consentHistory = require('./consentService');

// Customers from a CSV file (Phase 7): the person maps the file's columns to CRM fields, phones
// become +91… numbers, and nobody is added twice — rows of the same file with the same phone
// (or email) merge, and someone already in the CRM is updated (blank fields filled, tags added)
// or left alone. "Agreed to WhatsApp offers" marks everyone imported as opted in, but never
// someone who opted out (D35). A dry run reports without saving.
// The company's own fields (D74) are targets too ("cf:<key>"): read forgivingly (Indian numbers and
// dates, a dropdown choice by name), only filling a field someone already in the CRM has empty,
// never stopped by a required field; a value that cannot be read is left out with a warning.
const MAX_ROWS = 10000;
const REPORT_LIMIT = 200;
const FIELDS = ['name', 'phone', 'email', 'company', 'gstin', 'state', 'city', 'address', 'tags', 'source', 'notes'];
const GUESSES = {
  name: ['name', 'full name', 'customer', 'customer name', 'contact', 'contact name', 'naam', 'party', 'party name'],
  phone: ['phone', 'mobile', 'mobile no', 'mobile number', 'phone number', 'phone no', 'whatsapp', 'whatsapp number', 'contact number', 'number', 'cell'],
  email: ['email', 'e-mail', 'email id', 'mail'],
  company: ['company', 'company name', 'firm', 'firm name', 'business', 'shop', 'organisation', 'organization'],
  gstin: ['gstin', 'gst', 'gst no', 'gst number', 'gstin no'],
  state: ['state', 'region'],
  city: ['city', 'town', 'district'],
  address: ['address', 'full address'],
  tags: ['tags', 'tag', 'labels', 'group', 'groups', 'tier', 'segment'],
  source: ['source', 'lead source'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comment', 'comments'],
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const label = (header) => String(header || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function readFile(file) {
  if (!file) throw httpError(400, 'VALIDATION_ERROR', 'Choose a CSV or Excel file.', [{ field: 'file', code: 'FILE_REQUIRED', message: 'Choose a CSV or Excel file.' }]);
  const name = String(file.originalname || '').toLowerCase();
  if (/\.(xls|ods)$/.test(name)) {
    throw httpError(400, 'UNSUPPORTED_FILE', 'This is an older spreadsheet type. In Excel use File → Save as → "Excel Workbook (.xlsx)" or "CSV UTF-8", then import that file.');
  }
  // Excel (D82): the first sheet, read like a CSV (dates as YYYY-MM-DD).
  const rows = name.endsWith('.xlsx') ? xlsx.read(file.buffer).rows : parseCsv(file.buffer.toString('utf8'));
  if (rows.length < 2) throw httpError(400, 'EMPTY_FILE', 'The file needs a header row and at least one customer.');
  if (rows.length - 1 > MAX_ROWS) throw httpError(400, 'TOO_MANY_ROWS', `Import at most ${MAX_ROWS.toLocaleString('en-IN')} customers at a time (this file has ${(rows.length - 1).toLocaleString('en-IN')}).`);
  return { headers: rows[0], data: rows.slice(1) };
}

// Column index → field, from the header names (each field once). The built-in fields first; a
// column left over goes to a custom field with the same name or key.
function suggestMapping(headers, customTargets = []) {
  const taken = new Set();
  const mapping = headers.map((header) => {
    const name = label(header);
    const field = FIELDS.find((f) => !taken.has(f) && (GUESSES[f].map(label).includes(name) || name === f));
    if (field) taken.add(field);
    return field || '';
  });
  return mapping.map((field, index) => {
    if (field) return field;
    const name = customFieldService.loose(headers[index]);
    const target = customTargets.find((t) => !taken.has(t.value) && name && (customFieldService.loose(t.label) === name || customFieldService.loose(t.key) === name));
    if (target) taken.add(target.value);
    return target ? target.value : '';
  });
}

// The company's active customer fields as import targets: those this member may change (D77).
async function customTargetsOf(req) {
  const fields = await customFieldService.fieldsEditableBy(req, 'contact');
  return fields
    .filter((field) => field.status === 'active' && field.type !== 'lookup') // links are not imported (D75)
    .sort((a, b) => a.order - b.order)
    .map((field) => ({ value: `cf:${field.key}`, key: field.key, label: field.label, type: field.type }));
}

async function preview(req, file) {
  const { headers, data } = readFile(file);
  const customTargets = await customTargetsOf(req);
  return {
    headers,
    rows: data.slice(0, 5),
    totalRows: data.length,
    mapping: suggestMapping(headers, customTargets),
    fields: FIELDS,
    customFields: customTargets.map(({ value, label: name, type }) => ({ value, label: name, type })),
  };
}

// One file row → contact fields, or { reject }. customFields: key → field, for the cf: columns.
function recordOf(row, mapping, customFields = new Map()) {
  const value = (field) => {
    const index = mapping.indexOf(field);
    return index === -1 ? '' : String(row[index] || '').trim();
  };
  const phoneText = value('phone');
  const phoneE164 = normalizePhone(phoneText);
  if (phoneE164 === null) return { reject: `"${phoneText}" is not a phone number` };
  const emailText = value('email').toLowerCase();
  const email = EMAIL.test(emailText) ? emailText : '';
  if (!phoneE164 && !email) return { reject: 'no phone number or email' };
  const gstin = normalizeGstin(value('gstin'));
  const source = LEAD_SOURCES.find((s) => s.toLowerCase() === value('source').toLowerCase());
  const record = {
    name: (value('name') || value('company') || phoneText || email).slice(0, 200),
    phone: phoneText.slice(0, 30),
    phoneE164: phoneE164 || undefined,
    email: email.slice(0, 254),
    company: value('company').slice(0, 200),
    gstin: /^[0-9A-Z]{15}$/.test(gstin) ? gstin : '',
    state: value('state').slice(0, 100),
    city: value('city').slice(0, 100),
    address: value('address').slice(0, 500),
    tags: value('tags').split(/[,;|]/).map((t) => t.trim().slice(0, 50)).filter(Boolean),
    source: source || 'Import',
    notes: value('notes').slice(0, 5000),
  };
  record.stateCode = stateCodeFromGstin(record.gstin);
  const warnings = [];
  record.customFields = {};
  let leftOut = 0;
  mapping.forEach((target, index) => {
    const field = target.startsWith('cf:') && mapping.indexOf(target) === index ? customFields.get(target.slice(3)) : null;
    if (!field) return;
    const { value, warning } = customFieldService.readImportValue(field, row[index]);
    if (warning) warnings.push(warning);
    if (warning && value === undefined) leftOut += 1;
    if (value !== undefined) record.customFields[field.key] = value;
  });
  if (emailText && !email) warnings.push(`email "${emailText}" was left out`);
  if (value('gstin') && !record.gstin) warnings.push(`GSTIN "${value('gstin')}" was left out`);
  return { record, warnings, leftOut };
}

// Rows of the same file for the same person: later rows fill what earlier ones left blank.
function merge(into, from) {
  for (const [key, value] of Object.entries(from)) {
    if (key === 'customFields') into.customFields = { ...value, ...into.customFields };
    else if (key === 'tags') into.tags = [...new Set([...into.tags, ...value])];
    else if (!into[key] && value) into[key] = value;
  }
}

const unique = (values) => [...new Set(values.map((t) => t.toLowerCase()))].map((lower) => values.find((t) => t.toLowerCase() === lower));

async function run(req, file, options) {
  const { mapping, tags: extraTags = [], consent = 'unknown', lifecycle = 'customer', updateExisting = true, dryRun = false } = options;
  const { headers, data } = readFile(file);
  if (mapping.length !== headers.length) throw httpError(400, 'VALIDATION_ERROR', 'The column choices do not match the file; open the file again.');
  if (!mapping.includes('phone') && !mapping.includes('email')) {
    throw httpError(400, 'VALIDATION_ERROR', 'Choose which column has the phone number (or the email).', [{ field: 'mapping', code: 'PHONE_REQUIRED', message: 'Choose which column has the phone number (or the email).' }]);
  }
  const organizationId = req.tenant.organizationId;
  const customFields = new Map((await customFieldService.fieldsEditableBy(req, 'contact')).map((field) => [field.key, field]));
  const unknown = mapping.find((target) => target.startsWith('cf:') && customFields.get(target.slice(3))?.status !== 'active');
  if (unknown) {
    throw httpError(400, 'VALIDATION_ERROR', 'A column goes to a field that no longer exists; open the file again.', [{ field: 'mapping', code: 'UNKNOWN_FIELD', message: unknown }]);
  }
  const report = { totalRows: data.length, created: 0, updated: 0, unchanged: 0, mergedInFile: 0, rejected: 0, rejectedRows: [], warnings: [], customLeftOut: 0, dryRun };
  const note = (list, row, text) => {
    if (report[list].length < REPORT_LIMIT) report[list].push({ row, text });
  };

  // 1. Rows → people (merged by phone, else email).
  const people = new Map();
  data.forEach((row, index) => {
    const rowNumber = index + 2; // as in the spreadsheet (row 1 is the header)
    const { record, reject, warnings, leftOut } = recordOf(row, mapping, customFields);
    if (reject) {
      report.rejected += 1;
      note('rejectedRows', rowNumber, reject);
      return;
    }
    warnings.forEach((w) => note('warnings', rowNumber, w));
    report.customLeftOut += leftOut;
    record.tags = unique([...record.tags, ...extraTags]);
    const key = record.phoneE164 || `email:${record.email}`;
    if (people.has(key)) {
      merge(people.get(key).record, record);
      report.mergedInFile += 1;
    } else people.set(key, { record, rowNumber });
  });

  // 2. Who is already in the CRM.
  const list = [...people.values()];
  const phones = list.map((p) => p.record.phoneE164).filter(Boolean);
  const emails = list.filter((p) => !p.record.phoneE164).map((p) => p.record.email);
  const existing = await Contact.find({ organizationId, deletedAt: null, $or: [{ phoneE164: { $in: phones } }, { email: { $in: emails } }] });
  const byPhone = new Map(existing.filter((c) => c.phoneE164).map((c) => [c.phoneE164, c]));
  const byEmail = new Map(existing.filter((c) => c.email).map((c) => [c.email, c]));
  const visibility = visibilityFilter(req, 'customers');
  const mayUpdate = (contact) => !Object.keys(visibility).length || String(contact.ownerId) === String(req.member._id);
  const ownerId = await resolveOwnerId(req, undefined);
  const now = new Date();

  // 3. New people are added; people already here get their blank fields filled and the tags.
  const writes = [];
  for (const { record } of list) {
    const found = (record.phoneE164 && byPhone.get(record.phoneE164)) || (!record.phoneE164 && byEmail.get(record.email));
    const { customFields: values, ...fields } = record;
    if (!found) {
      report.created += 1;
      writes.push({
        insertOne: {
          document: {
            ...fields, ...(Object.keys(values).length && { customFields: values }), organizationId, lifecycle, status: 'Active', ownerId, createdById: req.user._id,
            ...(lifecycle === 'customer' && { becameCustomerAt: now }),
            consent: consent === 'opted_in' ? { marketing: 'opted_in', changedAt: now, method: 'import' } : { marketing: 'unknown' },
          },
        },
      });
      continue;
    }
    if (!updateExisting || !mayUpdate(found)) {
      report.unchanged += 1;
      continue;
    }
    const set = {};
    for (const field of ['email', 'company', 'gstin', 'stateCode', 'state', 'city', 'address']) if (!found[field] && record[field]) set[field] = record[field];
    if (!found.phoneE164 && record.phoneE164) Object.assign(set, { phone: record.phone, phoneE164: record.phoneE164 });
    // Their own fields: only the empty ones are filled, nothing is overwritten.
    for (const [key, value] of Object.entries(values)) if (found.customFields?.[key] === undefined) set[`customFields.${key}`] = value;
    if (consent === 'opted_in' && (found.consent?.marketing || 'unknown') === 'unknown') Object.assign(set, { consent: { marketing: 'opted_in', changedAt: now, method: 'import' } });
    const newTags = record.tags.filter((t) => !found.tags.some((x) => x.toLowerCase() === t.toLowerCase()));
    if (!Object.keys(set).length && !newTags.length) {
      report.unchanged += 1;
      continue;
    }
    report.updated += 1;
    writes.push({ updateOne: { filter: { _id: found._id }, update: { $set: set, ...(newTags.length && { $addToSet: { tags: { $each: newTags } } }) } } });
  }

  // New contacts must fit the plan (the whole file, so a half import never happens), checked and
  // written under the company's contacts hold (D81).
  await planService.withRoom(organizationId, [['contacts', { adding: report.created, action: 'import contacts' }]], async () => {
    if (dryRun || !writes.length) return;
    try {
      await Contact.bulkWrite(writes, { ordered: false });
    } catch (error) {
      // Someone added the same number meanwhile: those rows count as already here.
      const duplicates = (error.writeErrors || []).filter((e) => e.code === 11000).length;
      if (!duplicates) throw error;
      report.created -= duplicates;
      report.unchanged += duplicates;
    }
  }, { leaseMs: 120000 });
  if (!dryRun && writes.length) {
    await audit(req, { action: 'contacts.imported', entityType: 'Contact', changes: { created: report.created, updated: report.updated, rows: data.length } });
    // The customers this file opted in (new ones, and known ones whose consent was unknown), D79.
    if (consent === 'opted_in') {
      const optedIn = await Contact.find({ organizationId, 'consent.method': 'import', 'consent.changedAt': now }).select('_id').lean();
      await consentHistory.recordMany(organizationId, optedIn.map((c) => c._id), { from: 'unknown', to: 'opted_in', method: 'import', ...consentHistory.actorOf(req), at: now });
    }
  }
  return report;
}

module.exports = { preview, run, suggestMapping, FIELDS, MAX_ROWS };
