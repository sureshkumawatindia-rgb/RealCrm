jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

// Phase 3 (D115): the Leads and Customers lists page, search and filter on the server, and the
// pages' lead numbers come from GET /leads/summary — so a company with more records than a page
// loads (BUG-001) still sees, finds and counts every one, and "Won this month" counts by the day
// a lead was won (BUG-003).
const Lead = require('../models/Lead');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

describe('Lists and numbers at scale (D115)', () => {
  let owner;
  let agent;
  let product;
  const leads = {};

  const addLead = async (token, name, extra = {}) => {
    const res = await api().post('/api/v1/leads').set(bearer(token)).send({ contact: { name }, title: `${name} enquiry`, ...extra });
    expect(res.status).toBe(201);
    return res.body.data;
  };

  beforeAll(async () => {
    owner = await login('scale-owner@example.com');
    agent = await inviteAndJoin(owner.token, 'scale-agent@example.com', { role: 'agent' });
    product = (await api().post('/api/v1/products').set(bearer(owner.token)).send({ name: 'Basmati rice', pricePaise: 9000 })).body.data;
    const nextMonth = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();
    leads.won = await addLead(owner.token, 'Gupta Traders', { productId: product.id, expectedValuePaise: 5000000, expectedCloseDate: nextMonth, source: 'IndiaMART' });
    leads.open = await addLead(owner.token, 'Sharma Mills', { productId: product.id, expectedValuePaise: 1200000 });
    leads.lost = await addLead(owner.token, 'Verma Exports', { expectedValuePaise: 300000 });
    leads.agents = await addLead(agent.token, 'Agent Own Lead', { expectedValuePaise: 70000 });
    expect((await api().post(`/api/v1/leads/${leads.won.id}/stage`).set(bearer(owner.token)).send({ stage: 'Won' })).status).toBe(200);
    expect((await api().post(`/api/v1/leads/${leads.lost.id}/stage`).set(bearer(owner.token)).send({ stage: 'Lost', lostReason: 'Price' })).status).toBe(200);
    await Lead.updateOne({ _id: leads.open.id }, { $set: { score: { points: 82, band: 'hot', at: new Date() } } });
  });

  it('counts every lead by stage, product and owner, and won this month by the day it was won', async () => {
    const res = await api().get('/api/v1/leads/summary').set(bearer(owner.token));
    expect(res.status).toBe(200);
    const s = res.body.data;
    expect(s.total).toBe(4);
    // Won with an expected close date next month: still won this month (BUG-003).
    expect(s.wonMonth).toEqual({ count: 1, valuePaise: 5000000 });
    expect(s.open).toEqual({ count: 2, valuePaise: 1270000 });
    expect(s.stages.map((row) => row.stage)).toEqual(['New', 'Contacted', 'Quote Sent', 'Negotiation', 'Won', 'Lost']);
    expect(s.stages.find((row) => row.stage === 'Lost')).toEqual({ stage: 'Lost', count: 1, valuePaise: 300000 });
    expect(s.products).toEqual([{ productId: product.id, count: 2 }]);
    expect(s.owners.reduce((sum, row) => sum + row.count, 0)).toBe(2);

    // The agent counts only the leads they may see.
    const mine = (await api().get('/api/v1/leads/summary').set(bearer(agent.token))).body.data;
    expect(mine.total).toBe(1);
    expect(mine.open.valuePaise).toBe(70000);

    // Reports: only the leads made in the chosen days.
    const later = (await api().get('/api/v1/leads/summary?from=2020-01-01&to=2020-01-31').set(bearer(owner.token))).body.data;
    expect(later.total).toBe(0);
    expect((await api().get('/api/v1/leads/summary?from=2026-13-40').set(bearer(owner.token))).status).toBe(400);
  });

  it('filters leads by score and finds them by source, on the server', async () => {
    const hot = await api().get('/api/v1/leads?scoreBand=hot').set(bearer(owner.token));
    expect(hot.body.data.map((lead) => lead.id)).toEqual([leads.open.id]);
    expect((await api().get('/api/v1/leads?scoreBand=boiling').set(bearer(owner.token))).status).toBe(400);
    const bySource = await api().get('/api/v1/leads?q=indiamart').set(bearer(owner.token));
    expect(bySource.body.data.map((lead) => lead.id)).toEqual([leads.won.id]);
  });

  it('gives the ids of every lead and customer the search and filters match, for "select all"', async () => {
    const all = await api().get('/api/v1/leads/ids').set(bearer(owner.token));
    expect(all.status).toBe(200);
    expect(all.body.data).toMatchObject({ total: 4, max: 5000 });
    expect(all.body.data.ids).toHaveLength(4);
    const won = (await api().get('/api/v1/leads/ids?stage=Won').set(bearer(owner.token))).body.data;
    expect(won).toMatchObject({ ids: [leads.won.id], total: 1 });
    const agentsIds = (await api().get('/api/v1/leads/ids').set(bearer(agent.token))).body.data;
    expect(agentsIds.ids).toEqual([leads.agents.id]);

    // Customers: Gupta Traders became a customer when the lead was won.
    const customers = (await api().get('/api/v1/contacts/ids?lifecycle=customer&q=gupta').set(bearer(owner.token))).body.data;
    expect(customers).toMatchObject({ ids: [leads.won.contactId], total: 1 });
    expect((await api().get('/api/v1/contacts/ids?lifecycle=nobody').set(bearer(owner.token))).status).toBe(400);
  });
});
