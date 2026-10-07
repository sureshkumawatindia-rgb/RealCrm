jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Contact = require('../models/Contact');
const MessageTemplate = require('../models/MessageTemplate');
const Quotation = require('../models/Quotation');
const migration = require('../migrations/005-subscriptions');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const DAY = 24 * 60 * 60 * 1000;
const orgOf = (user) => Organization.findById(user.data.organizationId);
const setPlan = (organization, plan, subscription = { status: 'active' }) => Organization.updateOne({ _id: organization._id }, { $set: { plan, subscription } });

describe('Plans, limits and the trial (Phase 10A)', () => {
  it('starts a new company on a 30-day Growth trial and shows the usage to managers only', async () => {
    const owner = await login('plan-owner@example.com', { name: 'Asha' });
    const agent = await inviteAndJoin(owner.token, 'plan-agent@example.com', { role: 'agent' });
    const mine = (await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data;
    expect(mine.plan).toMatchObject({ key: 'growth', name: 'Growth', pricePaise: 599900, gstPaise: 107982, totalPaise: 707882 });
    expect(mine.subscription).toMatchObject({ status: 'trialing', locked: false, daysLeft: 30 });
    const usage = Object.fromEntries(mine.usage.map((meter) => [meter.metric, meter]));
    expect(usage.users).toMatchObject({ used: 2, limit: 10, left: 8 });
    expect(usage.templates).toMatchObject({ limit: null, left: null });
    const theirs = (await api().get('/api/v1/billing/subscription').set(bearer(agent.token))).body.data;
    expect(theirs.subscription.status).toBe('trialing');
    expect(theirs.usage).toBeUndefined();

    const catalog = (await api().get('/api/v1/billing/plans').set(bearer(agent.token))).body.data;
    expect(catalog.plans.map((p) => p.key)).toEqual(['starter', 'pro', 'growth', 'scale']);
    expect(catalog.plans[0]).toMatchObject({ limits: { users: 2, templates: 50, quotesPerMonth: 300 }, features: { paymentLinks: false, api: false } });
    expect(catalog).toMatchObject({ gstPct: 18, trialDays: 30 });
  });

  it('keeps a Starter company inside its seats, numbers, templates, quotations and features', async () => {
    const owner = await login('starter-owner@example.com', { name: 'Bina' });
    const org = await orgOf(owner);
    await setPlan(org, 'starter');
    const invite = (email) => api().post('/api/v1/invites').set(bearer(owner.token)).send({ email, role: 'agent' });

    // Users: the owner + one more (a pending invite holds the seat; sending it again is fine).
    const first = await invite('s-one@example.com');
    expect(first.status).toBe(201);
    expect((await invite('s-one@example.com')).status).toBe(201);
    const refused = await invite('s-two@example.com');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'PLAN_LIMIT', message: 'The Starter plan allows 2 users, and you have 2. Upgrade in Settings → Plan & usage.' });
    await api().delete(`/api/v1/invites/${first.body.data.invite.id}`).set(bearer(owner.token));
    expect((await invite('s-two@example.com')).status).toBe(201);

    // One WhatsApp number.
    expect((await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' })).status).toBe(201);
    expect((await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' })).body.code).toBe('PLAN_LIMIT');

    // 50 templates.
    await MessageTemplate.insertMany(Array.from({ length: 50 }, (_, i) => ({ organizationId: org._id, whatsappAccountId: new mongoose.Types.ObjectId(), name: `t_${i}`, language: 'en', category: 'UTILITY', status: 'APPROVED' })));
    const template = await api().post('/api/v1/templates').set(bearer(owner.token)).send({ name: 'one_more', language: 'en', category: 'UTILITY', bodyText: 'Hi' });
    expect(template.body).toMatchObject({ code: 'PLAN_LIMIT' });

    // 300 quotations a month: last month's do not count.
    const contact = (await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Ravi Traders' })).body.data;
    const filler = (i, createdAt) => ({ organizationId: org._id, number: `OLD-${createdAt.getTime()}-${i}`, createdAt, deletedAt: null });
    await Quotation.collection.insertMany(Array.from({ length: 299 }, (_, i) => filler(i, new Date())));
    await Quotation.collection.insertMany(Array.from({ length: 5 }, (_, i) => filler(i, new Date(Date.now() - 40 * DAY))));
    const quote = (await api().post('/api/v1/quotations').set(bearer(owner.token)).send({ contactId: contact.id, items: [{ name: 'Jeera', quantity: 1, unitPricePaise: 10000 }] }));
    expect(quote.status).toBe(201);
    const over = await api().post('/api/v1/quotations').set(bearer(owner.token)).send({ contactId: contact.id, items: [{ name: 'Jeera', quantity: 1, unitPricePaise: 10000 }] });
    expect(over.body).toMatchObject({ code: 'PLAN_LIMIT', message: "The Starter plan allows 300 quotations a month, and this month's are used up. Upgrade in Settings → Plan & usage." });

    // Features of bigger plans.
    const workflow = await api().post('/api/v1/workflows').set(bearer(owner.token)).send({ name: 'Flow', trigger: { type: 'lead.created' }, steps: [{ type: 'tag.add', params: { tag: 'new' } }] });
    expect(workflow.body).toMatchObject({ code: 'PLAN_LIMIT', message: 'Automation workflows come with the Growth plan and above (you are on Starter). Upgrade in Settings → Plan & usage.' });
    const link = await api().post('/api/v1/payment-links').set(bearer(owner.token)).send({ contactId: contact.id, amountPaise: 50000 });
    expect(link.body).toMatchObject({ code: 'PLAN_LIMIT', message: 'Payment links come with the Pro plan and above (you are on Starter). Upgrade in Settings → Plan & usage.' });

    // The meters say the same.
    const usage = Object.fromEntries((await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data.usage.map((m) => [m.metric, m]));
    expect(usage).toMatchObject({ users: { used: 2, limit: 2, left: 0 }, whatsappNumbers: { used: 1, limit: 1 }, templates: { used: 50, limit: 50 }, quotesPerMonth: { used: 300, limit: 300, left: 0 }, contacts: { used: 1, limit: 3000 } });
  }, 60000);

  it('stops contacts by hand and imports at the limit, never WhatsApp messages', async () => {
    const owner = await login('full-owner@example.com', { name: 'Chetan' });
    const org = await orgOf(owner);
    await setPlan(org, 'starter');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    await Contact.collection.insertMany(Array.from({ length: 2999 }, (_, i) => ({ organizationId: org._id, name: `C${i}`, deletedAt: null, createdAt: new Date() })));

    // Two new people in a file, room for one: the whole file is refused (no half import).
    const csv = 'name,phone\nAmit,9829010001\nBela,9829010002\n';
    const imported = await api().post('/api/v1/contacts/import').set(bearer(owner.token))
      .attach('file', Buffer.from(csv, 'utf8'), 'people.csv').field('mapping', JSON.stringify(['name', 'phone']));
    expect(imported.status).toBe(403);
    expect(imported.body.message).toBe('The Starter plan allows 3,000 contacts; you have room for 1 more (2,999 used), not 2. Upgrade in Settings → Plan & usage.');
    expect(await Contact.countDocuments({ organizationId: org._id })).toBe(2999);

    expect((await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Last one' })).status).toBe(201);
    expect((await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Too many' })).body.code).toBe('PLAN_LIMIT');
    expect((await api().post('/api/v1/leads').set(bearer(owner.token)).send({ title: 'New lead', contact: { name: 'Deepa', phone: '9829010003' } })).body.code).toBe('PLAN_LIMIT');

    // A customer who writes on WhatsApp always gets in.
    const chat = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from: '98290 10004', name: 'Esha', text: 'Hi' });
    expect(chat.status).toBe(201);
    expect(await Contact.countDocuments({ organizationId: org._id })).toBe(3001);
  }, 60000);

  it('after the trial: reading and replying work, adding things waits for a plan', async () => {
    const owner = await login('expired-owner@example.com', { name: 'Divya' });
    const org = await orgOf(owner);
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    const chat = (await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from: '98290 20001', name: 'Farhan', text: 'Rate?' })).body.data;
    await Organization.updateOne({ _id: org._id }, { $set: { 'subscription.trialEndsAt': new Date('2026-09-01T10:00:00Z') } });

    const state = (await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data.subscription;
    expect(state).toMatchObject({ status: 'expired', locked: true, wasTrial: true });
    const contact = await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'New' });
    expect(contact.status).toBe(403);
    expect(contact.body).toMatchObject({ code: 'SUBSCRIPTION_INACTIVE', message: 'Your free trial ended on 1 Sept 2026, so you cannot add contacts now. Everything you have stays available. Choose a plan in Settings → Plan & usage.' });
    expect((await api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: 'x@example.com', role: 'agent' })).body.code).toBe('SUBSCRIPTION_INACTIVE');
    expect((await api().post('/api/v1/workflows').set(bearer(owner.token)).send({ name: 'Flow', trigger: { type: 'lead.created' }, steps: [{ type: 'tag.add', params: { tag: 'new' } }] })).body.code).toBe('SUBSCRIPTION_INACTIVE');

    // Still works: lists, the chat (reading and replying), new messages from customers.
    expect((await api().get('/api/v1/contacts').set(bearer(owner.token))).status).toBe(200);
    const conversationId = chat.conversation?.id || chat.conversationId;
    expect((await api().post(`/api/v1/conversations/${conversationId}/messages`).set(bearer(owner.token)).send({ text: '₹3,000 a bag' })).status).toBe(201);
    expect((await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from: '98290 20002', text: 'Hello' })).status).toBe(201);

    // A plan unlocks it.
    await setPlan(org, 'pro', { status: 'active', currentPeriodEnd: new Date(Date.now() + 30 * DAY) });
    expect((await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'New' })).status).toBe(201);
  }, 60000);

  it('turning a disabled member back on needs a free seat', async () => {
    const owner = await login('seat-owner@example.com', { name: 'Gita' });
    const agent = await inviteAndJoin(owner.token, 'seat-agent@example.com', { role: 'agent' });
    const org = await orgOf(owner);
    const member = await OrganizationMember.findById(agent.data.member.id);
    await api().patch(`/api/v1/members/${member._id}`).set(bearer(owner.token)).send({ status: 'disabled' });
    await setPlan(org, 'starter');
    expect((await api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: 'seat-new@example.com', role: 'agent' })).status).toBe(201);
    const back = await api().patch(`/api/v1/members/${member._id}`).set(bearer(owner.token)).send({ status: 'active' });
    expect(back.body.code).toBe('PLAN_LIMIT');
  });

  it('migration 005 comps the companies from before billing, once', async () => {
    const { insertedId } = await Organization.collection.insertOne({ name: 'Old Co', plan: 'growth' });
    const trialing = await Organization.create({ name: 'New Co', subscription: { status: 'trialing', trialEndsAt: new Date(Date.now() + DAY) } });
    await migration.up();
    expect((await Organization.findById(insertedId)).subscription.status).toBe('comped');
    expect((await Organization.findById(trialing._id)).subscription.status).toBe('trialing');
    expect((await migration.up()).updated).toBe(0);
  });
});
