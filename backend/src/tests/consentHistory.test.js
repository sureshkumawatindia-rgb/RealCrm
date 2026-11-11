jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const ConsentEvent = require('../models/ConsentEvent');
const MessageTemplate = require('../models/MessageTemplate');
const consent = require('../services/automation/consent');
const { ACTIONS } = require('../services/automation/actions');
const { api, bearer, loginWithApi: login, inviteAndJoin } = require('./helpers/api'); // companies on Scale: the API needs it (D125)

// Phase 2 (D79): every change of a customer's WhatsApp marketing consent is kept, and an opted-out
// customer gets no marketing message.
const as = (user) => ({
  get: (url) => api().get(`/api/v1${url}`).set(bearer(user.token)),
  post: (url, body) => api().post(`/api/v1${url}`).set(bearer(user.token)).send(body),
  patch: (url, body) => api().patch(`/api/v1${url}`).set(bearer(user.token)).send(body),
});
const history = async (user, id) => (await as(user).get(`/contacts/${id}/consent-history`)).body.data;

describe('Consent history (D79)', () => {
  let owner;
  let agent;
  let other;
  let customer;

  beforeAll(async () => {
    owner = await login('ch-owner@example.com', { name: 'Asha' });
    agent = await inviteAndJoin(owner.token, 'ch-agent@example.com', { role: 'agent' });
    other = await login('ch-other@example.com');
  });

  it('keeps who changed it, how and when; saving the same state is not a change', async () => {
    customer = (await as(owner).post('/contacts', { name: 'Kota Stone', phone: '98290 91001', lifecycle: 'customer', marketingConsent: 'opted_in' })).body.data;
    await as(owner).patch(`/contacts/${customer.id}`, { marketingConsent: 'opted_in', city: 'Kota' });
    await as(owner).patch(`/contacts/${customer.id}`, { marketingConsent: 'opted_out' });
    const items = await history(owner, customer.id);
    expect(items.map((e) => [e.from, e.to, e.method, e.actorName])).toEqual([
      ['opted_in', 'opted_out', 'manual', 'Asha'],
      ['unknown', 'opted_in', 'manual', 'Asha'],
    ]);
  });

  it('a STOP or START reply is kept as the customer’s own change', async () => {
    const organizationId = (await Contact.findById(customer.id)).organizationId;
    await consent.handleMessage({ type: 'message.received', organizationId, contactId: customer.id, text: 'START' });
    await consent.handleMessage({ type: 'message.received', organizationId, contactId: customer.id, text: 'START' }); // no change
    await consent.handleMessage({ type: 'message.received', organizationId, contactId: customer.id, text: 'stop' });
    const items = await history(owner, customer.id);
    expect(items.slice(0, 2).map((e) => [e.from, e.to, e.method, e.actorName, e.detail])).toEqual([
      ['opted_in', 'opted_out', 'whatsapp_reply', 'Customer', 'Replied STOP'],
      ['opted_out', 'opted_in', 'whatsapp_reply', 'Customer', 'Replied START'],
    ]);
    expect(items).toHaveLength(4);
  });

  it('the API is recorded as the API', async () => {
    const key = (await as(owner).post('/api-keys', { name: 'Shop site', scopes: ['contacts:write'] })).body.data.key;
    const made = await api().post('/api/public/v1/contacts').set('Authorization', `Bearer ${key}`).send({ name: 'API Buyer', phone: '98290 91002', marketingConsent: 'opted_in' });
    expect(made.status).toBe(201);
    const [event] = await history(owner, made.body.data.id);
    expect(event).toMatchObject({ from: 'unknown', to: 'opted_in', method: 'api', actorName: expect.stringContaining('API key') });
  });

  it('an import that opts people in records each of them', async () => {
    const file = 'Name,Mobile\nImported One,98290 91010\nImported Two,98290 91011\n';
    const res = await api().post('/api/v1/contacts/import').set(bearer(owner.token)).attach('file', Buffer.from(file, 'utf8'), 'customers.csv')
      .field('mapping', JSON.stringify(['name', 'phone'])).field('consent', 'opted_in');
    expect(res.status).toBe(200);
    const imported = await Contact.find({ phoneE164: { $in: ['+919829091010', '+919829091011'] } });
    expect(imported).toHaveLength(2);
    for (const contact of imported) {
      expect(await ConsentEvent.findOne({ contactId: contact._id }).lean()).toMatchObject({ from: 'unknown', to: 'opted_in', method: 'import' });
    }
  });

  it('the website form’s box opts in only when the company asks for it and the visitor ticks it', async () => {
    const form = (await as(owner).post('/lead-sources', { type: 'website', name: 'Site', settings: { askFor: { consent: true }, consentText: 'WhatsApp offers please' } })).body.data;
    const post = (body) => api().post(`/api/v1/public/forms/${form.form.publicKey}`).send(body);
    const js = (await api().get(`/api/v1/public/forms/${form.form.publicKey}/embed.js`)).text;
    expect(js).toContain('WhatsApp offers please');
    await post({ name: 'Ticked', phone: '98290 91020', consent: true, landingPage: 'https://shop.in/offer' });
    await post({ name: 'Not ticked', phone: '98290 91021', consent: false });
    const ticked = await Contact.findOne({ phoneE164: '+919829091020' });
    expect(ticked.consent).toMatchObject({ marketing: 'opted_in', method: 'website_form' });
    expect(await ConsentEvent.findOne({ contactId: ticked._id }).lean()).toMatchObject({ method: 'website_form', actorName: 'Customer', detail: 'https://shop.in/offer' });
    expect((await Contact.findOne({ phoneE164: '+919829091021' })).consent.marketing).toBe('unknown');

    // A form that does not ask ignores a "consent" sent anyway.
    const plain = (await as(owner).post('/lead-sources', { type: 'website', name: 'Plain' })).body.data;
    // The box is drawn only when the form's settings ask for it.
    expect((await api().get(`/api/v1/public/forms/${plain.form.publicKey}/embed.js`)).text).toContain('"consent":false');
    await api().post(`/api/v1/public/forms/${plain.form.publicKey}`).send({ name: 'Sneaky', phone: '98290 91022', consent: true });
    expect((await Contact.findOne({ phoneE164: '+919829091022' })).consent.marketing).toBe('unknown');
  });

  it('only those who may see the customer read the history', async () => {
    expect((await as(agent).get(`/contacts/${customer.id}/consent-history`)).status).toBe(404); // not the agent's customer
    expect((await as(other).get(`/contacts/${customer.id}/consent-history`)).status).toBe(404);
  });

  describe('No marketing to those who opted out', () => {
    it('a workflow’s marketing template is skipped', async () => {
      const organizationId = (await Contact.findById(customer.id)).organizationId;
      const template = await MessageTemplate.create({
        organizationId, whatsappAccountId: new mongoose.Types.ObjectId(), name: 'diwali_offer', language: 'en', category: 'MARKETING', status: 'APPROVED',
        components: [{ type: 'BODY', text: 'Diwali offer: 10% off!' }],
      });
      const contact = await Contact.findById(customer.id); // opted out by the STOP above
      expect(contact.consent.marketing).toBe('opted_out');
      const result = await ACTIONS['whatsapp.template']({ ctx: { contact }, params: { templateId: template._id }, workflow: { organizationId } });
      expect(result).toMatchObject({ status: 'skipped', detail: expect.stringContaining('opted out') });
    });

    it('the API refuses to send them a template', async () => {
      const key = (await as(owner).post('/api-keys', { name: 'Sender', scopes: ['messages:write'] })).body.data.key;
      const res = await api().post('/api/public/v1/messages').set('Authorization', `Bearer ${key}`).send({ contactId: customer.id, template: { name: 'diwali_offer' } });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OPTED_OUT');
    });
  });

  it('the full export has the history', async () => {
    const res = await api().get('/api/v1/exports/crm').set(bearer(owner.token));
    expect(res.body.consentEvents.length).toBeGreaterThanOrEqual(6);
    expect(res.body).toHaveProperty('touchpoints');
  });
});
