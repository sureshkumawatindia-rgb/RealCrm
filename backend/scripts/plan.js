/**
 * The platform owner's plan command (Phase 10F): see every company's plan, comp one, give a
 * longer trial, or change a plan by hand (e.g. a company that paid by bank transfer).
 * Uses backend/.env (MONGO_URI); prints no secrets.
 *
 *   node scripts/plan.js list
 *   node scripts/plan.js comp  <organizationId>                complimentary: its plan, no end date
 *   node scripts/plan.js trial <organizationId> <days>         a trial ending <days> from now
 *   node scripts/plan.js set   <organizationId> <starter|pro|growth|scale>
 */
const mongoose = require('mongoose');
const env = require('../src/config/env');
const Organization = require('../src/models/Organization');
const OrganizationMember = require('../src/models/OrganizationMember');
require('../src/models/User');
const { PLAN_KEYS } = require('../src/constants/plans');
const planService = require('../src/services/planService');

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (date) => (date ? new Date(date).toISOString().slice(0, 10) : '');

async function list() {
  const organizations = await Organization.find().sort({ createdAt: 1 }).select('name plan subscription deletion createdAt');
  for (const organization of organizations) {
    const owner = await OrganizationMember.findOne({ organizationId: organization._id, role: 'owner', status: 'active' }).populate({ path: 'userId', select: 'email' });
    const state = planService.subscriptionOf(organization);
    const until = state.status === 'trialing' ? `trial until ${day(state.trialEndsAt)}` : state.currentPeriodEnd ? `until ${day(state.currentPeriodEnd)}` : '';
    console.log([
      String(organization._id), organization.plan.padEnd(7), state.status.padEnd(9), until.padEnd(22),
      organization.deletion?.scheduledFor ? `DELETION ${day(organization.deletion.scheduledFor)}` : '',
      `${organization.name} (${owner?.userId?.email || 'no owner'})`,
    ].join('  '));
  }
  console.log(`${organizations.length} companies`);
}

async function find(id) {
  if (!mongoose.isValidObjectId(id)) throw new Error('Give the organization id (24 characters) from "list".');
  const organization = await Organization.findById(id);
  if (!organization) throw new Error('No company with that id.');
  return organization;
}

async function main([command, id, value]) {
  await mongoose.connect(env.mongoUri);
  try {
    if (command === 'list') return await list(); // awaited before the connection closes
    const organization = await find(id);
    if (command === 'comp') {
      await Organization.updateOne({ _id: organization._id }, { $set: { 'subscription.status': 'comped', 'subscription.since': new Date() } });
    } else if (command === 'trial') {
      const days = Number(value);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Give the trial length in days (1-365).');
      await Organization.updateOne({ _id: organization._id }, { $set: { 'subscription.status': 'trialing', 'subscription.trialEndsAt': new Date(Date.now() + days * DAY_MS), 'subscription.since': new Date() }, $unset: { 'subscription.remindedFor': 1 } });
    } else if (command === 'set') {
      if (!PLAN_KEYS.includes(value)) throw new Error(`The plan is one of: ${PLAN_KEYS.join(', ')}.`);
      await Organization.updateOne({ _id: organization._id }, { $set: { plan: value } });
    } else {
      throw new Error('Commands: list | comp <id> | trial <id> <days> | set <id> <plan>');
    }
    const after = await Organization.findById(organization._id);
    console.log(`${after.name}: ${after.plan}, ${planService.subscriptionOf(after).status}`);
    return undefined;
  } finally {
    await mongoose.disconnect();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
