jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const { indiaDate } = require('../utils/dates');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;

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

describe('Sequences', () => {
  let owner;
  let ownerMemberId;
  beforeAll(async () => {
    owner = await login('automation-owner@example.com', { name: 'Arjun' });
    ownerMemberId = await memberId(owner.token, 'automation-owner@example.com');
  });

  it('Enroll schedules the first call or task step and counts the enrollment', async () => {
    const sequence = (await api().post('/api/v1/sequences').set(bearer(owner.token)).send({
      name: 'Quote follow-up', targetType: 'Deals',
      steps: [{ day: 5, type: 'Task', note: 'Send revised quote' }, { day: 0, type: 'Email', note: 'Thanks' }, { day: 2, type: 'Call', note: '' }],
    })).body.data;
    expect(sequence).toMatchObject({ targetType: 'Deals', status: 'Active', enrolledCount: 0 });

    const enrolled = await api().post(`/api/v1/sequences/${sequence.id}/enroll`).set(bearer(owner.token));
    expect(enrolled.status).toBe(200);
    expect(enrolled.body.data).toMatchObject({ firstTaskDay: 2, sequence: { enrolledCount: 1 } });
    expect(enrolled.body.data.task).toMatchObject({ title: 'Quote follow-up — Day 2 touchpoint', dueDate: indiaDate(2), origin: 'automation' });
    expect(enrolled.body.data.simulated.sort()).toEqual(['Email', 'Task']);

    const emailsOnly = (await api().post('/api/v1/sequences').set(bearer(owner.token)).send({ name: 'Newsletter', steps: [{ day: 0, type: 'Email' }] })).body.data;
    const noTask = await api().post(`/api/v1/sequences/${emailsOnly.id}/enroll`).set(bearer(owner.token));
    expect(noTask.body.data).toMatchObject({ task: null, sequence: { enrolledCount: 1 } });

    expect((await api().post('/api/v1/sequences').set(bearer(owner.token)).send({ name: 'x', steps: [{ day: 400, type: 'Call' }] })).status).toBe(400);
    expect((await api().post('/api/v1/sequences').set(bearer(owner.token)).send({ name: 'x', steps: [{ day: 1, type: 'Fax' }] })).status).toBe(400);
  });

  it('agents enroll only into their own sequences; automation alone does not allow writing tasks directly', async () => {
    const agent = await inviteAndJoin(owner.token, 'automation-agent@example.com', { role: 'agent', modules: ['automation'] });
    const agentId = await memberId(owner.token, 'automation-agent@example.com');
    const mine = (await api().post('/api/v1/sequences').set(bearer(agent.token)).send({ name: 'Agent cadence', steps: [{ day: 1, type: 'Task', note: 'Agent task' }], ownerId: ownerMemberId })).body.data;
    expect(mine.ownerId).toBe(agentId);
    const enrolled = await api().post(`/api/v1/sequences/${mine.id}/enroll`).set(bearer(agent.token));
    expect(enrolled.body.data.task.assigneeId).toBe(agentId);

    const ownersSequence = (await api().get('/api/v1/sequences?q=Quote').set(bearer(owner.token))).body.data[0];
    expect((await api().post(`/api/v1/sequences/${ownersSequence.id}/enroll`).set(bearer(agent.token))).status).toBe(404);
    expect((await api().delete(`/api/v1/sequences/${mine.id}`).set(bearer(agent.token))).status).toBe(403);
    expect((await api().post('/api/v1/tasks').set(bearer(agent.token)).send({ title: 'Direct' })).status).toBe(403);

    await api().patch(`/api/v1/sequences/${mine.id}`).set(bearer(agent.token)).send({ status: 'Paused' });
    const paused = await api().post(`/api/v1/sequences/${mine.id}/enroll`).set(bearer(agent.token));
    expect(paused.status).toBe(409);
    expect(paused.body.code).toBe('NOT_ACTIVE');

    const stranger = await login('automation-stranger@example.com');
    expect((await api().get('/api/v1/sequences').set(bearer(stranger.token))).body.data).toEqual([]);
    expect((await api().post(`/api/v1/sequences/${mine.id}/enroll`).set(bearer(stranger.token))).status).toBe(404);
  });
});
