const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiKey = require('../models/ApiKey');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const User = require('../models/User');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const planService = require('./planService');

// Keys for the public API (Phase 10C, Settings → API & webhooks, owners and admins). A key is
// ycrm_<10 hex>_<32 random characters>; only its SHA-256 is stored, and it is shown once. A key
// acts as the owner or admin who made it, within its scopes: it stops when that person is no
// longer an active owner or admin, when it is revoked, or when the plan has no API (Growth and up).
const MAX_ACTIVE_KEYS = 20;
const KEY_PATTERN = /^ycrm_([a-f0-9]{10})_([A-Za-z0-9_-]{32})$/;
const USE_STAMP_MS = 60 * 1000; // lastUsedAt is written at most once a minute

const hashOf = (key) => crypto.createHash('sha256').update(key).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

function serializeKey(key) {
  return {
    id: key._id,
    name: key.name,
    preview: `ycrm_${key.prefix}_…`,
    scopes: key.scopes,
    createdAt: key.createdAt,
    createdBy: key.createdById?.name || '',
    lastUsedAt: key.lastUsedAt || null,
    revokedAt: key.revokedAt || null,
  };
}

async function list(req) {
  const keys = await ApiKey.find({ organizationId: req.tenant.organizationId }).sort({ revokedAt: 1, createdAt: -1 }).limit(100)
    .populate({ path: 'createdById', select: 'name' });
  return keys.map(serializeKey);
}

// POST /api-keys { name, scopes } → the key (shown this once) and its details.
async function create(req, { name, scopes }) {
  await planService.assertFeature(req.tenant.organizationId, 'api');
  if (await ApiKey.countDocuments({ organizationId: req.tenant.organizationId, revokedAt: null }) >= MAX_ACTIVE_KEYS) {
    throw httpError(409, 'TOO_MANY_KEYS', `A company can have ${MAX_ACTIVE_KEYS} API keys; revoke one you no longer use.`);
  }
  const prefix = crypto.randomBytes(5).toString('hex');
  const key = `ycrm_${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
  const record = await ApiKey.create({
    organizationId: req.tenant.organizationId, name, prefix, hash: hashOf(key), scopes: [...new Set(scopes)],
    createdById: req.user._id, createdByMemberId: req.member._id,
  });
  await audit(req, { action: 'apikey.created', entityType: 'ApiKey', entityId: record._id, changes: { name, scopes: record.scopes } });
  record.createdById = req.user;
  return { ...serializeKey(record), key };
}

async function revoke(req, id) {
  const key = mongoose.isValidObjectId(id) ? await ApiKey.findOne({ _id: id, organizationId: req.tenant.organizationId }) : null;
  if (!key) throw httpError(404, 'NOT_FOUND', 'API key not found');
  if (!key.revokedAt) {
    key.revokedAt = new Date();
    key.revokedById = req.user._id;
    await key.save();
    await audit(req, { action: 'apikey.revoked', entityType: 'ApiKey', entityId: key._id, changes: { name: key.name } });
  }
  return serializeKey(key);
}

const invalid = (message = 'The API key is missing, wrong or revoked.') => httpError(401, 'API_KEY_INVALID', message);

// The key in Authorization: Bearer <key> (or X-API-Key) → what the request may do as whom.
async function authenticate(rawKey, ip) {
  const match = KEY_PATTERN.exec(String(rawKey || '').trim());
  if (!match) throw invalid();
  const key = await ApiKey.findOne({ prefix: match[1], revokedAt: null });
  if (!key || !sameHash(key.hash, hashOf(match[0]))) throw invalid();
  const [organization, member, user] = await Promise.all([
    Organization.findById(key.organizationId),
    OrganizationMember.findOne({ _id: key.createdByMemberId, organizationId: key.organizationId, status: 'active' }),
    User.findById(key.createdById).select('name email'),
  ]);
  if (!organization) throw invalid();
  if (!member || !['owner', 'admin'].includes(member.role) || !user) {
    throw invalid('The person who made this API key is no longer an owner or admin of the company; make a new key.');
  }
  const block = planService.featureBlock(organization, 'api');
  if (block) throw httpError(403, planService.subscriptionOf(organization).locked ? 'SUBSCRIPTION_INACTIVE' : 'PLAN_LIMIT', block);
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt > USE_STAMP_MS) {
    await ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date(), lastUsedIp: String(ip || '').slice(0, 64) } });
  }
  return { key, organization, member, user };
}

module.exports = { list, create, revoke, authenticate, serializeKey, hashOf, KEY_PATTERN, MAX_ACTIVE_KEYS };
