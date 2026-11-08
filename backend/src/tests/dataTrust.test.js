jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const fs = require('fs');
const path = require('path');
const AuditLog = require('../models/AuditLog');
const CalendarEvent = require('../models/CalendarEvent');
const Call = require('../models/Call');
const ConsentEvent = require('../models/ConsentEvent');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Document = require('../models/Document');
const InboundEvent = require('../models/InboundEvent');
const Job = require('../models/Job');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const Note = require('../models/Note');
const Order = require('../models/Order');
const PaymentReceipt = require('../models/PaymentReceipt');
const PrivacyRequest = require('../models/PrivacyRequest');
const Quotation = require('../models/Quotation');
const Task = require('../models/Task');
const TaxInvoice = require('../models/TaxInvoice');
const Ticket = require('../models/Ticket');
const WebhookDelivery = require('../models/WebhookDelivery');
const queue = require('../jobs/queue');
const safeWebhook = require('../utils/safeWebhook');
const engine = require('../services/automation/engine');
const webhooks = require('../services/outboundWebhookService');
const erasure = require('../services/erasureService');
const privacy = require('../services/privacyService');
const inbound = require('../services/whatsappInboundService');
const { indiaDate } = require('../utils/dates');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 8 of the 100 phases (D120): data trust. A customer's data is given to them or erased on
// their request (India's DPDP Act 2023, ss. 11–12), the tax records the law asks for are kept and
// made anonymous after their years, the company's privacy settings, and the register of requests.
const DAY = 24 * 60 * 60 * 1000;
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    await queue.runDue();
  }
};
const storedFile = (key) => path.join(process.env.DOCUMENT_DIR, ...key.split('/'));
const text = (res, cb) => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => cb(null, data));
};

describe('A customer\'s data on request (Phase 8, D120)', () => {
  let owner;
  let admin;
  let agent;
  let stranger;
  const ids = {};
  const as = (who) => bearer(who.token);
  const post = (who, url, body = {}) => api().post(`/api/v1${url}`).set(as(who)).send(body);
  const get = (who, url) => api().get(`/api/v1${url}`).set(as(who));
  const exportFile = (who, id, body) => api().post(`/api/v1/contacts/${id}/privacy/export`).set(as(who)).send(body).buffer(true).parse(text);
  const yesterday = indiaDate(-1);

  beforeAll(async () => {
    // Webhooks go to a test address (no network in tests).
    safeWebhook.setLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));
    engine.register(queue);
    webhooks.register(queue);
    erasure.register(queue);
    owner = await login('trust-owner@example.com', { name: 'Asha' });
    admin = await inviteAndJoin(owner.token, 'trust-admin@example.com', { role: 'admin', displayName: 'Ankit' });
    agent = await inviteAndJoin(owner.token, 'trust-agent@example.com', { role: 'agent', displayName: 'Arun' });
    stranger = await login('trust-stranger@example.com');
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Meera Traders', gstin: '08AAACM1234C1Z5', address: '9 MI Road', city: 'Jaipur', postalCode: '302001', email: 'hello@meera.example', phone: '+91 98290 00001' });
    await post(owner, '/whatsapp/accounts', { provider: 'mock' });
    const hook = await post(owner, '/outbound-webhooks', { url: 'https://hooks.example.com/crm', events: ['contact.erased', 'contact.updated'] });
    expect(hook.status).toBe(201);
    const product = (await post(owner, '/products', { name: 'Cotton yarn', unit: 'kg', pricePaise: 25000, gstRatePct: 5, hsnSac: '5205' })).body.data;

    // The customer: a WhatsApp chat with a photo, details, consent, a note, work, a ticket, a file,
    // a call, a lead, a quotation, an order, its tax invoice and a payment.
    const chat = (await post(owner, '/dev/simulate/whatsapp-inbound', { from: '98290 71001', name: 'Kavya', text: 'Cotton yarn 50 kg ka rate?' })).body.data;
    await post(owner, '/dev/simulate/whatsapp-inbound', { from: '98290 71001', type: 'image', text: 'sample photo' });
    await inbound.idle();
    ids.contact = String(chat.contactId);
    ids.conversation = String(chat.conversationId);
    await api().patch(`/api/v1/contacts/${ids.contact}`).set(as(owner)).send({ name: 'Kavya Textiles', email: 'kavya@textiles.example', address: '22 Johari Bazar', city: 'Jaipur', state: 'Rajasthan', tags: ['yarn'], notes: 'Pays on the 10th', marketingConsent: 'opted_in' });
    await post(owner, `/contacts/${ids.contact}/notes`, { text: 'Wants samples before ordering' });
    await post(owner, '/tasks', { title: 'Call Kavya about samples', relatedType: 'Customer', relatedId: ids.contact });
    await post(owner, '/events', { title: 'Visit Kavya Textiles', date: indiaDate(3), startTime: '11:00', relatedType: 'Customer', relatedId: ids.contact });
    await post(owner, '/events', { title: 'First meeting with Kavya', date: indiaDate(-20), startTime: '10:00', relatedType: 'Customer', relatedId: ids.contact });
    await post(owner, '/tickets', { subject: 'Kavya: late delivery', description: 'Asked twice about the truck', contactId: ids.contact });
    const doc = await api().post('/api/v1/documents').set(as(owner)).field('name', 'Kavya GST certificate').field('relatedType', 'Customer').field('relatedId', ids.contact)
      .attach('file', Buffer.from('gst certificate'), 'kavya-gst.pdf');
    expect(doc.status).toBe(201);
    ids.document = doc.body.data.id;
    await api().post('/api/v1/calls').set(as(owner)).set('Idempotency-Key', 'trust-call-0001').send({ contactId: ids.contact, outcome: 'connected', notes: 'Kavya wants 50 kg', durationSec: 120 });
    ids.lead = (await post(owner, '/leads', { contactId: ids.contact, title: 'Kavya — 50 kg yarn', notes: 'Price sensitive' })).body.data.id;
    const quotation = (await post(owner, '/quotations', { contactId: ids.contact, leadId: ids.lead, items: [{ productId: product.id, quantity: 50 }] })).body.data;
    ids.quotation = quotation.id;
    ids.quotationLink = new URL(quotation.shareUrl).pathname;
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(as(owner)).send({ status: 'Sent' });
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(as(owner)).send({ status: 'Accepted' });
    const order = (await post(owner, '/orders', { quotationId: quotation.id })).body.data;
    ids.order = order.id;
    ids.invoice = (await post(owner, `/orders/${order.id}/invoice`)).body.data.invoice.id;
    expect((await post(owner, `/orders/${order.id}/payments`, { amountPaise: 500000, method: 'bank_transfer', reference: 'UTR-KAVYA-1' })).status).toBe(201);

    // Another customer, whose data must never be touched.
    const otherChat = (await post(owner, '/dev/simulate/whatsapp-inbound', { from: '98290 71002', name: 'Rohan', text: 'Polyester rate?' })).body.data;
    ids.other = String(otherChat.contactId);
    ids.otherConversation = String(otherChat.conversationId);
    ids.otherLead = (await post(owner, '/leads', { contactId: ids.other, title: 'Rohan — polyester' })).body.data.id;
    await inbound.idle();
    await settle();
  });

  afterAll(() => {
    jest.restoreAllMocks();
    safeWebhook.setLookup((hostname) => require('dns').promises.lookup(hostname, { all: true, verbatim: true }));
  });

  it('gives a file of everything kept about the customer, in Hindi too, and notes it in the register', async () => {
    const res = await exportFile(owner, ids.contact, { language: 'hi', askedAt: yesterday });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="customer-data-\d{4}-\d{2}-\d{2}\.html"/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const page = res.body;
    expect(page).toContain('<html lang="hi">');
    expect(page).toContain('Meera Traders के पास आपका डेटा'); // the title, in Hindi
    expect(page).toContain('आपकी जानकारी'); // "Your details"
    for (const piece of ['Kavya Textiles', '+919829071001', 'kavya@textiles.example', 'Cotton yarn 50 kg ka rate?', 'Wants samples before ordering', 'Pays on the 10th', 'Kavya — 50 kg yarn', 'Kavya GST certificate', 'Kavya wants 50 kg', 'WhatsApp (Meta)', 'YELLOW CRM', 'hello@meera.example']) {
      expect({ piece, found: page.includes(piece) }).toEqual({ piece, found: true });
    }
    const quotation = await Quotation.findById(ids.quotation);
    const order = await Order.findById(ids.order);
    const invoice = await TaxInvoice.findById(ids.invoice);
    const receipt = await PaymentReceipt.findOne({ orderId: ids.order });
    for (const number of [quotation.number, order.number, invoice.number, receipt.number]) expect(page).toContain(number);
    expect(page).not.toMatch(/<script/i); // a document, nothing that runs

    // The same as JSON, for another system.
    const json = await exportFile(owner, ids.contact, { format: 'json' });
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    const data = JSON.parse(json.body);
    expect(data).toMatchObject({
      format: 'yellow-crm-customer-data', version: 1, language: 'en',
      company: { name: 'Meera Traders', privacyContact: { email: 'hello@meera.example', phone: '+91 98290 00001' } },
      customer: { name: 'Kavya Textiles', phone: '+919829071001', email: 'kavya@textiles.example', marketingConsent: 'opted_in', tags: ['yarn'] },
    });
    expect(data.chats).toEqual([expect.objectContaining({ channel: 'whatsapp', messages: expect.arrayContaining([expect.objectContaining({ from: 'customer', text: 'Cotton yarn 50 kg ka rate?' })]) })]);
    expect(data.chats[0].messages.some((m) => m.type === 'image')).toBe(true);
    expect(data.consentHistory).toEqual([expect.objectContaining({ from: 'unknown', to: 'opted_in', method: 'manual' })]);
    expect(data.quotations).toHaveLength(1);
    expect(data.orders).toHaveLength(1);
    expect(data.taxInvoices).toEqual([expect.objectContaining({ number: invoice.number, billTo: expect.objectContaining({ name: 'Kavya Textiles' }) })]);
    expect(data.payments).toEqual([expect.objectContaining({ amountPaise: 500000, reference: 'UTR-KAVYA-1' })]);
    expect(data.supportRequests).toHaveLength(1);
    expect(data.meetings).toHaveLength(2);
    expect(data.sharedWith.map((s) => s.name)).toEqual(expect.arrayContaining(['YELLOW CRM', 'WhatsApp (Meta)', 'hooks.example.com']));
    expect(JSON.stringify(data)).not.toContain('Rohan'); // nobody else's data
    expect(JSON.stringify(data)).not.toMatch(/storageKey|organizationId/);

    // The register: both copies, when asked and by whom.
    const register = (await get(owner, '/organization/privacy/requests')).body.data;
    expect(register.slice(0, 2)).toEqual([
      expect.objectContaining({ type: 'access', contactName: 'Kavya Textiles', format: 'json', byName: 'Asha', days: 0 }),
      expect.objectContaining({ type: 'access', contactName: 'Kavya Textiles', format: 'html', byName: 'Asha', days: 1 }),
    ]);
    expect(await AuditLog.countDocuments({ action: 'contact.data_exported', entityId: ids.contact })).toBe(2);

    // An admin may (the default); an agent and another company may not; no day in the future.
    expect((await exportFile(admin, ids.contact, {})).status).toBe(200);
    expect((await exportFile(agent, ids.contact, {})).status).toBe(403);
    expect((await exportFile(stranger, ids.contact, {})).status).toBe(404);
    const future = await exportFile(owner, ids.contact, { askedAt: indiaDate(2) });
    expect([future.status, JSON.parse(future.body).code]).toEqual([400, 'VALIDATION_ERROR']);
    expect((await get(agent, `/contacts/${ids.contact}/privacy/erase-preview`)).status).toBe(403);
  });

  it('erases the customer: their chats and notes go, the sales records stay without them, the tax records stay as the law asks', async () => {
    const preview = (await get(owner, `/contacts/${ids.contact}/privacy/erase-preview`)).body.data;
    expect(preview.customer).toEqual({ id: ids.contact, name: 'Kavya Textiles', deleted: false });
    expect(preview.counts.deleted).toMatchObject({ chats: 1, messages: 2, notes: 3, files: 2, consentEvents: 1, openTasks: 1, comingMeetings: 1 });
    // leads: the WhatsApp enquiry's own, and the one added by hand.
    expect(preview.counts.anonymised).toMatchObject({ leads: 2, quotations: 1, orders: 1, tickets: 1, calls: 1, pastMeetings: 1 });
    expect(preview.counts.kept).toEqual({ invoices: 1, receipts: 1 });
    expect(preview.keptUntil).toBe(erasure.keptUntilOf(new Date()).toISOString());
    // 50 kg × ₹250 + 5% GST = ₹13,125; ₹5,000 paid. The WhatsApp enquiry's lead is still open.
    expect(preview.warnings).toMatchObject({ openOrders: 1, duePaise: 1312500 - 500000, openLeads: 1, openPaymentLinks: 0 });

    // The files on the disk, and the webhook copy of the photo, before.
    const keys = [(await Document.findById(ids.document)).storageKey, (await Message.findOne({ conversationId: ids.conversation, type: 'image' })).media.storageKey];
    keys.forEach((key) => expect(fs.existsSync(storedFile(key))).toBe(true));
    expect(await InboundEvent.countDocuments({ 'payload.message.from': '919829071001' })).toBe(2);
    const leadsBefore = await Lead.countDocuments({ organizationId: owner.data.organizationId });

    // The name must be typed exactly.
    expect((await post(owner, `/contacts/${ids.contact}/privacy/erase`, { confirmName: 'Kavya' })).body.code).toBe('VALIDATION_ERROR');
    const res = await post(owner, `/contacts/${ids.contact}/privacy/erase`, { confirmName: '  kavya textiles ', askedAt: yesterday, language: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ counts: preview.counts, keptUntil: preview.keptUntil });
    await settle();

    // The customer is "an erased customer": deleted, nothing that says who they were.
    const contact = await Contact.findOne({ _id: ids.contact, deletedAt: { $ne: null } }).lean();
    expect(contact).toMatchObject({ name: 'Erased customer', email: '', phone: '', company: '', address: '', city: '', tags: [], notes: '', erasure: { keptUntil: new Date(preview.keptUntil) } });
    expect(contact.phoneE164).toBeUndefined();
    expect(contact.consent).toBeUndefined();
    const reopened = await get(owner, `/contacts/${ids.contact}`);
    expect(reopened.status).toBe(410);
    expect(reopened.body).toMatchObject({ code: 'ERASED' });
    expect((await post(owner, `/contacts/${ids.contact}/privacy/erase`, { confirmName: 'Erased customer' })).status).toBe(410);
    expect((await get(owner, '/contacts?q=Kavya')).body.data).toEqual([]);

    // Deleted for good.
    expect(await Conversation.countDocuments({ _id: ids.conversation })).toBe(0);
    expect(await Message.countDocuments({ conversationId: ids.conversation })).toBe(0);
    expect(await Note.countDocuments({ parentId: ids.contact })).toBe(0);
    expect(await Document.countDocuments({ _id: ids.document })).toBe(0);
    expect(await ConsentEvent.countDocuments({ contactId: ids.contact })).toBe(0);
    keys.forEach((key) => expect(fs.existsSync(storedFile(key))).toBe(false));
    expect(await InboundEvent.countDocuments({ 'payload.message.from': '919829071001' })).toBe(0);
    expect(await Job.countDocuments({ name: erasure.JOBS.CLEANUP, 'data.waIds': { $exists: true } })).toBe(0); // the job forgot the number

    // Made anonymous: the numbers stay right.
    expect(await Lead.countDocuments({ organizationId: owner.data.organizationId })).toBe(leadsBefore);
    expect(await Lead.findById(ids.lead).lean()).toMatchObject({ title: 'Erased customer', notes: '', contactId: contact._id });
    expect((await Quotation.findById(ids.quotation).lean()).billTo).toEqual({ name: 'Erased customer' });
    const order = await Order.findById(ids.order).lean();
    expect(order.billTo).toEqual({ name: 'Erased customer' });
    expect(order.totals.grandTotalPaise).toBe(1312500);
    expect(await Ticket.findOne({ contactId: ids.contact }).lean()).toMatchObject({ subject: 'Erased customer', description: '', customerName: '' });
    expect(await Call.findOne({ contactId: ids.contact }).lean()).toMatchObject({ notes: '', fromNumber: '', toNumber: '', durationSec: 120 });
    const contactOid = contact._id;
    const tasks = await Task.collection.find({ relatedId: contactOid }).toArray(); // deleted ones too
    expect(tasks.map((t) => [t.title, Boolean(t.deletedAt)])).toEqual([['Erased customer', true]]); // open: gone
    const events = await CalendarEvent.collection.find({ relatedId: contactOid }).sort({ date: 1 }).toArray();
    expect(events.map((e) => [e.title, Boolean(e.deletedAt)])).toEqual([['Erased customer', false], ['Erased customer', true]]);

    // The lists keep working without the customer.
    const listed = (await get(owner, '/leads?limit=100')).body.data.find((l) => l.id === ids.lead);
    expect(listed).toMatchObject({ title: 'Erased customer', contact: null });
    for (const url of ['/quotations', '/orders', '/tickets', '/tasks', '/events', '/reports/overview']) {
      expect({ url, status: (await get(owner, url)).status }).toEqual({ url, status: 200 });
    }

    // Kept as the law asks, as they were.
    expect((await TaxInvoice.findById(ids.invoice).lean()).billTo).toMatchObject({ name: 'Kavya Textiles' });
    expect((await PaymentReceipt.findOne({ orderId: ids.order }).lean()).receivedFrom).toMatchObject({ name: 'Kavya Textiles' });

    // The quotation's link no longer opens; the register and the log keep no name.
    expect((await api().get(ids.quotationLink)).status).toBe(404);
    const register = await PrivacyRequest.find({ contactId: ids.contact }).sort({ doneAt: -1 }).lean();
    expect(register[0]).toMatchObject({ type: 'erasure', contactName: '', keptUntil: new Date(preview.keptUntil) });
    expect(register.every((r) => r.contactName === '')).toBe(true);
    expect(await AuditLog.exists({ action: 'contact.erased', entityId: ids.contact })).toBeTruthy();
    const auditText = JSON.stringify(await AuditLog.find({ entityId: ids.contact }).lean());
    expect(auditText).not.toContain('Kavya');

    // Every phone drops the Inbox copies it kept (Phase 7) on its next page.
    expect((await get(agent, '/auth/me')).body.data.organization.copiesClearedAt).toBe(res.body.data.erasedAt);

    // Connected systems are told, with the id only.
    const told = await WebhookDelivery.findOne({ event: 'contact.erased' }).lean();
    expect(told.payload.data).toEqual({ contact: { id: ids.contact }, erasedAt: res.body.data.erasedAt });
    expect(await WebhookDelivery.countDocuments({ event: 'contact.updated', 'payload.data.contact.id': ids.contact })).toBe(0);

    // Nothing of the other customer changed.
    expect(await Conversation.countDocuments({ _id: ids.otherConversation })).toBe(1);
    expect(await Message.countDocuments({ conversationId: ids.otherConversation })).toBe(1);
    expect(await Lead.findById(ids.otherLead).lean()).toMatchObject({ title: 'Rohan — polyester' });
    expect(await Contact.findById(ids.other).lean()).toMatchObject({ name: 'Rohan', phoneE164: '+919829071002' });
  });

  it('takes the day the customer asked as India\'s calendar day', () => {
    const morning = new Date('2026-11-08T03:00:00Z'); // 8:30 am in India
    expect(privacy.askedAtOf('2026-11-08', morning)).toBe(morning); // today, even before noon
    expect(privacy.askedAtOf('2026-11-07', morning).toISOString()).toBe('2026-11-07T06:30:00.000Z');
    expect(() => privacy.askedAtOf('2026-11-09', morning)).toThrow('cannot be in the future');
    expect(privacy.askedAtOf('', morning)).toBe(morning);
  });

  it('makes the tax records anonymous once the law\'s years are over, and not before', () => {
    // 8 years after the financial year (April–March, India time) ends, on 31 March.
    expect(erasure.keptUntilOf(new Date('2026-11-08T10:00:00+05:30')).toISOString()).toBe('2035-03-31T18:29:59.999Z');
    expect(erasure.keptUntilOf(new Date('2027-03-31T23:00:00+05:30')).toISOString()).toBe('2035-03-31T18:29:59.999Z');
    expect(erasure.keptUntilOf(new Date('2027-04-01T00:30:00+05:30')).toISOString()).toBe('2036-03-31T18:29:59.999Z');
  });

  it('finishes the erasure after the tax years', async () => {
    const contact = await Contact.findOne({ _id: ids.contact, deletedAt: { $ne: null } }).lean();
    expect(await erasure.finishDue(new Date(contact.erasure.keptUntil.getTime() - DAY))).toBe(0);
    expect(await erasure.finishDue(new Date(contact.erasure.keptUntil.getTime() + DAY))).toBe(1);
    expect((await TaxInvoice.findById(ids.invoice).lean()).billTo).toEqual({ name: 'Erased customer' });
    expect((await PaymentReceipt.findOne({ orderId: ids.order }).lean()).receivedFrom).toEqual({ name: 'Erased customer' });
    expect((await Contact.findOne({ _id: ids.contact, deletedAt: { $ne: null } }).lean()).erasure.finishedAt).toBeInstanceOf(Date);
    expect(await erasure.finishDue(new Date(contact.erasure.keptUntil.getTime() + 2 * DAY))).toBe(0); // once
  });

  it('finds a customer deleted earlier (their data is still kept) and erases them, with anyone merged into them', async () => {
    const old = (await post(owner, '/contacts', { name: 'Old Buyer', phone: '98290 71555', email: 'old@buyer.example' })).body.data;
    const twin = (await post(owner, '/contacts', { name: 'Old Buyer (2)', email: 'old2@buyer.example' })).body.data;
    expect((await post(owner, `/contacts/${old.id}/merge`, { otherId: twin.id }).set('Idempotency-Key', 'trust-merge-0001')).status).toBe(200);
    expect((await api().delete(`/api/v1/contacts/${old.id}`).set(as(owner))).status).toBe(200);

    const found = (await get(owner, '/organization/privacy/customers?q=71555')).body.data;
    expect(found).toEqual([expect.objectContaining({ id: old.id, name: 'Old Buyer', deleted: true })]);
    expect((await get(owner, '/organization/privacy/customers?q=old@buyer')).body.data).toHaveLength(1);
    expect((await get(agent, '/organization/privacy/customers?q=71555')).status).toBe(403);
    expect((await get(stranger, '/organization/privacy/customers?q=71555')).body.data).toEqual([]);

    expect((await get(owner, `/contacts/${old.id}/privacy/erase-preview`)).body.data.customer).toMatchObject({ deleted: true });
    expect((await post(owner, `/contacts/${old.id}/privacy/erase`, { confirmName: 'Old Buyer', language: 'hi' })).status).toBe(200);
    const [kept, merged] = await Promise.all([old.id, twin.id].map((id) => Contact.findOne({ _id: id, deletedAt: { $ne: null } }).lean()));
    expect(kept).toMatchObject({ name: 'मिटाया गया ग्राहक', email: '' });
    expect(merged).toMatchObject({ name: 'मिटाया गया ग्राहक', email: '', erasure: { at: expect.any(Date) } });
    expect((await get(owner, '/organization/privacy/customers?q=old@buyer')).body.data).toEqual([]);
  });

  it('keeps the company\'s privacy settings, shows them to customers, and lets owners keep requests to themselves', async () => {
    expect((await get(owner, '/organization/privacy')).body.data).toEqual({
      contactName: '', contactEmail: '', contactPhone: '', noticeUrl: '', deviceCopies: true, requestsBy: 'managers', canChangeWho: true,
      company: { email: 'hello@meera.example', phone: '+91 98290 00001' },
    });
    expect((await get(agent, '/organization/privacy')).status).toBe(403);
    const put = (who, body) => api().put('/api/v1/organization/privacy').set(as(who)).send(body);
    expect((await put(owner, { noticeUrl: 'ftp://meera.example/privacy' })).body.code).toBe('VALIDATION_ERROR');
    expect((await put(owner, { contactEmail: 'not an email' })).body.code).toBe('VALIDATION_ERROR');
    expect((await put(admin, { requestsBy: 'owners' })).status).toBe(403); // only an owner decides who

    const saved = await put(owner, { contactName: 'Asha Meera', contactEmail: 'Privacy@Meera.example', contactPhone: '+91 98290 00009', noticeUrl: 'https://meera.example/privacy', deviceCopies: false, requestsBy: 'owners' });
    expect(saved.body.data).toMatchObject({ contactName: 'Asha Meera', contactEmail: 'privacy@meera.example', noticeUrl: 'https://meera.example/privacy', deviceCopies: false, requestsBy: 'owners' });
    expect(await AuditLog.exists({ action: 'organization.privacy_updated' })).toBeTruthy();

    // Phones stop keeping chats (Phase 7), told through /auth/me.
    expect((await get(agent, '/auth/me')).body.data.organization.deviceCopies).toBe(false);
    // Owners only now: an admin is told so.
    expect((await get(admin, '/organization/privacy/requests')).status).toBe(403);
    expect((await exportFile(admin, ids.other, {})).status).toBe(403);
    expect((await exportFile(owner, ids.other, {})).status).toBe(200);

    // Customers see who to ask: the data file, the quotation page, the website form.
    const file = (await exportFile(owner, ids.other, {})).body;
    expect(file).toContain('Asha Meera · privacy@meera.example · +91 98290 00009');
    expect(file).toContain('href="https://meera.example/privacy"');
    const quotation = (await post(owner, '/quotations', { contactId: ids.other, items: [{ name: 'Polyester', quantity: 10, unitPricePaise: 10000, gstRatePct: 5 }] })).body.data;
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(as(owner)).send({ status: 'Sent' });
    const quotationPage = (await api().get(new URL(quotation.shareUrl).pathname)).text;
    expect(quotationPage).toContain('Questions about your data: Asha Meera · privacy@meera.example · +91 98290 00009');
    expect(quotationPage).toContain('<a href="https://meera.example/privacy" rel="noopener">Privacy notice</a>');
    const { form } = (await post(owner, '/lead-sources', { type: 'website', name: 'Website form' })).body.data;
    const script = (await api().get(`/api/v1/public/forms/${form.publicKey}/embed.js`)).text;
    expect(script).toContain('"privacyUrl":"https://meera.example/privacy"');

    await put(owner, { requestsBy: 'managers', deviceCopies: true });
  });
});
