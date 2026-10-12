jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Message = require('../models/Message');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const inbound = require('../services/whatsappInboundService');
const mock = require('../integrations/whatsapp/mock');
const { isOggOpusMono } = require('../utils/oggOpus');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// CP3: reactions, read receipts and "typing…", pinned and archived chats, voice notes.
const DAY = 24 * 60 * 60 * 1000;
const simulate = async (token, body) => {
  const res = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(token)).send(body);
  if (res.status !== 201) throw new Error(`simulate: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const messages = async (token, conversationId) => (await api().get(`/api/v1/conversations/${conversationId}/messages`).set(bearer(token))).body.data;
// A webhook from Meta for this test number, processed at once.
const deliver = async (account, value) => inbound.processNow(await inbound.ingest(account, {
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba-test', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: account.phoneNumberId }, ...value } }] }],
}));
const now = () => String(Math.floor(Date.now() / 1000));

// The first Ogg page of a voice note: "OpusHead" with the channel count.
function oggOpus(channels = 1) {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1; // version
  head[9] = channels;
  head.writeUInt16LE(312, 10); // pre-skip
  head.writeUInt32LE(48000, 12);
  const page = Buffer.alloc(28);
  page.write('OggS', 0, 'latin1');
  page[5] = 2; // first page of the stream
  page[26] = 1; // one segment
  page[27] = head.length;
  return Buffer.concat([page, head, Buffer.alloc(64, 1)]);
}

describe('Inbox: reactions, read receipts, pinned and archived chats, voice notes (CP3)', () => {
  let owner;
  let agent;
  let account;
  let chat;
  beforeAll(async () => {
    owner = await login('polish-owner@example.com');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    account = await WhatsAppAccount.findOne({ organizationId: owner.data.organizationId });
    agent = await inviteAndJoin(owner.token, 'polish-agent@example.com', { role: 'agent', modules: ['inbox'] });
    chat = await simulate(owner.token, { from: '98290 12345', name: 'Ravi', text: 'Jeera ka rate?' });
  });
  afterEach(() => jest.restoreAllMocks());

  it("shows the customer's reaction on our message, and takes it off when they remove it", async () => {
    const sent = (await api().post(`/api/v1/conversations/${chat.conversationId}/messages`).set(bearer(owner.token)).send({ text: '₹3,000 a bag' })).body.data;
    const from = { contacts: [{ profile: { name: 'Ravi' }, wa_id: '919829012345' }] };
    await deliver(account, { ...from, messages: [{ from: '919829012345', id: 'wamid.REACT1', timestamp: now(), type: 'reaction', reaction: { message_id: sent.providerMessageId, emoji: '👍' } }] });
    let ours = (await messages(owner.token, chat.conversationId)).find((m) => m.id === sent.id);
    expect(ours.reactions).toEqual({ customer: '👍', business: '' });

    // Removed: Meta leaves the emoji out.
    await deliver(account, { ...from, messages: [{ from: '919829012345', id: 'wamid.REACT2', timestamp: now(), type: 'reaction', reaction: { message_id: sent.providerMessageId } }] });
    ours = (await messages(owner.token, chat.conversationId)).find((m) => m.id === sent.id);
    expect(ours.reactions).toBeNull();
  });

  it('reacts to a message of the last 30 days inside the 24-hour window, never to a reaction', async () => {
    const send = jest.spyOn(mock, 'sendMessage');
    const customer = (await messages(owner.token, chat.conversationId)).find((m) => m.direction === 'in' && m.type === 'text');
    const res = await api().post(`/api/v1/conversations/${chat.conversationId}/messages/${customer.id}/reaction`).set(bearer(owner.token)).send({ emoji: '❤️' });
    expect(res.status).toBe(201);
    expect(res.body.data.reactions).toEqual({ customer: '', business: '❤️' });
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'reaction', reaction: { message_id: customer.providerMessageId, emoji: '❤️' } }));

    const reactionMessage = (await messages(owner.token, chat.conversationId)).find((m) => m.type === 'reaction');
    const onReaction = await api().post(`/api/v1/conversations/${chat.conversationId}/messages/${reactionMessage.id}/reaction`).set(bearer(owner.token)).send({ emoji: '👍' });
    expect(onReaction.body.code).toBe('CANNOT_REACT');

    await Message.updateOne({ _id: customer.id }, { $set: { providerTimestamp: new Date(Date.now() - 31 * DAY) } });
    const old = await api().post(`/api/v1/conversations/${chat.conversationId}/messages/${customer.id}/reaction`).set(bearer(owner.token)).send({ emoji: '👍' });
    expect(old.body).toMatchObject({ code: 'CANNOT_REACT', message: 'WhatsApp takes reactions only on messages from the last 30 days.' });
  });

  it('sends blue ticks once per customer message, "typing…", and nothing when the company turns read receipts off', async () => {
    const read = jest.spyOn(mock, 'markRead');
    const other = await simulate(owner.token, { from: '98290 22222', name: 'Meena', text: 'Haldi?' });
    const last = (await messages(owner.token, other.conversationId)).at(-1);
    await api().post(`/api/v1/conversations/${other.conversationId}/read`).set(bearer(owner.token));
    await api().post(`/api/v1/conversations/${other.conversationId}/read`).set(bearer(owner.token));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(expect.anything(), { messageId: last.providerMessageId, typing: false });

    const typing = await api().post(`/api/v1/conversations/${other.conversationId}/typing`).set(bearer(owner.token));
    expect(typing.body.data).toEqual({ sent: true });
    expect(read).toHaveBeenLastCalledWith(expect.anything(), { messageId: last.providerMessageId, typing: true });
    expect((await api().post(`/api/v1/conversations/${other.conversationId}/typing`).set(bearer(owner.token))).body.data).toEqual({ sent: false }); // 20 seconds apart

    // Off for the company: no ticks, the setting shows it.
    expect((await api().patch('/api/v1/organization/settings').set(bearer(owner.token)).send({ sendReadReceipts: false })).body.data).toMatchObject({ sendReadReceipts: false });
    await simulate(owner.token, { from: '98290 22222', text: 'Hello?' });
    await api().post(`/api/v1/conversations/${other.conversationId}/read`).set(bearer(owner.token));
    expect(read).toHaveBeenCalledTimes(2);
    expect((await api().get('/api/v1/organization/settings').set(bearer(agent.token))).body.data).toMatchObject({ sendReadReceipts: false });
    await api().patch('/api/v1/organization/settings').set(bearer(owner.token)).send({ sendReadReceipts: true });
  });

  it('pins are each member\'s own and come first; an archived chat is out of the list until the customer writes', async () => {
    const newer = await simulate(owner.token, { from: '98290 33333', name: 'Gupta', text: 'Delivery kab?' });
    const pin = (who, id, pinned = true) => api().patch(`/api/v1/conversations/${id}`).set(bearer(who.token)).send({ pinned });
    const listOf = async (who, view = 'all') => (await api().get(`/api/v1/conversations?view=${view}`).set(bearer(who.token))).body.data;

    expect((await pin(owner, chat.conversationId)).body.data.pinned).toBe(true);
    await pin(owner, newer.conversationId);
    const mine = await listOf(owner);
    expect(mine.slice(0, 2).map((c) => [String(c.id), c.pinned])).toEqual(expect.arrayContaining([[String(chat.conversationId), true], [String(newer.conversationId), true]]));
    const agents = await listOf(agent);
    expect(agents.find((c) => String(c.id) === String(newer.conversationId)).pinned).toBe(false);
    expect((await pin(owner, chat.conversationId, false)).body.data.pinned).toBe(false);

    const before = (await api().get('/api/v1/conversations/summary').set(bearer(owner.token))).body.data.all;
    const archived = await api().patch(`/api/v1/conversations/${newer.conversationId}`).set(bearer(agent.token)).send({ archived: true });
    expect(archived.body.data.archived).toBe(true);
    expect((await listOf(owner)).map((c) => String(c.id))).not.toContain(String(newer.conversationId));
    expect((await listOf(owner, 'archived')).map((c) => String(c.id))).toEqual([String(newer.conversationId)]);
    expect((await api().get('/api/v1/conversations/summary').set(bearer(owner.token))).body.data.all).toBe(before - 1);

    await simulate(owner.token, { from: '98290 33333', text: 'Hello?' });
    expect((await listOf(owner)).find((c) => String(c.id) === String(newer.conversationId))).toMatchObject({ archived: false });
  });

  it('sends a recorded note as a WhatsApp voice message (Ogg Opus, mono only), and shows when it was played', async () => {
    const send = jest.spyOn(mock, 'sendMessage');
    const upload = (buffer, name, voice = true) => api().post(`/api/v1/conversations/${chat.conversationId}/messages/media`).set(bearer(owner.token)).field('voice', String(voice)).attach('file', buffer, name);
    const sent = await upload(oggOpus(1), 'voice-note.ogg');
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ type: 'audio', media: { mimeType: 'audio/ogg', voice: true } });
    expect(send).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ type: 'audio', audio: expect.objectContaining({ voice: true }) }));

    expect((await upload(oggOpus(2), 'voice-note.ogg')).body.errors[0]).toMatchObject({ field: 'voice', code: 'VOICE_FORMAT' });
    expect((await upload(Buffer.from('ID3 not an ogg file'), 'voice-note.mp3')).status).toBe(400);
    expect(isOggOpusMono(oggOpus(1))).toBe(true);

    // Meta's "played": the first time the customer listens; a late "read" never moves it back.
    const status = (name) => deliver(account, { statuses: [{ id: sent.body.data.providerMessageId, status: name, timestamp: now(), recipient_id: '919829012345' }] });
    await status('played');
    await status('read');
    const voice = (await messages(owner.token, chat.conversationId)).find((m) => m.id === sent.body.data.id);
    expect(voice).toMatchObject({ status: 'played', playedAt: expect.any(String) });
  });
});
