jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const Message = require('../models/Message');
const Touchpoint = require('../models/Touchpoint');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const WidgetClick = require('../models/WidgetClick');
const queue = require('../jobs/queue');
const inbound = require('../services/whatsappInboundService');
const leadRouting = require('../services/leadRoutingService');
const engine = require('../services/automation/engine');
const metaConversions = require('../services/metaConversionsService');
const { refCodeIn } = require('../views/whatsappButton');
const { api, bearer, login } = require('./helpers/api');

// D102: where leads come from — Click-to-WhatsApp ads (the webhook's referral: lead source
// "WhatsApp Ad", the ad on the touch, the Inbox, reports by ad, Meta's Conversions API with the
// click id) and the website's WhatsApp button (its script, the click beacon, the ref code).
const settle = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};
const DATASET = '1234567890123';
const WA_DATASET = '9876543210987';
const TOKEN = 'EAAG-capi-token-0123456789abcdef';
const WABA = '102030405060708';

describe('Leads from Click-to-WhatsApp ads and the website button', () => {
  let owner;
  let account;
  let metaSent = [];
  const auth = () => bearer(owner.token);
  const post = (path, body = {}) => api().post(`/api/v1${path}`).set(auth()).send(body);
  const get = (path) => api().get(`/api/v1${path}`).set(auth());
  const simulate = (body) => post('/dev/simulate/whatsapp-inbound', body);

  beforeAll(async () => {
    engine.register(queue);
    leadRouting.attach(queue);
    metaConversions.register(queue);
    const realFetch = global.fetch;
    jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (target.endsWith(`/${DATASET}?fields=id,name`)) return reply({ id: DATASET, name: 'Yellow Traders pixel' });
      if (target.endsWith(`/${WABA}/dataset`)) return reply({ data: [{ id: WA_DATASET }] });
      if (target.endsWith('/events')) {
        metaSent.push({ url: target, body: JSON.parse(options.body) });
        return reply({ events_received: 1, fbtrace_id: 'trace1' });
      }
      return realFetch(url, options);
    });
    owner = await login('ads-owner@example.com', { name: 'Asha' });
    await api().patch('/api/v1/organization').set(auth()).send({ name: 'Yellow Traders' });
    await post('/whatsapp/accounts', { provider: 'mock' });
    account = await WhatsAppAccount.findOne({ organizationId: owner.data.organizationId });
    await WhatsAppAccount.updateOne({ _id: account._id }, { $set: { wabaId: WABA } });
  });
  afterAll(() => jest.restoreAllMocks());

  it('reads Meta\'s referral: a first message from an ad is a "WhatsApp Ad" lead with the ad on its touch', async () => {
    // Meta's own field names (messages webhook reference, Click to WhatsApp ad example).
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: WABA,
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: account.displayPhone, phone_number_id: account.phoneNumberId },
            contacts: [{ profile: { name: 'Meena Stores' }, wa_id: '919829011111' }],
            messages: [{
              from: '919829011111', id: 'wamid.AD1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Can I get more info about this?' },
              referral: {
                source_url: 'https://fb.me/3cr4Wqqkv', source_id: '120226305854810726', source_type: 'ad', body: 'Fresh jeera, straight from Unjha', headline: 'Jeera at mandi price',
                media_type: 'video', video_url: 'https://video.example/ad.mp4', thumbnail_url: 'https://scontent.example/thumb.jpg',
                ctwa_clid: 'Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4', welcome_message: { text: 'Hi! Let us know how we can help!' },
              },
            }],
          },
        }],
      }],
    };
    await inbound.processNow(await inbound.ingest(account, payload));
    const contact = await Contact.findOne({ phoneE164: '+919829011111' });
    expect(contact.source).toBe('WhatsApp Ad');
    const lead = await Lead.findOne({ contactId: contact._id });
    expect(lead).toMatchObject({ source: 'WhatsApp Ad', stage: 'New' });
    expect(lead.attribution.first).toMatchObject({ channel: 'paid_social', source: 'WhatsApp Ad', adId: '120226305854810726', ad: 'Jeera at mandi price' });
    expect(await LeadActivity.exists({ leadId: lead._id, text: 'First message on WhatsApp, from the ad "Jeera at mandi price"' })).toBeTruthy();
    const touch = await Touchpoint.findOne({ contactId: contact._id }).lean();
    expect(touch).toMatchObject({
      source: 'WhatsApp Ad', channel: 'paid_social', leadId: lead._id,
      ad: { id: '120226305854810726', name: 'Jeera at mandi price', body: 'Fresh jeera, straight from Unjha', sourceType: 'ad', mediaType: 'video', mediaUrl: 'https://scontent.example/thumb.jpg', url: 'https://fb.me/3cr4Wqqkv' },
      clickIds: { ctwaClid: 'Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4' },
    });
    // The message keeps the ad to show, not the click id; the chat says where it came from.
    const message = await Message.findOne({ providerMessageId: 'wamid.AD1' }).lean();
    expect(message.referral).toMatchObject({ headline: 'Jeera at mandi price', sourceUrl: 'https://fb.me/3cr4Wqqkv', welcomeText: 'Hi! Let us know how we can help!' });
    expect(JSON.stringify(message)).not.toContain('Aff-n8ZTOD');
    const chat = (await get(`/conversations/${message.conversationId}`)).body.data;
    expect(chat.cameFrom).toMatchObject({ kind: 'ad', headline: 'Jeera at mandi price', sourceUrl: 'https://fb.me/3cr4Wqqkv', mediaUrl: 'https://scontent.example/thumb.jpg' });
    const messages = (await get(`/conversations/${message.conversationId}/messages`)).body.data;
    expect(messages.find((m) => m.id === String(message._id)).referral).toMatchObject({ headline: 'Jeera at mandi price', mediaType: 'video' });
  });

  it('works for an ad in WhatsApp Status (no click id), and puts a known customer\'s ad on their open lead\'s last touch', async () => {
    await simulate({ from: '9829022222', name: 'Status Buyer', text: 'Price?', ad: { headline: 'Diwali dry fruits', sourceId: '120200000000000222', ctwaClid: '' } });
    const contact = await Contact.findOne({ phoneE164: '+919829022222' });
    const touch = await Touchpoint.findOne({ contactId: contact._id }).lean();
    expect(touch.ad.name).toBe('Diwali dry fruits');
    expect(touch.clickIds.ctwaClid || '').toBe('');

    // Known customer, open lead: the ad is the lead's last touch; the first stays.
    await simulate({ from: '9829033333', name: 'Ravi Traders', text: 'Hello' });
    const ravi = await Contact.findOne({ phoneE164: '+919829033333' });
    const lead = await Lead.findOne({ contactId: ravi._id });
    expect(lead.source).toBe('WhatsApp');
    await simulate({ from: '9829033333', name: 'Ravi Traders', text: 'Saw your ad', ad: { headline: 'Cumin 25 kg offer', sourceId: '120200000000000333' } });
    expect(await Lead.countDocuments({ contactId: ravi._id })).toBe(1);
    const again = await Lead.findById(lead._id);
    expect(again.attribution.last).toMatchObject({ source: 'WhatsApp Ad', ad: 'Cumin 25 kg offer' });
    expect(await Touchpoint.countDocuments({ contactId: ravi._id, leadId: lead._id, 'ad.name': 'Cumin 25 kg offer' })).toBe(1);
    expect((await Conversation.findOne({ contactId: ravi._id })).cameFrom).toMatchObject({ kind: 'ad', headline: 'Cumin 25 kg offer' });
  });

  it('keeps a private number out of it (D61)', async () => {
    expect((await post('/privacy/numbers', { phone: '9829044444', note: 'Family' })).status).toBe(201);
    await simulate({ from: '9829044444', name: 'Family', text: 'Hi', ad: { headline: 'Any ad', sourceId: '120200000000000444' } });
    const contact = await Contact.findOne({ phoneE164: '+919829044444' });
    expect(await Touchpoint.countDocuments({ contactId: contact._id })).toBe(0);
    expect(await Lead.countDocuments({ contactId: contact._id })).toBe(0);
    expect((await Conversation.findOne({ contactId: contact._id })).cameFrom?.kind).toBeUndefined();
  });

  it('reports leads and wins by ad, and by source', async () => {
    const res = await get('/reports/attribution?by=ad');
    expect(res.status).toBe(200);
    const keys = res.body.data.items.map((r) => [r.key, r.channel]);
    expect(keys).toEqual(expect.arrayContaining([['Jeera at mandi price', 'paid_social'], ['Diwali dry fruits', 'paid_social'], ['', 'whatsapp']]));
    const sources = (await get('/reports/sources')).body.data;
    expect(JSON.stringify(sources)).toContain('WhatsApp Ad');
  });

  it('sends a Click-to-WhatsApp lead to Meta with its click id when switched on', async () => {
    await settle(); // the earlier leads' rules run before the Conversions API is connected
    await api().put('/api/v1/meta-conversions').set(auth()).send({ datasetId: DATASET, accessToken: TOKEN });
    // The WhatsApp Business Account's dataset, from Meta.
    const found = await post('/meta-conversions/ctwa-dataset');
    expect(found.body.data).toEqual({ datasetId: WA_DATASET, wabaId: WABA });
    const saved = await api().put('/api/v1/meta-conversions').set(auth()).send({ ctwaEnabled: true, ctwaDatasetId: WA_DATASET });
    expect(saved.body.data.ctwa).toEqual({ enabled: true, datasetId: WA_DATASET });

    metaSent = [];
    await simulate({ from: '9829055555', name: 'Kirti Foods', text: 'Rate?', ad: { headline: 'Saunf 50 kg', sourceId: '120200000000000555', ctwaClid: 'CLICK-555' } });
    await settle();
    const adEvents = metaSent.filter((s) => s.url.endsWith(`/${WA_DATASET}/events`));
    expect(adEvents).toHaveLength(1);
    const [event] = adEvents[0].body.data;
    expect(event).toMatchObject({
      event_name: 'LeadSubmitted', action_source: 'business_messaging', messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: WABA, ctwa_clid: 'CLICK-555' },
    });
    expect(event.event_id).toMatch(/:LeadSubmitted$/);

    // Won: Purchase with the value; Contacted sends nothing for the ad.
    metaSent = [];
    const lead = await Lead.findOne({ contactId: (await Contact.findOne({ phoneE164: '+919829055555' }))._id });
    await api().patch(`/api/v1/leads/${lead._id}`).set(auth()).send({ expectedValuePaise: 1250000 });
    await post(`/leads/${lead._id}/stage`, { stage: 'Contacted' });
    await settle();
    expect(metaSent.filter((s) => s.url.endsWith(`/${WA_DATASET}/events`))).toHaveLength(0);
    await post(`/leads/${lead._id}/stage`, { stage: 'Won' });
    await settle();
    const won = metaSent.filter((s) => s.url.endsWith(`/${WA_DATASET}/events`)).map((s) => s.body.data[0]);
    expect(won).toEqual([expect.objectContaining({ event_name: 'Purchase', custom_data: { currency: 'INR', value: 12500 } })]);
  });

  describe('The website\'s WhatsApp button', () => {
    let button;
    const script = (key, query = '') => api().get(`/api/v1/public/widget/${key}/widget.js${query}`);
    const click = (key, body, origin) => {
      const req = api().post(`/api/v1/public/widget/${key}/click`).type('form');
      return (origin ? req.set('Origin', origin) : req).send(body);
    };

    it('is a lead source with its own look; the number must be one of the company\'s', async () => {
      const made = await post('/lead-sources', { type: 'whatsapp_button' });
      expect(made.status).toBe(201);
      button = made.body.data;
      expect(button).toMatchObject({
        type: 'whatsapp_button', source: 'Website widget', name: 'Website WhatsApp button',
        settings: { color: '#25D366', position: 'right', language: 'en', replyTime: 'minutes', showHours: true },
      });
      expect(button.widget.scriptUrl).toBe(`http://127.0.0.1:3000/api/v1/public/widget/${button.widget.publicKey}/widget.js`);
      expect((await api().patch(`/api/v1/lead-sources/${button.id}`).set(auth()).send({ settings: { color: 'green' } })).status).toBe(400);
      expect((await api().patch(`/api/v1/lead-sources/${button.id}`).set(auth()).send({ settings: { accountId: '0123456789abcdef01234567' } })).body.code).toBe('VALIDATION_ERROR');
      const set = await api().patch(`/api/v1/lead-sources/${button.id}`).set(auth()).send({ settings: { color: '#0B7A6E', position: 'left', greeting: 'Namaste! Kaise madad karein?', message: 'Mujhe price chahiye', agentName: 'Asha', language: 'hi' } });
      expect(set.body.data.settings).toMatchObject({ color: '#0B7A6E', position: 'left', agentName: 'Asha', language: 'hi' });
    });

    it('serves a small script with the number and look, in a shadow root, with no cookie', async () => {
      const res = await script(button.widget.publicKey);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/javascript/);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      const text = res.text;
      expect(text).toContain('"phone":"919000000000"');
      expect(text).toContain('"color":"#0B7A6E"');
      expect(text).toContain('attachShadow');
      expect(text).not.toMatch(/document\.cookie|localStorage|innerHTML/);
      expect(() => new Function(text)).not.toThrow(); // eslint-disable-line no-new-func
      expect(text.length).toBeLessThan(20000);
      expect((await script('0123456789abcdef01234567')).status).toBe(404);
      // Switched off: nothing on the websites, but the Settings preview still draws it.
      await api().patch(`/api/v1/lead-sources/${button.id}`).set(auth()).send({ status: 'paused' });
      expect((await script(button.widget.publicKey)).text).toMatch(/switched off/);
      expect((await script(button.widget.publicKey, '?preview=1')).text).toContain('attachShadow');
      await api().patch(`/api/v1/lead-sources/${button.id}`).set(auth()).send({ status: 'active' });
    });

    it('turns the ref code of a click into a "Website widget" lead with the page it came from', async () => {
      expect(refCodeIn('Mujhe price chahiye\n\nRef: 7k2q9x')).toBe('7K2Q9X');
      expect(refCodeIn('my order ref: 12')).toBe('');
      const page = 'https://www.yellowtraders.in/jeera?utm_source=facebook&utm_medium=cpc&utm_campaign=diwali';
      expect((await click(button.widget.publicKey, { code: '7K2Q9X', page, referrer: 'https://www.facebook.com/' })).status).toBe(204);
      expect((await click(button.widget.publicKey, { code: 'not-a-code', page })).status).toBe(204);
      expect(await WidgetClick.countDocuments()).toBe(1);
      expect((await LeadSourceConnection.findById(button.id)).stats.received).toBe(1);

      await simulate({ from: '9829066666', name: 'Website Buyer', text: 'Mujhe price chahiye\n\nRef: 7K2Q9X' });
      const contact = await Contact.findOne({ phoneE164: '+919829066666' });
      const lead = await Lead.findOne({ contactId: contact._id });
      expect(lead.source).toBe('Website widget');
      expect(lead.attribution.first).toMatchObject({ source: 'Website widget', channel: 'paid_social', campaign: 'diwali' });
      expect(await Touchpoint.findOne({ contactId: contact._id }).lean()).toMatchObject({ landingPage: page, referrer: 'https://www.facebook.com/', utm: { source: 'facebook', medium: 'cpc', campaign: 'diwali' } });
      expect((await Conversation.findOne({ contactId: contact._id })).cameFrom).toMatchObject({ kind: 'widget', page });
      expect((await WidgetClick.findOne({ code: '7K2Q9X' })).usedAt).toBeTruthy();
      expect((await LeadSourceConnection.findById(button.id)).stats.created).toBe(1);

      // A "Ref: …" nobody clicked is just text: a plain WhatsApp lead.
      await simulate({ from: '9829077777', name: 'Someone', text: 'Ref: ZZZZZZ' });
      expect((await Lead.findOne({ contactId: (await Contact.findOne({ phoneE164: '+919829077777' }))._id })).source).toBe('WhatsApp');
    });

    it('keeps no click from a website not on the list', async () => {
      await api().patch(`/api/v1/lead-sources/${button.id}`).set(auth()).send({ settings: { allowedOrigins: ['https://www.yellowtraders.in'] } });
      await click(button.widget.publicKey, { code: '3M4N5P', page: 'https://copycat.example/' }, 'https://copycat.example');
      await click(button.widget.publicKey, { code: '6Q7R8S', page: 'https://www.yellowtraders.in/' }, 'https://www.yellowtraders.in');
      expect((await WidgetClick.find().sort({ at: 1 })).map((c) => c.code)).toEqual(['7K2Q9X', '6Q7R8S']);
    });
  });
});
