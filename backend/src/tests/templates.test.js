jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const Conversation = require('../models/Conversation');
const MessageTemplate = require('../models/MessageTemplate');
const inbound = require('../services/whatsappInboundService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const APP_SECRET = 'tpl-app-secret-0123456789';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sign = (raw) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const postWebhook = (account, payload) => {
  const raw = JSON.stringify(payload);
  return api().post(account.webhookPath).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw);
};
const templateEvent = (id, event, reason = 'NONE', time = Date.now()) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '5550009999', time, changes: [{ field: 'message_template_status_update', value: { event, message_template_id: id, message_template_name: 'x', message_template_language: 'en', reason } }] }],
});
const simulate = async (token, from, text, name = '') => {
  const res = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(token)).send({ from, text, name });
  if (res.status !== 201) throw new Error(`simulate: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const sendTo = (token, conversationId, body, key) => {
  const req = api().post(`/api/v1/conversations/${conversationId}/messages`).set(bearer(token));
  return (key ? req.set('Idempotency-Key', key) : req).send(body);
};

describe('Templates on a test number', () => {
  let owner;
  let agent;
  let chat;
  beforeAll(async () => {
    owner = await login('tpl-owner@example.com');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    agent = await inviteAndJoin(owner.token, 'tpl-agent@example.com', { role: 'agent', modules: ['inbox'] });
    chat = await simulate(owner.token, '98290 12345', 'Hello', 'Ravi');
  });

  it('a sync brings the number\'s templates; inbox members read them, only owners/admins change them', async () => {
    expect((await api().post('/api/v1/templates/sync').set(bearer(agent.token)).send({})).status).toBe(403);
    const synced = await api().post('/api/v1/templates/sync').set(bearer(owner.token)).send({});
    expect(synced.status).toBe(200);
    const byName = Object.fromEntries(synced.body.data.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['diwali_offer', 'hello_world', 'order_update', 'quotation_pdf', 'quote_follow_up']);
    // A PDF header is filled by a quotation, not from the inbox picker.
    expect(byName.quotation_pdf).toMatchObject({ documentHeader: true, sendable: false, header: { format: 'DOCUMENT' } });
    expect(byName.order_update).toMatchObject({ status: 'APPROVED', sendable: true, parameterFormat: 'POSITIONAL', body: { variables: ['1', '2'] } });
    expect(byName.quote_follow_up).toMatchObject({ parameterFormat: 'NAMED', header: { format: 'TEXT', variables: ['product'] }, body: { variables: ['customer_name'] } });
    expect(byName.diwali_offer).toMatchObject({ status: 'REJECTED', rejectedReason: 'INVALID_FORMAT', sendable: false });

    const approved = await api().get('/api/v1/templates?status=approved').set(bearer(agent.token));
    expect(approved.status).toBe(200);
    expect(approved.body.data.map((t) => t.name).sort()).toEqual(['hello_world', 'order_update', 'quotation_pdf', 'quote_follow_up']);
    expect((await api().post('/api/v1/templates').set(bearer(agent.token)).send({ name: 'x', language: 'en', category: 'UTILITY', bodyText: 'Hi there' })).status).toBe(403);
  });

  it('checks a new template before submitting it, and removes it again', async () => {
    const create = (body) => api().post('/api/v1/templates').set(bearer(owner.token)).send({ name: 'price_update', language: 'en', category: 'UTILITY', ...body });

    const mixed = await create({ bodyText: 'Hi {{1}}, the price of {{product}} changed today.', bodyExamples: { 1: 'Ravi', product: 'Cumin' } });
    expect(mixed.status).toBe(400);
    expect(mixed.body.errors[0].field).toBe('bodyText');
    expect((await create({ bodyText: '{{1}} is the new price today', bodyExamples: { 1: '₹250' } })).status).toBe(400);
    expect((await create({ bodyText: 'Hi {{1}}, see {{3}} today', bodyExamples: { 1: 'a', 3: 'b' } })).status).toBe(400);
    const noExample = await create({ bodyText: 'Hi {{1}}, prices changed today.' });
    expect(noExample.status).toBe(400);
    expect(noExample.body.errors[0].code).toBe('EXAMPLE_REQUIRED');
    expect((await create({ name: 'Price Update', bodyText: 'Prices changed today.' })).status).toBe(400);
    expect((await create({ bodyText: 'Prices changed.', footerText: 'For {{1}}' })).status).toBe(400);

    const ok = await create({
      headerText: 'Price update',
      bodyText: 'Namaste {{1}}, the price of {{2}} is now {{3}} per kg.',
      bodyExamples: { 1: 'Ravi', 2: 'Cumin', 3: '₹250' },
      footerText: 'Yellow Traders',
      buttons: [{ type: 'URL', text: 'Price list', url: 'https://example.com/prices' }, { type: 'QUICK_REPLY', text: 'Order now' }],
    });
    expect(ok.status).toBe(201);
    // A test number approves at once; quick replies are grouped first as WhatsApp requires.
    expect(ok.body.data).toMatchObject({ name: 'price_update', status: 'APPROVED', sendable: true, body: { variables: ['1', '2', '3'] }, footer: 'Yellow Traders' });
    expect(ok.body.data.buttons.map((b) => b.type)).toEqual(['QUICK_REPLY', 'URL']);
    expect((await create({ bodyText: 'Namaste {{1}}, again.', bodyExamples: { 1: 'x' } })).status).toBe(409);

    const synced = await api().post('/api/v1/templates/sync').set(bearer(owner.token)).send({});
    expect(synced.body.data.map((t) => t.name)).toContain('price_update');
    expect((await api().delete(`/api/v1/templates/${ok.body.data.id}`).set(bearer(agent.token))).status).toBe(403);
    expect((await api().delete(`/api/v1/templates/${ok.body.data.id}`).set(bearer(owner.token))).status).toBe(200);
    const again = await api().post('/api/v1/templates/sync').set(bearer(owner.token)).send({});
    expect(again.body.data.map((t) => t.name)).not.toContain('price_update');
  });

  it('sends an approved template even when the 24-hour window is closed; variables are checked', async () => {
    await Conversation.updateOne({ _id: chat.conversationId }, { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    expect((await sendTo(agent.token, chat.conversationId, { text: 'hi' })).status).toBe(422);

    const templates = (await api().get('/api/v1/templates').set(bearer(agent.token))).body.data;
    const order = templates.find((t) => t.name === 'order_update');
    const missing = await sendTo(agent.token, chat.conversationId, { type: 'template', templateId: order.id, variables: { body: { 1: 'Ravi' } } });
    expect(missing.status).toBe(400);
    expect(missing.body.errors[0].code).toBe('VARIABLE_REQUIRED');
    expect((await sendTo(agent.token, chat.conversationId, { type: 'template', templateId: order.id, variables: { body: { 1: 'Ravi', 2: '#45\nextra' } } })).status).toBe(400);
    expect((await sendTo(agent.token, chat.conversationId, { type: 'template', templateId: order.id, text: 'both' })).status).toBe(400);

    const sent = await sendTo(agent.token, chat.conversationId, { type: 'template', templateId: order.id, variables: { body: { 1: 'Ravi', 2: '#45' } } }, 'tpl-send-0001');
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({
      type: 'template', status: 'sent',
      text: 'Namaste Ravi, your order #45 has been dispatched. We will share the tracking details soon.\n\nReply STOP to stop updates',
      template: { name: 'order_update', language: 'en', variables: ['Ravi', '#45'] },
    });
    const conversation = (await api().get(`/api/v1/conversations/${chat.conversationId}`).set(bearer(owner.token))).body.data;
    expect(conversation.lastMessagePreview).toMatch(/^Namaste Ravi, your order #45/);
    expect(conversation.assigneeId).toBeTruthy(); // the first reply took the chat
    expect(conversation.window.open).toBe(false); // a template does not reopen the window

    const rejected = await MessageTemplate.findOne({ name: 'diwali_offer' });
    const refused = await sendTo(owner.token, chat.conversationId, { type: 'template', templateId: String(rejected._id) });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('TEMPLATE_NOT_SENDABLE');
  });
});

describe('Templates through the Cloud API', () => {
  afterEach(() => jest.restoreAllMocks());

  it('needs the business account id, reads every page, submits, sends and deletes with Meta; status webhooks update it', async () => {
    const owner = await login('tpl-meta@example.com');
    const calls = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const u = String(url);
      const method = options.method || 'GET';
      calls.push({ url: u, method, body: options.body });
      if (u.includes('/message_templates') && method === 'GET') {
        if (!u.includes('after=')) {
          return json({
            data: [{ id: '111', name: 'order_update', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, order {{2}} shipped.' }] }],
            paging: { cursors: { after: 'CURSOR2' }, next: 'https://graph.facebook.com/next-page' },
          });
        }
        return json({
          data: [{ id: '222', name: 'welcome', language: 'hi', status: 'PENDING', category: 'MARKETING', parameter_format: 'NAMED', components: [{ type: 'BODY', text: 'Namaste {{name}}, swagat hai!' }], quality_score: { score: 'UNKNOWN' } }],
          paging: { cursors: { after: 'CURSOR3' } },
        });
      }
      if (u.includes('/message_templates') && method === 'POST') return json({ id: '333', status: 'PENDING', category: 'UTILITY' });
      if (u.includes('/message_templates') && method === 'DELETE') return json({ success: true });
      if (u.endsWith('/messages') && method === 'POST') return json({ messages: [{ id: `wamid.TPL${calls.length}` }] });
      return json({ display_phone_number: '+91 90000 22222', verified_name: 'Meta Shop' });
    });
    const account = (await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ phoneNumberId: '6660001111', accessToken: 'EAAG-token-tpl-1234', appSecret: APP_SECRET })).body.data;

    const noWaba = await api().post('/api/v1/templates/sync').set(bearer(owner.token)).send({});
    expect(noWaba.status).toBe(400);
    expect(noWaba.body.code).toBe('WABA_ID_MISSING');
    await api().patch(`/api/v1/whatsapp/accounts/${account.id}`).set(bearer(owner.token)).send({ wabaId: '5550009999' });

    const synced = await api().post('/api/v1/templates/sync').set(bearer(owner.token)).send({});
    expect(synced.body.data.map((t) => [t.name, t.status, t.parameterFormat])).toEqual([['order_update', 'APPROVED', 'POSITIONAL'], ['welcome', 'PENDING', 'NAMED']]);
    const pages = calls.filter((c) => c.url.includes('/message_templates') && c.method === 'GET');
    expect(pages.map((c) => c.url)).toEqual([
      'https://graph.facebook.com/v26.0/5550009999/message_templates?fields=id,name,language,status,category,components,parameter_format,rejected_reason,quality_score&limit=100',
      'https://graph.facebook.com/v26.0/5550009999/message_templates?fields=id,name,language,status,category,components,parameter_format,rejected_reason,quality_score&limit=100&after=CURSOR2',
    ]);

    const created = await api().post('/api/v1/templates').set(bearer(owner.token)).send({
      name: 'dispatch_note', language: 'en_US', category: 'utility', headerText: 'Order {{1}}', headerExample: '#45', bodyText: 'Hello {{1}}, your goods left today.', bodyExamples: { 1: 'Ravi' },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'PENDING', sendable: false });
    const submit = calls.find((c) => c.method === 'POST' && c.url.includes('/message_templates'));
    expect(submit.url).toBe('https://graph.facebook.com/v26.0/5550009999/message_templates');
    expect(JSON.parse(submit.body)).toEqual({
      name: 'dispatch_note', language: 'en_US', category: 'UTILITY', parameter_format: 'POSITIONAL',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}', example: { header_text: ['#45'] } },
        { type: 'BODY', text: 'Hello {{1}}, your goods left today.', example: { body_text: [['Ravi']] } },
      ],
    });

    // Meta approves both through the status webhook.
    expect((await postWebhook(account, templateEvent(333, 'APPROVED'))).status).toBe(200);
    expect((await postWebhook(account, templateEvent(222, 'APPROVED'))).status).toBe(200);
    await inbound.idle();
    expect((await MessageTemplate.findById(created.body.data.id)).status).toBe('APPROVED');

    const chat = await simulate(owner.token, '98290 55555', 'Namaste');
    const dispatch = await sendTo(owner.token, chat.conversationId, { type: 'template', templateId: created.body.data.id, variables: { header: { 1: '#46' }, body: { 1: 'Ravi' } } });
    expect(dispatch.body.data).toMatchObject({ status: 'sent', text: 'Order #46\n\nHello Ravi, your goods left today.' });
    const welcome = synced.body.data.find((t) => t.name === 'welcome');
    await sendTo(owner.token, chat.conversationId, { type: 'template', templateId: welcome.id, variables: { body: { name: 'Sunita' } } });
    const sends = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages')).map((c) => JSON.parse(c.body));
    expect(sends).toEqual([
      {
        messaging_product: 'whatsapp', recipient_type: 'individual', to: '919829055555', type: 'template',
        template: { name: 'dispatch_note', language: { code: 'en_US' }, components: [{ type: 'header', parameters: [{ type: 'text', text: '#46' }] }, { type: 'body', parameters: [{ type: 'text', text: 'Ravi' }] }] },
      },
      {
        messaging_product: 'whatsapp', recipient_type: 'individual', to: '919829055555', type: 'template',
        template: { name: 'welcome', language: { code: 'hi' }, components: [{ type: 'body', parameters: [{ type: 'text', parameter_name: 'name', text: 'Sunita' }] }] },
      },
    ]);

    // A rejection keeps Meta's reason; a repeated webhook is ignored.
    await postWebhook(account, templateEvent(333, 'REJECTED', 'INVALID_FORMAT', 1790000100));
    await postWebhook(account, templateEvent(333, 'REJECTED', 'INVALID_FORMAT', 1790000100));
    await inbound.idle();
    expect(await MessageTemplate.findById(created.body.data.id)).toMatchObject({ status: 'REJECTED', rejectedReason: 'INVALID_FORMAT' });

    expect((await api().delete(`/api/v1/templates/${welcome.id}`).set(bearer(owner.token))).status).toBe(200);
    const removal = calls.find((c) => c.method === 'DELETE');
    expect(removal.url).toBe('https://graph.facebook.com/v26.0/5550009999/message_templates?name=welcome&hsm_id=222');
  });
});
