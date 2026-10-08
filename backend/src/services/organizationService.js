const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const Organization = require('../models/Organization');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { validateLogoFile } = require('../utils/logoFile');
const { normalizeGstin, stateCodeFromGstin } = require('../utils/gstin');
const { stateCodeFor, stateName } = require('../constants/gst');

const PROFILE_FIELDS = [
  'name', 'industry', 'size', 'foundedYear', 'website', 'email', 'phone', 'gstin',
  'address', 'city', 'state', 'country', 'postalCode', 'description',
];
// Older field names, moved by migration 001; read as a fallback until then.
const LEGACY_FIELDS = { gstin: 'gst', postalCode: 'pincode', foundedYear: 'founded' };

function serializeOrganization(organization) {
  const read = (field) => organization.get(field) ?? (LEGACY_FIELDS[field] ? organization.get(LEGACY_FIELDS[field]) : undefined);
  return {
    id: organization._id,
    logoUrl: organization.logoUrl || '',
    ...Object.fromEntries(PROFILE_FIELDS.map((field) => [field, read(field) ?? ''])),
    stateCode: organization.stateCode || stateCodeFromGstin(read('gstin')),
  };
}

async function loadOrganization(req) {
  const organization = await Organization.findById(req.tenant.organizationId);
  if (!organization) throw httpError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
  return organization;
}

async function get(req) {
  return serializeOrganization(await loadOrganization(req));
}

async function update(req, patch) {
  const organization = await loadOrganization(req);
  const changed = {};
  for (const field of PROFILE_FIELDS) {
    if (!(field in patch)) continue;
    let value = patch[field];
    if (field === 'gstin') value = normalizeGstin(value);
    if (field === 'foundedYear' && value === '') value = null;
    organization.set(field, value);
    changed[field] = value;
    if (LEGACY_FIELDS[field]) organization.set(LEGACY_FIELDS[field], undefined);
  }
  if ('gstin' in changed) organization.stateCode = stateCodeFromGstin(changed.gstin);
  await organization.save();
  await audit(req, { action: 'organization.updated', entityType: 'Organization', entityId: organization._id, changes: changed });
  return serializeOrganization(organization);
}

function fileNameFromUrl(logoUrl) {
  if (!logoUrl) return '';
  try {
    return path.basename(new URL(logoUrl).pathname);
  } catch {
    return path.basename(logoUrl);
  }
}

async function removeStoredLogo(logoUrl) {
  const fileName = fileNameFromUrl(logoUrl);
  if (!fileName) return;
  try {
    await fs.unlink(path.resolve(env.uploadDir, fileName));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function setLogo(req, file) {
  if (!file) throw httpError(400, 'FILE_REQUIRED', 'Logo file is required');
  const extension = validateLogoFile(file);
  const organization = await loadOrganization(req);

  const oldLogoUrl = organization.logoUrl;
  await fs.mkdir(path.resolve(env.uploadDir), { recursive: true });
  const fileName = `${organization._id}-${crypto.randomUUID()}.${extension}`;
  await fs.writeFile(path.resolve(env.uploadDir, fileName), file.buffer);
  organization.logoUrl = `${env.publicUrl}/uploads/${fileName}`;
  await organization.save();
  await removeStoredLogo(oldLogoUrl);
  await audit(req, { action: 'organization.logo_updated', entityType: 'Organization', entityId: organization._id });
  return serializeOrganization(organization);
}

async function removeLogo(req) {
  const organization = await loadOrganization(req);
  const oldLogoUrl = organization.logoUrl;
  organization.logoUrl = '';
  await organization.save();
  await removeStoredLogo(oldLogoUrl);
  await audit(req, { action: 'organization.logo_removed', entityType: 'Organization', entityId: organization._id });
  return serializeOrganization(organization);
}

// --- billing (Phase 5): quotations and orders ---------------------------------------------
const DEFAULT_PREFIXES = Object.freeze({ quotation: 'QT', estimate: 'EST', proforma: 'PI', order: 'SO' });
const plainOf = (value) => (value?.toObject ? value.toObject() : value || {});

// The organization's own GST state: from its GSTIN, else the state in its company profile.
function sellerStateCode(organization) {
  return stateCodeFromGstin(organization?.gstin) || organization?.stateCode || stateCodeFor(organization?.state);
}

function billingOf(organization) {
  const billing = organization?.billing || {};
  const code = sellerStateCode(organization);
  return {
    bank: { accountName: '', accountNumber: '', ifsc: '', bankName: '', branch: '', ...plainOf(billing.bank) },
    upiId: billing.upiId || '',
    terms: billing.terms || '',
    validityDays: billing.validityDays || 15,
    prefixes: { ...DEFAULT_PREFIXES, ...plainOf(billing.prefixes) },
    roundOff: billing.roundOff !== false,
    reduceStockOnDispatch: Boolean(billing.reduceStockOnDispatch),
    // Read-only here: the GSTIN and address are edited in the company profile.
    gstin: organization?.gstin || '',
    stateCode: code,
    state: stateName(code),
    stateFrom: stateCodeFromGstin(organization?.gstin) ? 'gstin' : code ? 'address' : '',
  };
}

async function getBilling(req) {
  return billingOf(await loadOrganization(req));
}

async function setBilling(req, body) {
  const organization = await loadOrganization(req);
  const current = billingOf(organization);
  const next = {
    bank: { ...current.bank, ...(body.bank || {}) },
    upiId: body.upiId ?? current.upiId,
    terms: body.terms ?? current.terms,
    validityDays: body.validityDays ?? current.validityDays,
    prefixes: { ...current.prefixes, ...(body.prefixes || {}) },
    roundOff: body.roundOff ?? current.roundOff,
    reduceStockOnDispatch: body.reduceStockOnDispatch ?? current.reduceStockOnDispatch,
  };
  const prefixes = Object.values(next.prefixes);
  if (new Set(prefixes).size !== prefixes.length) {
    throw httpError(400, 'VALIDATION_ERROR', 'Each kind of document needs its own prefix.', [{ field: 'prefixes', code: 'DUPLICATE_PREFIX', message: 'Each kind of document needs its own prefix.' }]);
  }
  organization.billing = next;
  await organization.save();
  await audit(req, { action: 'organization.billing_updated', entityType: 'Organization', entityId: organization._id, changes: Object.keys(body) });
  return billingOf(organization);
}

module.exports = {
  get, update, setLogo, removeLogo, serializeOrganization, PROFILE_FIELDS,
  getBilling, setBilling, billingOf, sellerStateCode, fileNameFromUrl, removeStoredLogo, DEFAULT_PREFIXES,
};
