const WhatsAppAccount = require('../models/WhatsAppAccount');
const GmailConnection = require('../models/GmailConnection');
const PaymentConnection = require('../models/PaymentConnection');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const ConversionsApiConnection = require('../models/ConversionsApiConnection');
const ApiKey = require('../models/ApiKey');
const WebhookSubscription = require('../models/WebhookSubscription');
const MicrosoftConnection = require('../models/MicrosoftConnection');
const TeamsChannel = require('../models/TeamsChannel');
const TelephonyConnection = require('../models/TelephonyConnection');
const Organization = require('../models/Organization');
const planService = require('./planService');
const { PLANS, PLAN_KEYS } = require('../constants/plans');
const { CONNECTION_TYPES } = require('../constants/leadSources');
const { PAYMENT_PROVIDERS } = require('../constants/payments');

// Settings → Connections (Phase 1F, D78, owners and admins): every integration of the company on
// one screen, from the state each connection already keeps. Nothing is stored here.
//   state: working | attention (something to fix: problem says what) | off | not_connected
// A kind with nothing set up is one "not_connected" row, so the screen also says what is possible.

const KINDS = Object.freeze(['whatsapp', 'gmail', 'payments', 'leadsources', 'metaCapi', 'apiKeys', 'webhooks', 'microsoft', 'teams', 'calling']);
// Which Settings tab each kind is managed on.
const TABS = Object.freeze({
  whatsapp: 'whatsapp', gmail: 'profile', payments: 'payments', leadsources: 'leadsources', metaCapi: 'integrations', apiKeys: 'integrations', webhooks: 'integrations', microsoft: 'profile', teams: 'integrations', calling: 'calling',
});
// The plan feature each kind needs (Phase 3A, D80): a row whose feature the plan lacks says which
// plan has it (plan: { feature, needs: { key, name } | null, message }); the server still refuses.
const PLAN_FEATURES = Object.freeze({ payments: 'paymentLinks', metaCapi: 'conversionsApi', apiKeys: 'api', webhooks: 'api' });
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

// Microsoft 365 (D83): one row for the team, how many members connected and who must reconnect.
function microsoftRows(connections) {
  if (!connections.length) return [];
  const stale = connections.filter((c) => c.status !== 'active');
  return [row('microsoft', {
    name: `${connections.length} member${connections.length === 1 ? '' : 's'}`,
    state: stale.length ? 'attention' : 'working',
    lastActivityAt: latest(...connections.map((c) => c.lastSyncAt)),
    problem: stale.length ? `${stale.map((c) => c.email || c.name).join(', ')} must connect Microsoft 365 again (Settings → My profile).` : '',
  })];
}

// Teams channel notes (D83): one row per channel.
function teamsRows(channels) {
  return channels.map((c) => row('teams', {
    id: String(c._id),
    name: c.name,
    state: !c.active ? (c.disabledReason ? 'attention' : 'off') : c.lastStatus === 'failed' ? 'attention' : 'working',
    lastActivityAt: c.lastSentAt || null,
    problem: !c.active ? c.disabledReason || '' : c.lastStatus === 'failed' ? c.lastError || 'The last card was not posted.' : '',
  }));
}

// Calling (D85): the company's telephony connection.
function callingRows(connection) {
  if (!connection) return [];
  return [row('calling', {
    id: String(connection._id),
    name: connection.provider === 'mock' ? 'Test provider' : `Exotel ${connection.callerId || ''}`.trim(),
    state: connection.status === 'error' ? 'attention' : 'working',
    lastActivityAt: connection.lastCallAt || null,
    problem: connection.status === 'error' ? connection.lastError || 'The last call could not be placed.' : '',
  })];
}

// GET /integrations/status
async function status(req) {
  const organizationId = req.tenant.organizationId;
  const [organization, accounts, gmail, payments, sources, meta, keys, hooks, microsoftConnections, teamsChannels, telephony] = await Promise.all([
    Organization.findById(organizationId).select('plan subscription entitlementGrants'),
    WhatsAppAccount.find({ organizationId }).select('name verifiedName displayPhone status statusMessage lastWebhookAt').lean(),
    GmailConnection.find({ organizationId }).select('updatedAt').lean(),
    PaymentConnection.find({ organizationId }).select('name provider status statusMessage lastWebhookAt lastCheckedAt').lean(),
    LeadSourceConnection.find({ organizationId }).select('name type status statusMessage lastLeadAt lastPolledAt lastError lastErrorAt').lean(),
    ConversionsApiConnection.findOne({ organizationId }).select('datasetId datasetName enabled status statusMessage stats').lean(),
    ApiKey.find({ organizationId, revokedAt: null }).select('lastUsedAt').lean(),
    WebhookSubscription.find({ organizationId }).select('url description active disabledReason lastStatus lastResponseCode lastDeliveryAt').lean(),
    MicrosoftConnection.find({ organizationId }).select('email name status lastSyncAt').lean(),
    TeamsChannel.find({ organizationId }).select('name active disabledReason lastStatus lastError lastSentAt').lean(),
    TelephonyConnection.findOne({ organizationId }).select('provider callerId status lastError lastCallAt').lean(),
  ]);
  const rows = {
    whatsapp: whatsappRows(accounts),
    gmail: gmailRows(gmail),
    payments: paymentRows(payments),
    leadsources: leadSourceRows(sources),
    metaCapi: metaRows(meta),
    apiKeys: apiKeyRows(keys),
    webhooks: webhookRows(hooks),
    microsoft: microsoftRows(microsoftConnections),
    teams: teamsRows(teamsChannels),
    calling: callingRows(telephony),
  };
  const planNotes = Object.fromEntries(Object.entries(PLAN_FEATURES).map(([kind, feature]) => {
    const message = planService.featureBlock(organization, feature);
    if (!message) return [kind, null];
    const needed = planService.subscriptionOf(organization).locked ? null : PLAN_KEYS.find((key) => PLANS[key][feature]);
    return [kind, { feature, needs: needed ? { key: needed, name: PLANS[needed].name } : null, message }];
  }));
  const items = KINDS.flatMap((kind) => (rows[kind].length ? rows[kind] : [row(kind, {})])).map((item) => ({ ...item, plan: planNotes[item.kind] || null }));
  return { items, needsAttention: items.filter((item) => item.state === 'attention').length };
}

module.exports = { status, KINDS };
