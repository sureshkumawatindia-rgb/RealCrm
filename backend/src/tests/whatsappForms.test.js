jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mock = require('../integrations/whatsapp/mock');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Job = require('../models/Job');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Order = require('../models/Order');
const queue = require('../jobs/queue');
const inbound = require('../services/whatsappInboundService');
const forms = require('../services/whatsappFormService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// G6 (D110): WhatsApp forms (Meta's Flows) — owners and admins make and publish an enquiry or an
// order form (a published Flow on each WhatsApp Business Account), teammates send it in a chat,
// and the customer's answers fill the customer and their lead, or make an order.
describe('WhatsApp forms (G6, D110)', () => {
  let owner;
  let agent;
  let sent = [];
  const as = (user) => bearer(user.token);
  const post = (path, body = {}, user = owner) => api().post(`/api/v1${path}`).set(as(user)).send(body);
  const patch = (path, body, user = owner) => api().patch(`/api/v1${path}`).set(as(user)).send(body);
  const get = (path, user = owner) => api().get(`/api/v1${path}`).set(as(user));
  // A customer writes (the 24-hour window opens), or answers a form, on the test number.
  const write = async (from, text, name = '') => {
    const data = (await post('/dev/simulate/whatsapp-inbound', { from, name, text })).body.data;
    await inbound.idle();
    return data;
  };
  const answer = async (from, flowToken, answers) => {
    const res = await post('/dev/simulate/whatsapp-inbound', { from, type: 'form', flowToken, answers });
    await inbound.idle();
    return res.body.data;
  };
  const sendForm = (conversationId, formId, user = agent) => api().post(`/api/v1/conversations/${conversationId}/form`).set(as(user)).set('Idempotency-Key', `form-${conversationId}-${formId}-${Math.random()}`).send({ formId });
  const flowOf = (formId) => mock.flows().filter((f) => f.name.includes(String(formId).slice(-6)));

  beforeAll(async () => {
    forms.register(queue);
    owner = await login('forms-owner@example.com', { name: 'Asha Owner' });
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', address: '12 MI Road', city: 'Jaipur', postalCode: '302001' });
    await post('/whatsapp/accounts', { provider: 'mock' });
    agent = await inviteAndJoin(owner.token, 'forms-agent@example.com', { role: 'agent', modules: ['inbox', 'leads'] });
  });
  beforeEach(() => {
    sent = [];
    jest.spyOn(mock, 'sendMessage').mockImplementation(async (credentials, body) => {
      sent.push(body);
      return { providerMessageId: `wamid.FORM${sent.length}${Date.now()}` };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  let enquiry;
  it('lets owners and admins make, change and publish a form as a Flow; teammates see the ones they can send', async () => {
    expect((await post('/whatsapp-forms', { kind: 'enquiry', name: 'Price enquiry' }, agent)).status).toBe(403);
    const made = await post('/whatsapp-forms', { kind: 'enquiry', name: 'Price enquiry' });
    expect(made.status).toBe(201);
    enquiry = made.body.data;
    expect(enquiry).toMatchObject({ kind: 'enquiry', status: 'draft', sendable: false, cta: 'Fill the form', submitLabel: 'Send', version: 0 });
    expect(enquiry.fields.map((f) => [f.key, f.on, f.required])).toEqual([
      ['name', true, true], ['email', true, false], ['company', false, false], ['city', true, false],
      ['requirement', true, true], ['quantity', true, false], ['budget', false, false], ['callTime', false, false],
    ]);
    const long = await patch(`/whatsapp-forms/${enquiry.id}`, { fields: [{ key: 'city', label: 'Which city do you live in?' }] });
    expect(long.status).toBe(400);
    expect(long.body.errors[0].code).toBe('LABEL_TOO_LONG');
    await patch(`/whatsapp-forms/${enquiry.id}`, { cta: 'Get prices', thanks: 'Thank you! We will call you soon.', fields: [{ key: 'budget', label: 'Budget (₹)', on: true }] });
    expect((await get('/whatsapp-forms', agent)).body.data.items).toEqual([]); // a draft cannot be sent

    const published = (await post(`/whatsapp-forms/${enquiry.id}/publish`)).body.data;
    expect(published).toMatchObject({ status: 'published', sendable: true, dirty: false, version: 1, error: '' });
    const [flow] = flowOf(enquiry.id);
    expect(flow).toMatchObject({ status: 'PUBLISHED', categories: ['LEAD_GENERATION'] });
    const screen = flow.flowJson.screens[0];
    expect(flow.flowJson.version).toBe('7.3');
    expect(screen).toMatchObject({ id: 'ENQUIRY', terminal: true, success: true });
    expect(screen.layout.children.map((c) => `${c.type}${c.name ? `:${c.name}` : ''}`)).toEqual([
      'TextHeading', 'TextInput:name', 'TextInput:email', 'TextInput:city', 'TextArea:requirement', 'TextInput:quantity', 'TextInput:budget', 'Footer',
    ]);
    expect(screen.layout.children[2]).toMatchObject({ 'input-type': 'email', required: false });
    expect(screen.layout.children.at(-1)['on-click-action']).toEqual({
      name: 'complete',
      payload: { name: '${form.name}', email: '${form.email}', city: '${form.city}', requirement: '${form.requirement}', quantity: '${form.quantity}', budget: '${form.budget}' },
    });
    expect((await get('/whatsapp-forms', agent)).body.data.items.map((f) => f.id)).toEqual([enquiry.id]);

    // Changed after publishing: the live version still goes out; publishing again retires it.
    expect((await patch(`/whatsapp-forms/${enquiry.id}`, { heading: 'What do you need?' })).body.data).toMatchObject({ dirty: true, sendable: true });
    expect((await post(`/whatsapp-forms/${enquiry.id}/publish`)).body.data).toMatchObject({ version: 2, dirty: false });
    expect(flowOf(enquiry.id).map((f) => f.status)).toEqual(['DEPRECATED', 'PUBLISHED']);

    // Meta refuses: the error is kept and the draft it made is deleted.
    const refused = (await post('/whatsapp-forms', { kind: 'enquiry', name: 'Refused form' })).body.data;
    jest.spyOn(mock, 'createFlow').mockImplementationOnce(async () => ({ flowId: 'mock-flow-refused', status: 'DRAFT', problems: ['The business is not verified.'] }));
    const deleted = jest.spyOn(mock, 'deleteFlow');
    expect((await post(`/whatsapp-forms/${refused.id}/publish`)).body.data).toMatchObject({ status: 'error', sendable: false, error: 'The business is not verified.' });
    expect(deleted).toHaveBeenCalledWith(expect.anything(), 'mock-flow-refused');
    expect((await post('/whatsapp-forms', { kind: 'order', name: 'No products' })).status).toBe(201);
    const noProducts = (await get('/whatsapp-forms')).body.data.items.find((f) => f.name === 'No products');
    expect((await post(`/whatsapp-forms/${noProducts.id}/publish`)).body.code).toBe('NO_PRODUCTS');
  });

  it('sends a form in a chat inside the 24-hour window; the answers fill the customer and their lead', async () => {
    const chat = await write('98290 51111', 'Jeera ka rate?');
    expect((await sendForm(chat.conversationId, enquiry.id)).status).toBe(201);
    const [body] = sent;
    expect(body.interactive).toMatchObject({
      type: 'flow',
      body: { text: 'Please fill this short form and we will get back to you.' },
      action: { name: 'flow', parameters: { flow_message_version: '3', flow_cta: 'Get prices', flow_action: 'navigate', flow_action_payload: { screen: 'ENQUIRY' } } },
    });
    const live = flowOf(enquiry.id).find((f) => f.status === 'PUBLISHED');
    expect(body.interactive.action.parameters.flow_id).toBe(live.flowId);
    const token = body.interactive.action.parameters.flow_token;
    expect(token).toMatch(/^[0-9a-f]{24}$/);
    const out = await Message.findOne({ conversationId: chat.conversationId, direction: 'out' }).lean();
    expect(out).toMatchObject({ type: 'interactive', interactive: { kind: 'flow' }, form: { name: 'Price enquiry', token } });

    const reply = await answer('98290 51111', token, {
      name: 'Meena Sharma', email: 'MEENA@example.com', city: 'Jaipur', requirement: 'Jeera 500 kg every month', quantity: '500', budget: '125000',
    });
    expect(await Job.countDocuments({ name: forms.JOB, 'data.messageId': String(reply.messageId) })).toBe(1);
    const result = await forms.answerFromMessage({ messageId: reply.messageId });
    expect(result.answers).toEqual([
      { label: 'Your name', value: 'Meena Sharma' }, { label: 'Email', value: 'MEENA@example.com' }, { label: 'City', value: 'Jaipur' },
      { label: 'What do you need?', value: 'Jeera 500 kg every month' }, { label: 'Quantity', value: '500' }, { label: 'Budget (₹)', value: '125000' },
    ]);
    const lead = await Lead.findById(result.leadId).lean();
    expect(lead).toMatchObject({ title: 'Jeera 500 kg every month', quantity: 500, expectedValuePaise: 12500000, source: 'WhatsApp' });
    const contact = await Contact.findById(chat.contactId).lean();
    expect(contact).toMatchObject({ name: 'Meena Sharma', email: 'meena@example.com', city: 'Jaipur' }); // the name was only the number
    const activity = await LeadActivity.findOne({ leadId: lead._id, type: 'WhatsApp form' }).lean();
    expect(activity.text).toBe('Filled the WhatsApp form "Price enquiry": Your name: Meena Sharma; Email: MEENA@example.com; City: Jaipur; What do you need?: Jeera 500 kg every month; Quantity: 500; Budget (₹): 125000');
    const stored = await Message.findById(reply.messageId).lean();
    expect(stored.form).toMatchObject({ name: 'Price enquiry', done: true, leadId: lead._id });
    const chatView = (await get(`/conversations/${chat.conversationId}/messages`)).body.data;
    expect(chatView.find((m) => String(m.id) === String(reply.messageId)).form).toMatchObject({ name: 'Price enquiry', leadId: String(lead._id), answers: result.answers });
    expect(await Message.findOne({ conversationId: chat.conversationId, 'automation.kind': 'form' }).lean()).toMatchObject({ text: 'Thank you! We will call you soon.' });
    const note = await Notification.findOne({ source: 'forms', organizationId: owner.data.organizationId }).lean();
    expect(note).toMatchObject({ title: 'WhatsApp form answered: Price enquiry', link: `Inbox.html?c=${chat.conversationId}` });
    expect((await get('/whatsapp-forms')).body.data.items.find((f) => f.id === enquiry.id)).toMatchObject({ sentCount: 1, answerCount: 1 });
    expect(await forms.answerFromMessage({ messageId: reply.messageId })).toBeNull(); // once
    expect(await LeadActivity.countDocuments({ leadId: lead._id, type: 'WhatsApp form' })).toBe(1);

    // Answers with a token the CRM never sent: kept as they came, nothing more.
    const stray = await answer('98290 51111', 'not-ours', { colour: 'Red' });
    expect((await forms.answerFromMessage({ messageId: stray.messageId })).answers).toEqual([{ label: 'colour', value: 'Red' }]);

    // Outside the window, or a form that is not published: refused.
    const draft = (await post('/whatsapp-forms', { kind: 'enquiry', name: 'Never published' })).body.data;
    expect((await sendForm(chat.conversationId, draft.id)).body.code).toBe('FORM_NOT_PUBLISHED');
    await Conversation.updateOne({ _id: chat.conversationId }, { $set: { lastInboundAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } });
    expect((await sendForm(chat.conversationId, enquiry.id)).body.code).toBe('WINDOW_CLOSED');
  });

  it('turns an order form\'s answers into an order priced from the product', async () => {
    const cumin = (await post('/products', { name: 'Cumin Seeds', unit: 'kg', pricePaise: 25000, gstRatePct: 5, hsnSac: '0909' })).body.data;
    const form = (await post('/whatsapp-forms', { kind: 'order', name: 'Order spices', productIds: [cumin.id], fields: [{ key: 'date', on: true }] })).body.data;
    expect((await post(`/whatsapp-forms/${form.id}/publish`)).body.data.status).toBe('published');
    const dropdown = flowOf(form.id)[0].flowJson.screens[0].layout.children.find((c) => c.name === 'product');
    expect(dropdown).toMatchObject({ type: 'Dropdown', required: true, 'data-source': [{ id: cumin.id, title: 'Cumin Seeds' }] });

    const chat = await write('98290 52222', 'Order karna hai', 'Ravi Traders');
    await sendForm(chat.conversationId, form.id);
    const token = sent[0].interactive.action.parameters.flow_token;
    const reply = await answer('98290 52222', token, { product: cumin.id, quantity: '10', address: '4 Johari Bazar, Jaipur', date: '2026-11-20', note: 'Morning delivery' });
    const result = await forms.answerFromMessage({ messageId: reply.messageId });
    expect(result.answers).toEqual([
      { label: 'Product', value: 'Cumin Seeds' }, { label: 'Quantity', value: '10' }, { label: 'Delivery address', value: '4 Johari Bazar, Jaipur' },
      { label: 'Delivery date', value: '2026-11-20' }, { label: 'Note', value: 'Morning delivery' },
    ]);
    const order = await Order.findById(result.orderId).lean();
    expect(order).toMatchObject({
      source: 'form', stage: 'Received', formOrder: { formName: 'Order spices' },
      totals: { taxablePaise: 250000, grandTotalPaise: 262500 },
      notes: "Delivery address: 4 Johari Bazar, Jaipur\nCustomer's note: Morning delivery",
    });
    expect(String(order.formOrder.messageId)).toBe(String(reply.messageId));
    expect(order.items[0]).toMatchObject({ name: 'Cumin Seeds', quantity: 10 });
    expect(order.dispatch.expectedDeliveryDate.toISOString()).toBe('2026-11-20T00:00:00.000Z'); // the day chosen, as Orders keeps it
    expect(order.history[0]).toMatchObject({ stage: 'Received', byName: 'WhatsApp form' });
    const view = (await get(`/orders/${order._id}`)).body.data;
    expect(view.formOrder).toMatchObject({ formName: 'Order spices', conversationId: String(chat.conversationId) });
    expect(await Notification.findOne({ source: 'forms', link: `Orders.html?id=${order._id}` }).lean()).toBeTruthy();

    // Without a quantity there is no order; the bell says so.
    await sendForm(chat.conversationId, form.id);
    const second = await answer('98290 52222', sent[1].interactive.action.parameters.flow_token, { product: cumin.id, address: 'Jaipur' });
    expect((await forms.answerFromMessage({ messageId: second.messageId })).orderId).toBeNull();
    expect((await Notification.findOne({ source: 'forms', body: /no order was made/ }).lean())).toBeTruthy();

    // Deleted: its Flow is retired; it no longer shows.
    expect((await api().delete(`/api/v1/whatsapp-forms/${form.id}`).set(as(owner))).status).toBe(200);
    expect(flowOf(form.id).map((f) => f.status)).toEqual(['DEPRECATED']);
    expect((await get('/whatsapp-forms')).body.data.items.some((f) => f.id === form.id)).toBe(false);
  });
});
