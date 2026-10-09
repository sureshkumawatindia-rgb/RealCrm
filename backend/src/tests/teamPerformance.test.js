jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const ChatResolution = require('../models/ChatResolution');
const Notification = require('../models/Notification');
const teamSummary = require('../services/teamSummaryService');
const { indiaDate } = require('../utils/dates');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// The team's work for the owner (D61): resolution rate and time on the agent report, the live
// team page, "My performance" for each member, and the evening summary.
const simulate = async (token, from, text, name = '') => {
  const res = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(token)).send({ from, text, name });
  if (res.status !== 201) throw new Error(`simulate: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;
const today = () => `from=${indiaDate(0)}&to=${indiaDate(0)}`;

describe('Team performance', () => {
  let owner;
  let agent;
  let agentId;
  let chat;
  beforeAll(async () => {
    owner = await login('team-owner@example.com', { name: 'Ramesh' });
    agent = await inviteAndJoin(owner.token, 'team-agent@example.com', { role: 'agent', modules: ['inbox'] });
    agentId = await memberId(owner.token, 'team-agent@example.com');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    chat = await simulate(owner.token, '98290 80001', 'Haldi ka rate?', 'Sunil');
    await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(bearer(owner.token)).send({ assigneeId: agentId });
    await api().post(`/api/v1/conversations/${chat.conversationId}/messages`).set(bearer(agent.token)).send({ text: '₹180 per kg' });
  });

  it('counts a resolved chat for its assignee, with the time it took, and again after a reopen', async () => {
    await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(bearer(agent.token)).send({ status: 'closed' });
    const first = await ChatResolution.findOne({ conversationId: chat.conversationId });
    expect(first).toMatchObject({ seconds: expect.any(Number) });
    expect(String(first.memberId)).toBe(agentId);

    // The customer writes again: a new round; closing it counts once more.
    await simulate(owner.token, '98290 80001', 'Aur jeera?', 'Sunil');
    await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(bearer(agent.token)).send({ status: 'closed' });
    expect(await ChatResolution.countDocuments({ conversationId: chat.conversationId })).toBe(2);

    const report = (await api().get(`/api/v1/reports/agents?${today()}`).set(bearer(owner.token))).body.data;
    const row = report.items.find((r) => r.memberId === agentId);
    expect(row).toMatchObject({ chatsHandled: 1, chatsResolved: 2, resolutionRatePct: 100, resolutionMedianSeconds: expect.any(Number) });
    expect(report.team.chatsResolved).toBe(2);
    const csv = await api().get(`/api/v1/reports/export?type=agents&${today()}`).set(bearer(owner.token));
    expect(csv.text).toContain('Chats resolved');
  });

  it('shows each member only their own figures in My performance', async () => {
    const mine = (await api().get(`/api/v1/reports/me?${today()}`).set(bearer(agent.token))).body.data;
    expect(mine.me).toMatchObject({ memberId: agentId, chatsHandled: 1, replies: 1, chatsResolved: 2 });
    expect((await api().get(`/api/v1/reports/agents?${today()}`).set(bearer(agent.token))).status).toBe(403); // no Reports page
    const ownerMine = (await api().get(`/api/v1/reports/me?${today()}`).set(bearer(owner.token))).body.data;
    expect(ownerMine.me.memberId).not.toBe(agentId);
  });

  it('shows the live team: who is online, open and waiting chats, today\'s replies and the queue', async () => {
    await simulate(owner.token, '98290 80002', 'Hello?', 'New buyer'); // nobody has it yet
    expect((await api().get('/api/v1/reports/team-live').set(bearer(agent.token))).status).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 50)); // "last seen" is written in the background
    const live = (await api().get('/api/v1/reports/team-live').set(bearer(owner.token))).body.data;
    const row = live.items.find((r) => r.memberId === agentId);
    expect(row).toMatchObject({ name: expect.any(String), online: true, repliesToday: 1, resolvedToday: 2, openChats: 0 });
    expect(live.queue).toMatchObject({ openChats: 1, waitingChats: 1 });
    expect(live.today).toMatchObject({ replies: 1, resolved: 2, waiting: 1 });
  });

  it('sends the owners one evening summary, and only after 7 pm', async () => {
    const morning = new Date(`${indiaDate(0)}T04:00:00.000Z`); // 9:30 am in India
    const evening = new Date(`${indiaDate(0)}T14:00:00.000Z`); // 7:30 pm in India
    expect(await teamSummary.run({ now: morning })).toBe(0);
    expect(await teamSummary.run({ now: evening })).toBe(1);
    expect(await teamSummary.run({ now: evening })).toBe(0); // once a day
    const note = await Notification.findOne({ source: 'team-summary' });
    expect(note).toMatchObject({ title: "Today's team summary", link: 'team-live.html', body: expect.stringContaining('1 reply') });
    expect(note.body).toContain('2 chats resolved');
    expect(await Notification.countDocuments({ source: 'team-summary' })).toBe(1); // the owner only
  });
});
