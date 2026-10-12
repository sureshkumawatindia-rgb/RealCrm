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
    expect(mine.plan).toMatchObject({ key: 'growth', name: 'Growth', pricePaise: 499900, gstPaise: 89982, totalPaise: 589882 });
    expect(mine.subscription).toMatchObject({ status: 'trialing', locked: false, daysLeft: 30 });
    const usage = Object.fromEntries(mine.usage.map((meter) => [meter.metric, meter]));
    expect(usage.users).toMatchObject({ used: 2, limit: 30, left: 28 });
    expect(usage.agents).toMatchObject({ used: 1, limit: 20, left: 19 });
    expect(usage.templates).toMatchObject({ limit: null, left: null });
    const theirs = (await api().get('/api/v1/billing/subscription').set(bearer(agent.token))).body.data;
    expect(theirs.subscription.status).toBe('trialing');
    expect(theirs.usage).toBeUndefined();

    const catalog = (await api().get('/api/v1/billing/plans').set(bearer(agent.token))).body.data;
    expect(catalog.plans.map((p) => p.key)).toEqual(['starter', 'pro', 'growth', 'scale', 'infinite']);
    expect(catalog.plans[0]).toMatchObject({ limits: { users: 8, agents: 8, templates: 100, quotesPerMonth: 2000, contacts: 6000, broadcastsPerMonth: 20 }, features: { paymentLinks: true, agentNumbers: false, api: false } });
    expect(catalog.plans.map((p) => p.pricePaise)).toEqual([79900, 249900, 499900, 849900, 1499900]);
    expect(catalog.plans.map((p) => p.limits.users)).toEqual([8, 16, 30, 50, null]);
    expect(catalog.plans.map((p) => p.limits.agents)).toEqual([8, 12, 20, 40, null]);
    // A number per agent, up to Meta's 20 for one business.
    expect(catalog.plans.map((p) => p.limits.whatsappNumbers)).toEqual([8, 12, 20, 20, 20]);
    expect(catalog.plans[4]).toMatchObject({ name: 'Infinite', limits: { contacts: null, broadcastsPerMonth: null, quotesPerMonth: null, templates: null }, features: { api: true, agentNumbers: true } });
    expect(catalog.limits.map((l) => l.metric)).toContain('agents');
    expect(catalog.included).toContain('WhatsApp for every user: the whole team replies from the shared inbox');
    expect(catalog).toMatchObject({ gstPct: 18, trialDays: 30 });
  });

  it('keeps a Starter company inside its seats, numbers, templates, quotations and features', async () => {
    const owner = await login('starter-owner@example.com', { name: 'Bina' });
    const org = await orgOf(owner);
    await setPlan(org, 'starter');
    const invite = (email) => api().post('/api/v1/invites').set(bearer(owner.token)).send({ email, role: 'agent' });

    // Users: the owner + seven more (a pending invite holds the seat; sending it again is fine).
    const first = await invite('s-1@example.com');
    expect(first.status).toBe(201);
    expect((await invite('s-1@example.com')).status).toBe(201);
    for (let i = 2; i <= 7; i += 1) expect((await invite(`s-${i}@example.com`)).status).toBe(201);
    const refused = await invite('s-8@example.com');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'PLAN_LIMIT', message: 'The Starter plan allows 8 users, and you have 8. Upgrade in Settings → Plan & usage.' });
    await api().delete(`/api/v1/invites/${first.body.data.invite.id}`).set(bearer(owner.token));
    expect((await invite('s-8@example.com')).status).toBe(201);

    // A WhatsApp number per agent: 8 (an agent's own number needs Pro).
    const number = await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    expect(number.status).toBe(201);
    for (let i = 2; i <= 8; i += 1) expect((await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' })).status).toBe(201);
    expect((await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' })).body.code).toBe('PLAN_LIMIT');
    const own = await api().patch(`/api/v1/whatsapp/accounts/${number.body.data.id}`).set(bearer(owner.token)).send({ agentMemberId: owner.data.member.id });
    expect(own.body).toMatchObject({ code: 'PLAN_LIMIT', message: "An agent's own WhatsApp number comes with the Pro plan and above (you are on Starter). Upgrade in Settings → Plan & usage." });

    // 100 templates.
    await MessageTemplate.insertMany(Array.from({ length: 100 }, (_, i) => ({ organizationId: org._id, whatsappAccountId: new mongoose.Types.ObjectId(), name: `t_${i}`, language: 'en', category: 'UTILITY', status: 'APPROVED' })));
    const template = await api().post('/api/v1/templates').set(bearer(owner.token)).send({ name: 'one_more', language: 'en', category: 'UTILITY', bodyText: 'Hi' });
    expect(template.body).toMatchObject({ code: 'PLAN_LIMIT' });

    // 2,000 quotations a month (twice BizNuma's 1,000, D69): last month's do not count.
    const contact = (await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Ravi Traders' })).body.data;
    const filler = (i, createdAt) => ({ organizationId: org._id, number: `OLD-${createdAt.getTime()}-${i}`, createdAt, deletedAt: null });
    await Quotation.collection.insertMany(Array.from({ length: 1999 }, (_, i) => filler(i, new Date())));
    await Quotation.collection.insertMany(Array.from({ length: 5 }, (_, i) => filler(i, new Date(Date.now() - 40 * DAY))));
    const quote = (await api().post('/api/v1/quotations').set(bearer(owner.token)).send({ contactId: contact.id, items: [{ name: 'Jeera', quantity: 1, unitPricePaise: 10000 }] }));
    expect(quote.status).toBe(201);
    const over = await api().post('/api/v1/quotations').set(bearer(owner.token)).send({ contactId: contact.id, items: [{ name: 'Jeera', quantity: 1, unitPricePaise: 10000 }] });
    expect(over.body).toMatchObject({ code: 'PLAN_LIMIT', message: "The Starter plan allows 2,000 quotations a month, and this month's are used up. Upgrade in Settings → Plan & usage." });

    // Features of bigger plans.
    const workflow = await api().post('/api/v1/workflows').set(bearer(owner.token)).send({ name: 'Flow', trigger: { type: 'lead.created' }, steps: [{ type: 'tag.add', params: { tag: 'new' } }] });
    expect(workflow.body).toMatchObject({ code: 'PLAN_LIMIT', message: 'Automation workflows come with the Growth plan and above (you are on Starter). Upgrade in Settings → Plan & usage.' });
    const catalogSync = await api().post('/api/v1/products/whatsapp-catalog/sync').set(bearer(owner.token)).send({});
    expect(catalogSync.body).toMatchObject({ code: 'PLAN_LIMIT', message: 'The WhatsApp catalog comes with the Pro plan and above (you are on Starter). Upgrade in Settings → Plan & usage.' });

    // The meters say the same.
    const usage = Object.fromEntries((await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data.usage.map((m) => [m.metric, m]));
    expect(usage).toMatchObject({ users: { used: 8, limit: 8, left: 0 }, agents: { used: 7, limit: 8, left: 1 }, whatsappNumbers: { used: 8, limit: 8 }, templates: { used: 100, limit: 100 }, quotesPerMonth: { used: 2000, limit: 2000, left: 0 }, contacts: { used: 1, limit: 6000 } });
  }, 60000);

  it('stops contacts by hand and imports at the limit, never WhatsApp messages', async () => {
    const owner = await login('full-owner@example.com', { name: 'Chetan' });
    const org = await orgOf(owner);
    await setPlan(org, 'starter');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    await Contact.collection.insertMany(Array.from({ length: 5999 }, (_, i) => ({ organizationId: org._id, name: `C${i}`, deletedAt: null, createdAt: new Date() })));

    // Two new people in a file, room for one: the whole file is refused (no half import).
    const csv = 'name,phone\nAmit,9829010001\nBela,9829010002\n';
    const imported = await api().post('/api/v1/contacts/import').set(bearer(owner.token))
      .attach('file', Buffer.from(csv, 'utf8'), 'people.csv').field('mapping', JSON.stringify(['name', 'phone']));
    expect(imported.status).toBe(403);
    expect(imported.body.message).toBe('The Starter plan allows 6,000 contacts; you have room for 1 more (5,999 used), not 2. Upgrade in Settings → Plan & usage.');
    expect(await Contact.countDocuments({ organizationId: org._id })).toBe(5999);

    expect((await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Last one' })).status).toBe(201);
    expect((await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Too many' })).body.code).toBe('PLAN_LIMIT');
    expect((await api().post('/api/v1/leads').set(bearer(owner.token)).send({ title: 'New lead', contact: { name: 'Deepa', phone: '9829010003' } })).body.code).toBe('PLAN_LIMIT');

    // A customer who writes on WhatsApp always gets in.
    const chat = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from: '98290 10004', name: 'Esha', text: 'Hi' });
    expect(chat.status).toBe(201);
    expect(await Contact.countDocuments({ organizationId: org._id })).toBe(6001);
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

  it('counts agents inside the users: an agent seat for each agent, viewers only need a user seat (D68)', async () => {
    const owner = await login('agents-owner@example.com', { name: 'Kavita' });
    const org = await orgOf(owner);
    await setPlan(org, 'pro'); // 16 users, 12 agents
    const invite = (email, role) => api().post('/api/v1/invites').set(bearer(owner.token)).send({ email, role });
    for (let i = 1; i <= 12; i += 1) expect((await invite(`agent-${i}@example.com`, 'agent')).status).toBe(201);
    const thirteenth = await invite('agent-13@example.com', 'agent');
    expect(thirteenth.status).toBe(403);
    expect(thirteenth.body).toMatchObject({ code: 'PLAN_LIMIT', message: 'The Pro plan allows 12 agents, and you have 12. Upgrade in Settings → Plan & usage.' });
    // A viewer still fits (13 of 16 users), and a pending agent invite sent again keeps its seat.
    const viewer = await inviteAndJoin(owner.token, 'pro-viewer@example.com', { role: 'viewer' });
    expect((await invite('agent-1@example.com', 'agent')).status).toBe(201);
    // Making someone an agent takes an agent seat too.
    const promote = await api().patch(`/api/v1/members/${viewer.data.member.id}`).set(bearer(owner.token)).send({ role: 'agent' });
    expect(promote.body).toMatchObject({ code: 'PLAN_LIMIT', message: 'The Pro plan allows 12 agents, and you have 12. Upgrade in Settings → Plan & usage.' });

    // Infinite: no limit on users, agents, contacts, broadcasts, quotations or templates; 20 numbers.
    await setPlan(org, 'infinite');
    expect((await invite('agent-13@example.com', 'agent')).status).toBe(201);
    expect((await api().patch(`/api/v1/members/${viewer.data.member.id}`).set(bearer(owner.token)).send({ role: 'agent' })).status).toBe(200);
    const usage = Object.fromEntries((await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data.usage.map((m) => [m.metric, m]));
    expect(usage).toMatchObject({ users: { limit: null }, agents: { used: 14, limit: null }, whatsappNumbers: { limit: 20 }, contacts: { limit: null } });
  }, 60000);

  it('turning a disabled member back on needs a free seat', async () => {
    const owner = await login('seat-owner@example.com', { name: 'Gita' });
    const agent = await inviteAndJoin(owner.token, 'seat-agent@example.com', { role: 'agent' });
    const org = await orgOf(owner);
    const member = await OrganizationMember.findById(agent.data.member.id);
    await api().patch(`/api/v1/members/${member._id}`).set(bearer(owner.token)).send({ status: 'disabled' });
    await setPlan(org, 'starter');
    // The owner + 7 invites fill Starter's 8 seats.
    for (let i = 1; i <= 7; i += 1) {
      expect((await api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: `seat-new${i}@example.com`, role: 'viewer' })).status).toBe(201);
    }
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
