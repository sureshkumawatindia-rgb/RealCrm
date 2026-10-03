jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

describe('Campaigns', () => {
  let owner;
  beforeAll(async () => { owner = await login('campaigns-owner@example.com', { name: 'Maya' }); });
  const create = (token, body) => api().post('/api/v1/campaigns').set(bearer(token)).send(body);

  it('saves a campaign with its budget in paise and checks the dates', async () => {
    const res = await create(owner.token, { name: 'Diwali SMS', type: 'SMS', status: 'Scheduled', startDate: '2026-10-15', endDate: '2026-11-05', budgetPaise: 500000, leadsGenerated: 12, audience: 'Old buyers' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Diwali SMS', type: 'SMS', status: 'Scheduled', startDate: '2026-10-15', endDate: '2026-11-05', budgetPaise: 500000, leadsGenerated: 12 });

    const wrongOrder = await api().patch(`/api/v1/campaigns/${res.body.data.id}`).set(bearer(owner.token)).send({ endDate: '2026-10-01' });
    expect(wrongOrder.status).toBe(400);
    expect(wrongOrder.body.errors[0].code).toBe('END_BEFORE_START');
    const cleared = await api().patch(`/api/v1/campaigns/${res.body.data.id}`).set(bearer(owner.token)).send({ endDate: '' });
    expect(cleared.body.data.endDate).toBe('');

    expect((await create(owner.token, { name: 'x', type: 'Fax' })).status).toBe(400);
    expect((await create(owner.token, { name: 'x', budgetPaise: -1 })).status).toBe(400);
    const scheduled = await api().get('/api/v1/campaigns?status=Scheduled&type=SMS&startFrom=2026-10-01&startTo=2026-10-31').set(bearer(owner.token));
    expect(scheduled.body.data.map((c) => c.name)).toEqual(['Diwali SMS']);
  });

  it('keeps notes on a campaign', async () => {
    const campaign = (await create(owner.token, { name: 'Expo stall', type: 'Event' })).body.data;
    await api().post(`/api/v1/campaigns/${campaign.id}/notes`).set(bearer(owner.token)).send({ text: 'Booked stall 14' });
    const notes = await api().get(`/api/v1/campaigns/${campaign.id}/notes`).set(bearer(owner.token));
    expect(notes.body.data).toMatchObject([{ text: 'Booked stall 14', authorName: 'Maya', parentType: 'campaign' }]);
  });

  it('agents see their own campaigns; the dashboard may read but not change them', async () => {
    const agent = await inviteAndJoin(owner.token, 'campaigns-agent@example.com', { role: 'agent', modules: ['marketing'] });
    const mine = (await create(agent.token, { name: 'Agent WhatsApp push' })).body.data;
    const view = await api().get('/api/v1/campaigns').set(bearer(agent.token));
    expect(view.body.data.map((c) => c.id)).toEqual([mine.id]);

    const dashboardOnly = await inviteAndJoin(owner.token, 'campaigns-dash@example.com', { role: 'agent', modules: ['dashboard'] });
    expect((await api().get('/api/v1/campaigns').set(bearer(dashboardOnly.token))).status).toBe(200);
    expect((await create(dashboardOnly.token, { name: 'x' })).status).toBe(403);

    const stranger = await login('campaigns-stranger@example.com');
    expect((await api().get('/api/v1/campaigns').set(bearer(stranger.token))).body.data).toEqual([]);
  });
});
