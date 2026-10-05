const Contact = require('../models/Contact');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { parseCsv } = require('../utils/csv');
const { normalizePhone } = require('../utils/phone');
const { normalizeGstin, stateCodeFromGstin } = require('../utils/gstin');
const { LEAD_SOURCES } = require('../constants/crm');
const { visibilityFilter, resolveOwnerId } = require('./access');

// Customers from a CSV file (Phase 7): the person maps the file's columns to CRM fields, phones
// become +91… numbers, and nobody is added twice — rows of the same file with the same phone
// (or email) merge, and someone already in the CRM is updated (blank fields filled, tags added)
// or left alone. "Agreed to WhatsApp offers" marks everyone imported as opted in, but never
// someone who opted out (D35). A dry run reports without saving.
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
  if (!file) throw httpError(400, 'VALIDATION_ERROR', 'Choose a CSV file.', [{ field: 'file', code: 'FILE_REQUIRED', message: 'Choose a CSV file.' }]);
  const name = String(file.originalname || '').toLowerCase();
  if (/\.(xlsx|xls|ods)$/.test(name)) {
    throw httpError(400, 'UNSUPPORTED_FILE', 'Excel files are not read yet: in Excel use File → Save as → "CSV UTF-8", then import that file.');
  }
  const rows = parseCsv(file.buffer.toString('utf8'));
  if (rows.length < 2) throw httpError(400, 'EMPTY_FILE', 'The file needs a header row and at least one customer.');
  if (rows.length - 1 > MAX_ROWS) throw httpError(400, 'TOO_MANY_ROWS', `Import at most ${MAX_ROWS.toLocaleString('en-IN')} customers at a time (this file has ${(rows.length - 1).toLocaleString('en-IN')}).`);
  return { headers: rows[0], data: rows.slice(1) };
}

// Column index → field, from the header names (each field once).
function suggestMapping(headers) {
  const taken = new Set();
  return headers.map((header) => {
    const name = label(header);
    const field = FIELDS.find((f) => !taken.has(f) && (GUESSES[f].map(label).includes(name) || name === f));
    if (field) taken.add(field);
    return field || '';
  });
}

function preview(file) {
  const { headers, data } = readFile(file);
  return { headers, rows: data.slice(0, 5), totalRows: data.length, mapping: suggestMapping(headers), fields: FIELDS };
}

// One file row → contact fields, or { reject }.
function recordOf(row, mapping) {
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
  if (emailText && !email) warnings.push(`email "${emailText}" was left out`);
  if (value('gstin') && !record.gstin) warnings.push(`GSTIN "${value('gstin')}" was left out`);
  return { record, warnings };
}

// Rows of the same file for the same person: later rows fill what earlier ones left blank.
function merge(into, from) {
  for (const [key, value] of Object.entries(from)) {
    if (key === 'tags') into.tags = [...new Set([...into.tags, ...value])];
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
  const report = { totalRows: data.length, created: 0, updated: 0, unchanged: 0, mergedInFile: 0, rejected: 0, rejectedRows: [], warnings: [], dryRun };
  const note = (list, row, text) => {
    if (report[list].length < REPORT_LIMIT) report[list].push({ row, text });
  };

  // 1. Rows → people (merged by phone, else email).
  const people = new Map();
  data.forEach((row, index) => {
    const rowNumber = index + 2; // as in the spreadsheet (row 1 is the header)
    const { record, reject, warnings } = recordOf(row, mapping);
    if (reject) {
      report.rejected += 1;
      note('rejectedRows', rowNumber, reject);
      return;
    }
    warnings.forEach((w) => note('warnings', rowNumber, w));
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
    if (!found) {
      report.created += 1;
      writes.push({
        insertOne: {
          document: {
            ...record, organizationId, lifecycle, status: 'Active', ownerId, createdById: req.user._id,
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
    if (consent === 'opted_in' && (found.consent?.marketing || 'unknown') === 'unknown') Object.assign(set, { consent: { marketing: 'opted_in', changedAt: now, method: 'import' } });
    const newTags = record.tags.filter((t) => !found.tags.some((x) => x.toLowerCase() === t.toLowerCase()));
    if (!Object.keys(set).length && !newTags.length) {
      report.unchanged += 1;
      continue;
    }
    report.updated += 1;
    writes.push({ updateOne: { filter: { _id: found._id }, update: { $set: set, ...(newTags.length && { $addToSet: { tags: { $each: newTags } } }) } } });
  }

  if (!dryRun && writes.length) {
    try {
      await Contact.bulkWrite(writes, { ordered: false });
    } catch (error) {
      // Someone added the same number meanwhile: those rows count as already here.
      const duplicates = (error.writeErrors || []).filter((e) => e.code === 11000).length;
      if (!duplicates) throw error;
      report.created -= duplicates;
      report.unchanged += duplicates;
    }
    await audit(req, { action: 'contacts.imported', entityType: 'Contact', changes: { created: report.created, updated: report.updated, rows: data.length } });
  }
  return report;
}

module.exports = { preview, run, suggestMapping, FIELDS, MAX_ROWS };
