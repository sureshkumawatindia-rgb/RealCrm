jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Conversation = require('../models/Conversation');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// WhatsApp for every agent (D67): the whole team replies from the company's shared number, and
// on Pro and above a number can be an agent's own: its new chats and new WhatsApp leads go
// straight to that agent, and other agents do not see them.
describe("An agent's own WhatsApp number", () => {
  let owner;
  let asha;
  let ravi;
  let shared;
  let ashaNumber;
  const as = (who) => bearer(who.token);
  const inbound = (number, from, text = 'Rate?') => api().post('/api/v1/dev/simulate/whatsapp-inbound').set(as(owner)).send({ accountId: number.id, from, name: `Customer ${from.slice(-4)}`, text });
  const visibleTo = async (who) => (await api().get('/api/v1/conversations?limit=50').set(as(who))).body.data.map((c) => String(c.id));

  beforeAll(async () => {
    owner = await login('numbers-owner@example.com', { name: 'Mohan' }); // a Growth trial
    asha = await inviteAndJoin(owner.token, 'asha-agent@example.com', { role: 'agent' });
    ravi = await inviteAndJoin(owner.token, 'ravi-agent@example.com', { role: 'agent' });
    shared = (await api().post('/api/v1/whatsapp/accounts').set(as(owner)).send({ provider: 'mock', name: 'Shop' })).body.data;
    ashaNumber = (await api().post('/api/v1/whatsapp/accounts').set(as(owner)).send({ provider: 'mock', name: 'Asha' })).body.data;
  });

  it('owners and admins give a number to an agent who can open the Inbox', async () => {
    const given = await api().patch(`/api/v1/whatsapp/accounts/${ashaNumber.id}`).set(as(owner)).send({ agentMemberId: asha.data.member.id });
    expect(given.status).toBe(200);
    expect(String(given.body.data.agentMemberId)).toBe(String(asha.data.member.id));
    expect((await api().get('/api/v1/whatsapp/accounts').set(as(owner))).body.data.find((a) => a.id === ashaNumber.id).agentMemberId).toBe(String(asha.data.member.id));

    // Agents cannot, and the number goes only to someone who works in the Inbox.
    expect((await api().patch(`/api/v1/whatsapp/accounts/${ashaNumber.id}`).set(as(asha)).send({ agentMemberId: asha.data.member.id })).status).toBe(403);
    const noInbox = await inviteAndJoin(owner.token, 'no-inbox@example.com', { role: 'agent', modules: ['leads'] });
    const refused = await api().patch(`/api/v1/whatsapp/accounts/${shared.id}`).set(as(owner)).send({ agentMemberId: noInbox.data.member.id });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe('Pick an active teammate who can open the Inbox.');
  });

  it("sends new chats and new leads on the agent's number to that agent, unseen by other agents", async () => {
    const mine = (await inbound(ashaNumber, '98290 61001')).body.data;
    const chat = await Conversation.findById(mine.conversationId);
    expect(String(chat.assigneeId)).toBe(String(asha.data.member.id));
    const lead = await Lead.findOne({ contactId: mine.contactId });
    expect(String(lead.ownerId)).toBe(String(asha.data.member.id));
    expect(String((await Contact.findById(mine.contactId)).ownerId)).toBe(String(asha.data.member.id));

    // The shared number: nobody's yet, so every agent can pick it up.
    const open = (await inbound(shared, '98290 61002')).body.data;
    expect((await Conversation.findById(open.conversationId)).assigneeId ?? null).toBeNull();

    expect(await visibleTo(asha)).toEqual(expect.arrayContaining([String(mine.conversationId), String(open.conversationId)]));
    expect(await visibleTo(ravi)).toContain(String(open.conversationId));
    expect(await visibleTo(ravi)).not.toContain(String(mine.conversationId));
    expect(await visibleTo(owner)).toEqual(expect.arrayContaining([String(mine.conversationId), String(open.conversationId)]));
  });

  it("starts an agent's new chats from their own number, everyone else's from the shared one", async () => {
    const contact = (await api().post('/api/v1/contacts').set(as(asha)).send({ name: 'Kiran Stores', phone: '9829061003' })).body.data;
    const fromAsha = await api().post('/api/v1/conversations').set(as(asha)).send({ contactId: contact.id });
    expect(fromAsha.status).toBe(201);
    expect(fromAsha.body.data.account.id).toBe(ashaNumber.id);
    const other = (await api().post('/api/v1/contacts').set(as(ravi)).send({ name: 'Leela Traders', phone: '9829061004' })).body.data;
    const fromRavi = await api().post('/api/v1/conversations').set(as(ravi)).send({ contactId: other.id });
    expect(fromRavi.body.data.account.id).toBe(shared.id);
  });

  it('is shared again when the agent is disabled, and when the number is given back to the team', async () => {
    await OrganizationMember.updateOne({ _id: asha.data.member.id }, { status: 'disabled' });
    const after = (await inbound(ashaNumber, '98290 61005')).body.data;
    expect((await Conversation.findById(after.conversationId)).assigneeId ?? null).toBeNull();
    await OrganizationMember.updateOne({ _id: asha.data.member.id }, { status: 'active' });

    const back = await api().patch(`/api/v1/whatsapp/accounts/${ashaNumber.id}`).set(as(owner)).send({ agentMemberId: null });
    expect(back.body.data.agentMemberId).toBeNull();
    const later = (await inbound(ashaNumber, '98290 61006')).body.data;
    expect((await Conversation.findById(later.conversationId)).assigneeId ?? null).toBeNull();
  });

  it('needs the Pro plan or above', async () => {
    await Organization.updateOne({ _id: owner.data.organizationId }, { $set: { plan: 'starter', subscription: { status: 'active' } } });
    const refused = await api().patch(`/api/v1/whatsapp/accounts/${ashaNumber.id}`).set(as(owner)).send({ agentMemberId: asha.data.member.id });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('PLAN_LIMIT');
    await Organization.updateOne({ _id: owner.data.organizationId }, { $set: { plan: 'pro' } });
    const allowed = await api().patch(`/api/v1/whatsapp/accounts/${ashaNumber.id}`).set(as(owner)).send({ agentMemberId: asha.data.member.id });
    expect(allowed.body).toMatchObject({ success: true });
  });
});
