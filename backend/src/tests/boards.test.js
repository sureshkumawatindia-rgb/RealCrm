jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Lead = require('../models/Lead');
const Notification = require('../models/Notification');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Boards (Phase 7B, D87): saved table, Kanban and calendar views of leads and tasks, private or
// shared, read through the existing lists; and @mentions on a deal's notes.
const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;
const req = (token) => ({
  get: (path) => api().get(`/api/v1${path}`).set(bearer(token)),
  post: (path, body) => api().post(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, body) => api().patch(`/api/v1${path}`).set(bearer(token)).send(body),
  del: (path) => api().delete(`/api/v1${path}`).set(bearer(token)),
});
const DAY = 24 * 60 * 60 * 1000;

describe('Boards', () => {
  let owner;
  let agent;
  let taskOnly;
  beforeAll(async () => {
    owner = await login('board-owner@example.com', { name: 'Kavita' });
    agent = await inviteAndJoin(owner.token, 'board-agent@example.com', { role: 'agent', modules: ['leads', 'deals', 'tasks'] });
    taskOnly = await inviteAndJoin(owner.token, 'board-tasks@example.com', { role: 'agent', modules: ['tasks'] });
    const agentId = await memberId(owner.token, 'board-agent@example.com');
    const o = req(owner.token);
    await o.post('/leads', { title: 'Cement 100 bags', source: 'IndiaMART', contact: { name: 'Jain Traders', phone: '+919829080401' }, expectedValuePaise: 4500000, followUpAt: new Date(Date.now() + 2 * DAY).toISOString() });
    await o.post('/leads', { title: 'Steel rods', source: 'Website', contact: { name: 'Rao Infra', phone: '+919829080402' }, expectedValuePaise: 9000000 });
    await o.post('/leads', { title: 'Agent lead', source: 'IndiaMART', ownerId: agentId, contact: { name: 'Mehta & Sons', phone: '+919829080403' } });
    await o.post('/tasks', { title: 'Visit site', priority: 'High', dueDate: new Date(Date.now() + DAY).toISOString().slice(0, 10) });
    await o.post('/tasks', { title: 'Send rate list', priority: 'Low', status: 'In Progress' });
  });

  it('describes per object only what the member can open', async () => {
    const meta = (await req(owner.token).get('/boards/meta')).body.data;
    expect(Object.keys(meta.objects)).toEqual(['lead', 'task']);
    expect(meta.objects.lead.groupBy).toEqual(['stage', 'source', 'owner']);
    expect(meta.layouts).toEqual(['table', 'kanban', 'calendar']);
    expect(Object.keys((await req(taskOnly.token).get('/boards/meta')).body.data.objects)).toEqual(['task']);
    expect((await req(taskOnly.token).post('/boards', { object: 'lead', name: 'x' })).status).toBe(403);
  });

  it('saves private and shared boards; only the maker (or a manager, when shared) changes them', async () => {
    const o = req(owner.token);
    const a = req(agent.token);
    const mine = (await a.post('/boards', { object: 'lead', name: 'My IndiaMART leads', filters: { sources: ['IndiaMART'] } })).body.data;
    expect(mine).toMatchObject({ layout: 'table', columns: ['title', 'contact', 'stage', 'value', 'owner', 'followUpAt'], groupBy: 'stage', shared: false, mine: true, canEdit: true });
    const team = (await o.post('/boards', { object: 'lead', name: 'Pipeline', layout: 'kanban', groupBy: 'source', shared: true })).body.data;
    expect((await o.get('/boards')).body.data.map((b) => b.name)).toEqual(['Pipeline']); // not the agent's private one
    const agentSees = (await a.get('/boards')).body.data;
    expect(agentSees.map((b) => [b.name, b.mine, b.canEdit])).toEqual([['My IndiaMART leads', true, true], ['Pipeline', false, false]]);
    expect((await a.patch(`/boards/${team.id}`, { name: 'Mine now' })).status).toBe(403);
    expect((await a.del(`/boards/${team.id}`)).status).toBe(403);
    expect((await o.patch(`/boards/${mine.id}`, { name: 'x' })).status).toBe(404);
    expect((await o.patch(`/boards/${team.id}`, { layout: 'calendar', dateField: 'followUpAt' })).body.data).toMatchObject({ layout: 'calendar', dateField: 'followUpAt' });
    // Settings are checked against the object.
    expect((await a.patch(`/boards/${mine.id}`, { columns: ['title', 'password'] })).body.errors[0].code).toBe('UNKNOWN_COLUMN');
    expect((await a.patch(`/boards/${mine.id}`, { groupBy: 'priority' })).body.errors[0].code).toBe('UNKNOWN_GROUP');
    expect((await a.patch(`/boards/${mine.id}`, { filters: { stages: ['Sleeping'] } })).body.errors[0].code).toBe('INVALID_FILTER');
    const stranger = await login('board-stranger@example.com');
    expect((await req(stranger.token).get(`/boards/${team.id}`)).status).toBe(404);
    expect((await req(stranger.token).get(`/boards/${team.id}/items`)).status).toBe(404);
  });

  it('reads the records through the existing lists, with each viewer\'s visibility', async () => {
    const o = req(owner.token);
    const board = (await o.post('/boards', { object: 'lead', name: 'IndiaMART', shared: true, filters: { sources: ['IndiaMART'] }, sort: '-expectedValuePaise' })).body.data;
    const ownerItems = (await o.get(`/boards/${board.id}/items`)).body.data;
    expect(ownerItems.items.map((l) => l.title)).toEqual(['Cement 100 bags', 'Agent lead']);
    const agentItems = (await req(agent.token).get(`/boards/${board.id}/items`)).body.data;
    expect(agentItems.items.map((l) => l.title)).toEqual(['Agent lead']); // only their own
    await o.patch(`/boards/${board.id}`, { filters: { sources: ['IndiaMART'], ownerId: 'me' } });
    expect((await o.get(`/boards/${board.id}/items`)).body.data.items.map((l) => l.title)).toEqual(['Cement 100 bags']);

    // A calendar needs a range, and reads that range of its date.
    const cal = (await o.post('/boards', { object: 'lead', name: 'Follow-ups', layout: 'calendar', dateField: 'followUpAt' })).body.data;
    expect((await o.get(`/boards/${cal.id}/items`)).status).toBe(400);
    const range = (from, to) => o.get(`/boards/${cal.id}/items?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`);
    expect((await range(Date.now(), Date.now() + 5 * DAY)).body.data.items.map((l) => l.title)).toEqual(['Cement 100 bags']);
    expect((await range(Date.now() + 10 * DAY, Date.now() + 20 * DAY)).body.data.items).toEqual([]);

    // Tasks: a Kanban by status, and a calendar on the due day.
    const tasks = (await o.post('/boards', { object: 'task', name: 'Work', layout: 'kanban', groupBy: 'status', filters: { priorities: ['High', 'Low'] } })).body.data;
    expect((await o.get(`/boards/${tasks.id}/items`)).body.data.items.map((x) => [x.title, x.status]).sort()).toEqual([['Send rate list', 'In Progress'], ['Visit site', 'To Do']]);
    await o.patch(`/boards/${tasks.id}`, { layout: 'calendar', dateField: 'dueDate' });
    expect((await o.get(`/boards/${tasks.id}/items?from=${new Date().toISOString()}&to=${new Date(Date.now() + 3 * DAY).toISOString()}`)).body.data.items.map((x) => x.title)).toEqual(['Visit site']);
  });

  it('drops a column whose company field was archived', async () => {
    const o = req(owner.token);
    const field = (await o.post('/custom-fields', { object: 'lead', label: 'Grade', type: 'text' })).body.data;
    const board = (await o.post('/boards', { object: 'lead', name: 'Grades', columns: ['title', `cf.${field.key}`] })).body.data;
    expect(board.columns).toEqual(['title', `cf.${field.key}`]);
    expect((await o.post(`/custom-fields/${field.id}/archive`, {})).status).toBe(200);
    expect((await o.get(`/boards/${board.id}`)).body.data.columns).toEqual(['title']);
  });
});

describe('@mentions on a deal', () => {
  it('mentions only teammates who can open the deal, and gives each a bell note', async () => {
    const owner = await login('mention-owner@example.com', { name: 'Anil' });
    const seller = await inviteAndJoin(owner.token, 'mention-seller@example.com', { role: 'agent', modules: ['leads', 'deals'] });
    const allSeer = await inviteAndJoin(owner.token, 'mention-all@example.com', { role: 'agent', modules: ['leads'], permissions: ['leads:view_all'] });
    const inboxOnly = await inviteAndJoin(owner.token, 'mention-inbox@example.com', { role: 'agent', modules: ['inbox'] });
    const ids = Object.fromEntries(await Promise.all(['mention-owner', 'mention-seller', 'mention-all', 'mention-inbox'].map(async (n) => [n, await memberId(owner.token, `${n}@example.com`)])));
    const o = req(owner.token);
    const lead = (await o.post('/leads', { title: 'Tiles order', contact: { name: 'Bansal Homes', phone: '+919829080501' } })).body.data;

    const can = (await o.get(`/leads/${lead.id}/mentionable`)).body.data.map((m) => m.name).sort();
    expect(can).toEqual(['mention-all']); // the seller sees only their own deals; the inbox agent has no Leads
    expect((await o.get(`/leads/${lead.id}/mentionable?q=MENT`)).body.data).toHaveLength(1);

    const refused = await o.post(`/leads/${lead.id}/activities`, { text: '@seller please call', mentions: [ids['mention-seller'], ids['mention-inbox']] });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('MENTION_NO_ACCESS');
    expect(refused.body.errors.map((e) => e.memberId).sort()).toEqual([ids['mention-seller'], ids['mention-inbox']].sort());
    const other = await login('mention-other@example.com');
    const otherId = await memberId(other.token, 'mention-other@example.com');
    expect((await o.post(`/leads/${lead.id}/activities`, { text: 'x', mentions: [otherId] })).body.code).toBe('MENTION_UNKNOWN');

    const before = await Notification.countDocuments();
    const notes = (await o.post(`/leads/${lead.id}/activities`, { text: '@mention-all can you check the rate? @Anil', mentions: [ids['mention-all'], ids['mention-owner']] })).body.data;
    expect(notes[0].mentions.map((m) => m.name).sort()).toEqual(['Anil', 'mention-all']);
    expect(await Notification.countDocuments()).toBe(before + 1); // not to the writer
    const bell = (await req(allSeer.token).get('/notifications')).body.data;
    expect(bell.items[0]).toMatchObject({ title: 'Anil mentioned you on “Tiles order”', link: `Deals.html?open=${lead.id}` });

    // Given the deal, the seller can be mentioned.
    await Lead.updateOne({ _id: lead.id }, { $set: { ownerId: ids['mention-seller'] } });
    expect((await o.get(`/leads/${lead.id}/mentionable`)).body.data.map((m) => m.name).sort()).toEqual(['mention-all', 'mention-seller']);
    expect((await req(seller.token).post(`/leads/${lead.id}/activities`, { text: 'On it @Anil', mentions: [ids['mention-owner']] })).status).toBe(201);
    expect(inboxOnly).toBeTruthy();
  });
});
