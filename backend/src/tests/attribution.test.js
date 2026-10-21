jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Lead = require('../models/Lead');
const Touchpoint = require('../models/Touchpoint');
const { channelOf, cleanTouch } = require('../services/attributionService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 2 (D79): where leads come from — touchpoints, first and last touch, and the report.
const as = (user) => ({
  get: (url) => api().get(`/api/v1${url}`).set(bearer(user.token)),
  post: (url, body) => api().post(`/api/v1${url}`).set(bearer(user.token)).send(body),
  patch: (url, body) => api().patch(`/api/v1${url}`).set(bearer(user.token)).send(body),
});
const pathOf = (url) => new URL(url).pathname;

describe('Where leads come from (D79)', () => {
  it('works out the channel from the source, click ids, tags and referrer', () => {
    const cases = [
      [{ source: 'Facebook' }, 'paid_social'],
      [{ source: 'Google Ads' }, 'paid_search'],
      [{ source: 'IndiaMART' }, 'marketplace'],
      [{ source: 'WhatsApp' }, 'whatsapp'],
      [{ source: 'Website', clickIds: { gclid: 'x' } }, 'paid_search'],
      [{ source: 'Website', utm: { source: 'google', medium: 'cpc' } }, 'paid_search'],
      [{ source: 'Website', utm: { source: 'instagram', medium: 'paid' } }, 'paid_social'],
      [{ source: 'Website', utm: { source: 'newsletter', medium: 'email' } }, 'email'],
      [{ source: 'Website', utm: { source: 'facebook' } }, 'social'],
      [{ source: 'Website', utm: { source: 'partner-site' } }, 'referral'],
      [{ source: 'Website', referrer: 'https://www.google.co.in/search?q=pumps' }, 'organic_search'],
      [{ source: 'Website', referrer: 'https://l.facebook.com/x' }, 'social'],
      [{ source: 'Website', referrer: 'https://blog.example.org/post' }, 'referral'],
      [{ source: 'Website' }, 'direct'],
      [{ source: 'Manual' }, 'other'],
    ];
    for (const [input, channel] of cases) expect([input, channelOf(input)]).toEqual([input, channel]);
    // Tags missing from the input are read from the landing page; fragments are dropped.
    expect(cleanTouch({ landingPage: 'https://shop.in/pumps?utm_source=google&utm_campaign=diwali&gclid=G1#top' })).toMatchObject({
      utm: { source: 'google', campaign: 'diwali' }, clickIds: { gclid: 'G1' }, landingPage: 'https://shop.in/pumps?utm_source=google&utm_campaign=diwali&gclid=G1',
    });
    expect(cleanTouch({ referrer: 'javascript:alert(1)', utm: { source: 'x'.repeat(300) } })).toMatchObject({ referrer: '', utm: { source: 'x'.repeat(200) } });
  });

  describe('Through the website form', () => {
    let owner;
    let viewer;
    let other;
    let form;
    const post = (body) => api().post(`/api/v1/public/forms/${form.form.publicKey}`).set('Origin', 'https://shop.example.in').send(body);
    const tagged = (phone, extra = {}) => post({
      name: 'Kota Stone', phone, utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'diwali_sale', gclid: 'G-1',
      referrer: 'https://www.google.com/', landingPage: 'https://shop.example.in/pumps?utm_source=google#form', ...extra,
    });

    beforeAll(async () => {
      owner = await login('at-owner@example.com', { name: 'Asha' });
      viewer = await inviteAndJoin(owner.token, 'at-viewer@example.com', { role: 'viewer' });
      other = await login('at-other@example.com');
      form = (await as(owner).post('/lead-sources', { type: 'website', name: 'Main website' })).body.data;
    });

    it('a tagged enquiry keeps its campaign on the lead, the customer and the touchpoint', async () => {
      expect((await tagged('98290 81001')).status).toBe(201); // the form answers 201 Created
      const lead = (await as(owner).get('/leads?limit=5')).body.data[0];
      const first = { channel: 'paid_search', source: 'Website', medium: 'cpc', campaign: 'diwali_sale' };
      expect(lead.attribution).toMatchObject({ first, last: first });
      const contact = (await as(owner).get(`/contacts/${lead.contactId}`)).body.data;
      expect(contact.firstTouch).toMatchObject(first);
      const touch = (await as(owner).get(`/contacts/${lead.contactId}/touchpoints`)).body.data;
      expect(touch.firstTouch).toMatchObject(first);
      expect(touch.items).toEqual([expect.objectContaining({
        source: 'Website', channel: 'paid_search', utm: expect.objectContaining({ source: 'google', medium: 'cpc', campaign: 'diwali_sale' }),
        clickIds: expect.objectContaining({ gclid: 'G-1' }), referrer: 'https://www.google.com/', landingPage: 'https://shop.example.in/pumps?utm_source=google',
      })]);
    });

    it('a repeat enquiry from another campaign keeps the first touch and updates the last', async () => {
      const res = await tagged('98290 81001', { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'navratri', gclid: '' });
      expect(res.status).toBe(201);
      const lead = (await as(owner).get('/leads?limit=5')).body.data[0];
      expect(lead.attribution.first).toMatchObject({ channel: 'paid_search', campaign: 'diwali_sale' });
      expect(lead.attribution.last).toMatchObject({ channel: 'paid_social', campaign: 'navratri' });
      const touch = (await as(owner).get(`/contacts/${lead.contactId}/touchpoints`)).body.data;
      expect(touch.items.map((t) => t.utm.campaign)).toEqual(['navratri', 'diwali_sale']);
      expect(touch.firstTouch).toMatchObject({ campaign: 'diwali_sale' });
      expect(await Lead.countDocuments({ contactId: lead.contactId })).toBe(1);
    });

    it('without tags the referrer decides; with nothing it is Direct; a double click makes one touch', async () => {
      await post({ name: 'Search Visitor', phone: '98290 81002', referrer: 'https://www.bing.com/search?q=pump' });
      await post({ name: 'Direct Visitor', phone: '98290 81003', submissionId: 'abcdef12-0001' });
      await post({ name: 'Direct Visitor', phone: '98290 81003', submissionId: 'abcdef12-0001' });
      const leads = (await as(owner).get('/leads?limit=10')).body.data;
      const byName = Object.fromEntries(leads.map((l) => [l.contact.name, l.attribution?.first?.channel]));
      expect(byName).toMatchObject({ 'Search Visitor': 'organic_search', 'Direct Visitor': 'direct' });
      const direct = leads.find((l) => l.contact.name === 'Direct Visitor');
      expect(await Touchpoint.countDocuments({ contactId: direct.contactId })).toBe(1);
    });

    it('the bot trap and the allowed sites still work', async () => {
      const before = await Touchpoint.countDocuments();
      expect((await post({ name: 'Bot', phone: '98290 81009', website_url: 'http://spam', utm_source: 'x' })).status).toBe(201);
      expect(await Touchpoint.countDocuments()).toBe(before);
      await as(owner).patch(`/lead-sources/${form.id}`, { settings: { allowedOrigins: ['https://shop.example.in'] } });
      const elsewhere = await api().post(`/api/v1/public/forms/${form.form.publicKey}`).set('Origin', 'https://evil.example').send({ name: 'X', phone: '98290 81010' });
      expect(elsewhere.status).toBe(403);
    });

    it('the embed script reads the page tags and keeps the first ones for 30 days', async () => {
      const js = (await api().get(`/api/v1/public/forms/${form.form.publicKey}/embed.js`)).text;
      expect(js).toContain("'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'");
      expect(js).toContain('ycrm_first_touch');
      expect(js).toContain('30 * 864e5');
    });

    it('the report counts leads, wins and won value by channel and by campaign, first or last touch', async () => {
      // Win the Diwali lead for ₹50,000, and add one by hand (no touch: its source decides).
      const lead = (await as(owner).get('/leads?limit=10')).body.data.find((l) => l.contact.name === 'Kota Stone');
      await as(owner).patch(`/leads/${lead.id}`, { expectedValuePaise: 5000000 });
      await as(owner).post(`/leads/${lead.id}/stage`, { stage: 'Won' });
      await as(owner).post('/leads', { title: 'Walk-in', contact: { name: 'Walk In', phone: '98290 81020' } });

      const report = async (query) => (await as(owner).get(`/reports/attribution?${query}`)).body.data;
      const byChannel = await report('by=channel&touch=first');
      const rows = Object.fromEntries(byChannel.items.map((r) => [r.key, r]));
      expect(rows.paid_search).toMatchObject({ leads: 1, won: 1, wonValuePaise: 5000000, conversionPct: 100 });
      expect(rows.organic_search).toMatchObject({ leads: 1, won: 0, wonValuePaise: 0 });
      expect(rows.direct).toMatchObject({ leads: 1, won: 0 });
      expect(rows.other).toMatchObject({ leads: 1 }); // the walk-in, added by hand
      expect(byChannel.totals).toMatchObject({ leads: 4, won: 1, wonValuePaise: 5000000, conversionPct: 25 });
      expect(byChannel.items[0].key).toBe('paid_search'); // most won value first

      const last = Object.fromEntries((await report('by=channel&touch=last')).items.map((r) => [r.key, r]));
      expect(last.paid_social).toMatchObject({ leads: 1, won: 1, wonValuePaise: 5000000 });
      expect(last.paid_search).toBeUndefined();

      const campaigns = await report('by=campaign');
      expect(campaigns.items.find((r) => r.key === 'diwali_sale')).toMatchObject({ channel: 'paid_search', leads: 1, won: 1 });
      expect((await as(owner).get('/reports/attribution?by=ad')).status).toBe(400);
    });

    it('members who see only their own leads get their own; other companies see nothing', async () => {
      const mine = (await as(viewer).get('/reports/attribution')).body.data;
      expect(mine).toMatchObject({ scope: 'own', totals: { leads: 0 } });
      const lead = (await as(owner).get('/leads?limit=1')).body.data[0];
      expect((await as(other).get(`/contacts/${lead.contactId}/touchpoints`)).status).toBe(404);
      expect((await as(other).get('/reports/attribution')).body.data.totals.leads).toBe(0);
    });
  });

  describe('Through ad platforms and the API', () => {
    let owner;
    beforeAll(async () => {
      owner = await login('at2-owner@example.com');
    });

    it('a Google Ads lead keeps its campaign and click id', async () => {
      const google = (await as(owner).post('/lead-sources', { type: 'googleads' })).body.data;
      const res = await api().post(pathOf(google.pushUrl)).set('Content-Type', 'application/json').send(JSON.stringify({
        lead_id: 'GA-9', campaign_id: 5678, adgroup_id: 91, gcl_id: 'GCL-9', google_key: google.googleKey,
        user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Meena Stores' }, { column_id: 'PHONE_NUMBER', string_value: '+91 98111 00099' }],
      }));
      expect(res.status).toBe(200);
      const lead = await Lead.findOne({ source: 'Google Ads', sourceRef: 'GA-9' });
      expect(lead.attribution.first).toMatchObject({ channel: 'paid_search', campaign: '5678' });
      expect(await Touchpoint.findOne({ leadId: lead._id })).toMatchObject({ clickIds: { gclid: 'GCL-9' }, ad: { campaignId: '5678', id: '91' } });
    });

    it('an API lead takes utm or reads it from the landing page', async () => {
      const key = (await as(owner).post('/api-keys', { name: 'Site', scopes: ['leads:write', 'leads:read'] })).body.data.key;
      const res = await api().post('/api/public/v1/leads').set('Authorization', `Bearer ${key}`).send({
        contact: { name: 'API Buyer', phone: '98111 00100' }, title: 'Pump', landingPage: 'https://shop.in/?utm_source=instagram&utm_medium=paid&utm_campaign=reels',
      });
      expect(res.status).toBe(201);
      const lead = await Lead.findById(res.body.data.lead.id);
      expect(lead.attribution.first).toMatchObject({ channel: 'paid_social', source: 'API', campaign: 'reels' });
    });
  });
});
