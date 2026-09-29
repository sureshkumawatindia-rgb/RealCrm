jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const inbound = require('../services/whatsappInboundService');
const mock = require('../integrations/whatsapp/mock');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const APP_SECRET = 'media-app-secret-0123456789';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sign = (raw) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const postWebhook = (account, payload) => {
  const raw = JSON.stringify(payload);
  return api().post(account.webhookPath).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw);
};
const webhook = (phoneNumberId, messages, from = '919829012345') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, contacts: [{ profile: { name: 'Ravi' }, wa_id: from }], messages } }] }],
});
const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
const simulate = async (token, body) => {
  const res = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(token)).send(body);
  if (res.status !== 201) throw new Error(`simulate: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const lastMessage = async (token, conversationId) => (await api().get(`/api/v1/conversations/${conversationId}/messages`).set(bearer(token))).body.data.at(-1);
const download = (token, conversationId, messageId) => api().get(`/api/v1/conversations/${conversationId}/messages/${messageId}/media`).set(bearer(token)).buffer(true).parse(binary);
const sendFile = (token, conversationId, { name, content, caption, key }) => {
  const req = api().post(`/api/v1/conversations/${conversationId}/messages/media`).set(bearer(token));
  if (key) req.set('Idempotency-Key', key);
  if (caption !== undefined) req.field('caption', caption);
  return content ? req.attach('file', content, name) : req.field('caption', caption || '');
};
const png = () => mock.sampleFile('image').buffer;

describe('Photos, documents and voice notes on a test number', () => {
  let owner;
  let agentA;
  let agentB;
  let chat;
  beforeAll(async () => {
    owner = await login('media-owner@example.com');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    agentA = await inviteAndJoin(owner.token, 'media-a@example.com', { role: 'agent', modules: ['inbox'] });
    agentB = await inviteAndJoin(owner.token, 'media-b@example.com', { role: 'agent', modules: ['inbox'] });
    chat = await simulate(owner.token, { from: '98290 12345', text: 'Hi', name: 'Ravi' });
  });

  it('an incoming photo is copied into the CRM and only people who see the chat can download it', async () => {
    await simulate(owner.token, { from: '98290 12345', type: 'image', text: 'Sample of the goods' });
    const photo = await lastMessage(owner.token, chat.conversationId);
    expect(photo).toMatchObject({ type: 'image', text: 'Sample of the goods', media: { mimeType: 'image/png', hasFile: true } });
    const conversation = (await api().get(`/api/v1/conversations/${chat.conversationId}`).set(bearer(owner.token))).body.data;
    expect(conversation.lastMessagePreview).toBe('Photo: Sample of the goods');

    const file = await download(agentB.token, chat.conversationId, photo.id);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/^application\/octet-stream/);
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="whatsapp-image-\d{4}-\d{2}-\d{2}\.png"/);
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(file.body.equals(png())).toBe(true);

    const aId = (await api().get('/api/v1/members').set(bearer(owner.token))).body.data.find((m) => m.email === 'media-a@example.com').id;
    await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(bearer(owner.token)).send({ assigneeId: aId });
    expect((await download(agentB.token, chat.conversationId, photo.id)).status).toBe(404);
    expect((await download(agentA.token, chat.conversationId, photo.id)).status).toBe(200);
  });

  it('documents keep their name; voice notes are marked as such', async () => {
    await simulate(owner.token, { from: '98290 12345', type: 'document', text: 'Our order' });
    const doc = await lastMessage(owner.token, chat.conversationId);
    expect(doc).toMatchObject({ type: 'document', text: 'Our order', media: { fileName: 'Sample document.pdf', mimeType: 'application/pdf', hasFile: true } });
    const file = await download(owner.token, chat.conversationId, doc.id);
    expect(file.headers['content-disposition']).toContain('filename="Sample document.pdf"');
    expect(file.body.subarray(0, 5).toString()).toBe('%PDF-');

    await simulate(owner.token, { from: '98290 12345', type: 'audio' });
    expect(await lastMessage(owner.token, chat.conversationId)).toMatchObject({ type: 'audio', media: { voice: true, hasFile: true } });
    const video = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from: '98290 12345', type: 'video' });
    expect(video.status).toBe(400);
  });

  it('sends a photo or document inside the window and refuses what WhatsApp would refuse', async () => {
    const sent = await sendFile(agentA.token, chat.conversationId, { name: 'price list.png', content: png(), caption: 'Our price list' });
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ type: 'image', text: 'Our price list', status: 'sent', media: { mimeType: 'image/png', fileName: 'price list.png', hasFile: true } });
    expect((await download(agentA.token, chat.conversationId, sent.body.data.id)).body.equals(png())).toBe(true);
    expect((await api().get(`/api/v1/conversations/${chat.conversationId}`).set(bearer(owner.token))).body.data.lastMessagePreview).toBe('Photo: Our price list');

    const exe = await sendFile(agentA.token, chat.conversationId, { name: 'setup.exe', content: Buffer.from('MZ fake program') });
    expect(exe.status).toBe(400);
    expect(exe.body.code).toBe('UNSUPPORTED_FILE');
    const big = await sendFile(agentA.token, chat.conversationId, { name: 'big.png', content: Buffer.alloc(5 * 1024 * 1024 + 1) });
    expect(big.status).toBe(413);
    expect(big.body.message).toBe('Photos can be up to 5 MB on WhatsApp.');
    expect((await sendFile(agentA.token, chat.conversationId, { name: 'note.mp3', content: Buffer.from('ID3 fake mp3'), caption: 'listen' })).status).toBe(400);
    expect((await sendFile(agentA.token, chat.conversationId, { caption: 'no file' })).status).toBe(400);

    // The same click twice sends once; the same key with another file is refused.
    const first = await sendFile(agentA.token, chat.conversationId, { name: 'quote.pdf', content: mock.sampleFile('document').buffer, key: 'media-key-0001' });
    const again = await sendFile(agentA.token, chat.conversationId, { name: 'quote.pdf', content: mock.sampleFile('document').buffer, key: 'media-key-0001' });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data.id).toBe(first.body.data.id);
    expect((await sendFile(agentA.token, chat.conversationId, { name: 'quote.pdf', content: png(), key: 'media-key-0001' })).status).toBe(422);
    expect(await Message.countDocuments({ conversationId: chat.conversationId, 'media.fileName': 'quote.pdf' })).toBe(1);

    await Conversation.updateOne({ _id: chat.conversationId }, { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    const closed = await sendFile(agentA.token, chat.conversationId, { name: 'late.png', content: png() });
    expect(closed.status).toBe(422);
    expect(closed.body.code).toBe('WINDOW_CLOSED');
  });

  it('starts a chat from a contact: one per contact and number, assigned to whoever starts it', async () => {
    const contact = (await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Mohan', phone: '98111 22233' })).body.data;
    const started = await api().post('/api/v1/conversations').set(bearer(owner.token)).send({ contactId: contact.id });
    expect(started.status).toBe(201);
    expect(started.body.data).toMatchObject({ contact: { id: contact.id, phone: '+919811122233' }, window: { open: false }, status: 'open' });
    expect(started.body.data.assigneeId).toBeTruthy();
    const same = await api().post('/api/v1/conversations').set(bearer(owner.token)).send({ contactId: contact.id });
    expect(same.status).toBe(200);
    expect(same.body.data.id).toBe(started.body.data.id);
    const forContact = await api().get(`/api/v1/conversations?contactId=${contact.id}&status=any`).set(bearer(owner.token));
    expect(forContact.body.data.map((c) => c.id)).toEqual([started.body.data.id]);

    // An agent cannot start chats with contacts they cannot see, or take a teammate's chat.
    expect((await api().post('/api/v1/conversations').set(bearer(agentA.token)).send({ contactId: contact.id })).status).toBe(404);
    const seller = await inviteAndJoin(owner.token, 'media-seller@example.com', { role: 'agent', modules: ['inbox', 'customers'], permissions: ['customers:view_all'] });
    const taken = await api().post('/api/v1/conversations').set(bearer(seller.token)).send({ contactId: contact.id });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('CHAT_ASSIGNED');

    const noPhone = (await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'No phone', email: 'nophone@example.com' })).body.data;
    expect((await api().post('/api/v1/conversations').set(bearer(owner.token)).send({ contactId: noPhone.id })).body.code).toBe('NO_PHONE');
  });

  it('gives owners and admins a click-to-chat link and QR code', async () => {
    const res = await api().get('/api/v1/whatsapp/click-to-chat?text=Hi%20there').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ phone: '+919000000000', link: 'https://wa.me/919000000000?text=Hi%20there' });
    expect(res.body.data.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(res.body.data.qrDataUrl.split(',')[1], 'base64').toString()).toContain('<svg');

    const qr = await api().get('/api/v1/whatsapp/click-to-chat/qr.png').set(bearer(owner.token)).buffer(true).parse(binary);
    expect(qr.status).toBe(200);
    expect(qr.headers['content-disposition']).toContain('whatsapp-qr.png');
    expect(qr.body.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect((await api().get('/api/v1/whatsapp/click-to-chat').set(bearer(agentA.token))).status).toBe(403);
  });
});

describe('Files through the Cloud API', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fetches incoming files with the token and checks them, retries when opened, and uploads before sending', async () => {
    const owner = await login('media-meta@example.com');
    const photo = Buffer.from('fake jpeg bytes for the test');
    const calls = [];
    let lateReady = false;
    jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const u = String(url);
      const method = options.method || 'GET';
      calls.push({ url: u, method, options });
      const mediaId = /v26\.0\/(MEDIA-[A-Z]+)\?/.exec(u)?.[1];
      if (mediaId === 'MEDIA-LATE' && !lateReady) return json({ error: { message: 'Media not found', code: 100 } }, 404);
      if (mediaId) return json({ url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${mediaId}`, mime_type: 'image/jpeg', sha256: crypto.createHash('sha256').update(photo).digest('hex'), file_size: photo.length, id: mediaId });
      if (u.startsWith('https://lookaside.fbsbx.com/')) {
        return new Response(u.endsWith('MEDIA-BAD') ? Buffer.from('tampered') : photo, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (u.endsWith('/media') && method === 'POST') return json({ id: 'MEDIA-UPLOADED-1' });
      if (u.endsWith('/messages') && method === 'POST') return json({ messages: [{ id: `wamid.OUT${calls.length}` }] });
      return json({ display_phone_number: '+91 90000 33333', verified_name: 'Meta Shop' });
    });
    const account = (await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ phoneNumberId: '7770001111', accessToken: 'EAAG-token-media-5678', appSecret: APP_SECRET })).body.data;
    const image = (id) => ({ from: '919829012345', id: `wamid.${id}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id, mime_type: 'image/jpeg', caption: id } });

    await postWebhook(account, webhook('7770001111', [image('MEDIA-OK'), image('MEDIA-BAD'), image('MEDIA-LATE')]));
    await inbound.idle();
    const stored = Object.fromEntries((await Message.find({ whatsappAccountId: account.id, type: 'image' })).map((m) => [m.text, m]));
    expect(stored['MEDIA-OK'].media.storageKey).toBeTruthy();
    expect(stored['MEDIA-BAD'].media.storageKey).toBeUndefined(); // checksum mismatch: not kept
    expect(stored['MEDIA-LATE'].media.storageKey).toBeUndefined();
    const lookup = calls.find((c) => c.url.includes('MEDIA-OK?'));
    expect(lookup.url).toBe('https://graph.facebook.com/v26.0/MEDIA-OK?phone_number_id=7770001111');
    const fetched = calls.find((c) => c.url.endsWith('mid=MEDIA-OK'));
    expect(fetched.options.headers.Authorization).toBe('Bearer EAAG-token-media-5678');

    const conversationId = String(stored['MEDIA-OK'].conversationId);
    expect((await download(owner.token, conversationId, stored['MEDIA-OK']._id)).body.equals(photo)).toBe(true);
    const bad = await download(owner.token, conversationId, stored['MEDIA-BAD']._id);
    expect(bad.status).toBe(404);
    lateReady = true;
    const late = await download(owner.token, conversationId, stored['MEDIA-LATE']._id);
    expect(late.status).toBe(200);
    expect(late.body.equals(photo)).toBe(true);
    expect((await Message.findById(stored['MEDIA-LATE']._id)).media.storageKey).toBeTruthy();

    const sent = await sendFile(owner.token, conversationId, { name: 'quote.pdf', content: mock.sampleFile('document').buffer, caption: 'Quotation' });
    expect(sent.body.data).toMatchObject({ type: 'document', status: 'sent', media: { fileName: 'quote.pdf', mimeType: 'application/pdf' } });
    const upload = calls.find((c) => c.url.endsWith('/media') && c.method === 'POST');
    expect(upload.url).toBe('https://graph.facebook.com/v26.0/7770001111/media');
    expect(upload.options.body).toBeInstanceOf(FormData);
    expect(upload.options.body.get('messaging_product')).toBe('whatsapp');
    expect(upload.options.body.get('type')).toBe('application/pdf');
    expect(upload.options.body.get('file').name).toBe('quote.pdf');
    const message = JSON.parse(calls.filter((c) => c.url.endsWith('/messages')).at(-1).options.body);
    expect(message).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '919829012345', type: 'document',
      document: { id: 'MEDIA-UPLOADED-1', caption: 'Quotation', filename: 'quote.pdf' },
    });
  });

  it('one Meta app for two numbers: messages go to the number they were sent to', async () => {
    const owner = await login('media-two@example.com');
    jest.spyOn(global, 'fetch').mockImplementation(async () => json({ display_phone_number: '+91 90000 44444', verified_name: 'Two Lines' }));
    const first = (await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ phoneNumberId: '8880001111', accessToken: 'EAAG-token-two-1111', appSecret: APP_SECRET })).body.data;
    const second = (await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ phoneNumberId: '8880002222', accessToken: 'EAAG-token-two-2222', appSecret: APP_SECRET })).body.data;
    const text = (id, body) => ({ from: '919829077777', id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } });

    await postWebhook(first, webhook('8880002222', [text('wamid.TWO1', 'to the second line')], '919829077777'));
    await postWebhook(first, webhook('9990000000', [text('wamid.TWO2', 'unknown line')], '919829077777'));
    await inbound.idle();
    const routed = await Message.findOne({ providerMessageId: 'wamid.TWO1' });
    expect(String(routed.whatsappAccountId)).toBe(second.id);
    expect(await Message.exists({ providerMessageId: 'wamid.TWO2' })).toBeNull();
  });
});
