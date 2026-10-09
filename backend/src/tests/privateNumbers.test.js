jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Lead = require('../models/Lead');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const AuditLog = require('../models/AuditLog');
const automationEvents = require('../services/automation/events');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Private numbers (D61): an owner makes a personal chat (family, friends) private. Only owners
// see its contact, leads and chats; new messages from it stay private and start nothing; the
// reports leave it out; making it visible again undoes it.
const simulate = async (token, from, text, name = '') => {
  const res = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(token)).send({ from, text, name });
  if (res.status !== 201) throw new Error(`simulate: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const chatsOf = async (token) => (await api().get('/api/v1/conversations?status=any&view=all').set(bearer(token))).body.data;
const contactsOf = async (token) => (await api().get('/api/v1/contacts?limit=100').set(bearer(token))).body.data;
const leadsOf = async (token) => (await api().get('/api/v1/leads?limit=100').set(bearer(token))).body.data;

describe('Private numbers', () => {
  let owner;
  let admin;
  let agent;
  let family;
  beforeAll(async () => {
    owner = await login('private-owner@example.com', { name: 'Owner' });
    admin = await inviteAndJoin(owner.token, 'private-admin@example.com', { role: 'admin' });
    agent = await inviteAndJoin(owner.token, 'private-agent@example.com', { role: 'agent', modules: ['inbox', 'customers', 'leads'], permissions: ['inbox:view_all', 'customers:view_all', 'leads:view_all'] });
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    family = await simulate(owner.token, '98290 70001', 'Beta, khana kha liya?', 'Mummy');
    await simulate(owner.token, '98290 70002', 'Price of jeera?', 'Customer');
  });

  it('only the owner can make a number private, with a clear result', async () => {
    expect((await api().post(`/api/v1/conversations/${family.conversationId}/private`).set(bearer(admin.token)).send({})).status).toBe(403);
    expect((await api().post(`/api/v1/conversations/${family.conversationId}/private`).set(bearer(agent.token)).send({})).status).toBe(403);
    expect((await api().get('/api/v1/privacy/numbers').set(bearer(admin.token))).status).toBe(403);

    const made = await api().post(`/api/v1/conversations/${family.conversationId}/private`).set(bearer(owner.token)).send({ note: 'Family' });
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ phone: '+919829070001', name: 'Mummy', note: 'Family', chats: 1 });
    const audit = await AuditLog.findOne({ action: 'privacy.number_private' });
    expect(JSON.stringify(audit.changes)).not.toContain('9829070001'); // admins read the audit log
    expect(JSON.stringify(audit.changes)).toContain('+91 ••••• 0001');
  });

  it('hides the chat, contact and lead from admins and agents; the owner still sees them', async () => {
    expect((await chatsOf(owner.token)).map((c) => c.contact.name).sort()).toEqual(['Customer', 'Mummy']);
    expect((await chatsOf(owner.token)).find((c) => c.contact.name === 'Mummy')).toMatchObject({ private: true });
    for (const someone of [admin, agent]) {
      expect((await chatsOf(someone.token)).map((c) => c.contact.name)).toEqual(['Customer']);
      expect((await api().get(`/api/v1/conversations/${family.conversationId}`).set(bearer(someone.token))).status).toBe(404);
      expect((await api().get(`/api/v1/conversations/${family.conversationId}/messages`).set(bearer(someone.token))).status).toBe(404);
      expect((await contactsOf(someone.token)).map((c) => c.name)).not.toContain('Mummy');
      expect((await api().get(`/api/v1/contacts/${family.contactId}`).set(bearer(someone.token))).status).toBe(404);
      expect((await leadsOf(someone.token)).length).toBe(1);
    }
    expect((await contactsOf(owner.token)).map((c) => c.name)).toContain('Mummy');
    expect((await leadsOf(owner.token)).length).toBe(2);
    // The inbox counts leave it out for them too.
    const summary = (await api().get('/api/v1/conversations/summary').set(bearer(admin.token))).body.data;
    expect(summary.all).toBe(1);
  });

  it('keeps new messages from the number private and quiet', async () => {
    const emitted = jest.spyOn(automationEvents, 'emit');
    try {
      await simulate(owner.token, '98290 70001', 'Kab aaoge?', 'Mummy');
      const latest = await Message.findOne({ text: 'Kab aaoge?' });
      expect(latest.private).toBe(true);
      expect(emitted).not.toHaveBeenCalled();
      // A number made private before it ever wrote: its first message starts nothing either.
      await api().post('/api/v1/privacy/numbers').set(bearer(owner.token)).send({ phone: '98290 70003', note: 'Friend' });
      await simulate(owner.token, '98290 70003', 'Hi!', 'Friend');
      expect(emitted).not.toHaveBeenCalled();
      expect(await Lead.countDocuments({ source: 'WhatsApp', private: { $ne: true } })).toBe(1);
      expect((await chatsOf(agent.token)).map((c) => c.contact.name)).toEqual(['Customer']);
    } finally {
      emitted.mockRestore();
    }
  });

  it('leaves private chats out of the reports', async () => {
    const overview = (await api().get('/api/v1/reports/overview?preset=today').set(bearer(owner.token))).body.data;
    expect(overview.whatsapp.newChats).toBe(1); // only the customer's chat
  });

  it('lists the private numbers for the owner and makes one visible again', async () => {
    const list = (await api().get('/api/v1/privacy/numbers').set(bearer(owner.token))).body.data;
    expect(list.map((n) => [n.phone, n.note])).toEqual([['+919829070003', 'Friend'], ['+919829070001', 'Family']]);
    const mummy = list.find((n) => n.note === 'Family');
    expect((await api().delete(`/api/v1/privacy/numbers/${mummy.id}`).set(bearer(admin.token))).status).toBe(403);
    expect((await api().delete(`/api/v1/privacy/numbers/${mummy.id}`).set(bearer(owner.token))).body.data).toEqual({ removed: true });
    expect((await chatsOf(agent.token)).map((c) => c.contact.name).sort()).toEqual(['Customer', 'Mummy']);
    expect(await Conversation.exists({ _id: family.conversationId, private: true })).toBeNull();
    expect(await Message.countDocuments({ contactId: family.contactId, private: true })).toBe(0);
  });
});
