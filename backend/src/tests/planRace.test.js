jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const Contact = require('../models/Contact');
const Quotation = require('../models/Quotation');
const Invite = require('../models/Invite');
const PlanLock = require('../models/PlanLock');
const planLock = require('../services/planLockService');
const { api, bearer, login } = require('./helpers/api');

// Phase 3B (D81): a limit holds when many adds arrive at the same moment.
const setStarter = (organizationId) => Organization.updateOne({ _id: organizationId }, { $set: { plan: 'starter', subscription: { status: 'active' } } });
const codes = (responses) => responses.map((r) => (r.status === 201 ? 'ok' : r.body.code)).sort();

describe('Plan limits under parallel requests (Phase 3B)', () => {
  it('lets exactly the room left through when contacts are added at the same moment', async () => {
    const owner = await login('race-contacts@example.com', { name: 'Hema' });
    const organizationId = new mongoose.Types.ObjectId(owner.data.organizationId);
    await setStarter(organizationId);
    await Contact.collection.insertMany(Array.from({ length: 5997 }, (_, i) => ({ organizationId, name: `C ${i}`, deletedAt: null })));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: `Parallel ${i}` })));
    expect(codes(results)).toEqual(['PLAN_LIMIT', 'PLAN_LIMIT', 'PLAN_LIMIT', 'PLAN_LIMIT', 'PLAN_LIMIT', 'ok', 'ok', 'ok']);
    expect(await Contact.countDocuments({ organizationId })).toBe(6000);
    expect(await PlanLock.countDocuments()).toBe(0); // every hold was let go
  });

  it('holds the monthly quotation limit and the team seats', async () => {
    const owner = await login('race-quotes@example.com', { name: 'Indu' });
    const organizationId = new mongoose.Types.ObjectId(owner.data.organizationId);
    await setStarter(organizationId);
    const contact = (await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Ravi Traders' })).body.data;
    await Quotation.collection.insertMany(Array.from({ length: 1998 }, (_, i) => ({ organizationId, number: `F-${i}`, createdAt: new Date(), deletedAt: null })));
    const quote = () => api().post('/api/v1/quotations').set(bearer(owner.token)).send({ contactId: contact.id, items: [{ name: 'Jeera', quantity: 1, unitPricePaise: 10000 }] });
    expect(codes(await Promise.all(Array.from({ length: 5 }, quote)))).toEqual(['PLAN_LIMIT', 'PLAN_LIMIT', 'PLAN_LIMIT', 'ok', 'ok']);
    expect(await Quotation.collection.countDocuments({ organizationId })).toBe(2000);

    // 8 users on Starter: the owner + 5 invites, then 4 at once → 2 more.
    for (let i = 0; i < 5; i += 1) expect((await api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: `seat-${i}@example.com`, role: 'agent' })).status).toBe(201);
    const invites = await Promise.all(Array.from({ length: 4 }, (_, i) => api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: `rush-${i}@example.com`, role: 'agent' })));
    expect(codes(invites)).toEqual(['PLAN_LIMIT', 'PLAN_LIMIT', 'ok', 'ok']);
    expect(await Invite.countDocuments({ organizationId, status: 'pending' })).toBe(7);
  });

  it('takes over a hold whose server stopped, and says "busy" rather than waiting for ever', async () => {
    const owner = await login('race-stale@example.com', { name: 'Jaya' });
    const organizationId = owner.data.organizationId;
    // A hold left by a server that stopped mid-add: its lease ended, so the next add takes it.
    await PlanLock.create({ _id: `${organizationId}:contacts`, holder: 'gone', expireAt: new Date(Date.now() - 1000) });
    expect((await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'After a crash' })).status).toBe(201);

    // A live hold: another add waits, and gives up with PLAN_BUSY when it is held too long.
    const held = await planLock.acquire(`${organizationId}:templates`, { leaseMs: 5000 });
    await expect(planLock.acquire(`${organizationId}:templates`, { waitMs: 150 })).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_BUSY' });
    await planLock.release(held);
    const next = await planLock.acquire(`${organizationId}:templates`, { waitMs: 150 });
    expect(next.holder).not.toBe(held.holder);
    await planLock.release(next);
    // Releasing someone else's hold does nothing.
    const mine = await planLock.acquire(`${organizationId}:templates`);
    await planLock.release({ key: mine.key, holder: 'someone-else' });
    expect(await PlanLock.exists({ _id: mine.key })).toBeTruthy();
    await planLock.release(mine);
  });
});
