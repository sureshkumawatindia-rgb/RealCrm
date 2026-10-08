const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const User = require('../models/User');
const env = require('../config/env');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { documentStorage } = require('../storage');
const notificationService = require('./notificationService');

// Deleting a company (Phase 10F, D57; India's DPDP Act: a company can have its data erased).
// An owner asks, typing the company's name; the company keeps working for ORG_DELETION_GRACE_DAYS
// (7) so the team can download its data or change its mind (any owner can cancel). Then a daily
// job removes every record that belongs to it — in every collection with an organizationId —
// its stored files and logo, and stops its paid plan. The platform's own GST invoices to the
// company are kept (tax law asks for them); people's sign-in accounts stay (they may belong to
// other companies).
const JOB = 'organization.purge';
const DAY_MS = 24 * 60 * 60 * 1000;
// Kept: the platform's tax records, and people's sign-in accounts (User.organizationId is only
// "the company used last"; it is cleared below).
const KEEP = new Set(['BillingInvoice', 'User']);

const managersOf = async (organizationId) => (await OrganizationMember.find({ organizationId, status: 'active', role: { $in: ['owner', 'admin'] } }).select('_id')).map((m) => m._id);
const dateText = (date) => new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

const statusOf = (organization) => (organization?.deletion?.scheduledFor
  ? { requestedAt: organization.deletion.requestedAt, scheduledFor: organization.deletion.scheduledFor }
  : null);

async function load(req) {
  const organization = await Organization.findById(req.tenant.organizationId);
  if (!organization) throw httpError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
  return organization;
}

const assertOwner = (req) => {
  if (req.member?.role !== 'owner') throw httpError(403, 'FORBIDDEN', 'Only an owner can delete or keep the company.');
};

// DELETE /organization { confirmName }
async function request(req, { confirmName }) {
  assertOwner(req);
  const organization = await load(req);
  if (organization.deletion?.scheduledFor) throw httpError(409, 'DELETION_SCHEDULED', `The company is already set to be deleted on ${dateText(organization.deletion.scheduledFor)}.`);
  if (String(confirmName || '').trim().toLowerCase() !== String(organization.name || '').trim().toLowerCase()) {
    throw httpError(400, 'VALIDATION_ERROR', 'Type the company name exactly as it is shown, to confirm.', [{ field: 'confirmName', message: 'Type the company name exactly.' }]);
  }
  const now = new Date();
  const scheduledFor = new Date(now.getTime() + env.orgDeletionGraceDays * DAY_MS);
  await Organization.updateOne({ _id: organization._id }, { $set: { deletion: { requestedAt: now, scheduledFor, requestedById: req.user._id } } });
  await audit(req, { action: 'organization.deletion_requested', entityType: 'Organization', entityId: organization._id, changes: { scheduledFor } });
  await notificationService.notify(organization._id, await managersOf(organization._id), {
    title: `${organization.name} will be deleted on ${dateText(scheduledFor)}`,
    body: `${req.user.name || 'An owner'} asked to delete the company and all its data. Download the data in Settings → Data & Privacy; an owner can cancel until then.`,
    link: 'Settings.html?tab=data', source: 'organization',
  }).catch((error) => logger.error(`Deletion note failed: ${error.message}`));
  return { requestedAt: now, scheduledFor };
}

// POST /organization/deletion/cancel
async function cancel(req) {
  assertOwner(req);
  const organization = await load(req);
  if (!organization.deletion?.scheduledFor) throw httpError(409, 'NOT_SCHEDULED', 'The company is not set to be deleted.');
  await Organization.updateOne({ _id: organization._id }, { $unset: { deletion: 1 } });
  await audit(req, { action: 'organization.deletion_cancelled', entityType: 'Organization', entityId: organization._id });
  await notificationService.notify(organization._id, await managersOf(organization._id), {
    title: `${organization.name} will not be deleted`, body: `${req.user.name || 'An owner'} cancelled the deletion.`, link: 'Settings.html?tab=data', source: 'organization',
  }).catch((error) => logger.error(`Deletion note failed: ${error.message}`));
  return null;
}

// Removes everything of one organization whose time has come. → { collections, documents }
async function purge(organizationId, now = new Date()) {
  const organization = await Organization.findById(organizationId);
  if (!organization?.deletion?.scheduledFor || organization.deletion.scheduledFor > now) return null;
  const id = new mongoose.Types.ObjectId(String(organizationId));

  // The paid plan stops (best effort: the gateway may be unreachable; the records go anyway).
  try {
    await require('./billingService').cancelForDeletion(organization); // eslint-disable-line global-require
  } catch (error) {
    logger.warn(`Stopping the plan of deleted organization ${id} failed: ${error.message}`);
  }
  // Stored files (documents, WhatsApp media, quotation PDFs) and the logo.
  await documentStorage.removeOrganization(id);
  if (organization.logoUrl) {
    await require('./organizationService').removeStoredLogo(organization.logoUrl).catch(() => {}); // eslint-disable-line global-require
  }
  // Every record that carries this organization's id, soft-deleted ones too. All model files are
  // loaded first, so no collection is missed.
  const modelsDir = path.join(__dirname, '..', 'models');
  fs.readdirSync(modelsDir).filter((file) => file.endsWith('.js')).forEach((file) => require(path.join(modelsDir, file))); // eslint-disable-line global-require
  let documents = 0;
  let collections = 0;
  for (const name of mongoose.modelNames()) {
    const Model = mongoose.model(name);
    if (KEEP.has(name) || name === 'Organization' || !Model.schema.path('organizationId')) continue;
    const { deletedCount } = await Model.collection.deleteMany({ organizationId: id });
    documents += deletedCount;
    collections += 1;
  }
  await User.updateMany({ organizationId: id }, { $unset: { organizationId: 1 } });
  await Organization.collection.deleteOne({ _id: id });
  logger.info(`Organization ${id} deleted after its grace period: ${documents} records in ${collections} collections`);
  return { collections, documents };
}

async function purgeDue() {
  const due = await Organization.find({ 'deletion.scheduledFor': { $lte: new Date() } }).select('_id').limit(20);
  for (const { _id } of due) {
    try {
      await purge(_id);
    } catch (error) {
      logger.error(`Deleting organization ${_id} failed (tried again later): ${error.message}`);
    }
  }
}

function register(queue) {
  queue.define(JOB, () => purgeDue(), { maxAttempts: 2 });
  queue.every(JOB, 6 * 60 * 60 * 1000).catch((error) => logger.error(`Scheduling ${JOB} failed: ${error.message}`));
}

module.exports = { JOB, request, cancel, statusOf, purge, purgeDue, register, KEEP };
