jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const LeadIntake = require('../models/LeadIntake');
const bus = require('../realtime/bus');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const simulate = (token, body) => api().post('/api/v1/dev/simulate/lead').set(bearer(token)).send(body);

describe('Lead intake (every source ends here)', () => {
  let owner;
  beforeAll(async () => { owner = await login('intake-owner@example.com'); });

  it('makes a contact and a New lead with the source, its reference and the raw payload', async () => {
    const heard = [];
    const listener = (event) => heard.push(event);
    bus.on('lead:intake', listener);
    const res = await simulate(owner.token, {
      source: 'IndiaMART', sourceRef: 'IM-1001', name: 'Ravi Traders', phone: '98290 12345', city: 'Jaipur', state: 'Rajasthan',
      product: 'Cumin Seeds', quantity: '50', message: 'Need 50kg every month',
    });
    bus.off('lead:intake', listener);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ outcome: 'created', contactCreated: true });
    const lead = await Lead.findById(res.body.data.leadId);
    expect(lead).toMatchObject({ stage: 'New', source: 'IndiaMART', sourceRef: 'IM-1001', title: 'Cumin Seeds', quantity: 50, notes: 'Need 50kg every month' });
    expect(lead.followUpAt).toBeTruthy();
    const contact = await Contact.findById(res.body.data.contactId);
    expect(contact).toMatchObject({ name: 'Ravi Traders', phoneE164: '+919829012345', city: 'Jaipur', source: 'IndiaMART', lifecycle: 'lead' });
    const intake = await LeadIntake.findOne({ sourceRef: 'IM-1001' });
    expect(intake).toMatchObject({ outcome: 'created', summary: 'IndiaMART enquiry: Cumin Seeds · qty 50 — Need 50kg every month' });
    expect(intake.raw).toMatchObject({ simulated: true, product: 'Cumin Seeds' });
    expect(heard).toEqual([expect.objectContaining({ outcome: 'created', source: 'IndiaMART', contactCreated: true })]);
  });

  it('takes the same enquiry once; a new enquiry from the same number joins the open lead (D26)', async () => {
    const again = await simulate(owner.token, { source: 'IndiaMART', sourceRef: 'IM-1001', name: 'Ravi', phone: '9829012345' });
    expect(again.body.data.outcome).toBe('duplicate');
    const first = await Lead.findOne({ sourceRef: 'IM-1001' });

    const more = await simulate(owner.token, { source: 'Website', sourceRef: 'W-1', name: 'Ravi T', phone: '+91 98290 12345', email: 'ravi@traders.in', company: 'Ravi Traders Pvt Ltd', product: 'Fennel' });
    expect(more.body.data).toMatchObject({ outcome: 'attached', leadId: String(first._id), contactCreated: false });
    expect(await Lead.countDocuments({ contactId: first.contactId })).toBe(1);
    const activity = await LeadActivity.findOne({ leadId: first._id, type: 'Enquiry' });
    expect(activity.text).toBe('Website enquiry: Fennel');
    const updated = await Lead.findById(first._id);
    expect(updated.version).toBe(first.version + 1);
    // Blank contact details are filled in; the name is not overwritten.
    expect(await Contact.findById(first.contactId)).toMatchObject({ name: 'Ravi Traders', email: 'ravi@traders.in', company: 'Ravi Traders Pvt Ltd' });

    // Once the lead is closed, the next enquiry is a new lead.
    await Lead.updateOne({ _id: first._id }, { stage: 'Won' });
    const next = await simulate(owner.token, { source: 'IndiaMART', sourceRef: 'IM-1002', name: 'Ravi', phone: '9829012345', product: 'Cumin Seeds' });
    expect(next.body.data.outcome).toBe('created');
    expect(await Lead.countDocuments({ contactId: first.contactId })).toBe(2);
  });

  it('accepts email-only enquiries, refuses ones without a way to reach the person, and links known products', async () => {
    const product = (await api().post('/api/v1/products').set(bearer(owner.token)).send({ name: 'Ajwain 1kg', pricePaise: 30000 })).body.data;
    const byEmail = await simulate(owner.token, { source: 'Website', name: 'Mail Only', email: 'buyer@example.com', product: 'ajwain 1KG' });
    expect(byEmail.body.data.outcome).toBe('created');
    expect(String((await Lead.findById(byEmail.body.data.leadId)).productId)).toBe(product.id);

    const nothing = await simulate(owner.token, { source: 'JustDial', name: 'No contact', phone: '12' });
    expect(nothing.status).toBe(400);
    expect(nothing.body.data.outcome).toBe('rejected');
    expect(await LeadIntake.findOne({ source: 'JustDial' })).toMatchObject({ outcome: 'rejected', reason: 'No valid mobile number or email' });
  });
});

describe('Website enquiry forms', () => {
  let owner;
  let form;
  const origin = 'https://shop.example';
  const post = (key, body, from = origin) => api().post(`/api/v1/public/forms/${key}`).set('Origin', from).send(body);

  beforeAll(async () => {
    owner = await login('form-owner@example.com');
  });

  it('owners and admins create a form and get its embed code; others cannot', async () => {
    const agent = await inviteAndJoin(owner.token, 'form-agent@example.com', { role: 'agent' });
    expect((await api().post('/api/v1/lead-sources').set(bearer(agent.token)).send({ type: 'website' })).status).toBe(403);
    const res = await api().post('/api/v1/lead-sources').set(bearer(owner.token)).send({ type: 'website', name: 'Main website', settings: { title: 'Get a quote' } });
    expect(res.status).toBe(201);
    form = res.body.data;
    expect(form).toMatchObject({ type: 'website', source: 'Website', status: 'active', settings: { title: 'Get a quote', buttonText: 'Send', allowedOrigins: [] } });
    expect(form.form.publicKey).toMatch(/^[a-f0-9]{24}$/);
    expect(form.form.embedUrl).toBe(`http://127.0.0.1:3000/api/v1/public/forms/${form.form.publicKey}/embed.js`);
    expect((await api().get('/api/v1/lead-sources').set(bearer(owner.token))).body.data.map((c) => c.id)).toEqual([form.id]);
  });

  it('serves the embed script to any website', async () => {
    const js = await api().get(`/api/v1/public/forms/${form.form.publicKey}/embed.js`);
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/^application\/javascript/);
    expect(js.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(js.text).toContain(`"endpoint":"http://127.0.0.1:3000/api/v1/public/forms/${form.form.publicKey}"`);
    expect(js.text).toContain('"title":"Get a quote"');
    expect(js.text).not.toContain('innerHTML');
    const missing = await api().get('/api/v1/public/forms/0123456789abcdef01234567/embed.js');
    expect(missing.status).toBe(404);

    // A title that tries to close the script tag is harmless.
    await api().patch(`/api/v1/lead-sources/${form.id}`).set(bearer(owner.token)).send({ settings: { title: '</script><script>alert(1)</script>' } });
    const tricky = await api().get(`/api/v1/public/forms/${form.form.publicKey}/embed.js`);
    expect(tricky.text).not.toContain('</script>');
    await api().patch(`/api/v1/lead-sources/${form.id}`).set(bearer(owner.token)).send({ settings: { title: 'Get a quote' } });
  });

  it('takes enquiries from any website as a Website lead; a double click counts once; bots get nothing', async () => {
    const preflight = await api().options(`/api/v1/public/forms/${form.form.publicKey}`).set('Origin', origin).set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();

    const body = { name: 'Sunita', phone: '98111 00011', city: 'Ajmer', message: 'Price for 20kg?', submissionId: 'a1b2c3d4-0001' };
    const sent = await post(form.form.publicKey, body);
    expect(sent.status).toBe(201);
    expect(sent.body.data).toEqual({ accepted: true, message: 'Thank you! We will contact you shortly.' });
    expect((await post(form.form.publicKey, body)).status).toBe(201);
    const leads = await Lead.find({ source: 'Website', sourceRef: new RegExp(`^form:${form.id}:`) });
    expect(leads).toHaveLength(1);
    const intake = await LeadIntake.findOne({ leadId: leads[0]._id });
    expect(intake.raw).toMatchObject({ origin, fields: { name: 'Sunita', city: 'Ajmer' } });

    const bot = await post(form.form.publicKey, { name: 'Bot', phone: '98111 99999', website_url: 'http://spam.example' });
    expect(bot.status).toBe(201);
    expect(await Contact.exists({ phoneE164: '+919811199999' })).toBeNull();

    const badPhone = await post(form.form.publicKey, { name: 'X', phone: '123' });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.errors[0].field).toBe('phone');
    expect((await post(form.form.publicKey, { phone: '98111 00012' })).status).toBe(400);

    const log = (await api().get(`/api/v1/lead-sources/${form.id}/intakes`).set(bearer(owner.token))).body.data;
    expect(log.map((i) => i.outcome)).toEqual(['created']);
    expect((await api().get('/api/v1/lead-sources').set(bearer(owner.token))).body.data[0].stats).toMatchObject({ received: 2, created: 1, duplicate: 1 });
  });

  it('can be limited to listed websites, paused, and used as a plain HTML form', async () => {
    await api().patch(`/api/v1/lead-sources/${form.id}`).set(bearer(owner.token)).send({ settings: { allowedOrigins: ['https://www.mysite.in'] } });
    expect((await post(form.form.publicKey, { name: 'A', phone: '98111 00021' })).body.code).toBe('ORIGIN_NOT_ALLOWED');
    expect((await post(form.form.publicKey, { name: 'A', phone: '98111 00021' }, 'https://www.mysite.in')).status).toBe(201);

    const html = await api().post(`/api/v1/public/forms/${form.form.publicKey}`).type('form').send({ name: 'Plain', phone: '98111 00022' });
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/^text\/html/);
    expect(html.text).toContain('Thank you! We will contact you shortly.');
    await api().patch(`/api/v1/lead-sources/${form.id}`).set(bearer(owner.token)).send({ settings: { redirectUrl: 'https://www.mysite.in/thanks' } });
    const redirected = await api().post(`/api/v1/public/forms/${form.form.publicKey}`).type('form').send({ name: 'Plain 2', phone: '98111 00023' });
    expect(redirected.status).toBe(303);
    expect(redirected.headers.location).toBe('https://www.mysite.in/thanks');

    await api().patch(`/api/v1/lead-sources/${form.id}`).set(bearer(owner.token)).send({ status: 'paused' });
    expect((await post(form.form.publicKey, { name: 'A', phone: '98111 00024' }, 'https://www.mysite.in')).body.code).toBe('FORM_PAUSED');
  });

  it('is invisible to other companies, and a removed form stops working', async () => {
    const stranger = await login('form-stranger@example.com');
    expect((await api().patch(`/api/v1/lead-sources/${form.id}`).set(bearer(stranger.token)).send({ name: 'mine' })).status).toBe(404);
    expect((await api().get(`/api/v1/lead-sources/${form.id}/intakes`).set(bearer(stranger.token))).status).toBe(404);
    expect((await api().delete(`/api/v1/lead-sources/${form.id}`).set(bearer(stranger.token))).status).toBe(404);
    expect((await api().get('/api/v1/lead-sources').set(bearer(stranger.token))).body.data).toEqual([]);

    await api().delete(`/api/v1/lead-sources/${form.id}`).set(bearer(owner.token));
    expect((await post(form.form.publicKey, { name: 'A', phone: '98111 00025' })).status).toBe(404);
  });

  it('limits how many enquiries one address can send in a minute', async () => {
    const fresh = (await api().post('/api/v1/lead-sources').set(bearer(owner.token)).send({ type: 'website' })).body.data;
    const statuses = [];
    for (let i = 0; i < 32; i += 1) statuses.push((await post(fresh.form.publicKey, { name: `P${i}`, phone: `98222 000${String(i).padStart(2, '0')}` })).status);
    expect(statuses).toContain(429);
  });
});
