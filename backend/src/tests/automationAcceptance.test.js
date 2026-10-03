jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const http = require('http');
const { io: connect } = require('socket.io-client');
const app = require('../app');
const jobs = require('../jobs');
const AutomationRun = require('../models/AutomationRun');
const Conversation = require('../models/Conversation');
const Job = require('../models/Job');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const Task = require('../models/Task');
const inbound = require('../services/whatsappInboundService');
const { attachRealtime } = require('../realtime/socket');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 6 acceptance: an IndiaMART lead is given to a salesperson and followed up by a sequence
// until the customer replies; a new WhatsApp customer is served by the FAQ bot until they ask
// for a person; a quiet customer gets a reminder task — through the real code: the job worker,
// the automation engine, sequences, the bot, the Cloud API sender (Meta replaced by a fake
// fetch), signed webhooks and the live bell, with another company seeing none of it.
const APP_SECRET = 'p6-app-secret-0123456789';
const PHONE_NUMBER_ID = '5550006666';
const WABA_ID = '4440006666';
const RAVI = '919829044001';
const MEENA = '919829044002';
const HOUR = 60 * 60 * 1000;
const TEMPLATES = [
  { id: '9301', name: 'enquiry_welcome', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Namaste {{1}}, thank you for your enquiry about {{2}}. We will call you soon.' }] },
  { id: '9302', name: 'follow_up', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Namaste {{1}}, did you get our {{2}} rates? Reply here with any question.' }] },
];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sign = (raw) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// Waits for the worker (which polls every 200 ms) to get somewhere.
async function until(check, what, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('Phase 6 acceptance: workflows, sequences and the FAQ bot working together', () => {
  let server;
  let io;
  let url;
  const sockets = [];
  const graph = []; // what the CRM sent to Meta

  beforeAll(async () => {
    server = http.createServer(app);
    io = attachRealtime(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    const realFetch = global.fetch;
    jest.spyOn(global, 'fetch').mockImplementation(async (target, options = {}) => {
      const u = String(target);
      if (u.startsWith(url)) return realFetch(target, options);
      if (u.includes('/message_templates')) return json({ data: TEMPLATES });
      if (u.endsWith(`/${PHONE_NUMBER_ID}/messages`) && options.method === 'POST') {
        graph.push(JSON.parse(options.body));
        return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.P6OUT${graph.length}` }] });
      }
      return json({ display_phone_number: '+91 90000 66666', verified_name: 'Yellow Traders', quality_rating: 'GREEN' });
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
  // Every event of a kind a socket receives, for checking afterwards.
  const record = (socket, event) => {
    const seen = [];
    socket.on(event, (payload) => seen.push(payload));
    return seen;
  };
  const sentTo = (to) => graph.filter((body) => body.to === to);

  it('works from an IndiaMART lead to a bot hand-off and a reminder, for the right people only', async () => {
    // --- 1. Set-up, as on the Settings and Sales Automation screens -------------------------
    const owner = await login('p6-owner@example.com', { name: 'Asha' });
    const arun = await inviteAndJoin(owner.token, 'p6-arun@example.com', { role: 'agent', displayName: 'Arun', modules: ['leads', 'deals', 'inbox', 'tasks'] });
    const stranger = await login('p6-stranger@example.com');
    const as = (user) => bearer(user.token);
    const members = (await api().get('/api/v1/members').set(as(owner))).body.data;
    const id = (email) => members.find((m) => m.email === email).id;
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Yellow Traders' });
    // Open all day, so the result does not depend on the clock.
    expect((await api().put('/api/v1/organization/business-hours').set(as(owner)).send({ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' })).status).toBe(200);
    const account = (await api().post('/api/v1/whatsapp/accounts').set(as(owner)).send({ name: 'Sales', phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: 'EAAG-p6-token-7788', appSecret: APP_SECRET })).body.data;
    const templates = Object.fromEntries((await api().post('/api/v1/templates/sync').set(as(owner)).send({})).body.data.map((t) => [t.name, t]));

    const created = async (path, body) => {
      const res = await api().post(`/api/v1${path}`).set(as(owner)).send(body);
      if (res.status !== 201) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.data;
    };
    const followUp = await created('/sequences', {
      name: 'IndiaMART follow-up',
      steps: [
        { day: 0, type: 'whatsapp.template', params: { templateId: templates.enquiry_welcome.id, variables: { body: { 1: 'contact.name', 2: 'lead.product' } } } },
        { day: 2, type: 'whatsapp.template', params: { templateId: templates.follow_up.id, variables: { body: { 1: 'contact.name', 2: 'lead.product' } } } },
        { day: 3, type: 'task.create', params: { title: 'Call {{contact.name}} about {{lead.title}}', dueInDays: 0 } },
      ],
    });
    const newLead = await created('/workflows', {
      name: 'New IndiaMART lead', trigger: { type: 'lead.created', params: { sources: ['IndiaMART'] } }, conditions: [{ field: 'owner', op: 'none' }],
      steps: [
        { type: 'assign', params: { memberId: id('p6-arun@example.com') } },
        { type: 'sequence.enroll', params: { sequenceId: followUp.id } },
        { type: 'agent.notify', params: { to: 'owner', message: 'New IndiaMART lead: {{contact.name}} ({{lead.title}})' } },
      ],
    });
    const quiet = await created('/workflows', {
      name: 'Quiet customer', trigger: { type: 'lead.no_reply', params: { hours: 24 } },
      steps: [{ type: 'task.create', params: { title: 'Call {{contact.name}}: no reply for a day', dueInDays: 0 } }],
    });
    const price = await created('/faq-rules', { name: 'Price list', priority: 10, keywords: ['price', 'rate', 'दाम'], answer: { text: 'Namaste {{contact.name}}! Cumin ₹250/kg, Fennel ₹180/kg.' } });
    const delivery = await created('/faq-rules', { name: 'Delivery', keywords: ['delivery'], answer: { text: 'We deliver across Rajasthan in 2 days.' } });
    const address = await created('/faq-rules', { name: 'Address', keywords: ['address'], answer: { text: '12 MI Road, Jaipur.' } });
    expect((await api().put('/api/v1/bot/settings').set(as(owner)).send({
      enabled: true,
      greeting: {
        enabled: true,
        answer: {
          text: 'Welcome to {{org.name}}, {{contact.name}}! What do you need?', listButton: 'Choose',
          options: [
            { title: 'Price list', action: 'rule', ruleId: price.id }, { title: 'Delivery', action: 'rule', ruleId: delivery.id },
            { title: 'Our address', action: 'rule', ruleId: address.id }, { title: 'Talk to a person', description: 'Someone from our team', action: 'handoff' },
          ],
        },
      },
    })).status).toBe(200);

    // The team has the inbox open; the worker runs as on the server.
    const [ownerSocket, arunSocket, strangerSocket] = await Promise.all([owner, arun, stranger].map((user) => open(user.token)));
    const ownerBell = record(ownerSocket, 'notification:new');
    const arunBell = record(arunSocket, 'notification:new');
    const strangerHears = [...['notification:new', 'message:new', 'conversation:updated'].map((event) => record(strangerSocket, event))];
    jobs.start({ pollMs: 200 });

    // --- 2. An IndiaMART enquiry: the workflow gives it to Arun, starts the follow-up, rings him
    const enquiry = await api().post('/api/v1/dev/simulate/lead').set(as(owner)).send({ source: 'IndiaMART', name: 'Ravi Traders', phone: '98290 44001', product: 'Cumin Seeds' });
    expect(enquiry.status).toBe(201);
    const raviLead = enquiry.body.data.leadId;
    const run = await until(() => AutomationRun.findOne({ workflowId: newLead.id, status: 'done' }), 'the new-lead workflow');
    expect(run.steps.map((s) => [s.type, s.status])).toEqual([['assign', 'done'], ['sequence.enroll', 'done'], ['agent.notify', 'done']]);
    expect(String((await Lead.findById(raviLead)).ownerId)).toBe(id('p6-arun@example.com'));
    await until(() => arunBell.length, 'Arun\'s bell');
    expect(arunBell[0]).toMatchObject({ title: 'New IndiaMART lead: Ravi Traders (Cumin Seeds)', link: expect.stringMatching(/^customer-360\.html\?id=/) });
    // Day 0: the welcome template, in a chat that is Arun's.
    await until(() => sentTo(RAVI).length, 'the day-0 template');
    expect(sentTo(RAVI)[0]).toMatchObject({ type: 'template', template: { name: 'enquiry_welcome', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi Traders' }, { type: 'text', text: 'Cumin Seeds' }] }] } });
    const raviChat = await Conversation.findOne({ whatsappAccountId: account.id, contactId: enquiry.body.data.contactId });
    expect(String(raviChat.assigneeId)).toBe(id('p6-arun@example.com'));

    // Two days later: the follow-up template (once day 2 is scheduled, about two days ahead).
    const scheduled = await until(async () => {
      const found = await SequenceEnrollment.findOne({ sequenceId: followUp.id, stepIndex: 1, status: 'active' });
      return found && (await Job.exists({ name: 'sequence.step', status: 'queued', 'data.enrollmentId': String(found._id) })) && found;
    }, 'day 2 to be scheduled');
    expect(scheduled.nextAt.getTime() - scheduled.enrolledAt.getTime()).toBeGreaterThanOrEqual(2 * 24 * HOUR - 1000);
    await Job.updateMany({ name: 'sequence.step', status: 'queued' }, { $set: { runAt: new Date() } });
    await until(() => sentTo(RAVI).length >= 2, 'the day-2 template');
    expect(sentTo(RAVI)[1].template).toMatchObject({ name: 'follow_up' });

    // --- 3. Ravi replies on WhatsApp: the follow-up stops; the bot stays out of Arun's chat ----
    const webhook = async (from, name, message) => {
      const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_NUMBER_ID }, contacts: [{ profile: { name }, wa_id: from }], messages: [{ from, id: `wamid.P6IN${crypto.randomBytes(6).toString('hex')}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }] });
      expect((await api().post(account.webhookPath).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw)).status).toBe(200);
      await inbound.idle();
    };
    await webhook(RAVI, 'Ravi Traders', { type: 'text', text: { body: 'Ji, rate bhejiye 50 kg ka' } });
    const enrollment = await until(async () => {
      const found = await SequenceEnrollment.findOne({ sequenceId: followUp.id, contactId: enquiry.body.data.contactId });
      return found?.status === 'stopped' && found;
    }, 'the sequence to stop');
    expect(enrollment).toMatchObject({ stopReason: 'The customer replied on WhatsApp.', stepIndex: 2 });
    await Job.updateMany({ name: 'sequence.step', status: 'queued' }, { $set: { runAt: new Date() } });
    await sleep(1500); // time for a (wrong) day-3 task or bot answer
    expect(await Task.exists({ title: 'Call Ravi Traders about Cumin Seeds' })).toBeFalsy();
    expect(sentTo(RAVI)).toHaveLength(2); // "rate" is a bot keyword, but Arun has this chat (D33)

    // --- 4. A new customer writes on WhatsApp: the bot greets with a list, answers, hands over --
    await webhook(MEENA, 'Meena', { type: 'text', text: { body: 'Hi' } });
    await until(() => sentTo(MEENA).length, 'the greeting');
    expect(sentTo(MEENA)[0]).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'list', body: { text: 'Welcome to Yellow Traders, Meena! What do you need?' },
        action: { button: 'Choose', sections: [{ rows: [{ id: `bot:rule:${price.id}`, title: 'Price list' }, { title: 'Delivery' }, { title: 'Our address' }, { id: 'bot:handoff', title: 'Talk to a person', description: 'Someone from our team' }] }] },
      },
    });
    await webhook(MEENA, 'Meena', { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: `bot:rule:${price.id}`, title: 'Price list' } } });
    await until(() => sentTo(MEENA).length >= 2, 'the price answer');
    expect(sentTo(MEENA)[1]).toMatchObject({ type: 'text', text: { body: 'Namaste Meena! Cumin ₹250/kg, Fennel ₹180/kg.' } });
    await webhook(MEENA, 'Meena', { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'bot:handoff', title: 'Talk to a person' } } });
    await until(() => ownerBell.some((n) => n.title === 'Meena wants to talk to a person'), 'the hand-off bell');
    const meenaChat = await Conversation.findOne({ whatsappAccountId: account.id, contactId: (await Message.findOne({ 'reply.id': 'bot:handoff' })).contactId });
    expect(meenaChat.bot.handoffReason).toBe('The customer tapped the button to talk to a person.');
    expect(sentTo(MEENA)[2]).toMatchObject({ type: 'text', text: { body: 'Sure! Someone from our team will reply here soon.' } });
    await webhook(MEENA, 'Meena', { type: 'text', text: { body: 'delivery kab tak?' } });
    await sleep(1000);
    expect(sentTo(MEENA)).toHaveLength(3); // the bot waits for a person
    // Arun answers; the chat is his (and so is Meena's lead).
    expect((await api().post(`/api/v1/conversations/${meenaChat._id}/messages`).set(as(arun)).send({ text: 'Namaste Meena ji, kal tak delivery ho jayegi.' })).status).toBe(201);
    const meenaLead = await Lead.findOne({ contactId: meenaChat.contactId });
    expect(String(meenaLead.ownerId)).toBe(id('p6-arun@example.com'));
    expect(await Message.countDocuments({ conversationId: meenaChat._id, 'automation.kind': 'bot' })).toBe(3);

    // --- 5. A day without a reply: the scan finds Meena's chat and Arun gets a task ------------
    await Conversation.updateOne({ _id: meenaChat._id }, { $set: { lastMessageAt: new Date(Date.now() - 25 * HOUR) } });
    await Job.updateMany({ name: 'automation.scan', status: 'queued' }, { $set: { runAt: new Date() } });
    const reminder = await until(() => Task.findOne({ title: 'Call Meena: no reply for a day' }), 'the reminder task');
    expect(String(reminder.assigneeId)).toBe(id('p6-arun@example.com'));
    expect(reminder).toMatchObject({ origin: 'automation', relatedType: 'Lead' });
    expect(await AutomationRun.countDocuments({ workflowId: quiet.id })).toBe(1);

    // --- 6. The record of it all, and nothing for another company ------------------------------
    const log = (await api().get(`/api/v1/automation-runs?leadId=${raviLead}`).set(as(owner))).body.data;
    expect(log.map((r) => [r.workflowName, r.status])).toEqual([['New IndiaMART lead', 'done']]);
    const people = (await api().get(`/api/v1/sequences/${followUp.id}/enrollments`).set(as(owner))).body.data;
    expect(people).toMatchObject([{ label: 'Ravi Traders', status: 'stopped', enrolledBy: { kind: 'workflow', name: 'Automation "New IndiaMART lead"' }, steps: [{ day: 0, status: 'done' }, { day: 2, status: 'done' }] }]);
    const backup = await api().get('/api/v1/exports/crm').set(as(owner));
    expect(backup.body.workflows.map((w) => w.name).sort()).toEqual(['New IndiaMART lead', 'Quiet customer']);
    expect(backup.body.sequences.map((s) => s.name)).toEqual(['IndiaMART follow-up']);
    expect(JSON.stringify(backup.body)).not.toContain('webhookSecret');

    for (const path of ['/workflows', '/sequences', '/automation-runs', '/sequence-enrollments', '/faq-rules']) {
      const res = await api().get(`/api/v1${path}`).set(as(stranger));
      expect({ path, data: res.body.data }).toEqual({ path, data: [] });
    }
    expect((await api().get(`/api/v1/automation-runs/${run._id}`).set(as(stranger))).status).toBe(404);
    expect((await api().get('/api/v1/notifications').set(as(stranger))).body.data).toEqual({ items: [], unread: 0 });
    expect(strangerHears.every((events) => events.length === 0)).toBe(true);
  }, 180000);
});
