const WhatsAppAccount = require('../models/WhatsAppAccount');
const GmailConnection = require('../models/GmailConnection');
const PaymentConnection = require('../models/PaymentConnection');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const ConversionsApiConnection = require('../models/ConversionsApiConnection');
const ApiKey = require('../models/ApiKey');
const WebhookSubscription = require('../models/WebhookSubscription');
const { CONNECTION_TYPES } = require('../constants/leadSources');
const { PAYMENT_PROVIDERS } = require('../constants/payments');

// Settings → Connections (Phase 1F, D78, owners and admins): every integration of the company on
// one screen, from the state each connection already keeps. Nothing is stored here.
//   state: working | attention (something to fix: problem says what) | off | not_connected
// A kind with nothing set up is one "not_connected" row, so the screen also says what is possible.

const KINDS = Object.freeze(['whatsapp', 'gmail', 'payments', 'leadsources', 'metaCapi', 'apiKeys', 'webhooks']);
// Which Settings tab each kind is managed on.
const TABS = Object.freeze({
  whatsapp: 'whatsapp', gmail: 'profile', payments: 'payments', leadsources: 'leadsources', metaCapi: 'integrations', apiKeys: 'integrations', webhooks: 'integrations',
});
const latest = (...dates) => dates.filter(Boolean).map((d) => new Date(d)).sort((a, b) => b - a)[0] || null;
const row = (kind, fields) => ({ kind, id: null, name: '', state: 'not_connected', lastActivityAt: null, problem: '', settingsTab: TABS[kind], ...fields });

function whatsappRows(accounts) {
  return accounts.map((a) => row('whatsapp', {
    id: String(a._id),
    name: a.verifiedName || a.displayPhone || a.name || 'WhatsApp number',
    state: a.status === 'connected' ? 'working' : a.status === 'disconnected' ? 'off' : 'attention',
    lastActivityAt: a.lastWebhookAt || null,
    problem: a.status === 'connected' ? '' : a.statusMessage || (a.status === 'pending' ? 'Not finished connecting.' : 'WhatsApp reported a problem.'),
  }));
}

function gmailRows(connections) {
  if (!connections.length) return [];
  // Gmail is each person's own mailbox: only how many teammates connected it.
  return [row('gmail', { name: `${connections.length} teammate${connections.length === 1 ? '' : 's'}`, state: 'working', lastActivityAt: latest(...connections.map((c) => c.updatedAt)) })];
}

function paymentRows(connections) {
  return connections.map((c) => row('payments', {
    id: String(c._id),
    name: c.name || PAYMENT_PROVIDERS[c.provider] || c.provider,
    state: c.status === 'connected' ? 'working' : 'attention',
    lastActivityAt: latest(c.lastWebhookAt, c.lastCheckedAt),
    problem: c.status === 'connected' ? '' : c.statusMessage || 'The payment gateway reported a problem.',
  }));
}

function leadSourceRows(connections) {
  return connections.map((c) => {
    // A recent error after the last lead means it needs a look, even if it is still "active".
    const failing = c.status === 'error' || (c.lastErrorAt && (!c.lastLeadAt || c.lastErrorAt > c.lastLeadAt) && c.lastError);
    return row('leadsources', {
      id: String(c._id),
      name: c.name || CONNECTION_TYPES[c.type] || c.type,
      state: c.status === 'paused' ? 'off' : failing ? 'attention' : 'working',
      lastActivityAt: latest(c.lastLeadAt, c.lastPolledAt),
      problem: failing ? c.statusMessage || c.lastError || 'The lead source reported a problem.' : '',
    });
  });
}

function metaRows(connection) {
  if (!connection) return [];
  const failing = connection.status === 'error' || (connection.stats?.lastErrorAt && connection.stats.lastErrorAt > (connection.stats.lastSentAt || 0));
  return [row('metaCapi', {
    id: String(connection._id),
    name: connection.datasetName || `Dataset ${connection.datasetId}`,
    state: !connection.enabled ? 'off' : failing ? 'attention' : 'working',
    lastActivityAt: connection.stats?.lastSentAt || null,
    problem: failing ? connection.statusMessage || connection.stats?.lastError || 'Meta refused the last event.' : '',
  })];
}

function apiKeyRows(keys) {
  if (!keys.length) return [];
  return [row('apiKeys', { name: `${keys.length} key${keys.length === 1 ? '' : 's'}`, state: 'working', lastActivityAt: latest(...keys.map((k) => k.lastUsedAt)) })];
}

function webhookRows(subs) {
  return subs.map((s) => {
    const failing = s.active && s.lastStatus === 'failed';
    return row('webhooks', {
      id: String(s._id),
      name: s.description || s.url,
      state: !s.active ? (s.disabledReason ? 'attention' : 'off') : failing ? 'attention' : 'working',
      lastActivityAt: s.lastDeliveryAt || null,
      problem: !s.active ? s.disabledReason || '' : failing ? `The last delivery failed${s.lastResponseCode ? ` (answer ${s.lastResponseCode})` : ''}.` : '',
    });
  });
}

// GET /integrations/status
async function status(req) {
  const organizationId = req.tenant.organizationId;
  const [accounts, gmail, payments, sources, meta, keys, hooks] = await Promise.all([
    WhatsAppAccount.find({ organizationId }).select('name verifiedName displayPhone status statusMessage lastWebhookAt').lean(),
    GmailConnection.find({ organizationId }).select('updatedAt').lean(),
    PaymentConnection.find({ organizationId }).select('name provider status statusMessage lastWebhookAt lastCheckedAt').lean(),
    LeadSourceConnection.find({ organizationId }).select('name type status statusMessage lastLeadAt lastPolledAt lastError lastErrorAt').lean(),
    ConversionsApiConnection.findOne({ organizationId }).select('datasetId datasetName enabled status statusMessage stats').lean(),
    ApiKey.find({ organizationId, revokedAt: null }).select('lastUsedAt').lean(),
    WebhookSubscription.find({ organizationId }).select('url description active disabledReason lastStatus lastResponseCode lastDeliveryAt').lean(),
  ]);
  const rows = {
    whatsapp: whatsappRows(accounts),
    gmail: gmailRows(gmail),
    payments: paymentRows(payments),
    leadsources: leadSourceRows(sources),
    metaCapi: metaRows(meta),
    apiKeys: apiKeyRows(keys),
    webhooks: webhookRows(hooks),
  };
  const items = KINDS.flatMap((kind) => (rows[kind].length ? rows[kind] : [row(kind, {})]));
  return { items, needsAttention: items.filter((item) => item.state === 'attention').length };
}

module.exports = { status, KINDS };
