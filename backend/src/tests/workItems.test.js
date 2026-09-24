jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;

describe('Tasks', () => {
  let owner;
  beforeAll(async () => { owner = await login('tasks-owner@example.com', { name: 'Tara' }); });

  it('creates, filters and completes a task; Done records when', async () => {
    const me = await memberId(owner.token, 'tasks-owner@example.com');
    const created = await api().post('/api/v1/tasks').set(bearer(owner.token))
      .send({ title: 'Call Ravi', assigneeId: me, dueDate: '2026-10-01', priority: 'High' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ title: 'Call Ravi', status: 'To Do', dueDate: '2026-10-01', origin: 'manual', completedAt: null });

    const done = await api().patch(`/api/v1/tasks/${created.body.data.id}`).set(bearer(owner.token)).send({ status: 'Done' });
    expect(done.body.data.completedAt).not.toBeNull();
    const reopened = await api().patch(`/api/v1/tasks/${created.body.data.id}`).set(bearer(owner.token)).send({ status: 'In Progress', dueDate: '' });
    expect(reopened.body.data).toMatchObject({ completedAt: null, dueDate: '' });

    const high = await api().get('/api/v1/tasks?priority=High&q=ravi').set(bearer(owner.token));
    expect(high.body.data).toHaveLength(1);
    const range = await api().get('/api/v1/tasks?dueFrom=2026-01-01&dueTo=2026-12-31').set(bearer(owner.token));
    expect(range.body.data).toHaveLength(0); // its due date was cleared
  });

  it('links a task to a lead and keeps the name as a snapshot', async () => {
    const lead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Linked Lead' }, title: 'Big Order' })).body.data;
    const asLead = await api().post('/api/v1/tasks').set(bearer(owner.token)).send({ title: 'Follow up', relatedType: 'Lead', relatedId: lead.id, relatedName: 'typo' });
    expect(asLead.body.data).toMatchObject({ relatedType: 'Lead', relatedName: 'Linked Lead' });
    const asDeal = await api().post('/api/v1/tasks').set(bearer(owner.token)).send({ title: 'Send quote', relatedType: 'Deal', relatedId: lead.id });
    expect(asDeal.body.data.relatedName).toBe('Big Order');
    const byLead = await api().get(`/api/v1/tasks?relatedType=Lead&relatedId=${lead.id}`).set(bearer(owner.token));
    expect(byLead.body.data).toHaveLength(1);

    const unknown = await api().post('/api/v1/tasks').set(bearer(owner.token)).send({ title: 'x', relatedType: 'Customer', relatedId: '0123456789abcdef01234567' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors[0].code).toBe('INVALID_RELATED');
    const account = await api().post('/api/v1/tasks').set(bearer(owner.token)).send({ title: 'Visit', relatedType: 'Account', relatedName: 'Gupta Wholesale' });
    expect(account.body.data).toMatchObject({ relatedType: 'Account', relatedName: 'Gupta Wholesale', relatedId: null });
  });

  it('validates assignees, dates and the origin', async () => {
    const other = await login('tasks-other@example.com');
    const outsider = await memberId(other.token, 'tasks-other@example.com');
    const bad = await api().post('/api/v1/tasks').set(bearer(owner.token)).send({ title: 'x', assigneeId: outsider });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0].code).toBe('INVALID_ASSIGNEE');
    expect((await api().post('/api/v1/tasks').set(bearer(owner.token)).send({ title: 'x', dueDate: '01/10/2026' })).status).toBe(400);

    const followUp = await api().post('/api/v1/tasks').set(bearer(owner.token)).send({ title: 'Deal follow-up', origin: 'deal_followup' });
    expect(followUp.body.data.origin).toBe('deal_followup');
    const changeOrigin = await api().patch(`/api/v1/tasks/${followUp.body.data.id}`).set(bearer(owner.token)).send({ origin: 'manual' });
    expect(changeOrigin.status).toBe(400);
  });

  it('agents see tasks assigned to them or created by them; others need view_all', async () => {
    const agent = await inviteAndJoin(owner.token, 'tasks-agent@example.com', { role: 'agent', modules: ['tasks'] });
    const agentId = await memberId(owner.token, 'tasks-agent@example.com');

    const forAgent = (await api().post('/api/v1/tasks').set(bearer(owner.token)).send({ title: 'For the agent', assigneeId: agentId })).body.data;
    const byAgent = (await api().post('/api/v1/tasks').set(bearer(agent.token)).send({ title: 'Agent made this' })).body.data;
    const view = await api().get('/api/v1/tasks').set(bearer(agent.token));
    expect(view.body.data.map((t) => t.id).sort()).toEqual([forAgent.id, byAgent.id].sort());

    const ownersOnly = (await api().get('/api/v1/tasks?q=Call Ravi').set(bearer(owner.token))).body.data[0];
    expect((await api().get(`/api/v1/tasks/${ownersOnly.id}`).set(bearer(agent.token))).status).toBe(404);
    expect((await api().delete(`/api/v1/tasks/${byAgent.id}`).set(bearer(agent.token))).status).toBe(403);

    await api().patch(`/api/v1/members/${agentId}`).set(bearer(owner.token)).send({ permissions: ['tasks:view_all', 'tasks:delete'] });
    expect((await api().get(`/api/v1/tasks/${ownersOnly.id}`).set(bearer(agent.token))).status).toBe(200);
    expect((await api().delete(`/api/v1/tasks/${byAgent.id}`).set(bearer(agent.token))).status).toBe(200);
  });

  it('another organization sees none of these tasks', async () => {
    const stranger = await login('tasks-stranger@example.com');
    expect((await api().get('/api/v1/tasks').set(bearer(stranger.token))).body.data).toEqual([]);
  });
});

describe('Calendar events', () => {
  let owner;
  beforeAll(async () => { owner = await login('events-owner@example.com'); });

  it('stores the calendar day and wall-clock times, and filters by range', async () => {
    const meeting = await api().post('/api/v1/events').set(bearer(owner.token))
      .send({ title: 'Buyer meeting', type: 'Meeting', date: '2026-10-05', startTime: '10:30', endTime: '11:15' });
    expect(meeting.status).toBe(201);
    expect(meeting.body.data).toMatchObject({ date: '2026-10-05', startTime: '10:30', endTime: '11:15', timezone: 'Asia/Kolkata' });

    await api().post('/api/v1/events').set(bearer(owner.token)).send({ title: 'All-day expo', type: 'Reminder', date: '2026-11-20' });
    const october = await api().get('/api/v1/events?from=2026-10-01&to=2026-10-31').set(bearer(owner.token));
    expect(october.body.data.map((e) => e.title)).toEqual(['Buyer meeting']);

    const wrongOrder = await api().post('/api/v1/events').set(bearer(owner.token)).send({ title: 'x', date: '2026-10-05', startTime: '12:00', endTime: '11:00' });
    expect(wrongOrder.status).toBe(400);
    expect(wrongOrder.body.errors[0].code).toBe('END_BEFORE_START');
    const noDate = await api().post('/api/v1/events').set(bearer(owner.token)).send({ title: 'x' });
    expect(noDate.status).toBe(400);
    const endOnly = await api().post('/api/v1/events').set(bearer(owner.token)).send({ title: 'End only', date: '2026-10-06', endTime: '09:00' });
    expect(endOnly.body.data.endTime).toBe('');
  });

  it('agents need the calendar module to add events; dashboard users may read them', async () => {
    const tasksOnly = await inviteAndJoin(owner.token, 'events-tasks@example.com', { role: 'agent', modules: ['tasks'] });
    expect((await api().post('/api/v1/events').set(bearer(tasksOnly.token)).send({ title: 'x', date: '2026-10-05' })).status).toBe(403);
    expect((await api().get('/api/v1/events').set(bearer(tasksOnly.token))).status).toBe(403);

    const dashboardAgent = await inviteAndJoin(owner.token, 'events-dash@example.com', { role: 'agent', modules: ['dashboard'] });
    expect((await api().get('/api/v1/events').set(bearer(dashboardAgent.token))).status).toBe(200);
  });
});
