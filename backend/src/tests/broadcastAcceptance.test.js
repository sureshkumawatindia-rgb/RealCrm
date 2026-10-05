jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const jobs = require('../jobs');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const Contact = require('../models/Contact');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const inbound = require('../services/whatsappInboundService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 7 acceptance (brief, test 4): the admin imports customers, one of them opts out on
// WhatsApp, the admin broadcasts an approved template to "Tier A – Rajasthan" and sees the
// delivery and read stats — through the real code: CSV import, the job worker, the Cloud API
// sender (Meta replaced by a fake fetch, which also reports the number's daily limit), signed
// status and message webhooks; agents and another company see none of it.
const APP_SECRET = 'p7-app-secret-0123456789';
const PHONE_NUMBER_ID = '5550007777';
const WABA_ID = '4440007777';
const TEMPLATE = { id: '9401', name: 'diwali_offer_2026', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Namaste {{1}}! Diwali offer from {{2}}: 10% off on {{3}}. Reply to order.' }, { type: 'FOOTER', text: 'Reply STOP to stop offers' }] };
const CSV = [
  'Party Name,Mobile No,City,State,Group',
  'Ravi Traders,98290 81001,Jaipur,Rajasthan,Tier A',
  'Kiran Stores,98290 81002,Ajmer,Rajasthan,"Tier A, Wholesale"',
  'Meena Spices,98290 81003,Kota,Rajasthan,Tier A',
  'Bhavya Mart,98290 81004,Udaipur,rajasthan,tier a',
  'Surat Mart,98290 81005,Surat,Gujarat,Tier A',
  'Small Shop,98290 81006,Jaipur,Rajasthan,Tier B',
].join('\n');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sign = (raw) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function until(check, what, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('Phase 7 acceptance: a WhatsApp broadcast to "Tier A – Rajasthan" with delivery and read stats', () => {
  const graph = []; // messages the CRM sent to Meta
  beforeAll(() => {
    jest.spyOn(global, 'fetch').mockImplementation(async (target, options = {}) => {
      const url = String(target);
      if (url.includes('/message_templates')) return json({ data: [TEMPLATE] });
      if (url.includes('whatsapp_business_manager_messaging_limit')) return json({ whatsapp_business_manager_messaging_limit: 'TIER_2K', id: PHONE_NUMBER_ID });
      if (url.endsWith(`/${PHONE_NUMBER_ID}/messages`) && options.method === 'POST') {
        const body = JSON.parse(options.body);
        if (body.to === '919829081003') return json({ error: { message: '(#131026) Message undeliverable', code: 131026 } }, 400);
        graph.push(body);
        return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.P7OUT${graph.length}` }] });
      }
      return json({ display_phone_number: '+91 90000 77777', verified_name: 'Yellow Traders', quality_rating: 'GREEN' });
    });
  });
  afterAll(async () => {
    await jobs.stop();
    jest.restoreAllMocks();
  });

  it('works from the import to the stats, for the admin only', async () => {
    // --- 1. Set-up: the admin, an agent, the WhatsApp number and its template ------------------
    const owner = await login('p7-owner@example.com', { name: 'Asha' });
    const agent = await inviteAndJoin(owner.token, 'p7-agent@example.com', { role: 'agent', modules: ['customers', 'marketing', 'inbox'] });
    const stranger = await login('p7-stranger@example.com');
    const as = (user) => bearer(user.token);
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Yellow Traders' });
    const account = (await api().post('/api/v1/whatsapp/accounts').set(as(owner)).send({ name: 'Sales', phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: 'EAAG-p7-token-9900', appSecret: APP_SECRET })).body.data;
    expect(account).toMatchObject({ status: 'connected', messagingLimit: 'TIER_2K' });
    const [template] = (await api().post('/api/v1/templates/sync').set(as(owner)).send({})).body.data;
    jobs.start({ pollMs: 200 });
    const webhook = async (value) => {
      const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_NUMBER_ID }, ...value } }] }] });
      expect((await api().post(account.webhookPath).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw)).status).toBe(200);
      await inbound.idle();
    };
    const customerSays = (waId, name, text) => webhook({ contacts: [{ profile: { name }, wa_id: waId }], messages: [{ from: waId, id: `wamid.P7IN${crypto.randomBytes(6).toString('hex')}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] });
    const status = (wamid, value) => webhook({ statuses: [{ id: wamid, status: value, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '91' }] });

    // --- 2. The customers come from a CSV file, agreed to offers ------------------------------
    const imported = await api().post('/api/v1/contacts/import').set(as(owner))
      .attach('file', Buffer.from(CSV, 'utf8'), 'customers.csv')
      .field('mapping', JSON.stringify(['name', 'phone', 'city', 'state', 'tags'])).field('consent', 'opted_in');
    expect(imported.body.data).toMatchObject({ created: 6, rejected: 0 });

    // --- 3. Bhavya says STOP on WhatsApp: opted out, with a confirmation ---------------------
    await customerSays('919829081004', 'Bhavya Mart', 'STOP');
    const bhavya = await until(async () => {
      const contact = await Contact.findOne({ phoneE164: '+919829081004' });
      return contact?.consent?.marketing === 'opted_out' && contact;
    }, 'the opt-out');
    expect(bhavya.consent.method).toBe('whatsapp_reply');
    await until(() => graph.some((m) => m.to === '919829081004' && m.type === 'text'), 'the opt-out confirmation');

    // --- 4. The segment and the broadcast ---------------------------------------------------
    const segment = (await api().post('/api/v1/segments').set(as(owner)).send({ name: 'Tier A – Rajasthan', filters: { tagsAll: ['Tier A'], states: ['Rajasthan'] } })).body.data;
    const preview = (await api().get(`/api/v1/segments/${segment.id}/preview`).set(as(owner))).body.data;
    expect(preview).toMatchObject({ total: 3, withWhatsApp: 3, optedOut: 1 }); // Ravi, Kiran, Meena — not Bhavya, Surat or Tier B
    const draft = (await api().post('/api/v1/broadcasts').set(as(owner)).send({
      name: 'Diwali offer – Tier A Rajasthan', templateId: template.id, segmentId: segment.id,
      variables: { body: { 1: 'contact.name', 2: 'org.name', 3: 'text:all spices' } },
    })).body.data;
    const estimate = (await api().get(`/api/v1/broadcasts/${draft.id}/estimate`).set(as(owner))).body.data;
    expect(estimate).toMatchObject({ recipients: 3, cost: { perMessagePaise: 86.31, paise: 259 }, dailyLimit: { limit: 2000, tier: 'TIER_2K' }, quota: { plan: 'Growth', left: 500 } });
    expect((await api().post(`/api/v1/broadcasts/${draft.id}/send`).set(as(owner)).set('Idempotency-Key', 'p7-send-0001').send({})).status).toBe(200);

    // --- 5. It goes out: two accepted by WhatsApp, Meena's number refused --------------------
    await until(async () => (await api().get(`/api/v1/broadcasts/${draft.id}`).set(as(owner))).body.data.status === 'completed', 'the broadcast to finish');
    const toMeta = graph.filter((m) => m.type === 'template');
    expect(toMeta.map((m) => m.to).sort()).toEqual(['919829081001', '919829081002']);
    expect(toMeta.find((m) => m.to === '919829081001').template).toMatchObject({
      name: 'diwali_offer_2026', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi Traders' }, { type: 'text', text: 'Yellow Traders' }, { type: 'text', text: 'all spices' }] }],
    });

    // --- 6. WhatsApp reports back; Ravi replies ---------------------------------------------
    const wamidOf = async (phone) => (await BroadcastRecipient.findOne({ broadcastId: draft.id, phoneE164: phone }).populate('messageId')).messageId.providerMessageId;
    const ravi = await wamidOf('+919829081001');
    const kiran = await wamidOf('+919829081002');
    await status(ravi, 'sent');
    await status(ravi, 'delivered');
    await status(kiran, 'delivered');
    await status(ravi, 'read');
    await customerSays('919829081001', 'Ravi Traders', 'Ji, 50 kg jeera bhejiye');
    await until(async () => (await BroadcastRecipient.findOne({ broadcastId: draft.id, phoneE164: '+919829081001' }))?.status === 'replied', 'Ravi\'s reply');

    // --- 7. The admin sees the stats ----------------------------------------------------------
    const result = (await api().get(`/api/v1/broadcasts/${draft.id}`).set(as(owner))).body.data;
    expect(result).toMatchObject({ status: 'completed', stats: { total: 3, sent: 2, delivered: 2, read: 1, replied: 1, failed: 1, skipped: 0 } });
    const failed = (await api().get(`/api/v1/broadcasts/${draft.id}/recipients?status=failed`).set(as(owner))).body.data;
    expect(failed).toMatchObject([{ name: 'Meena Spices', reason: expect.stringMatching(/undeliverable/) }]);
    expect((await api().get('/api/v1/broadcasts/quota').set(as(owner))).body.data).toMatchObject({ used: 1, left: 499 });
    // The reply is in the inbox like any message; the broadcast is in Ravi's chat.
    const raviChat = (await BroadcastRecipient.findOne({ broadcastId: draft.id, phoneE164: '+919829081001' })).conversationId;
    const chat = (await api().get(`/api/v1/conversations/${raviChat}/messages`).set(as(owner))).body.data;
    expect(chat.map((m) => [m.direction, m.automation?.kind || ''])).toEqual([['out', 'broadcast'], ['in', '']]);

    // --- 8. Nobody else -------------------------------------------------------------------------
    expect((await api().get('/api/v1/broadcasts').set(as(agent))).status).toBe(403);
    expect((await api().get('/api/v1/segments').set(as(agent))).status).toBe(403);
    expect((await api().get('/api/v1/broadcasts').set(as(stranger))).body.data).toEqual([]);
    expect((await api().get(`/api/v1/broadcasts/${draft.id}`).set(as(stranger))).status).toBe(404);
    expect((await api().get(`/api/v1/broadcasts/${draft.id}/recipients`).set(as(stranger))).status).toBe(404);
    expect((await WhatsAppAccount.findById(account.id)).messagingLimit).toBe('TIER_2K');
  }, 120000);
});
