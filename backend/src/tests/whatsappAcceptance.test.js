jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const http = require('http');
const { io: connect } = require('socket.io-client');
const app = require('../app');
const env = require('../config/env');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const inbound = require('../services/whatsappInboundService');
const { attachRealtime } = require('../realtime/socket');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 3 acceptance: a customer writes on WhatsApp and the team handles the chat end to end,
// through the real Cloud API code (Meta's servers replaced by a fake fetch), with live updates;
// another company sees none of it; test-only features are off in production.
const APP_SECRET = 'acceptance-app-secret-012345';
const TOKEN = 'EAAG-acceptance-token-7788';
const PHONE_NUMBER_ID = '5550001234';
const WABA_ID = '4440001234';
const CUSTOMER = '919829012345';
const PHOTO = Buffer.from('a customer photo, pretend jpeg');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sign = (raw, secret = APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const now = () => String(Math.floor(Date.now() / 1000));
const change = (field, value) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, time: Number(now()), changes: [{ field, value }] }] });
const messages = (list) => change('messages', {
  messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_NUMBER_ID }, contacts: [{ profile: { name: 'Ravi Traders' }, wa_id: CUSTOMER }], messages: list,
});
const statuses = (list) => change('messages', { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_NUMBER_ID }, statuses: list });
const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('Phase 3 acceptance: a WhatsApp customer, handled by the team', () => {
  let server;
  let io;
  let url;
  const sockets = [];
  const graphCalls = [];
  let owner;
  let agentA;
  let agentB;
  let stranger;
  let account;
  let webhook;

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

  // Meta's Graph API, as the CRM sees it.
  function fakeMeta() {
    let sent = 0;
    const realFetch = global.fetch;
    jest.spyOn(global, 'fetch').mockImplementation(async (target, options = {}) => {
      const u = String(target);
      if (u.startsWith(url)) return realFetch(target, options); // the test's own calls
      const method = options.method || 'GET';
      graphCalls.push({ url: u, method, body: options.body, headers: options.headers });
      if (u.includes('/message_templates')) {
        return json({ data: [{ id: '9001', name: 'order_update', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Namaste {{1}}, your order {{2}} is ready.' }] }], paging: { cursors: { after: 'X' } } });
      }
      if (u.includes('/MEDIA-IN-1?')) return json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'image/jpeg', sha256: crypto.createHash('sha256').update(PHOTO).digest('hex'), file_size: PHOTO.length });
      if (u.startsWith('https://lookaside.fbsbx.com/')) return new Response(PHOTO, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      if (u.endsWith('/messages') && method === 'POST') {
        sent += 1;
        return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT${sent}` }] });
      }
      return json({ display_phone_number: '+91 90000 12345', verified_name: 'Yellow Traders', quality_rating: 'GREEN' });
    });
  }

  const open = (token) => new Promise((resolve, reject) => {
    const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
  const next = (socket, event, match = () => true, ms = 2000) => new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
    function handler(payload) {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
  const post = async (payload, signature) => {
    const raw = JSON.stringify(payload);
    const res = await api().post(webhook).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature || sign(raw)).send(raw);
    await inbound.idle();
    return res;
  };

  it('works from the first message to a template after 24 hours', async () => {
    fakeMeta();
    owner = await login('p3-owner@example.com', { name: 'Asha' });
    agentA = await inviteAndJoin(owner.token, 'p3-agent-a@example.com', { role: 'agent', name: 'Arun' });
    agentB = await inviteAndJoin(owner.token, 'p3-agent-b@example.com', { role: 'agent', name: 'Bela' });
    stranger = await login('p3-stranger@example.com');
    const members = (await api().get('/api/v1/members').set(bearer(owner.token))).body.data;
    const aId = members.find((m) => m.email === 'p3-agent-a@example.com').id;

    // 1. The owner connects the number (checked with Meta).
    account = (await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token))
      .send({ name: 'Sales', phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: TOKEN, appSecret: APP_SECRET })).body.data;
    expect(account.status).toBe('connected');
    webhook = account.webhookPath;
    const [ownerSocket, aSocket, bSocket, strangerSocket] = await Promise.all([owner, agentA, agentB, stranger].map((u) => open(u.token)));

    // 2. A customer writes. Everyone in the company hears it live; the other company does not.
    const heard = [ownerSocket, aSocket, bSocket, strangerSocket].map((s) => next(s, 'message:new', (p) => p.message.text === 'Namaste, 50kg jeera ka rate?'));
    const first = messages([{ from: CUSTOMER, id: 'wamid.IN1', timestamp: now(), type: 'text', text: { body: 'Namaste, 50kg jeera ka rate?' } }]);
    expect((await post(first)).status).toBe(200);
    const [toOwner, toA, toB, toStranger] = await Promise.all(heard);
    expect(toOwner).toMatchObject({ conversation: { contact: { name: 'Ravi Traders', phone: `+${CUSTOMER}` }, assigneeId: null, window: { open: true } } });
    expect(toA).not.toBeNull();
    expect(toB).not.toBeNull();
    expect(toStranger).toBeNull();
    const conversationId = toOwner.conversation.id;

    // The number became a contact and a WhatsApp lead; Meta's retry of the same webhook changes nothing.
    await post(first);
    expect(await Message.countDocuments({ conversationId })).toBe(1);
    const { organizationId } = await Conversation.findById(conversationId);
    const contact = await Contact.findOne({ phoneE164: `+${CUSTOMER}`, organizationId });
    const lead = await Lead.findOne({ contactId: contact._id });
    expect(lead).toMatchObject({ stage: 'New', source: 'WhatsApp' });
    expect(lead.ownerId).toBeFalsy();
    expect((await api().get(`/api/v1/leads?contactId=${contact._id}`).set(bearer(agentA.token))).body.data).toEqual([]);

    // 3. Agent A answers first: the chat and the unowned customer become A's (D24, D25); B is told live.
    const bLoses = next(bSocket, 'conversation:updated', (c) => c.id === conversationId && c.assigneeId === aId);
    const reply = await api().post(`/api/v1/conversations/${conversationId}/messages`).set(bearer(agentA.token)).set('Idempotency-Key', 'p3-reply-00001')
      .send({ text: '50kg: ₹12,500 + 5% GST. Kab chahiye?' });
    expect(reply.body.data).toMatchObject({ status: 'sent', direction: 'out' });
    expect(await bLoses).not.toBeNull();
    expect((await api().get(`/api/v1/conversations/${conversationId}`).set(bearer(agentB.token))).status).toBe(404);
    const aLeads = (await api().get(`/api/v1/leads?contactId=${contact._id}`).set(bearer(agentA.token))).body.data;
    expect(aLeads.map((l) => [l.id, l.ownerId])).toEqual([[String(lead._id), aId]]);
    const sentToMeta = graphCalls.find((c) => c.url.endsWith(`/${PHONE_NUMBER_ID}/messages`));
    expect(JSON.parse(sentToMeta.body)).toMatchObject({ to: CUSTOMER, type: 'text', text: { body: '50kg: ₹12,500 + 5% GST. Kab chahiye?' } });
    expect(sentToMeta.headers.Authorization).toBe(`Bearer ${TOKEN}`);

    // 4. Delivery ticks arrive out of order; the message ends at "read" and A sees it live.
    const readTick = next(aSocket, 'message:status', (m) => m.id === reply.body.data.id && m.status === 'read');
    await post(statuses([{ id: 'wamid.OUT1', status: 'read', timestamp: now(), recipient_id: CUSTOMER }]));
    await post(statuses([{ id: 'wamid.OUT1', status: 'delivered', timestamp: now(), recipient_id: CUSTOMER }]));
    expect(await readTick).not.toBeNull();
    expect((await Message.findById(reply.body.data.id)).status).toBe('read');

    // 5. The customer sends a photo: it is copied into the CRM; A can open it, B cannot.
    await post(messages([{ from: CUSTOMER, id: 'wamid.IN2', timestamp: now(), type: 'image', image: { id: 'MEDIA-IN-1', mime_type: 'image/jpeg', caption: 'Yeh wala' } }]));
    const photo = await Message.findOne({ providerMessageId: 'wamid.IN2' });
    expect(photo.media.storageKey).toBeTruthy();
    const download = (user) => api().get(`/api/v1/conversations/${conversationId}/messages/${photo._id}/media`).set(bearer(user.token)).buffer(true).parse(binary);
    expect((await download(agentA)).body.equals(PHOTO)).toBe(true);
    expect((await download(agentB)).status).toBe(404);

    // 6. A moves the lead on and notes something for the team (never sent to the customer).
    const moved = await api().post(`/api/v1/leads/${lead._id}/stage`).set(bearer(agentA.token)).send({ stage: 'Quote Sent', version: aLeads[0].version });
    expect(moved.body.data.stage).toBe('Quote Sent');
    const noteHeard = next(ownerSocket, 'note:new', (p) => p.conversationId === conversationId);
    await api().post(`/api/v1/conversations/${conversationId}/notes`).set(bearer(agentA.token)).send({ text: 'Regular buyer, 2% off ok' });
    expect(await noteHeard).not.toBeNull();
    expect(graphCalls.some((c) => String(c.body || '').includes('Regular buyer'))).toBe(false);

    // 7. A day later only a template may go out: the owner syncs templates, A sends one.
    await Conversation.updateOne({ _id: conversationId }, { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    const late = await api().post(`/api/v1/conversations/${conversationId}/messages`).set(bearer(agentA.token)).send({ text: 'Hello?' });
    expect(late.body.code).toBe('WINDOW_CLOSED');
    const templates = (await api().post('/api/v1/templates/sync').set(bearer(owner.token)).send({})).body.data;
    const template = await api().post(`/api/v1/conversations/${conversationId}/messages`).set(bearer(agentA.token))
      .send({ type: 'template', templateId: templates[0].id, variables: { body: { 1: 'Ravi ji', 2: '#45' } } });
    expect(template.body.data).toMatchObject({ type: 'template', status: 'sent', text: 'Namaste Ravi ji, your order #45 is ready.' });
    expect(JSON.parse(graphCalls.filter((c) => c.url.endsWith('/messages')).at(-1).body).template).toEqual({
      name: 'order_update', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi ji' }, { type: 'text', text: '#45' }] }],
    });

    // Meta pauses the template: it cannot be sent any more.
    await post(change('message_template_status_update', { event: 'PAUSED', message_template_id: 9001, message_template_name: 'order_update', message_template_language: 'en', reason: 'LOW_QUALITY' }));
    const paused = await api().post(`/api/v1/conversations/${conversationId}/messages`).set(bearer(agentA.token))
      .send({ type: 'template', templateId: templates[0].id, variables: { body: { 1: 'x', 2: 'y' } } });
    expect(paused.body.code).toBe('TEMPLATE_NOT_SENDABLE');

    // 8. Forged or misdirected webhooks are refused and stored nowhere.
    const forged = messages([{ from: CUSTOMER, id: 'wamid.FORGED', timestamp: now(), type: 'text', text: { body: 'send money' } }]);
    expect((await post(forged, sign(JSON.stringify(forged), 'someone-elses-secret-000'))).status).toBe(401);
    expect((await api().post('/api/v1/webhooks/whatsapp/0123456789abcdef0123456789abcdef').send({})).status).toBe(404);
    expect(await Message.exists({ providerMessageId: 'wamid.FORGED' })).toBeNull();
  });

  it('shows another company none of it, even with the ids', async () => {
    const own = await Conversation.findOne({ whatsappAccountId: account.id });
    const message = await Message.findOne({ conversationId: own._id, type: 'image' });
    const template = (await api().get('/api/v1/templates').set(bearer(owner.token))).body.data[0];
    const quick = (await api().post('/api/v1/quick-replies').set(bearer(owner.token)).send({ shortcut: 'rate', body: 'Rate list attached' })).body.data;
    await api().post('/api/v1/whatsapp/accounts').set(bearer(stranger.token)).send({ provider: 'mock' });
    const as = (method, path, body) => api()[method](`/api/v1${path}`).set(bearer(stranger.token)).send(body);

    const refused = await Promise.all([
      as('get', `/conversations/${own._id}`),
      as('get', `/conversations/${own._id}/messages`),
      as('get', `/conversations/${own._id}/notes`),
      as('get', `/conversations/${own._id}/messages/${message._id}/media`),
      as('patch', `/conversations/${own._id}`, { status: 'closed' }),
      as('post', `/conversations/${own._id}/read`),
      as('post', `/conversations/${own._id}/messages`, { text: 'hi' }),
      as('post', `/conversations/${own._id}/notes`, { text: 'hi' }),
      as('post', '/conversations', { contactId: String(own.contactId) }),
      as('delete', `/templates/${template.id}`),
      as('patch', `/quick-replies/${quick.id}`, { body: 'changed' }),
      as('delete', `/quick-replies/${quick.id}`),
      as('patch', `/whatsapp/accounts/${account.id}`, { name: 'mine now' }),
      as('delete', `/whatsapp/accounts/${account.id}`),
      as('get', `/whatsapp/click-to-chat?accountId=${account.id}`),
      as('post', '/dev/simulate/whatsapp-inbound', { accountId: account.id, from: '98290 11111', text: 'x' }),
    ]);
    refused.forEach((res) => expect({ path: res.req.path, status: res.status }).toEqual({ path: res.req.path, status: 404 }));

    const lists = await Promise.all([
      as('get', '/conversations?status=any'),
      as('get', `/conversations?contactId=${own.contactId}&status=any`),
      as('get', '/templates'),
      as('get', '/quick-replies'),
    ]);
    lists.forEach((res) => expect(res.body.data).toEqual([]));
    expect((await as('get', '/conversations/summary')).body.data).toEqual({ mine: 0, unassigned: 0, all: 0, unread: 0 });
    expect((await as('get', '/whatsapp/accounts')).body.data.map((a) => a.id)).not.toContain(account.id);
    expect(await Conversation.findById(own._id)).toMatchObject({ status: 'open' });
  });
});

describe('Phase 3 acceptance: test-only features are off in production', () => {
  it('refuses test numbers and hides the simulator', async () => {
    const owner = await login('p3-prod@example.com');
    const mock = await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    expect(mock.status).toBe(201);
    env.isProduction = true;
    try {
      expect((await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' })).status).toBe(400);
      expect((await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from: '98290 12345', text: 'x' })).status).toBe(404);
    } finally {
      env.isProduction = false;
    }
  });
});
