jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const env = require('../config/env');
const Organization = require('../models/Organization');
const User = require('../models/User');
const BillingInvoice = require('../models/BillingInvoice');
const deletion = require('../services/organizationDeletionService');
const mock = require('../integrations/billing/mock');
const queue = require('../jobs/queue');
const billing = require('../services/billingService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const DAY = 24 * 60 * 60 * 1000;
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    await queue.runDue();
  }
};

describe('Audit log viewer (Phase 10F)', () => {
  it('shows owners and admins who did what, with filters, in their company only', async () => {
    const owner = await login('audit-owner@example.com', { name: 'Asha' });
    const agent = await inviteAndJoin(owner.token, 'audit-agent@example.com', { role: 'agent', modules: ['customers'] });
    await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Ravi Traders' });
    await api().post('/api/v1/contacts').set(bearer(agent.token)).send({ name: 'Kiran Stores' });
    const stranger = await login('audit-stranger@example.com');
    await api().post('/api/v1/contacts').set(bearer(stranger.token)).send({ name: 'Theirs' });

    expect((await api().get('/api/v1/audit-logs').set(bearer(agent.token))).status).toBe(403);
    const all = await api().get('/api/v1/audit-logs?limit=100').set(bearer(owner.token));
    expect(all.status).toBe(200);
    expect(all.body.data.map((e) => e.action)).toEqual(expect.arrayContaining(['contact.created', 'invite.created', 'auth.login']));
    expect(all.body.data.some((e) => e.changes && JSON.stringify(e.changes).includes('Theirs'))).toBe(false);
    const contacts = (await api().get('/api/v1/audit-logs?action=contact.').set(bearer(owner.token))).body;
    expect(contacts.data.map((e) => e.actor.name).sort()).toEqual(['Asha', 'audit-agent']);
    expect(contacts.pagination).toMatchObject({ total: 2 });
    const agentUser = await User.findOne({ email: 'audit-agent@example.com' });
    expect((await api().get(`/api/v1/audit-logs?actorUserId=${agentUser._id}&action=contact`).set(bearer(owner.token))).body.data).toHaveLength(1);
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    expect((await api().get(`/api/v1/audit-logs?from=${today}&to=${today}&action=contact`).set(bearer(owner.token))).body.data).toHaveLength(2);
    expect((await api().get('/api/v1/audit-logs?from=2020-01-01&to=2020-01-02').set(bearer(owner.token))).body.data).toEqual([]);
    const meta = (await api().get('/api/v1/audit-logs/meta').set(bearer(owner.token))).body.data;
    expect(meta.areas).toEqual(expect.arrayContaining(['auth', 'contact', 'invite']));
    expect(meta.people.map((p) => p.email).sort()).toEqual(['audit-agent@example.com', 'audit-owner@example.com']);
  });
});

describe('Deleting a company (Phase 10F)', () => {
  it('waits the grace period (cancellable), then removes everything of that company only', async () => {
    const owner = await login('del-owner@example.com', { name: 'Bina' });
    const admin = await inviteAndJoin(owner.token, 'del-admin@example.com', { role: 'admin' });
    const other = await login('del-other@example.com', { name: 'Other' });
    const orgId = owner.data.organizationId;
    await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ name: 'Bina Traders' });
    // Some data in many places: customers, leads, WhatsApp, documents, keys, a paid plan, an invoice.
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from: '9829011111', name: 'Ravi', text: 'Rate?' });
    await api().post('/api/v1/leads').set(bearer(owner.token)).send({ title: 'Jeera', contact: { name: 'Kiran', phone: '9829022222' } });
    const doc = await api().post('/api/v1/documents').set(bearer(owner.token)).field('name', 'Contract').attach('file', Buffer.from('signed'), 'contract.pdf');
    expect(doc.status).toBe(201);
    const folder = path.join(path.resolve(env.documentDir), orgId);
    expect(fs.existsSync(folder)).toBe(true);
    await api().post('/api/v1/api-keys').set(bearer(owner.token)).send({ name: 'ERP', scopes: ['contacts:read'] });
    billing.register(queue);
    await Organization.updateOne({ _id: orgId }, { $set: { 'subscription.trialEndsAt': new Date(Date.now() - DAY) } });
    const { checkoutUrl } = (await api().post('/api/v1/billing/checkout').set(bearer(owner.token)).send({ plan: 'pro' })).body.data;
    await api().post(new URL(checkoutUrl).pathname).type('form').send({ action: 'pay' });
    await settle();
    expect(await BillingInvoice.countDocuments({ organizationId: orgId })).toBe(1);
    await api().post('/api/v1/contacts').set(bearer(other.token)).send({ name: 'Not theirs to delete' });

    // Only an owner, and only with the exact name.
    expect((await api().delete('/api/v1/organization').set(bearer(admin.token)).send({ confirmName: 'Bina Traders' })).status).toBe(403);
    expect((await api().delete('/api/v1/organization').set(bearer(owner.token)).send({ confirmName: 'Bina' })).body.code).toBe('VALIDATION_ERROR');
    const asked = await api().delete('/api/v1/organization').set(bearer(owner.token)).send({ confirmName: ' bina traders ' });
    expect(asked.status).toBe(200);
    const scheduledFor = new Date(asked.body.data.scheduledFor);
    expect(scheduledFor - Date.now()).toBeGreaterThan(6.9 * DAY);
    expect((await api().get('/api/v1/organization/deletion').set(bearer(admin.token))).body.data.scheduledFor).toBe(asked.body.data.scheduledFor);
    expect((await api().get('/api/v1/billing/subscription').set(bearer(admin.token))).body.data.deletion).toMatchObject({ scheduledFor: asked.body.data.scheduledFor });
    expect((await api().delete('/api/v1/organization').set(bearer(owner.token)).send({ confirmName: 'Bina Traders' })).body.code).toBe('DELETION_SCHEDULED');
    // Nothing happens before the date; an owner can change their mind.
    await deletion.purgeDue();
    expect(await Organization.exists({ _id: orgId })).toBeTruthy();
    expect((await api().post('/api/v1/organization/deletion/cancel').set(bearer(owner.token))).status).toBe(200);
    expect((await api().get('/api/v1/organization/deletion').set(bearer(owner.token))).body.data).toBeNull();

    // Asked again; the waiting period passes; the job removes it all.
    await api().delete('/api/v1/organization').set(bearer(owner.token)).send({ confirmName: 'Bina Traders' });
    await Organization.updateOne({ _id: orgId }, { $set: { 'deletion.scheduledFor': new Date(Date.now() - 1000) } });
    const subscriptionId = (await Organization.findById(orgId)).subscription.providerSubscriptionId;
    await deletion.purgeDue();
    expect(await Organization.exists({ _id: orgId })).toBeNull();
    const id = new mongoose.Types.ObjectId(orgId);
    const left = [];
    for (const name of mongoose.modelNames()) {
      const Model = mongoose.model(name);
      if (!Model.schema.path('organizationId')) continue;
      const count = await Model.collection.countDocuments({ organizationId: id });
      if (count) left.push(`${name}: ${count}`);
    }
    expect(left).toEqual(['BillingInvoice: 1']); // the platform's tax record stays
    expect(fs.existsSync(folder)).toBe(false);
    expect(mock.get(subscriptionId).status).toBe('cancelled');
    // The people stay (they may belong to other companies); the other company is untouched.
    expect((await User.findOne({ email: 'del-owner@example.com' })).organizationId).toBeUndefined();
    expect((await api().get('/api/v1/contacts').set(bearer(other.token))).body.data.map((c) => c.name)).toEqual(['Not theirs to delete']);
    // Signing in again starts afresh.
    const again = await login('del-owner@example.com', { name: 'Bina' });
    expect(again.data.organizationId).not.toBe(orgId);
  }, 60000);
});
