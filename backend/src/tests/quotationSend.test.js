jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mock = require('../integrations/whatsapp/mock');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Message = require('../models/Message');
const Quotation = require('../models/Quotation');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 5D: a quotation goes into the customer's WhatsApp chat — as a PDF document inside the
// 24-hour window, or in an approved template (a DOCUMENT header carries the PDF) outside it.
describe('Sending a quotation on WhatsApp', () => {
  let owner;
  let templates;
  let contact;
  let lead;
  let quotation;
  let sent;
  let wamids = 0; // WhatsApp message ids are unique
  const auth = () => bearer(owner.token);
  const send = (id, body, token = owner.token) => api().post(`/api/v1/quotations/${id}/send`).set(bearer(token)).send(body);
  const options = (id, token = owner.token) => api().get(`/api/v1/quotations/${id}/send-options`).set(bearer(token));

  beforeAll(async () => {
    owner = await login('send-owner@example.com', { name: 'Asha' });
    await api().patch('/api/v1/organization').set(auth()).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5' });
    await api().post('/api/v1/whatsapp/accounts').set(auth()).send({ provider: 'mock' });
    templates = Object.fromEntries((await api().post('/api/v1/templates/sync').set(auth()).send({})).body.data.map((t) => [t.name, t]));
    const product = (await api().post('/api/v1/products').set(auth()).send({ name: 'Cumin Seeds', unit: 'kg', pricePaise: 25000, gstRatePct: 5 })).body.data;
    contact = (await api().post('/api/v1/contacts').set(auth()).send({ name: 'Ravi Traders', phone: '9829012345', state: 'Rajasthan' })).body.data;
    lead = (await api().post('/api/v1/leads').set(auth()).send({ contactId: contact.id, title: 'Cumin' })).body.data;
    quotation = (await api().post('/api/v1/quotations').set(auth()).send({ leadId: lead.id, items: [{ productId: product.id, quantity: 20 }] })).body.data;
  });
  beforeEach(() => {
    sent = [];
    jest.spyOn(mock, 'sendMessage').mockImplementation(async (credentials, body) => {
      sent.push(body);
      wamids += 1;
      return { providerMessageId: `wamid.QUOTE${wamids}` };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('offers the approved templates of the number, with the values filled in, and a caption', async () => {
    const res = await options(quotation.id);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({ blocked: '', phone: '+919829012345', conversation: null });
    expect(data.caption).toMatch(/^Namaste Ravi Traders, please find our quotation QT\/\d{4}-\d{2}\/0001 for ₹5,250\.00\.\nView online: http:\/\/127\.0\.0\.1:3000\/q\//);
    const pdfTemplate = data.templates.find((t) => t.name === 'quotation_pdf');
    expect(pdfTemplate).toMatchObject({ documentHeader: true, sendable: false });
    expect(pdfTemplate.suggested.body).toEqual({ 1: 'Ravi Traders', 2: quotation.number, 3: '₹5,250.00' });
    expect(data.templates.find((t) => t.name === 'quote_follow_up').suggested).toMatchObject({ header: { product: '' }, body: { customer_name: 'Ravi Traders' } });
    expect(data.templates.map((t) => t.name)).not.toContain('diwali_offer');
  });

  it('outside the 24-hour window: refuses a plain document, sends the PDF in a document template', async () => {
    const closed = await send(quotation.id, { mode: 'document', caption: 'Hi' });
    expect(closed.status).toBe(422);
    expect(closed.body.code).toBe('WINDOW_CLOSED');
    expect(await Conversation.countDocuments({ contactId: contact.id })).toBe(0); // nothing opened for nothing

    const missing = await send(quotation.id, { mode: 'template', templateId: templates.quotation_pdf.id, variables: { body: { 1: 'Ravi' } } });
    expect(missing.status).toBe(400);
    expect(sent).toHaveLength(0);

    const res = await send(quotation.id, {
      mode: 'template', templateId: templates.quotation_pdf.id,
      variables: { body: { 1: 'Ravi Traders', 2: quotation.number, 3: '₹5,250.00' } },
    });
    expect(res.status).toBe(200);
    const { message, conversationId } = res.body.data;
    expect(res.body.data.quotation).toMatchObject({ status: 'Sent', sentVia: 'whatsapp' });
    expect(message).toMatchObject({ type: 'template', status: 'sent', direction: 'out', media: { mimeType: 'application/pdf', hasFile: true } });
    expect(message.media.fileName).toBe(`${quotation.number.replace(/\//g, '-')}.pdf`);
    expect(sent[0]).toMatchObject({
      to: '919829012345', type: 'template',
      template: {
        name: 'quotation_pdf', language: { code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'document', document: { filename: message.media.fileName } }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Ravi Traders' }, { type: 'text', text: quotation.number }, { type: 'text', text: '₹5,250.00' }] },
        ],
      },
    });
    expect(sent[0].template.components[0].parameters[0].document.id).toMatch(/^mock-media-/);

    // The new chat is the sender's; the lead moved to Quote Sent and says how it went out.
    expect(String((await Conversation.findById(conversationId)).assigneeId)).toBeTruthy();
    expect((await Lead.findById(lead.id)).stage).toBe('Quote Sent');
    const texts = (await LeadActivity.find({ leadId: lead.id }).sort({ createdAt: 1 })).map((a) => a.text);
    expect(texts).toEqual(expect.arrayContaining([expect.stringMatching(/ sent on WhatsApp$/), 'New → Quote Sent']));

    // The PDF stays in the chat and opens from the inbox.
    const file = await api().get(`/api/v1/conversations/${conversationId}/messages/${message.id}/media`).set(auth()).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.body.subarray(0, 5).toString()).toBe('%PDF-');

    // The inbox's own template picker still cannot send a PDF template (it has no PDF).
    const fromInbox = await api().post(`/api/v1/conversations/${conversationId}/messages`).set(auth()).send({ type: 'template', templateId: templates.quotation_pdf.id, variables: { body: { 1: 'a', 2: 'b', 3: 'c' } } });
    expect(fromInbox.status).toBe(422);
  });

  it('inside the window: sends the PDF as a document with the caption; a resend keeps the status', async () => {
    await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(auth()).send({ from: '9829012345', name: 'Ravi Traders', text: 'Please send again' });
    const opts = (await options(quotation.id)).body.data;
    expect(opts.conversation).toMatchObject({ windowOpen: true });
    const res = await send(quotation.id, { mode: 'document', caption: 'Here is the quotation again' });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatchObject({ type: 'document', text: 'Here is the quotation again', media: { mimeType: 'application/pdf' } });
    expect(sent[0]).toMatchObject({ type: 'document', document: { caption: 'Here is the quotation again', filename: `${quotation.number.replace(/\//g, '-')}.pdf` } });
    expect(res.body.data.quotation.status).toBe('Sent');
    expect(await LeadActivity.exists({ leadId: lead.id, text: /sent again on WhatsApp$/ })).toBeTruthy();
    expect(await Message.countDocuments({ contactId: contact.id, 'media.mimeType': 'application/pdf' })).toBe(2);
  });

  it('says why it cannot go: no mobile number, a rejected quotation, a teammate\'s chat, no inbox access', async () => {
    const noPhone = (await api().post('/api/v1/contacts').set(auth()).send({ name: 'Mail Only', email: 'mail@example.com' })).body.data;
    const q2 = (await api().post('/api/v1/quotations').set(auth()).send({ contactId: noPhone.id, items: [{ name: 'Service', quantity: 1, unitPricePaise: 10000 }] })).body.data;
    expect((await options(q2.id)).body.data.blocked).toMatch(/no mobile number/);
    expect((await send(q2.id, { mode: 'template', templateId: templates.hello_world.id })).body.code).toBe('NO_PHONE');

    const q3 = (await api().post('/api/v1/quotations').set(auth()).send({ contactId: contact.id, items: [{ name: 'Service', quantity: 1, unitPricePaise: 10000 }] })).body.data;
    await api().patch(`/api/v1/quotations/${q3.id}`).set(auth()).send({ status: 'Rejected' });
    expect((await send(q3.id, { mode: 'template', templateId: templates.hello_world.id })).body.code).toBe('REVISE_FIRST');

    // An agent with Leads but not the Inbox cannot send; one with both cannot take a teammate's chat.
    const leadsOnly = await inviteAndJoin(owner.token, 'send-leads@example.com', { role: 'agent', modules: ['leads'] });
    const both = await inviteAndJoin(owner.token, 'send-both@example.com', { role: 'agent', modules: ['leads', 'inbox'], permissions: ['leads:view_all'] });
    expect((await options(quotation.id, leadsOnly.token)).status).toBe(403);
    const blocked = await options(quotation.id, both.token);
    expect(blocked.body.data.blocked).toMatch(/is handling this customer's WhatsApp chat/);
    expect((await send(quotation.id, { mode: 'template', templateId: templates.hello_world.id }, both.token)).body.code).toBe('CHAT_ASSIGNED');
    expect(sent).toHaveLength(0);
  });

  it('a refused message leaves the quotation as it was and says why', async () => {
    const product = (await api().post('/api/v1/products').set(auth()).send({ name: 'Fennel', pricePaise: 10000 })).body.data;
    const draft = (await api().post('/api/v1/quotations').set(auth()).send({ contactId: contact.id, items: [{ productId: product.id, quantity: 1 }] })).body.data;
    mock.sendMessage.mockImplementation(async () => {
      const error = new Error('Re-engagement message');
      error.providerCode = 131047;
      throw error;
    });
    const res = await send(draft.id, { mode: 'template', templateId: templates.hello_world.id });
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/Re-engagement message/);
    expect((await Quotation.findById(draft.id)).status).toBe('Draft');
  });
});
