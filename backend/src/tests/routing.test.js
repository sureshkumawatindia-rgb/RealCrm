jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Message = require('../models/Message');
const OrganizationMember = require('../models/OrganizationMember');
const queue = require('../jobs/queue');
const leadRouting = require('../services/leadRoutingService');
const leadIntake = require('../services/leadIntakeService');
const { isOpen, DEFAULT_BUSINESS_HOURS } = require('../utils/businessHours');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const lead = (token, body) => api().post('/api/v1/dev/simulate/lead').set(bearer(token)).send(body);
const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;
const activities = async (leadId, type) => (await LeadActivity.find({ leadId, type }).sort({ createdAt: 1 })).map((a) => a.text);

beforeAll(() => leadRouting.attach(queue));
afterAll(() => queue.stop());

describe('Working hours', () => {
  it('knows when the organization is open (India time by default)', () => {
    const hours = { ...DEFAULT_BUSINESS_HOURS };
    expect(isOpen(hours, new Date('2026-09-29T05:00:00Z'))).toBe(true); // Tue 10:30 IST
    expect(isOpen(hours, new Date('2026-09-29T04:00:00Z'))).toBe(false); // Tue 09:30 IST
    expect(isOpen(hours, new Date('2026-09-29T13:45:00Z'))).toBe(false); // Tue 19:15 IST
    expect(isOpen(hours, new Date('2026-09-27T05:00:00Z'))).toBe(false); // Sunday
    expect(isOpen({ ...hours, timezone: 'Asia/Dubai' }, new Date('2026-09-29T06:10:00Z'))).toBe(true); // 10:10 in Dubai
  });

  it('owners and admins set them; everyone can read them', async () => {
    const owner = await login('hours-owner@example.com');
    const agent = await inviteAndJoin(owner.token, 'hours-agent@example.com', { role: 'agent' });
    const initial = await api().get('/api/v1/organization/business-hours').set(bearer(agent.token));
    expect(initial.body.data).toMatchObject({ timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '19:00' });
    expect(typeof initial.body.data.openNow).toBe('boolean');
    expect((await api().put('/api/v1/organization/business-hours').set(bearer(agent.token)).send({ days: [1], start: '09:00', end: '18:00' })).status).toBe(403);
    const saved = await api().put('/api/v1/organization/business-hours').set(bearer(owner.token)).send({ days: [1, 2, 3, 4, 5], start: '09:30', end: '18:30' });
    expect(saved.body.data).toMatchObject({ days: [1, 2, 3, 4, 5], start: '09:30', end: '18:30', timezone: 'Asia/Kolkata' });
    expect((await api().put('/api/v1/organization/business-hours').set(bearer(owner.token)).send({ days: [1], start: '18:00', end: '09:00' })).status).toBe(400);
    expect((await api().put('/api/v1/organization/business-hours').set(bearer(owner.token)).send({ days: [1], start: '09:00', end: '18:00', timezone: 'Mars/Base' })).status).toBe(400);
  });
});

describe('Assignment rules', () => {
  let owner;
  let a;
  let b;
  let c;
  let ids;
  beforeAll(async () => {
    owner = await login('assign-owner@example.com');
    a = await inviteAndJoin(owner.token, 'assign-a@example.com', { role: 'agent', displayName: 'Arun' });
    b = await inviteAndJoin(owner.token, 'assign-b@example.com', { role: 'agent', displayName: 'Bela' });
    c = await inviteAndJoin(owner.token, 'assign-c@example.com', { role: 'agent', displayName: 'Chetan' });
    ids = {
      a: await memberId(owner.token, 'assign-a@example.com'),
      b: await memberId(owner.token, 'assign-b@example.com'),
      c: await memberId(owner.token, 'assign-c@example.com'),
    };
  });

  it('only owners and admins manage rules; the team must be real', async () => {
    expect((await api().post('/api/v1/assignment-rules').set(bearer(a.token)).send({ memberIds: [ids.a] })).status).toBe(403);
    const stranger = await login('assign-stranger@example.com');
    const strangerId = (await api().get('/api/v1/members').set(bearer(stranger.token))).body.data[0].id;
    const foreign = await api().post('/api/v1/assignment-rules').set(bearer(owner.token)).send({ memberIds: [strangerId] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.errors[0].code).toBe('INVALID_MEMBER');
  });

  it('round-robins IndiaMART leads from Rajasthan, sends website leads to one person, and leaves the rest', async () => {
    await api().post('/api/v1/assignment-rules').set(bearer(owner.token))
      .send({ name: 'IndiaMART Rajasthan', priority: 1, conditions: { sources: ['IndiaMART'], states: ['rajasthan'] }, strategy: 'round_robin', memberIds: [ids.a, ids.b] });
    await api().post('/api/v1/assignment-rules').set(bearer(owner.token))
      .send({ name: 'Website', priority: 2, conditions: { sources: ['Website'] }, strategy: 'specific', memberIds: [ids.c] });

    const created = [];
    for (const [i, phone] of ['98290 00001', '98290 00002', '98290 00003'].entries()) {
      created.push((await lead(owner.token, { source: 'IndiaMART', name: `Buyer ${i}`, phone, state: 'Rajasthan' })).body.data);
    }
    const web = (await lead(owner.token, { source: 'Website', name: 'Web buyer', phone: '98290 00004' })).body.data;
    const gujarat = (await lead(owner.token, { source: 'IndiaMART', name: 'Far buyer', phone: '98290 00005', state: 'Gujarat' })).body.data;
    await queue.runDue();

    const ownerOf = async (id) => String((await Lead.findById(id)).ownerId || '');
    expect(await Promise.all(created.map((l) => ownerOf(l.leadId)))).toEqual([ids.a, ids.b, ids.a]);
    expect(await ownerOf(web.leadId)).toBe(ids.c);
    expect(await ownerOf(gujarat.leadId)).toBe('');
    expect(String((await Contact.findById(created[0].contactId)).ownerId)).toBe(ids.a);
    expect(await activities(created[1].leadId, 'Assigned')).toEqual(['Assigned to Bela by rule "IndiaMART Rajasthan" (round-robin)']);

    const history = await api().get(`/api/v1/assignment-rules/history?leadId=${gujarat.leadId}`).set(bearer(owner.token));
    expect(history.body.data[0]).toMatchObject({ toMemberId: null, reason: 'No assignment rule matched' });
    // The agent now sees the lead given to them.
    expect((await api().get('/api/v1/leads').set(bearer(b.token))).body.data.map((l) => l.id)).toEqual([created[1].leadId]);
    const rules = (await api().get('/api/v1/assignment-rules').set(bearer(owner.token))).body.data;
    expect(rules.map((r) => [r.name, r.stats.assigned])).toEqual([['IndiaMART Rajasthan', 3], ['Website', 1]]);
  });

  it('skips people who were disabled, and gives an existing WhatsApp chat to the new owner', async () => {
    await OrganizationMember.updateOne({ _id: ids.b }, { status: 'disabled' });
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    // The customer wrote on WhatsApp first (no rule for WhatsApp: the chat stays in the queue) ...
    const chat = (await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from: '98290 00006', name: 'Chat first', text: 'Hi' })).body.data;
    await queue.runDue();
    expect((await Conversation.findById(chat.conversationId)).assigneeId).toBeFalsy();
    // ... then the same number enquires on IndiaMART: the open lead and its chat go by the IndiaMART rule.
    await lead(owner.token, { source: 'IndiaMART', name: 'Chat first', phone: '98290 00006', state: 'Rajasthan' });
    await lead(owner.token, { source: 'IndiaMART', name: 'Next', phone: '98290 00007', state: 'Rajasthan' });
    await queue.runDue();
    const whatsappLead = await Lead.findOne({ contactId: chat.contactId });
    expect(String(whatsappLead.ownerId)).toBe(ids.a);
    expect(String((await Conversation.findById(chat.conversationId)).assigneeId)).toBe(ids.a);
    expect(String((await Lead.findOne({ title: 'IndiaMART enquiry', contactId: { $ne: chat.contactId } }).sort({ createdAt: -1 })).ownerId)).toBe(ids.a);
    await OrganizationMember.updateOne({ _id: ids.b }, { status: 'active' });
  });

  it('outside working hours sends leads to the fallback person, or leaves them unassigned', async () => {
    const closedAllDay = { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:01' };
    await api().put('/api/v1/organization/business-hours').set(bearer(owner.token)).send(closedAllDay);
    const rule = (await api().post('/api/v1/assignment-rules').set(bearer(owner.token))
      .send({ name: 'Facebook', priority: 0, conditions: { sources: ['Facebook'] }, memberIds: [ids.a], respectWorkingHours: true, fallbackMemberId: ids.c })).body.data;
    const night = (await lead(owner.token, { source: 'Facebook', name: 'Night owl', phone: '98290 00008' })).body.data;
    await queue.runDue();
    expect(String((await Lead.findById(night.leadId)).ownerId)).toBe(ids.c);
    expect(await activities(night.leadId, 'Assigned')).toEqual(['Assigned to Chetan by rule "Facebook": outside working hours, so the fallback person']);

    await api().patch(`/api/v1/assignment-rules/${rule.id}`).set(bearer(owner.token)).send({ fallbackMemberId: null });
    const later = (await lead(owner.token, { source: 'Facebook', name: 'Later owl', phone: '98290 00009' })).body.data;
    await queue.runDue();
    expect((await Lead.findById(later.leadId)).ownerId).toBeFalsy();
    await api().put('/api/v1/organization/business-hours').set(bearer(owner.token)).send({ days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '19:00' });
  });
});

describe('Auto-reply rules', () => {
  let owner;
  let templates;
  const rule = (body) => api().post('/api/v1/auto-reply-rules').set(bearer(owner.token)).send(body);
  const autoMessages = async (contactId) => Message.find({ contactId, 'automation.kind': 'auto-reply' });

  beforeAll(async () => {
    owner = await login('reply-owner@example.com', { name: 'Asha' });
    await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ name: 'Yellow Traders' });
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    templates = Object.fromEntries((await api().post('/api/v1/templates/sync').set(bearer(owner.token)).send({})).body.data.map((t) => [t.name, t]));
  });

  it('checks the template and that every variable is filled', async () => {
    const missing = await rule({ sources: ['IndiaMART'], templateId: templates.order_update.id, variables: { body: { 1: 'contact.name' } } });
    expect(missing.status).toBe(400);
    expect(missing.body.errors[0].code).toBe('VARIABLE_REQUIRED');
    const nonsense = await rule({ sources: ['IndiaMART'], templateId: templates.order_update.id, variables: { body: { 1: 'contact.password', 2: 'lead.product' } } });
    expect(nonsense.status).toBe(400);
    const stranger = await login('reply-stranger@example.com');
    expect((await api().post('/api/v1/auto-reply-rules').set(bearer(stranger.token)).send({ templateId: templates.order_update.id })).status).toBe(400);
  });

  it('greets a new IndiaMART lead on WhatsApp with the filled-in template, as the CRM, in the owner\'s chat', async () => {
    const created = await rule({
      name: 'IndiaMART welcome', sources: ['IndiaMART'], templateId: templates.order_update.id,
      variables: { body: { 1: 'contact.name', 2: 'lead.product' } },
    });
    expect(created.status).toBe(201);
    const res = (await lead(owner.token, { source: 'IndiaMART', name: 'Ravi Traders', phone: '98290 12345', product: 'Cumin Seeds' })).body.data;
    await queue.runDue();
    const [message] = await autoMessages(res.contactId);
    expect(message).toMatchObject({
      type: 'template', status: 'sent', direction: 'out',
      text: 'Namaste Ravi Traders, your order Cumin Seeds has been dispatched. We will share the tracking details soon.\n\nReply STOP to stop updates',
    });
    expect(message.sentByMemberId).toBeUndefined();
    const chat = await Conversation.findById(message.conversationId);
    expect(chat.assigneeId).toBeFalsy(); // no assignment rule here, and an auto-reply never takes the chat
    expect(await activities(res.leadId, 'Auto-reply')).toEqual(['Sent WhatsApp template "order_update".']);
    const conversation = (await api().get(`/api/v1/conversations/${chat._id}/messages`).set(bearer(owner.token))).body.data;
    expect(conversation.at(-1).automation).toMatchObject({ kind: 'auto-reply' });

    // A repeat enquiry from the same person gets no second greeting.
    await lead(owner.token, { source: 'IndiaMART', name: 'Ravi', phone: '98290 12345', product: 'Fennel' });
    await queue.runDue();
    expect(await autoMessages(res.contactId)).toHaveLength(1);
  });

  it('skips old enquiries, people without a mobile number, other sources, and unapproved templates', async () => {
    const old = await leadIntake.intake({
      organizationId: (await Contact.findOne({ phoneE164: '+919829012345' })).organizationId,
      source: 'IndiaMART', sourceRef: 'OLD-1', person: { name: 'Yesterday', phone: '98290 55555' }, enquiry: { product: 'Ajwain' },
      receivedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    const email = (await lead(owner.token, { source: 'IndiaMART', name: 'Mail only', email: 'mail@example.com' })).body.data;
    const website = (await lead(owner.token, { source: 'Website', name: 'Web', phone: '98290 66666' })).body.data;
    await queue.runDue();
    expect(await activities(old.leadId, 'Auto-reply')).toEqual(['No auto-reply: the enquiry is older than 60 minutes.']);
    expect(await activities(email.leadId, 'Auto-reply')).toEqual(['No auto-reply: the customer has no mobile number.']);
    expect(await autoMessages(website.contactId)).toHaveLength(0);

    await require('../models/MessageTemplate').updateOne({ _id: templates.order_update.id }, { status: 'PAUSED' });
    const paused = (await lead(owner.token, { source: 'IndiaMART', name: 'Paused', phone: '98290 77777' })).body.data;
    await queue.runDue();
    expect(await activities(paused.leadId, 'Auto-reply')).toEqual(['No auto-reply: the template is not approved (any more).']);
    await require('../models/MessageTemplate').updateOne({ _id: templates.order_update.id }, { status: 'APPROVED' });
  });

  it('with the worker running, a new lead is answered within seconds (the 60-second promise)', async () => {
    queue.start({ pollMs: 1000 });
    const started = Date.now();
    const res = (await lead(owner.token, { source: 'IndiaMART', name: 'Fast buyer', phone: '98290 88888', product: 'Saunf' })).body.data;
    let message = null;
    while (!message && Date.now() - started < 60000) {
      [message] = await autoMessages(res.contactId);
      if (!message) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await queue.stop();
    expect(message).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(10000);
  });
});
