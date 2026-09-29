jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const http = require('http');
const { io: connect } = require('socket.io-client');
const app = require('../app');
const jobs = require('../jobs');
const AssignmentHistory = require('../models/AssignmentHistory');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Message = require('../models/Message');
const { attachRealtime } = require('../realtime/socket');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 4 acceptance: an IndiaMART enquiry reaches the right salesperson's inbox, answered by
// the WhatsApp auto-reply, within 60 seconds — through the real code: the IndiaMART pull and
// push, the job worker, the assignment and auto-reply rules, the Cloud API sender (IndiaMART's
// and Meta's servers replaced by a fake fetch) and the live inbox updates.
const IM_KEY = 'MTc5MDY3NTQzMjY1MS1hY2NlcHRhbmNl';
const PHONE_NUMBER_ID = '5550004444';
const WABA_ID = '4440004444';
const WELCOME = 'Namaste {{1}}, thank you for your enquiry about {{2}}. {{3}} from {{4}} will call you shortly.';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// IndiaMART writes times in India time, "YYYY-MM-DD HH:MM:SS".
const istNow = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
const enquiry = (id, extra = {}) => ({
  UNIQUE_QUERY_ID: id, QUERY_TYPE: 'W', QUERY_TIME: istNow(), SENDER_NAME: 'Ravi Traders', SENDER_MOBILE: '+91-9829044001',
  SENDER_CITY: 'Jaipur', SENDER_STATE: 'Rajasthan', SENDER_COUNTRY_ISO: 'IN', QUERY_PRODUCT_NAME: 'Cumin Seeds', QUERY_MESSAGE: 'Need 50 kg every month', ...extra,
});

describe('Phase 4 acceptance: an IndiaMART lead, assigned and answered within 60 seconds', () => {
  let server;
  let io;
  let url;
  const sockets = [];
  const sent = []; // what the CRM sent to Meta
  let pullReply = () => ({ CODE: 200, STATUS: 'SUCCESS', TOTAL_RECORDS: 0, RESPONSE: [] });

  beforeAll(async () => {
    server = http.createServer(app);
    io = attachRealtime(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    const realFetch = global.fetch;
    jest.spyOn(global, 'fetch').mockImplementation(async (target, options = {}) => {
      const u = String(target);
      if (u.startsWith(url)) return realFetch(target, options);
      if (u.startsWith('https://mapi.indiamart.com/')) return json(pullReply());
      if (u.includes('/message_templates')) {
        return json({ data: [{ id: '9101', name: 'enquiry_welcome', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: WELCOME }] }] });
      }
      if (u.endsWith('/messages') && options.method === 'POST') {
        sent.push(JSON.parse(options.body));
        return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.AUTO${sent.length}` }] });
      }
      return json({ display_phone_number: '+91 90000 44444', verified_name: 'Yellow Traders', quality_rating: 'GREEN' });
    });
  });
  afterAll(async () => {
    await jobs.stop();
    jest.restoreAllMocks();
    sockets.forEach((socket) => socket.close());
    io.detach();
    await new Promise((resolve) => io.close(resolve));
  });

  const open = (token) => new Promise((resolve, reject) => {
    const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
  // Resolves with the first matching event, or null after `ms`.
  const next = (socket, event, match, ms) => new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
    function handler(payload) {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
  const autoReplyTo = (name) => (p) => p.message.automation?.kind === 'auto-reply' && p.conversation.contact?.name === name;
  const texts = async (leadId, type) => (await LeadActivity.find({ leadId, type }).sort({ createdAt: 1 })).map((a) => a.text);

  it('works from connecting the sources to a repeat enquiry', async () => {
    const owner = await login('p4-owner@example.com', { name: 'Asha' });
    const arun = await inviteAndJoin(owner.token, 'p4-arun@example.com', { role: 'agent', displayName: 'Arun' });
    const bela = await inviteAndJoin(owner.token, 'p4-bela@example.com', { role: 'agent', displayName: 'Bela' });
    const stranger = await login('p4-stranger@example.com');
    const members = (await api().get('/api/v1/members').set(bearer(owner.token))).body.data;
    const id = (email) => members.find((m) => m.email === email).id;
    const as = (user) => bearer(user.token);

    // 1. Set-up, as on the Settings screens: WhatsApp number and template, working hours (open
    //    all day, so the result does not depend on the clock), one assignment rule, one auto-reply.
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Yellow Traders' });
    const account = await api().post('/api/v1/whatsapp/accounts').set(as(owner))
      .send({ name: 'Sales', phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: 'EAAG-p4-token-5566', appSecret: 'p4-app-secret-0123456789' });
    expect(account.body.data.status).toBe('connected');
    const [template] = (await api().post('/api/v1/templates/sync').set(as(owner)).send({})).body.data;
    expect(template).toMatchObject({ name: 'enquiry_welcome', sendable: true });
    expect((await api().put('/api/v1/organization/business-hours').set(as(owner)).send({ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' })).status).toBe(200);
    expect((await api().post('/api/v1/assignment-rules').set(as(owner)).send({
      name: 'IndiaMART Rajasthan', conditions: { sources: ['IndiaMART'], states: ['Rajasthan'] }, strategy: 'round_robin',
      memberIds: [id('p4-arun@example.com'), id('p4-bela@example.com')], respectWorkingHours: true, fallbackMemberId: id('p4-owner@example.com'),
    })).status).toBe(201);
    expect((await api().post('/api/v1/auto-reply-rules').set(as(owner)).send({
      name: 'IndiaMART welcome', sources: ['IndiaMART'], templateId: template.id,
      variables: { body: { 1: 'contact.name', 2: 'lead.product', 3: 'owner.name', 4: 'org.name' } },
    })).status).toBe(201);

    // 2. The team has the inbox open; the worker runs as on the server.
    const [ownerSocket, arunSocket, belaSocket, strangerSocket] = await Promise.all([owner, arun, bela, stranger].map((user) => open(user.token)));
    jobs.start({ pollMs: 200 });

    // 3. Connecting IndiaMART pulls the last 24 hours at once: one waiting enquiry goes to Arun
    //    (first turn) and is answered in his chat.
    pullReply = () => ({ CODE: 200, STATUS: 'SUCCESS', TOTAL_RECORDS: 1, RESPONSE: [enquiry('P4-PULL-1', { SENDER_NAME: 'Meena Stores', SENDER_MOBILE: '+91-9829044002', QUERY_PRODUCT_NAME: 'Fennel' })] });
    const arunHears = next(arunSocket, 'message:new', autoReplyTo('Meena Stores'), 60000);
    let started = Date.now();
    const source = (await api().post('/api/v1/lead-sources').set(as(owner)).send({ type: 'indiamart', name: 'IndiaMART', apiKey: IM_KEY })).body.data;
    const pulled = await arunHears;
    expect(pulled).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(60000);
    expect(pulled.conversation.assigneeId).toBe(id('p4-arun@example.com'));
    expect(pulled.message).toMatchObject({ type: 'template', text: 'Namaste Meena Stores, thank you for your enquiry about Fennel. Arun from Yellow Traders will call you shortly.' });

    // 4. The acceptance itself: IndiaMART pushes a new enquiry. Within 60 seconds it is a lead
    //    owned by Bela (next turn), and her inbox shows the chat with the auto-reply, live.
    const belaHears = next(belaSocket, 'message:new', autoReplyTo('Ravi Traders'), 60000);
    const ownerHears = next(ownerSocket, 'message:new', autoReplyTo('Ravi Traders'), 60000);
    // (Nothing may reach Arun or the other company; they are checked once the rest is done.)
    const arunOverhears = next(arunSocket, 'message:new', autoReplyTo('Ravi Traders'), 8000);
    const strangerOverhears = next(strangerSocket, 'message:new', () => true, 8000);
    started = Date.now();
    const push = (body) => api().post(new URL(source.pushUrl).pathname).set('Content-Type', 'application/json').send(JSON.stringify(body));
    expect((await push({ CODE: 200, STATUS: 'SUCCESS', RESPONSE: enquiry('P4-PUSH-1') })).status).toBe(200);
    const live = await belaHears;
    const elapsed = Date.now() - started;
    expect(live).toBeTruthy();
    expect(elapsed).toBeLessThan(60000);
    expect(await ownerHears).toBeTruthy(); // the owner sees all chats

    const lead = await Lead.findOne({ sourceRef: 'P4-PUSH-1' });
    expect(lead).toMatchObject({ source: 'IndiaMART', title: 'Cumin Seeds', stage: 'New' });
    expect(String(lead.ownerId)).toBe(id('p4-bela@example.com'));
    expect(String((await Contact.findById(lead.contactId)).ownerId)).toBe(id('p4-bela@example.com'));
    expect(live.conversation.assigneeId).toBe(id('p4-bela@example.com'));
    expect(live.message).toMatchObject({
      direction: 'out', type: 'template', status: 'sent',
      text: 'Namaste Ravi Traders, thank you for your enquiry about Cumin Seeds. Bela from Yellow Traders will call you shortly.',
    });

    // What Meta received: the approved template with the four values, to the customer's number.
    expect(sent.at(-1)).toMatchObject({
      messaging_product: 'whatsapp', to: '919829044001', type: 'template',
      template: { name: 'enquiry_welcome', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi Traders' }, { type: 'text', text: 'Cumin Seeds' }, { type: 'text', text: 'Bela' }, { type: 'text', text: 'Yellow Traders' }] }] },
    });

    // Bela's inbox lists the chat (auto-reply last); the lead's timeline says who and why.
    const belaInbox = (await api().get('/api/v1/conversations').set(as(bela))).body.data;
    const chat = belaInbox.find((c) => c.id === live.conversation.id);
    expect(chat).toBeTruthy();
    const messages = (await api().get(`/api/v1/conversations/${chat.id}/messages`).set(as(bela))).body.data;
    expect(messages.at(-1)).toMatchObject({ automation: { kind: 'auto-reply' }, text: live.message.text });
    const timeline = (await api().get(`/api/v1/leads/${lead._id}/activities`).set(as(bela))).body.data.map((a) => [a.type, a.text]);
    expect(timeline).toEqual(expect.arrayContaining([
      ['Assigned', 'Assigned to Bela by rule "IndiaMART Rajasthan" (round-robin)'],
      ['Auto-reply', 'Sent WhatsApp template "enquiry_welcome".'],
    ]));
    const history = (await api().get(`/api/v1/assignment-rules/history?leadId=${lead._id}`).set(as(bela))).body.data;
    expect(history).toEqual([expect.objectContaining({ toMemberId: id('p4-bela@example.com'), reason: 'rule "IndiaMART Rajasthan" (round-robin)' })]);

    // Arun sees neither Bela's chat nor its messages; another company hears nothing at all.
    expect((await api().get('/api/v1/conversations').set(as(arun))).body.data.map((c) => c.id)).not.toContain(chat.id);
    expect((await api().get('/api/v1/leads').set(as(stranger))).body.data).toHaveLength(0);

    // 5. The same buyer asks again the next day (a new IndiaMART id): it joins Bela's open lead
    //    (D26), with no second greeting and no new owner.
    const before = sent.length;
    expect((await push({ CODE: 200, STATUS: 'SUCCESS', RESPONSE: enquiry('P4-PUSH-2', { QUERY_PRODUCT_NAME: 'Ajwain', QUERY_MESSAGE: 'Also ajwain rate?' }) })).status).toBe(200);
    const deadline = Date.now() + 10000;
    let enquiries = [];
    while (!enquiries.length && Date.now() < deadline) {
      enquiries = await texts(lead._id, 'Enquiry');
      if (!enquiries.length) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000)); // time for a (wrong) second auto-reply
    expect(enquiries).toHaveLength(1);
    expect(await Lead.countDocuments({ contactId: lead.contactId })).toBe(1);
    expect(String((await Lead.findById(lead._id)).ownerId)).toBe(id('p4-bela@example.com'));
    expect(sent.length).toBe(before);
    expect(await Message.countDocuments({ contactId: lead.contactId, 'automation.kind': 'auto-reply' })).toBe(1);
    expect(await AssignmentHistory.countDocuments({ entityId: lead._id })).toBe(1);

    expect(await arunOverhears).toBeNull();
    expect(await strangerOverhears).toBeNull();
    expect(await Conversation.countDocuments({ contactId: lead.contactId })).toBe(1);
  }, 180000);
});
