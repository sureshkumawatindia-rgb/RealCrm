const crypto = require('crypto');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const LeadIntake = require('../models/LeadIntake');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { CONNECTION_TYPES } = require('../constants/leadSources');

// Settings → Lead sources: the organization's connections (owners and admins).
const WEBSITE_DEFAULTS = Object.freeze({
  title: 'Send us an enquiry',
  buttonText: 'Send',
  successMessage: 'Thank you! We will contact you shortly.',
  redirectUrl: '',
  allowedOrigins: [],
  askFor: { email: true, company: true, city: true, product: false, message: true },
});

function websiteSettings(settings = {}) {
  return { ...WEBSITE_DEFAULTS, ...settings, askFor: { ...WEBSITE_DEFAULTS.askFor, ...(settings.askFor || {}) } };
}

function serializeConnection(connection) {
  const base = {
    id: connection._id,
    type: connection.type,
    source: CONNECTION_TYPES[connection.type],
    name: connection.name,
    status: connection.status,
    statusMessage: connection.statusMessage,
    settings: connection.type === 'website' ? websiteSettings(connection.settings) : connection.settings || {},
    stats: connection.stats,
    lastPolledAt: connection.lastPolledAt || null,
    lastLeadAt: connection.lastLeadAt || null,
    lastError: connection.lastError,
    lastErrorAt: connection.lastErrorAt || null,
    credentials: { configured: Boolean(connection.credentialsEnc), hint: connection.credentialsHint },
    createdAt: connection.createdAt,
  };
  if (connection.type === 'website') {
    const formPath = `/api/v1/public/forms/${connection.publicKey}`;
    base.form = { publicKey: connection.publicKey, submitUrl: `${env.publicUrl}${formPath}`, embedUrl: `${env.publicUrl}${formPath}/embed.js` };
  }
  return base;
}

async function findInOrg(req, id) {
  const connection = await LeadSourceConnection.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!connection) throw httpError(404, 'NOT_FOUND', 'Lead source not found');
  return connection;
}

async function list(req) {
  const connections = await LeadSourceConnection.find({ organizationId: req.tenant.organizationId }).sort({ createdAt: 1 });
  return connections.map(serializeConnection);
}

async function create(req, body) {
  const connection = await LeadSourceConnection.create({
    organizationId: req.tenant.organizationId,
    type: body.type,
    name: body.name || `${CONNECTION_TYPES[body.type]} ${body.type === 'website' ? 'form' : ''}`.trim(),
    ...(body.type === 'website' && { publicKey: crypto.randomBytes(12).toString('hex'), settings: websiteSettings(body.settings) }),
    createdById: req.user._id,
  });
  await audit(req, { action: 'leadsource.created', entityType: 'LeadSourceConnection', entityId: connection._id, changes: { type: body.type } });
  return serializeConnection(connection);
}

async function update(req, id, body) {
  const connection = await findInOrg(req, id);
  if ('name' in body) connection.name = body.name;
  if ('status' in body) {
    connection.status = body.status;
    if (body.status === 'active') connection.statusMessage = '';
  }
  if (body.settings) {
    connection.settings = connection.type === 'website' ? websiteSettings({ ...connection.settings, ...body.settings }) : { ...connection.settings, ...body.settings };
    connection.markModified('settings');
  }
  await connection.save();
  await audit(req, { action: 'leadsource.updated', entityType: 'LeadSourceConnection', entityId: connection._id, changes: Object.keys(body) });
  return serializeConnection(connection);
}

async function remove(req, id) {
  const connection = await findInOrg(req, id);
  await connection.softDelete();
  await audit(req, { action: 'leadsource.deleted', entityType: 'LeadSourceConnection', entityId: connection._id });
}

// The latest enquiries of a connection, with what became of them (and the raw payload).
async function intakes(req, id, { limit = 20 } = {}) {
  const connection = await findInOrg(req, id);
  const items = await LeadIntake.find({ organizationId: connection.organizationId, connectionId: connection._id }).sort({ createdAt: -1 }).limit(limit);
  return items.map((item) => ({
    id: item._id,
    source: item.source,
    sourceRef: item.sourceRef,
    outcome: item.outcome,
    reason: item.reason,
    summary: item.summary,
    leadId: item.leadId || null,
    contactId: item.contactId || null,
    receivedAt: item.receivedAt,
    raw: item.raw ?? null,
  }));
}

module.exports = { list, create, update, remove, intakes, findInOrg, serializeConnection, websiteSettings };
