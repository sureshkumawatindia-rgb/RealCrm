const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Quotation = require('../models/Quotation');
const Order = require('../models/Order');
const Product = require('../models/Product');
const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const xlsx = require('../utils/xlsx');
const { audit } = require('../utils/audit');
const { maskPhone } = require('../utils/phoneMask');
const { csvCell } = require('./reportService');
const customFieldService = require('./customFieldService');
const contactService = require('./contactService');
const leadService = require('./leadService');
const { visibilityFilter, privacyFilter } = require('./access');

// Tables as rows (Phase 4A, D82), for "Download Excel" on Contacts and Leads and for the Excel /
// Power BI feeds of the public API. One list of columns per table: a header for people, a key for
// feeds, and how to read the value. Money is in rupees, dates are dates, the company's own fields
// come last ("cf_<key>" in feeds), and phones are masked for members who see them masked.
const LIST_MAX = 50000;
const FEED_MAX = 100000;

const rupees = (paise) => (Number.isFinite(paise) ? Math.round(paise) / 100 : null);
const dateOf = (value) => (value ? new Date(value) : null);
const join = (list) => (Array.isArray(list) ? list.filter(Boolean).join(', ') : '');
const contactName = (doc) => doc.contactId?.name || '';

const TABLES = {
  contacts: {
    model: Contact, scope: 'contacts:read', object: 'contact', phones: ['phone'],
    columns: [
      ['id', 'ID', (c) => String(c._id)],
      ['name', 'Name', (c) => c.name],
      ['phone', 'Phone', (c) => c.phoneE164 || c.phone || ''],
      ['email', 'Email', (c) => c.email || ''],
      ['company', 'Company', (c) => c.company || ''],
      ['gstin', 'GSTIN', (c) => c.gstin || ''],
      ['city', 'City', (c) => c.city || ''],
      ['state', 'State', (c) => c.state || ''],
      ['lifecycle', 'Lifecycle', (c) => c.lifecycle || ''],
      ['status', 'Status', (c) => c.status || ''],
      ['owner', 'Owner', (c, ctx) => ctx.owner(c.ownerId)],
      ['tags', 'Tags', (c) => join(c.tags)],
      ['whatsappConsent', 'WhatsApp offers', (c) => c.consent?.marketing || 'unknown'],
      ['source', 'Source', (c) => c.source || ''],
      ['firstChannel', 'First channel', (c) => c.firstTouch?.channel || ''],
      ['firstCampaign', 'First campaign', (c) => c.firstTouch?.campaign || ''],
      ['createdAt', 'Added on', (c) => dateOf(c.createdAt)],
      ['updatedAt', 'Changed on', (c) => dateOf(c.updatedAt)],
    ],
  },
  leads: {
    model: Lead, scope: 'leads:read', object: 'lead', phones: ['contactPhone'], populate: { path: 'contactId', select: 'name phone phoneE164' },
    columns: [
      ['id', 'ID', (l) => String(l._id)],
      ['title', 'Lead', (l) => l.title || 'Enquiry'],
      ['contact', 'Customer', contactName],
      ['contactPhone', 'Customer phone', (l) => l.contactId?.phoneE164 || l.contactId?.phone || ''],
      ['contactId', 'Customer ID', (l) => (l.contactId?._id ? String(l.contactId._id) : '')],
      ['stage', 'Stage', (l) => l.stage],
      ['source', 'Source', (l) => l.source || ''],
      ['owner', 'Owner', (l, ctx) => ctx.owner(l.ownerId)],
      ['valueRupees', 'Value (₹)', (l) => rupees(l.expectedValuePaise)],
      ['expectedCloseDate', 'Expected close', (l) => dateOf(l.expectedCloseDate)],
      ['followUpAt', 'Follow-up', (l) => dateOf(l.followUpAt)],
      ['firstChannel', 'First channel', (l) => l.attribution?.first?.channel || ''],
      ['firstCampaign', 'First campaign', (l) => l.attribution?.first?.campaign || ''],
      ['lastChannel', 'Latest channel', (l) => l.attribution?.last?.channel || ''],
      ['lostReason', 'Lost reason', (l) => l.lostReason || ''],
      ['createdAt', 'Added on', (l) => dateOf(l.createdAt)],
      ['stageChangedAt', 'Stage changed on', (l) => dateOf(l.stageChangedAt)],
    ],
  },
  quotations: {
    model: Quotation, scope: 'quotations:read', populate: { path: 'contactId', select: 'name' },
    columns: [
      ['id', 'ID', (q) => String(q._id)],
      ['number', 'Number', (q) => q.number || ''],
      ['type', 'Type', (q) => q.type || ''],
      ['status', 'Status', (q) => q.status || ''],
      ['contact', 'Customer', contactName],
      ['contactId', 'Customer ID', (q) => (q.contactId?._id ? String(q.contactId._id) : '')],
      ['leadId', 'Lead ID', (q) => (q.leadId ? String(q.leadId) : '')],
      ['owner', 'Owner', (q, ctx) => ctx.owner(q.ownerId)],
      ['quotationDate', 'Date', (q) => dateOf(q.quotationDate)],
      ['validUntil', 'Valid until', (q) => dateOf(q.validUntil)],
      ['taxableRupees', 'Taxable (₹)', (q) => rupees(q.totals?.taxablePaise)],
      ['taxRupees', 'GST (₹)', (q) => rupees(q.totals?.taxPaise)],
      ['totalRupees', 'Total (₹)', (q) => rupees(q.totals?.grandTotalPaise)],
      ['sentAt', 'Sent on', (q) => dateOf(q.sentAt)],
      ['viewedAt', 'First viewed', (q) => dateOf(q.viewedAt)],
      ['acceptedAt', 'Accepted on', (q) => dateOf(q.acceptedAt)],
      ['rejectedAt', 'Rejected on', (q) => dateOf(q.rejectedAt)],
      ['createdAt', 'Made on', (q) => dateOf(q.createdAt)],
    ],
  },
  orders: {
    model: Order, scope: 'orders:read', populate: { path: 'contactId', select: 'name' },
    columns: [
      ['id', 'ID', (o) => String(o._id)],
      ['number', 'Number', (o) => o.number || ''],
      ['stage', 'Stage', (o) => o.stage || ''],
      ['contact', 'Customer', contactName],
      ['contactId', 'Customer ID', (o) => (o.contactId?._id ? String(o.contactId._id) : '')],
      ['quotationNumber', 'Quotation', (o) => o.quotationNumber || ''],
      ['owner', 'Owner', (o, ctx) => ctx.owner(o.ownerId)],
      ['orderDate', 'Date', (o) => dateOf(o.orderDate)],
      ['totalRupees', 'Total (₹)', (o) => rupees(o.totals?.grandTotalPaise)],
      ['paidRupees', 'Paid (₹)', (o) => rupees(o.amountPaidPaise || 0)],
      ['dueRupees', 'Due (₹)', (o) => (o.cancelledAt ? 0 : rupees(Math.max((o.totals?.grandTotalPaise || 0) - (o.amountPaidPaise || 0), 0)))],
      ['deliveredAt', 'Delivered on', (o) => dateOf(o.deliveredAt)],
      ['paidAt', 'Paid on', (o) => dateOf(o.paidAt)],
      ['cancelledAt', 'Cancelled on', (o) => dateOf(o.cancelledAt)],
      ['createdAt', 'Made on', (o) => dateOf(o.createdAt)],
    ],
  },
  products: {
    model: Product, scope: 'products:read',
    columns: [
      ['id', 'ID', (p) => String(p._id)],
      ['name', 'Name', (p) => p.name],
      ['sku', 'SKU', (p) => p.sku || ''],
      ['category', 'Category', (p) => p.category || ''],
      ['unit', 'Unit', (p) => p.unit || ''],
      ['hsnSac', 'HSN/SAC', (p) => p.hsnSac || ''],
      ['priceRupees', 'Price (₹)', (p) => rupees(p.pricePaise)],
      ['gstRatePct', 'GST %', (p) => (Number.isFinite(p.gstRatePct) ? p.gstRatePct : null)],
      ['moq', 'Minimum order', (p) => (Number.isFinite(p.moq) ? p.moq : null)],
      ['stockQty', 'Stock', (p) => (Number.isFinite(p.stockQty) ? p.stockQty : null)],
      ['active', 'Active', (p) => p.active !== false],
      ['updatedAt', 'Changed on', (p) => dateOf(p.updatedAt)],
    ],
  },
};
const TABLE_KEYS = Object.freeze(Object.keys(TABLES));

async function ownerNames(organizationId) {
  const members = await OrganizationMember.find({ organizationId }).populate('userId', 'name email').lean();
  const names = new Map(members.map((m) => [String(m._id), m.displayName || m.userId?.name || m.userId?.email || '']));
  return (id) => (id ? names.get(String(id)) || '' : '');
}

// A custom field's value as a cell: numbers stay numbers, ticks are booleans, the rest text.
function customCell(field, value) {
  if (value === undefined || value === null || value === '') return '';
  if (field.type === 'number') return Number.isFinite(Number(value)) ? Number(value) : String(value);
  if (field.type === 'checkbox') return Boolean(value);
  return Array.isArray(value) ? value.join(', ') : String(value);
}

// The columns and rows of a table for this request. filter: the records to take (already scoped).
async function tableOf(req, table, { filter, sort = { createdAt: -1 }, max }) {
  const def = TABLES[table];
  const [count, owner, fields] = await Promise.all([
    def.model.countDocuments(filter),
    ownerNames(req.tenant.organizationId),
    def.object ? customFieldService.fieldsFor(req, def.object) : [],
  ]);
  if (count > max) return { tooMany: count };
  let query = def.model.find(filter).sort(sort).limit(max).lean();
  if (def.populate) query = query.populate(def.populate);
  const docs = await query;
  const custom = fields.filter((field) => field.status === 'active');
  const columns = [
    ...def.columns.map(([key, header]) => ({ key, header })),
    ...custom.map((field) => ({ key: `cf_${field.key}`, header: field.label })),
  ];
  const ctx = { owner };
  const masked = new Set(req.maskPhones ? def.phones || [] : []);
  const rows = docs.map((doc) => [
    ...def.columns.map(([key, , read]) => {
      const value = read(doc, ctx);
      return masked.has(key) && value ? maskPhone(value) : value;
    }),
    ...custom.map((field) => customCell(field, doc.customFields?.[field.key])),
  ]);
  return { columns, rows, count };
}

const stamp = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
// A CSV cell: numbers as they are, dates as ISO. Any text that starts like a formula gets an
// apostrophe (csvCell), except, in feeds (read by Power Query, which never runs formulas), a phone
// number: "+" and digits only, which can hold no formula.
const PHONE_ONLY = /^\+\d[\d ]*$/;
const feedCell = (by) => (value) => {
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (by === 'key' && PHONE_ONLY.test(value)) return value;
  return csvCell(value);
};
const csvOf = (columns, rows, by = 'header') => `﻿${[columns.map((c) => c[by]).map(csvCell).join(','), ...rows.map((row) => row.map(feedCell(by)).join(','))].join('\r\n')}\r\n`;

// GET /contacts/export and /leads/export (owners and admins): the list as on screen, as a file.
// POST with { ids } (D100): the rows ticked in the list, those this member may see.
const LIST_SERVICES = { contacts: contactService, leads: leadService };
async function listFile(req, table, { query, ids }) {
  const service = LIST_SERVICES[table];
  const filter = { ...(await service.listFilter(req, query)), organizationId: req.tenant.organizationId, ...(ids && { _id: { $in: ids } }) };
  const result = await tableOf(req, table, { filter, sort: service.listSort(query), max: LIST_MAX });
  if (result.tooMany) {
    throw httpError(400, 'TOO_MANY_ROWS', `That is ${result.tooMany.toLocaleString('en-IN')} rows; a file takes at most ${LIST_MAX.toLocaleString('en-IN')}. Narrow the search or the filters, then download again.`);
  }
  const filtered = Boolean(ids || query.q || query.cf || query.stage || query.lifecycle || query.status || query.ownerId || query.tag || query.consent);
  await audit(req, { action: `${table}.exported`, entityType: table === 'contacts' ? 'Contact' : 'Lead', changes: { rows: result.rows.length, format: query.format, filtered, ...(ids && { selected: ids.length }) } });
  const name = `${table}-${stamp()}`;
  if (query.format === 'csv') return { fileName: `${name}.csv`, type: 'text/csv; charset=utf-8', body: csvOf(result.columns, result.rows) };
  const title = table === 'contacts' ? 'Contacts' : 'Leads';
  return { fileName: `${name}.xlsx`, type: xlsx.XLSX_TYPE, body: xlsx.write([{ name: title, rows: [result.columns.map((c) => c.header), ...result.rows] }]) };
}
const exportList = (req, table, query) => listFile(req, table, { query });
const exportSelected = (req, table, { ids, format }) => listFile(req, table, { query: { format }, ids });

// GET /api/public/v1/feeds/:table — every row of a table for Excel or Power BI (the key's
// company, what its member may see), as JSON objects or CSV, optionally only those changed since.
async function feed(req, table, { format = 'json', updatedSince } = {}) {
  const def = TABLES[table];
  const organizationId = req.tenant.organizationId;
  const seen = table === 'contacts' ? { ...visibilityFilter(req, 'customers'), ...privacyFilter(req) }
    : table === 'leads' ? { ...visibilityFilter(req, leadService.MODULES), ...privacyFilter(req) } : {};
  const filter = { organizationId, ...seen, ...(updatedSince && { updatedAt: { $gte: new Date(updatedSince) } }) };
  const result = await tableOf(req, table, { filter, sort: { _id: 1 }, max: FEED_MAX });
  if (result.tooMany) {
    throw httpError(400, 'TOO_MANY_ROWS', `That is ${result.tooMany.toLocaleString('en-IN')} rows; a feed gives at most ${FEED_MAX.toLocaleString('en-IN')}. Add updatedSince to take only the changed ones.`);
  }
  if (format === 'csv') return { csv: csvOf(result.columns, result.rows, 'key') };
  return { rows: result.rows.map((row) => Object.fromEntries(result.columns.map((column, i) => [column.key, row[i] instanceof Date ? row[i].toISOString() : row[i] ?? null]))) };
}

module.exports = { TABLES, TABLE_KEYS, LIST_MAX, FEED_MAX, tableOf, exportList, exportSelected, feed };
