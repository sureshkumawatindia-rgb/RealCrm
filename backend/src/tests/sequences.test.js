jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Job = require('../models/Job');
const Message = require('../models/Message');
const MessageTemplate = require('../models/MessageTemplate');
const Sequence = require('../models/Sequence');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const Task = require('../models/Task');
const queue = require('../jobs/queue');
const engine = require('../services/automation/engine');
const sequenceEngine = require('../services/automation/sequences');
const leadRouting = require('../services/leadRoutingService');
const migration = require('../migrations/004-sequences-v2');
const { isOpen, nextOpening, DEFAULT_BUSINESS_HOURS } = require('../utils/businessHours');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const DAY = 24 * 60 * 60 * 1000;
const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;
// Events reach the queue a moment after the request (bus → enqueue): wait, then run what is due.
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};
// "Some days later": every waiting sequence step is due now.
const fastForward = () => Job.updateMany({ name: 'sequence.step', status: 'queued' }, { $set: { runAt: new Date() } });
const enrollmentsOf = (sequenceId) => SequenceEnrollment.find({ sequenceId }).sort({ createdAt: 1 });

beforeAll(() => {
  leadRouting.attach(queue);
  engine.register(queue);
  sequenceEngine.register(queue);
});
afterAll(() => queue.stop());

describe('Working hours: the next opening', () => {
  it('waits for the morning, the next working day, or not at all', () => {
    const hours = { ...DEFAULT_BUSINESS_HOURS };
    const at = (iso) => nextOpening(hours, new Date(iso)).toISOString();
    expect(at('2026-09-29T05:00:00.000Z')).toBe('2026-09-29T05:00:00.000Z'); // Tue 10:30 IST: open
    expect(at('2026-09-29T02:00:00.000Z')).toBe('2026-09-29T04:30:00.000Z'); // Tue 07:30 → 10:00
    expect(at('2026-09-29T16:00:00.000Z')).toBe('2026-09-30T04:30:00.000Z'); // Tue 21:30 → Wed 10:00
    expect(at('2026-09-26T15:00:00.000Z')).toBe('2026-09-28T04:30:00.000Z'); // Sat 20:30 → Mon (Sunday off)
    expect(nextOpening({ ...hours, days: [] }, new Date('2026-09-26T15:00:00Z')).toISOString()).toBe('2026-09-26T15:00:00.000Z');
  });
});

describe('Sequences', () => {
  let owner;
  let ownerId;
  let templates;
  const auth = () => bearer(owner.token);
  const createSequence = async (body) => {
    const res = await api().post('/api/v1/sequences').set(auth()).send({ workingHoursOnly: false, ...body });
    if (res.status !== 201) throw new Error(`sequence: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const newLead = async (name, phone) => (await api().post('/api/v1/leads').set(auth()).send({ contact: { name, phone }, title: `${name} enquiry` })).body.data;
  const enroll = (sequenceId, body, token = owner.token) => api().post(`/api/v1/sequences/${sequenceId}/enroll`).set(bearer(token)).send(body);
  const inbound = async (from, text) => (await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(auth()).send({ from, name: 'Buyer', text })).body.data;
  const template = (day) => ({ day, type: 'whatsapp.template', params: { templateId: templates.order_update.id, variables: { body: { 1: 'contact.name', 2: 'text:for {{lead.title}}' } } } });

  beforeAll(async () => {
    owner = await login('seq-owner@example.com', { name: 'Asha' });
    ownerId = await memberId(owner.token, 'seq-owner@example.com');
    await api().post('/api/v1/whatsapp/accounts').set(auth()).send({ provider: 'mock' });
    templates = Object.fromEntries((await api().post('/api/v1/templates/sync').set(auth()).send({})).body.data.map((t) => [t.name, t]));
  });

  it('accepts follow-up steps on days, in day order, and checks them like workflow steps', async () => {
    const res = await api().post('/api/v1/sequences').set(auth()).send({
      name: 'Quote follow-up',
      steps: [{ day: 5, type: 'task.create', params: { title: 'Call {{contact.name}}' } }, template(0), { day: 2, type: 'agent.notify', params: { message: 'Chase {{contact.name}}' } }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'Active', stopOnReply: true, stopOnClose: true, workingHoursOnly: true, ownerId,
      stats: { enrolled: 0, active: 0, completed: 0, stopped: 0, failed: 0 },
    });
    expect(res.body.data.steps.map((s) => `${s.day}:${s.type}`)).toEqual(['0:whatsapp.template', '2:agent.notify', '5:task.create']);

    const refused = async (body) => {
      const r = await api().post('/api/v1/sequences').set(auth()).send({ name: 'x', ...body });
      return [r.status, r.body.errors?.[0]?.code || r.body.message];
    };
    expect((await refused({ steps: [{ day: 1, type: 'wait', params: { amount: 1 } }] }))[0]).toBe(400);
    expect((await refused({ steps: [{ day: 1, type: 'webhook.call', params: { url: 'https://93.184.216.34/x' } }] }))[0]).toBe(400);
    expect((await refused({ steps: [{ day: 400, type: 'tag.add', params: { tag: 'x' } }] }))[0]).toBe(400);
    expect((await refused({ steps: [] }))[0]).toBe(400);
    expect(await refused({ steps: [{ day: 0, type: 'whatsapp.template', params: { templateId: templates.order_update.id } }] })).toEqual([400, 'VARIABLE_REQUIRED']);
    expect((await api().get('/api/v1/workflows/meta').set(auth())).body.data.sequenceSteps).toContain('whatsapp.template');

    // A workflow can add customers to a sequence of this organization only.
    const stranger = await login('seq-stranger0@example.com');
    const theirs = (await api().post('/api/v1/sequences').set(bearer(stranger.token)).send({ name: 'Theirs', steps: [{ day: 0, type: 'tag.add', params: { tag: 'x' } }] })).body.data;
    const foreign = await api().post('/api/v1/workflows').set(auth()).send({ name: 'x', trigger: { type: 'lead.created' }, steps: [{ type: 'sequence.enroll', params: { sequenceId: theirs.id } }] });
    expect(foreign.body.errors[0].code).toBe('INVALID_SEQUENCE');
  });

  it('runs day 0 at once, later days on their day, then completes', async () => {
    const sequence = await createSequence({
      name: 'Three touches',
      steps: [template(0), { day: 2, type: 'task.create', params: { title: 'Call {{contact.name}}', dueInDays: 0 } }, { day: 4, type: 'tag.add', params: { tag: 'Followed up' } }],
    });
    const lead = await newLead('Ravi Traders', '98290 40001');
    const res = await enroll(sequence.id, { leadId: lead.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'active', label: 'Ravi Traders', leadId: lead.id, enrolledBy: { kind: 'member', name: 'Asha' } });
    await settle();

    let [enrollment] = await enrollmentsOf(sequence.id);
    expect(enrollment.steps.map((s) => [s.day, s.type, s.status])).toEqual([[0, 'whatsapp.template', 'done']]);
    expect(enrollment.stepIndex).toBe(1);
    expect(enrollment.nextAt.getTime() - enrollment.enrolledAt.getTime()).toBeGreaterThanOrEqual(2 * DAY - 1000);
    const sent = await Message.findOne({ contactId: lead.contactId, 'automation.kind': 'sequence' });
    expect(sent).toMatchObject({ type: 'template', status: 'sent', text: expect.stringContaining('Namaste Ravi Traders, your order for Ravi Traders enquiry') });
    expect(String(sent.automation.ruleId)).toBe(sequence.id);

    // Already in it.
    const twice = await enroll(sequence.id, { leadId: lead.id });
    expect([twice.status, twice.body.code]).toEqual([409, 'ALREADY_ENROLLED']);

    await fastForward();
    await settle();
    await fastForward();
    await settle();
    [enrollment] = await enrollmentsOf(sequence.id);
    expect(enrollment).toMatchObject({ status: 'completed', stepIndex: 3 });
    expect(enrollment.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(await Task.exists({ title: 'Call Ravi Traders', origin: 'automation', relatedId: lead.id })).toBeTruthy();
    expect((await Contact.findById(lead.contactId)).tags).toContain('Followed up');
    expect((await api().get(`/api/v1/sequences/${sequence.id}`).set(auth())).body.data.stats).toMatchObject({ enrolled: 1, active: 0, completed: 1 });

    // Done: the customer can go through it again.
    expect((await enroll(sequence.id, { contactId: lead.contactId })).status).toBe(201);
  });

  it('stops for a customer who replies on WhatsApp (unless told not to)', async () => {
    const stopping = await createSequence({ name: 'Nudge', steps: [{ day: 0, type: 'whatsapp.text', params: { text: 'Did you see our rates, {{contact.name}}?' } }, { day: 1, type: 'tag.add', params: { tag: 'Nudged twice' } }] });
    const keepGoing = await createSequence({ name: 'Newsletter', stopOnReply: false, steps: [{ day: 0, type: 'tag.add', params: { tag: 'News 1' } }, { day: 3, type: 'tag.add', params: { tag: 'News 2' } }] });
    const chat = await inbound('98290 40011', 'Hello, rates?');
    await settle();
    const contactId = chat.contactId;
    expect((await enroll(stopping.id, { contactId })).status).toBe(201);
    expect((await enroll(keepGoing.id, { contactId })).status).toBe(201);
    await settle();
    // The earlier message does not count; day 0 went out inside the 24-hour window.
    expect(await Message.findOne({ contactId, 'automation.kind': 'sequence', text: 'Did you see our rates, Buyer?' })).toBeTruthy();

    await inbound('98290 40011', 'Yes, thanks!');
    await settle();
    const [stopped] = await enrollmentsOf(stopping.id);
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'The customer replied on WhatsApp.' });
    expect(await Job.countDocuments({ name: 'sequence.step', status: 'queued', 'data.enrollmentId': String(stopped._id) })).toBe(0);
    expect((await enrollmentsOf(keepGoing.id))[0].status).toBe('active');

    await fastForward();
    await settle();
    const tags = (await Contact.findById(contactId)).tags;
    expect(tags).toEqual(expect.arrayContaining(['News 1', 'News 2']));
    expect(tags).not.toContain('Nudged twice');
  });

  it('stops when the lead is won or lost, and when stopped by hand or the sequence is paused', async () => {
    const sequence = await createSequence({ name: 'Until closed', steps: [{ day: 0, type: 'tag.add', params: { tag: 'In cadence' } }, { day: 7, type: 'tag.add', params: { tag: 'Week later' } }] });
    const won = await newLead('Kiran Stores', '98290 40021');
    const manual = await newLead('Manual Buyer', '98290 40022');
    const paused = await newLead('Paused Buyer', '98290 40023');
    for (const lead of [won, manual, paused]) await enroll(sequence.id, { leadId: lead.id });
    await settle();

    await api().patch(`/api/v1/leads/${won.id}`).set(auth()).send({ stage: 'Won' });
    await settle();
    const byLabel = async (label) => SequenceEnrollment.findOne({ sequenceId: sequence.id, label });
    expect(await byLabel('Kiran Stores')).toMatchObject({ status: 'stopped', stopReason: 'The lead was won.' });

    const manualId = String((await byLabel('Manual Buyer'))._id);
    const stop = await api().post(`/api/v1/sequence-enrollments/${manualId}/stop`).set(auth());
    expect(stop.body.data).toMatchObject({ status: 'stopped', stopReason: 'Stopped by Asha.' });
    expect((await api().post(`/api/v1/sequence-enrollments/${manualId}/stop`).set(auth())).body.code).toBe('ENROLLMENT_FINISHED');

    await api().patch(`/api/v1/sequences/${sequence.id}`).set(auth()).send({ status: 'Paused' });
    expect(await byLabel('Paused Buyer')).toMatchObject({ status: 'stopped', stopReason: 'Stopped: the sequence was set to Paused.' });
    const notActive = await enroll(sequence.id, { leadId: won.id });
    expect([notActive.status, notActive.body.code]).toEqual([409, 'NOT_ACTIVE']);
    expect((await api().get(`/api/v1/sequences/${sequence.id}`).set(auth())).body.data.stats).toMatchObject({ enrolled: 3, active: 0, stopped: 3 });

    await fastForward();
    await settle();
    expect((await Contact.findById(paused.contactId)).tags).not.toContain('Week later');
    const list = await api().get(`/api/v1/sequence-enrollments?leadId=${won.id}`).set(auth());
    expect(list.body.data).toMatchObject([{ sequenceName: 'Until closed', status: 'stopped', steps: [{ day: 0, type: 'tag.add', status: 'done' }] }]);
  });

  it('waits for working hours when asked to', async () => {
    // Open only on another weekday: the step waits for that day's opening.
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
    const day = (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(today) + 3) % 7;
    await api().put('/api/v1/organization/business-hours').set(auth()).send({ days: [day], start: '10:00', end: '18:00' });
    const sequence = await createSequence({ name: 'Polite', workingHoursOnly: true, steps: [{ day: 0, type: 'tag.add', params: { tag: 'Polite' } }] });
    const lead = await newLead('Night Owl', '98290 40031');
    await enroll(sequence.id, { leadId: lead.id });
    await settle();
    const [enrollment] = await enrollmentsOf(sequence.id);
    expect(enrollment.status).toBe('active');
    expect(enrollment.nextAt.getTime()).toBeGreaterThan(Date.now() + DAY);
    expect(isOpen({ ...DEFAULT_BUSINESS_HOURS, days: [day], start: '10:00', end: '18:00' }, enrollment.nextAt)).toBe(true);
    await api().put('/api/v1/organization/business-hours').set(auth()).send({ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' });
    await api().patch(`/api/v1/sequences/${sequence.id}`).set(auth()).send({ status: 'Paused' });
  });

  it('is started by a workflow step, also on the message that triggered it', async () => {
    const sequence = await createSequence({ name: 'Price follow-up', steps: [{ day: 0, type: 'tag.add', params: { tag: 'Asked price' } }, { day: 2, type: 'tag.add', params: { tag: 'Price day 2' } }] });
    const flow = (await api().post('/api/v1/workflows').set(auth()).send({
      name: 'Price asked', trigger: { type: 'message.received', params: { keywords: ['price'] } }, steps: [{ type: 'sequence.enroll', params: { sequenceId: sequence.id } }],
    })).body.data;
    const chat = await inbound('98290 40041', 'What is the price?');
    await settle();
    const [enrollment] = await enrollmentsOf(sequence.id);
    expect(enrollment).toMatchObject({ status: 'active', enrolledBy: { kind: 'workflow', name: 'Automation "Price asked"' }, stepIndex: 1 });
    expect(String(enrollment.enrolledBy.workflowId)).toBe(flow.id);
    expect(enrollment.chain.map(String)).toEqual([flow.id]);
    expect((await Contact.findById(chat.contactId)).tags).toContain('Asked price');

    // The same customer asks again: the reply ends the first round, the workflow starts a new one.
    await inbound('98290 40041', 'price again?');
    await settle();
    const [first, second] = await enrollmentsOf(sequence.id);
    expect(first).toMatchObject({ status: 'stopped', stopReason: 'The customer replied on WhatsApp.' });
    expect(second).toMatchObject({ status: 'active', stepIndex: 1 });
    const runs = (await api().get(`/api/v1/workflows/${flow.id}/runs`).set(auth())).body.data;
    expect(runs.map((r) => r.steps[0].detail)).toEqual(['Added to "Price follow-up"', 'Added to "Price follow-up"']);
    // A workflow's step is skipped while the customer is still in the sequence.
    const contact = await Contact.findById(chat.contactId);
    const again = await sequenceEngine.enroll({ organizationId: contact.organizationId, sequenceId: sequence.id, contact, by: { kind: 'workflow', name: 'x' } });
    expect(again).toMatchObject({ alreadyEnrolled: true, reason: 'Already in the sequence "Price follow-up".' });
    await api().patch(`/api/v1/workflows/${flow.id}`).set(auth()).send({ status: 'Paused' });
  });

  it('logs a refused step and carries on; skips a template the customer has no value for', async () => {
    const sequence = await createSequence({
      name: 'Broken template',
      steps: [template(0), { day: 0, type: 'whatsapp.template', params: { templateId: templates.quote_follow_up.id, variables: { header: { product: 'contact.company' }, body: { customer_name: 'contact.name' } } } }, { day: 1, type: 'tag.add', params: { tag: 'Still followed' } }],
    });
    await MessageTemplate.updateOne({ _id: templates.order_update.id }, { status: 'PAUSED' });
    try {
      const lead = await newLead('Fail Buyer', '98290 40051'); // no company
      await enroll(sequence.id, { leadId: lead.id });
      await settle();
      await fastForward();
      await settle();
      const [enrollment] = await enrollmentsOf(sequence.id);
      expect(enrollment.status).toBe('completed');
      expect(enrollment.steps.map((s) => [s.status, s.detail])).toEqual([
        ['failed', expect.stringMatching(/not approved/)],
        ['skipped', 'Not sent: this customer has no value for {{product}} in "quote_follow_up".'],
        ['done', 'Tagged "Still followed"'],
      ]);
    } finally {
      await MessageTemplate.updateOne({ _id: templates.order_update.id }, { status: 'APPROVED' });
    }
  });

  it('agents see their own sequences and who is in them; other organizations see nothing', async () => {
    const agent = await inviteAndJoin(owner.token, 'seq-agent@example.com', { role: 'agent', modules: ['automation', 'leads'] });
    const mine = (await api().post('/api/v1/sequences').set(bearer(agent.token)).send({ name: 'Agent cadence', workingHoursOnly: false, steps: [{ day: 3, type: 'tag.add', params: { tag: 'x' } }] })).body.data;
    expect(mine.ownerId).toBe(await memberId(owner.token, 'seq-agent@example.com'));
    const agentLead = (await api().post('/api/v1/leads').set(bearer(agent.token)).send({ contact: { name: 'Agent Buyer', phone: '98290 40061' } })).body.data;
    expect((await enroll(mine.id, { leadId: agentLead.id }, agent.token)).status).toBe(201);
    const ownersLead = await newLead('Owner Buyer', '98290 40062');
    expect((await enroll(mine.id, { leadId: ownersLead.id }, agent.token)).status).toBe(404); // not their lead

    const seen = (await api().get('/api/v1/sequences?limit=100').set(bearer(agent.token))).body.data.map((s) => s.name);
    expect(seen).toEqual(['Agent cadence']);
    const theirEnrollments = (await api().get('/api/v1/sequence-enrollments?limit=100').set(bearer(agent.token))).body.data;
    expect(theirEnrollments.map((e) => e.label)).toEqual(['Agent Buyer']);

    const stranger = await login('seq-stranger@example.com');
    expect((await api().get('/api/v1/sequences').set(bearer(stranger.token))).body.data).toEqual([]);
    expect((await api().get('/api/v1/sequence-enrollments').set(bearer(stranger.token))).body.data).toEqual([]);
    expect((await enroll(mine.id, { leadId: agentLead.id }, stranger.token)).status).toBe(404);
    expect((await api().post(`/api/v1/sequence-enrollments/${theirEnrollments[0].id}/stop`).set(bearer(stranger.token))).status).toBe(404);
  });
});

describe('Migration 004: Phase 2 sequences', () => {
  it('moves old sequences to the follow-up engine, paused, and is safe to repeat', async () => {
    const owner = await login('mig4-owner@example.com');
    const organizationId = (await api().get('/api/v1/organization').set(bearer(owner.token))).body.data.id;
    const { insertedId } = await Sequence.collection.insertOne({
      organizationId: new mongoose.Types.ObjectId(organizationId), name: 'New lead nurture', targetType: 'Leads', status: 'Active', enrolledCount: 6, deletedAt: null,
      steps: [{ day: 0, type: 'Email', note: 'Welcome' }, { day: 2, type: 'Call', note: '' }, { day: 3, type: 'Wait', note: '' }, { day: 5, type: 'Task', note: 'Send catalogue' }],
    });
    expect((await migration.up()).updated).toBeGreaterThanOrEqual(1);
    const migrated = await Sequence.findById(insertedId);
    expect(migrated).toMatchObject({ status: 'Paused', stopOnReply: true, stopOnClose: true, schemaVersion: 2, stats: { enrolled: 6, active: 0 } });
    expect(migrated.steps.map((s) => `${s.day}:${s.type}:${s.params.title}`)).toEqual(['2:task.create:Call {{contact.name}}', '5:task.create:Send catalogue']);
    expect(migrated.notes.join(' ')).toMatch(/paused.*Day 0 email "Welcome" was left out/s);
    const raw = await Sequence.collection.findOne({ _id: insertedId });
    expect([raw.targetType, raw.enrolledCount]).toEqual([undefined, undefined]);
    expect((await migration.up()).updated).toBe(0);
    expect((await api().patch(`/api/v1/sequences/${insertedId}`).set(bearer(owner.token)).send({ status: 'Active' })).body.data.status).toBe('Active');
  });
});
