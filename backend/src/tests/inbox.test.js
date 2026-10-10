jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const http = require('http');
const { io: connect } = require('socket.io-client');
const app = require('../app');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const inbound = require('../services/whatsappInboundService');
const { attachRealtime } = require('../realtime/socket');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;
const simulate = async (token, from, text, name = '') => {
  const res = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(token)).send({ from, text, name });
  if (res.status !== 201) throw new Error(`simulate: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const send = (token, conversationId, text, key) => {
  const req = api().post(`/api/v1/conversations/${conversationId}/messages`).set(bearer(token));
  return (key ? req.set('Idempotency-Key', key) : req).send({ text });
};

describe('Inbox: who sees which chat, and assigning', () => {
  let owner;
  let agentA;
  let agentB;
  let noInbox;
  let watcher;
  let chat;
  beforeAll(async () => {
    owner = await login('inbox-owner@example.com', { name: 'Owner' });
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    agentA = await inviteAndJoin(owner.token, 'inbox-a@example.com', { role: 'agent', modules: ['inbox'] });
    agentB = await inviteAndJoin(owner.token, 'inbox-b@example.com', { role: 'agent', modules: ['inbox'] });
    noInbox = await inviteAndJoin(owner.token, 'inbox-none@example.com', { role: 'agent', modules: ['leads'] });
    watcher = await inviteAndJoin(owner.token, 'inbox-watch@example.com', { role: 'agent', modules: ['inbox'], permissions: ['inbox:view_all'] });
    chat = await simulate(owner.token, '98111 00011', 'Price of cumin?', 'Sunita');
  });

  const listIds = async (user, query = '') => (await api().get(`/api/v1/conversations${query}`).set(bearer(user.token))).body.data.map((c) => c.id);

  it('a new chat is in everyone\'s queue; the list shows the contact, the preview and the open window', async () => {
    const res = await api().get('/api/v1/conversations').set(bearer(agentA.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: chat.conversationId, status: 'open', unreadCount: 1, lastMessagePreview: 'Price of cumin?', assigneeId: null,
      // Agents see customers' numbers masked unless the company turns it off (D65); searching by
      // number still works (below).
      contact: { name: 'Sunita', phone: '+91 98••• ••011' }, account: { verifiedName: 'Test Business (mock)' }, window: { open: true },
    });
    expect(await listIds(agentB)).toEqual([chat.conversationId]);
    expect((await api().get('/api/v1/conversations').set(bearer(noInbox.token))).status).toBe(403);
    expect(await listIds(agentA, '?view=unassigned')).toEqual([chat.conversationId]);
    expect(await listIds(agentA, '?view=mine')).toEqual([]);
    expect(await listIds(agentA, '?q=suni')).toEqual([chat.conversationId]);
    expect(await listIds(agentA, '?q=0011')).toEqual([chat.conversationId]);
    expect(await listIds(agentA, '?q=nobody')).toEqual([]);
  });

  it('once assigned, only the assignee and people who see all chats keep it', async () => {
    const aId = await memberId(owner.token, 'inbox-a@example.com');
    const assigned = await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(bearer(owner.token)).send({ assigneeId: aId });
    expect(assigned.body.data.assigneeId).toBe(aId);

    expect(await listIds(agentA, '?view=mine')).toEqual([chat.conversationId]);
    expect(await listIds(agentB)).toEqual([]);
    expect((await api().get(`/api/v1/conversations/${chat.conversationId}`).set(bearer(agentB.token))).status).toBe(404);
    expect((await api().get(`/api/v1/conversations/${chat.conversationId}/messages`).set(bearer(agentB.token))).status).toBe(404);
    expect(await listIds(watcher)).toEqual([chat.conversationId]);

    const summary = (await api().get('/api/v1/conversations/summary').set(bearer(agentA.token))).body.data;
    expect(summary).toEqual({ mine: 1, unassigned: 0, all: 1, unread: 1 });
    expect((await api().get('/api/v1/conversations/summary').set(bearer(agentB.token))).body.data).toMatchObject({ all: 0, unread: 0 });

    const noInboxId = await memberId(owner.token, 'inbox-none@example.com');
    const refused = await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(bearer(owner.token)).send({ assigneeId: noInboxId });
    expect(refused.body.errors[0].code).toBe('ASSIGNEE_NO_INBOX');

    // The assignee can hand it back to the queue.
    expect((await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(bearer(agentA.token)).send({ assigneeId: null })).body.data.assigneeId).toBeNull();
    expect(await listIds(agentB)).toEqual([chat.conversationId]);
  });

  it('closing and reading a chat', async () => {
    const read = await api().post(`/api/v1/conversations/${chat.conversationId}/read`).set(bearer(agentB.token));
    expect(read.body.data.unreadCount).toBe(0);
    const closed = await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(bearer(agentB.token)).send({ status: 'closed', tags: [' vip ', 'vip', 'bulk'] });
    expect(closed.body.data).toMatchObject({ status: 'closed', tags: ['vip', 'bulk'] });
    expect(await listIds(owner)).toEqual([]); // the default list hides closed chats
    expect(await listIds(owner, '?status=closed')).toEqual([chat.conversationId]);
    await simulate(owner.token, '98111 00011', 'Hello again');
    expect(await listIds(owner)).toEqual([chat.conversationId]); // a new message reopens it
  });

  it('another organization sees none of it', async () => {
    const stranger = await login('inbox-stranger@example.com');
    expect(await listIds(stranger)).toEqual([]);
    expect((await api().get(`/api/v1/conversations/${chat.conversationId}`).set(bearer(stranger.token))).status).toBe(404);
    expect((await send(stranger.token, chat.conversationId, 'hi')).status).toBe(404);
  });
});

describe('Inbox: messages, sending and notes', () => {
  let owner;
  let agent;
  let chat;
  beforeAll(async () => {
    owner = await login('send-owner@example.com');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    agent = await inviteAndJoin(owner.token, 'send-agent@example.com', { role: 'agent', modules: ['inbox'] });
    chat = await simulate(owner.token, '98290 12345', 'Need 20kg jeera', 'Ravi');
  });
  afterEach(() => jest.restoreAllMocks());

  it('pages through messages, oldest first within a page', async () => {
    for (let i = 1; i <= 4; i += 1) await simulate(owner.token, '98290 12345', `Line ${i}`);
    const first = await api().get(`/api/v1/conversations/${chat.conversationId}/messages?limit=2`).set(bearer(owner.token));
    expect(first.body.data.map((m) => m.text)).toEqual(['Line 3', 'Line 4']);
    expect(first.body.hasMore).toBe(true);
    // The Inbox matches quoted replies by WhatsApp's message id.
    expect(first.body.data[0].providerMessageId).toMatch(/^wamid\./);
    const older = await api().get(`/api/v1/conversations/${chat.conversationId}/messages?limit=10&before=${first.body.nextBefore}`).set(bearer(owner.token));
    expect(older.body.data.map((m) => m.text)).toEqual(['Need 20kg jeera', 'Line 1', 'Line 2']);
    expect(older.body.hasMore).toBe(false);
  });

  it('sends a reply once per click; the first reply takes the unassigned chat', async () => {
    const agentId = await memberId(owner.token, 'send-agent@example.com');
    const res = await send(agent.token, chat.conversationId, 'Rs 250/kg + GST', 'reply-key-0001');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ direction: 'out', type: 'text', text: 'Rs 250/kg + GST', status: 'sent', sentByMemberId: agentId });
    const again = await send(agent.token, chat.conversationId, 'Rs 250/kg + GST', 'reply-key-0001');
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await Message.countDocuments({ conversationId: chat.conversationId, direction: 'out' })).toBe(1);

    const conversation = await Conversation.findById(chat.conversationId);
    expect(conversation).toMatchObject({ lastMessageDirection: 'out', lastMessagePreview: 'Rs 250/kg + GST' });
    expect(String(conversation.assigneeId)).toBe(agentId);

    // Meta's delivery receipt for it moves it forward.
    const stored = await Message.findById(res.body.data.id);
    await inbound.processNow(await inbound.ingest(await require('../models/WhatsAppAccount').findById(stored.whatsappAccountId), {
      entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: stored.providerMessageId, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }],
    }));
    expect((await Message.findById(stored._id)).status).toBe('delivered');
  });

  it('refuses free text after 24 hours without a customer message', async () => {
    await Conversation.updateOne({ _id: chat.conversationId }, { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    const res = await send(owner.token, chat.conversationId, 'Are you there?');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('WINDOW_CLOSED');
    const listed = (await api().get(`/api/v1/conversations/${chat.conversationId}`).set(bearer(owner.token))).body.data;
    expect(listed.window.open).toBe(false);
    await Conversation.updateOne({ _id: chat.conversationId }, { lastInboundAt: new Date() });
  });

  it('sends through the Cloud API and keeps WhatsApp\'s refusal on the message', async () => {
    const meta = await login('send-meta@example.com');
    const graph = jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      if (!options.method || options.method === 'GET') return new Response(JSON.stringify({ display_phone_number: '+91 90000 11111', verified_name: 'Meta Shop' }), { status: 200 });
      const body = JSON.parse(options.body);
      if (body.text.body === 'fail please') {
        return new Response(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047, error_data: { details: 'More than 24 hours have passed since the recipient last replied.' } } }), { status: 400 });
      }
      return new Response(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: 'wamid.SENT1' }] }), { status: 200 });
    });
    const account = (await api().post('/api/v1/whatsapp/accounts').set(bearer(meta.token)).send({ phoneNumberId: '7778889990', accessToken: 'EAAG-token-abcdefgh', appSecret: 'meta-app-secret-123456' })).body.data;
    const conv = await simulate(meta.token, '98765 43210', 'hello');
    const firstMessageId = (await api().get(`/api/v1/conversations/${conv.conversationId}/messages`).set(bearer(meta.token))).body.data[0].id;

    const ok = await api().post(`/api/v1/conversations/${conv.conversationId}/messages`).set(bearer(meta.token)).send({ text: 'See https://shop.example', replyToMessageId: firstMessageId });
    expect(ok.body.data).toMatchObject({ status: 'sent' });
    expect((await Message.findById(ok.body.data.id)).providerMessageId).toBe('wamid.SENT1');
    const [url, options] = graph.mock.calls.at(-1);
    expect(url).toBe('https://graph.facebook.com/v26.0/7778889990/messages');
    expect(JSON.parse(options.body)).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'text',
      text: { body: 'See https://shop.example', preview_url: true }, context: { message_id: expect.stringMatching(/^wamid\.SIM/) },
    });

    const refused = await api().post(`/api/v1/conversations/${conv.conversationId}/messages`).set(bearer(meta.token)).send({ text: 'fail please' });
    expect(refused.status).toBe(201);
    expect(refused.body.data).toMatchObject({ status: 'failed', error: { code: 131047, message: 'More than 24 hours have passed since the recipient last replied.' } });
    expect(account.id).toBeTruthy();
  });

  it('keeps internal notes on the chat (never sent to the customer)', async () => {
    const note = await api().post(`/api/v1/conversations/${chat.conversationId}/notes`).set(bearer(agent.token)).send({ text: 'Regular buyer, give 5% off' });
    expect(note.status).toBe(201);
    const notes = await api().get(`/api/v1/conversations/${chat.conversationId}/notes`).set(bearer(owner.token));
    expect(notes.body.data.map((n) => n.text)).toEqual(['Regular buyer, give 5% off']);
    expect(await Message.countDocuments({ conversationId: chat.conversationId, text: 'Regular buyer, give 5% off' })).toBe(0);
  });
});

describe('Who owns a WhatsApp customer (D25)', () => {
  it('the person handling the chat gets the unowned contact and open leads, never a teammate\'s', async () => {
    const owner = await login('own-owner@example.com');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    const agent = await inviteAndJoin(owner.token, 'own-agent@example.com', { role: 'agent' });
    const agentId = await memberId(owner.token, 'own-agent@example.com');
    const ownerId = await memberId(owner.token, 'own-owner@example.com');

    // A new WhatsApp number: contact + lead without an owner; assigning the chat hands both over.
    const fresh = await simulate(owner.token, '98300 11111', 'New customer');
    const Lead = require('../models/Lead');
    const Contact = require('../models/Contact');
    const freshLead = await Lead.findOne({ contactId: fresh.contactId });
    expect(freshLead.ownerId).toBeFalsy();
    await api().patch(`/api/v1/conversations/${fresh.conversationId}`).set(bearer(owner.token)).send({ assigneeId: agentId });
    expect(String((await Lead.findById(freshLead._id)).ownerId)).toBe(agentId);
    expect(String((await Contact.findById(fresh.contactId)).ownerId)).toBe(agentId);

    // A customer the owner already looks after keeps its owner when the agent takes the chat.
    const known = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Known', phone: '98300 22222' }, title: 'Bulk order' })).body.data;
    const chat = await simulate(owner.token, '98300 22222', 'Hello again');
    await api().post(`/api/v1/conversations/${chat.conversationId}/messages`).set(bearer(agent.token)).send({ text: 'Namaste' });
    expect(String((await Lead.findById(known.id)).ownerId)).toBe(ownerId);
    expect(String((await Contact.findById(known.contactId)).ownerId)).toBe(ownerId);
  });
});

describe('Quick replies', () => {
  it('are shared by the organization; shortcuts are unique; deleting needs inbox:delete', async () => {
    const owner = await login('qr-owner@example.com');
    const agent = await inviteAndJoin(owner.token, 'qr-agent@example.com', { role: 'agent', modules: ['inbox'] });
    const created = await api().post('/api/v1/quick-replies').set(bearer(agent.token)).send({ shortcut: 'Price', title: 'Price list', body: 'Cumin 1kg ₹250 + GST' });
    expect(created.status).toBe(201);
    expect(created.body.data.shortcut).toBe('price');
    expect((await api().post('/api/v1/quick-replies').set(bearer(owner.token)).send({ shortcut: 'price', body: 'x' })).body.code).toBe('DUPLICATE_SHORTCUT');
    expect((await api().post('/api/v1/quick-replies').set(bearer(owner.token)).send({ shortcut: 'has space', body: 'x' })).status).toBe(400);
    const list = await api().get('/api/v1/quick-replies').set(bearer(owner.token));
    expect(list.body.data.map((r) => r.shortcut)).toEqual(['price']);
    expect((await api().patch(`/api/v1/quick-replies/${created.body.data.id}`).set(bearer(agent.token)).send({ body: 'Cumin 1kg ₹260 + GST' })).body.data.body).toBe('Cumin 1kg ₹260 + GST');
    expect((await api().delete(`/api/v1/quick-replies/${created.body.data.id}`).set(bearer(agent.token))).status).toBe(403);
    expect((await api().delete(`/api/v1/quick-replies/${created.body.data.id}`).set(bearer(owner.token))).status).toBe(200);
    const stranger = await login('qr-stranger@example.com');
    expect((await api().get('/api/v1/quick-replies').set(bearer(stranger.token))).body.data).toEqual([]);
  });
});

describe('Live updates (Socket.IO)', () => {
  let server;
  let io;
  let url;
  const sockets = [];
  beforeAll(async () => {
    server = http.createServer(app);
    io = attachRealtime(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    sockets.forEach((socket) => socket.close());
    io.detach();
    await new Promise((resolve) => io.close(resolve));
  });

  const open = (token) => new Promise((resolve, reject) => {
    const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (error) => reject(error));
  });
  // Resolves with the next matching event, or null after a short wait.
  const next = (socket, event, match = () => true, ms = 1500) => new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
    function handler(payload) {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });

  it('tells each member about the chats they may see, and refuses bad tokens', async () => {
    const owner = await login('live-owner@example.com');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    const agentA = await inviteAndJoin(owner.token, 'live-a@example.com', { role: 'agent', modules: ['inbox'] });
    const agentB = await inviteAndJoin(owner.token, 'live-b@example.com', { role: 'agent', modules: ['inbox'] });
    const leadsOnly = await inviteAndJoin(owner.token, 'live-leads@example.com', { role: 'agent', modules: ['leads'] });
    const stranger = await login('live-stranger@example.com');

    await expect(open('not-a-token')).rejects.toThrow('UNAUTHORIZED');
    await expect(open(leadsOnly.token)).rejects.toThrow('FORBIDDEN');
    const [ownerSocket, aSocket, bSocket, strangerSocket] = await Promise.all([owner, agentA, agentB, stranger].map((u) => open(u.token)));

    // A new, unassigned chat: owner and both agents hear about it; the other company does not.
    const heard = [ownerSocket, aSocket, bSocket, strangerSocket].map((s) => next(s, 'message:new', (p) => p.message.text === 'First!'));
    const chat = await simulate(owner.token, '98111 22233', 'First!', 'Kiran');
    const [toOwner, toA, toB, toStranger] = await Promise.all(heard);
    expect(toOwner).toMatchObject({ conversation: { id: chat.conversationId, contact: { name: 'Kiran' }, unreadCount: 1 }, message: { direction: 'in', text: 'First!' } });
    expect(toA).not.toBeNull();
    expect(toB).not.toBeNull();
    expect(toStranger).toBeNull();

    // Assigned to A: B is told (so the chat leaves B's queue), then no longer hears its messages.
    const aId = await memberId(owner.token, 'live-a@example.com');
    const bUpdate = next(bSocket, 'conversation:updated', (c) => c.id === chat.conversationId);
    await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(bearer(owner.token)).send({ assigneeId: aId });
    expect(await bUpdate).toMatchObject({ assigneeId: aId });

    const later = [ownerSocket, aSocket, bSocket].map((s) => next(s, 'message:new', (p) => p.message.text === 'Second'));
    await simulate(owner.token, '98111 22233', 'Second');
    const [ownerGot, aGot, bGot] = await Promise.all(later);
    expect(ownerGot).not.toBeNull();
    expect(aGot).not.toBeNull();
    expect(bGot).toBeNull();

    // A's reply and its delivery status reach the owner live.
    const reply = next(ownerSocket, 'message:new', (p) => p.message.direction === 'out');
    await send(agentA.token, chat.conversationId, 'Coming up!');
    expect((await reply).message).toMatchObject({ text: 'Coming up!', status: 'sent' });

    // A loses the inbox page: the connection is dropped right away.
    const dropped = new Promise((resolve) => aSocket.once('disconnect', resolve));
    await api().patch(`/api/v1/members/${aId}`).set(bearer(owner.token)).send({ modules: ['leads'] });
    expect(await dropped).toBe('io server disconnect');
  });
});
