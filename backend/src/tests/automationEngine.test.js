jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const AutomationRun = require('../models/AutomationRun');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Job = require('../models/Job');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Quotation = require('../models/Quotation');
const Task = require('../models/Task');
const Workflow = require('../models/Workflow');
const bus = require('../realtime/bus');
const queue = require('../jobs/queue');
const engine = require('../services/automation/engine');
const leadRouting = require('../services/leadRoutingService');
const safeWebhook = require('../utils/safeWebhook');
const migration = require('../migrations/003-workflows-v2');
const { indiaDate } = require('../utils/dates');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;
// Events reach the queue a moment after the request (bus → enqueue): wait, then run what is due.
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};
const runsOf = (workflowId) => AutomationRun.find({ workflowId }).sort({ createdAt: 1 });

beforeAll(() => {
  leadRouting.attach(queue);
  engine.register(queue);
});
afterAll(() => queue.stop());

describe('Workflow builder (API)', () => {
  let owner;
  let agent;
  let templates;
  const create = (token, body) => api().post('/api/v1/workflows').set(bearer(token)).send({
    name: 'Flow', trigger: { type: 'lead.created' }, steps: [{ type: 'tag.add', params: { tag: 'new' } }], ...body,
  });

  beforeAll(async () => {
    owner = await login('wf-owner@example.com', { name: 'Arjun' });
    agent = await inviteAndJoin(owner.token, 'wf-agent@example.com', { role: 'agent', modules: ['automation'] });
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    templates = Object.fromEntries((await api().post('/api/v1/templates/sync').set(bearer(owner.token)).send({})).body.data.map((t) => [t.name, t]));
  });

  it('describes its vocabulary', async () => {
    const meta = (await api().get('/api/v1/workflows/meta').set(bearer(agent.token))).body.data;
    expect(meta.triggers.map((t) => t.type)).toEqual(expect.arrayContaining(['lead.created', 'message.received', 'lead.no_reply', 'payment.received']));
    expect(meta.triggers.find((t) => t.type === 'task.overdue').kind).toBe('time');
    expect(meta.actions.map((a) => a.type)).toContain('webhook.call');
    expect(meta.conditions.find((c) => c.field === 'owner').ops).toEqual(['is', 'isNot', 'none', 'any']);
  });

  it('accepts only settings the engine understands', async () => {
    const statuses = [
      await create(owner.token, { trigger: { type: 'moon.rises' } }),
      await create(owner.token, { steps: [{ type: 'rocket.launch' }] }),
      await create(owner.token, { steps: [] }),
      await create(owner.token, { trigger: { type: 'lead.created', params: { sources: ['Pigeon'] } } }),
      await create(owner.token, { trigger: { type: 'order.stage_changed', params: { toStages: ['Won'] } } }),
      await create(owner.token, { steps: [{ type: 'wait', params: { amount: 91, unit: 'days' } }] }),
      await create(owner.token, { steps: [{ type: 'stage.change', params: { stage: 'Lost' } }] }),
      await create(owner.token, { steps: [{ type: 'whatsapp.text', params: {} }] }),
      await create(owner.token, { conditions: [{ field: 'source', op: 'has', value: ['IndiaMART'] }] }),
      await create(owner.token, { conditions: [{ field: 'owner', op: 'is' }] }),
      await create(owner.token, { steps: [{ type: 'webhook.call', params: { url: 'http://93.184.216.34/hook' } }] }),
    ].map((res) => res.status);
    expect(statuses).toEqual(Array(statuses.length).fill(400));

    const ok = await create(owner.token, {
      name: 'Full', trigger: { type: 'lead.created', params: { sources: ['IndiaMART'], extra: 1 } },
      conditions: [{ field: 'owner', op: 'none', value: 'ignored' }, { field: 'tag', op: 'hasNot', value: 'vip' }],
      steps: [{ type: 'wait', params: { amount: 2 } }, { type: 'task.create', params: { title: 'Call {{contact.name}}' } }],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({
      status: 'Active', trigger: { type: 'lead.created', params: { sources: ['IndiaMART'] } },
      conditions: [{ field: 'owner', op: 'none' }, { field: 'tag', op: 'hasNot', value: 'vip' }],
      steps: [{ type: 'wait', params: { amount: 2, unit: 'hours' } }, { type: 'task.create', params: { title: 'Call {{contact.name}}', dueInDays: 1, assignTo: 'owner', priority: 'Medium' } }],
      stats: { runs: 0, done: 0, failed: 0 }, hasWebhook: false,
    });
    expect(ok.body.data.trigger.params.extra).toBeUndefined();
    expect(ok.body.data.conditions[0].value).toBeUndefined();
  });

  it('checks the people, templates and webhook addresses a workflow uses', async () => {
    const stranger = await login('wf-stranger@example.com');
    const strangerId = (await api().get('/api/v1/members').set(bearer(stranger.token))).body.data[0].id;
    const viewer = await inviteAndJoin(owner.token, 'wf-viewer@example.com', { role: 'agent', modules: ['dashboard'] });
    const viewerId = await memberId(owner.token, 'wf-viewer@example.com');
    expect(viewer.token).toBeTruthy();

    const codes = async (body) => (await create(owner.token, body)).body.errors?.[0]?.code;
    expect(await codes({ steps: [{ type: 'assign', params: { memberId: strangerId } }] })).toBe('INVALID_MEMBER');
    expect(await codes({ steps: [{ type: 'assign', params: { memberId: viewerId } }] })).toBe('MEMBER_NO_LEADS');
    expect(await codes({ steps: [{ type: 'agent.notify', params: { to: strangerId, message: 'Hi' } }] })).toBe('INVALID_MEMBER');
    expect(await codes({ conditions: [{ field: 'owner', op: 'is', value: strangerId }] })).toBe('INVALID_MEMBER');
    expect(await codes({ steps: [{ type: 'whatsapp.template', params: { templateId: templates.order_update.id, variables: { body: { 1: 'contact.name' } } } }] })).toBe('VARIABLE_REQUIRED');
    expect(await codes({ steps: [{ type: 'whatsapp.template', params: { templateId: templates.order_update.id, variables: { body: { 1: 'contact.password', 2: 'org.name' } } } }] })).toBe('VARIABLE_REQUIRED');
    expect(await codes({ steps: [{ type: 'whatsapp.template', params: { templateId: templates.quotation_pdf.id } }] })).toBe('TEMPLATE_NOT_SENDABLE');
    expect(await codes({ steps: [{ type: 'whatsapp.template', params: { templateId: templates.diwali_offer.id } }] })).toBe('TEMPLATE_NOT_SENDABLE');
    expect(await codes({ steps: [{ type: 'webhook.call', params: { url: 'https://10.0.0.7/hook' } }] })).toBe('WEBHOOK_URL');
    expect(await codes({ steps: [{ type: 'webhook.call', params: { url: 'https://crm.localhost/hook' } }] })).toBe('WEBHOOK_URL');

    const template = await create(owner.token, { steps: [{ type: 'whatsapp.template', params: { templateId: templates.order_update.id, variables: { body: { 1: 'contact.name', 2: 'text:your Diwali order' } } } }] });
    expect(template.status).toBe(201);
  });

  it('keeps the webhook secret for owners and admins, and out of lists', async () => {
    const hook = (await create(agent.token, { name: 'Agent hook', steps: [{ type: 'webhook.call', params: { url: 'https://93.184.216.34/hook' } }] })).body.data;
    expect(hook.hasWebhook).toBe(true);
    expect(hook.webhookSecret).toBeUndefined();
    expect((await api().get(`/api/v1/workflows/${hook.id}`).set(bearer(agent.token))).body.data.webhookSecret).toBeUndefined();
    const byOwner = (await api().get(`/api/v1/workflows/${hook.id}`).set(bearer(owner.token))).body.data;
    expect(byOwner.webhookSecret).toMatch(/^[0-9a-f]{48}$/);
    const listed = (await api().get('/api/v1/workflows?limit=100').set(bearer(owner.token))).body.data;
    expect(listed.every((w) => w.webhookSecret === undefined)).toBe(true);
  });

  it('agents see and change only their own workflows; other organizations see nothing', async () => {
    const mine = (await create(agent.token, { name: 'Agent flow' })).body.data;
    expect(mine.ownerId).toBe(await memberId(owner.token, 'wf-agent@example.com'));
    const ownersFlow = (await create(owner.token, { name: 'Owner only' })).body.data;
    const seen = (await api().get('/api/v1/workflows?limit=100').set(bearer(agent.token))).body.data.map((w) => w.name);
    expect(seen).toContain('Agent flow');
    expect(seen).not.toContain('Owner only');
    expect((await api().patch(`/api/v1/workflows/${ownersFlow.id}`).set(bearer(agent.token)).send({ status: 'Paused' })).status).toBe(404);
    expect((await api().delete(`/api/v1/workflows/${mine.id}`).set(bearer(agent.token))).status).toBe(403);
    const stranger = await login('wf-stranger2@example.com');
    expect((await api().get('/api/v1/workflows').set(bearer(stranger.token))).body.data).toEqual([]);
    expect((await api().get(`/api/v1/workflows/${mine.id}`).set(bearer(stranger.token))).status).toBe(404);
  });
});

describe('Automation engine', () => {
  let owner;
  let ownerId;
  let sales;
  let salesId;
  let templates;
  const workflow = async (body) => {
    const res = await api().post('/api/v1/workflows').set(bearer(owner.token)).send(body);
    if (res.status !== 201) throw new Error(`workflow: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const pause = (id) => api().patch(`/api/v1/workflows/${id}`).set(bearer(owner.token)).send({ status: 'Paused' });
  const simulateLead = async (body) => (await api().post('/api/v1/dev/simulate/lead').set(bearer(owner.token)).send(body)).body.data;
  const inbound = async (body) => (await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send(body)).body.data;

  beforeAll(async () => {
    owner = await login('engine-owner@example.com', { name: 'Asha' });
    ownerId = await memberId(owner.token, 'engine-owner@example.com');
    await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ name: 'Yellow Traders' });
    sales = await inviteAndJoin(owner.token, 'engine-sales@example.com', { role: 'agent', displayName: 'Sonu', modules: ['leads', 'deals', 'inbox', 'tasks'] });
    salesId = await memberId(owner.token, 'engine-sales@example.com');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    templates = Object.fromEntries((await api().post('/api/v1/templates/sync').set(bearer(owner.token)).send({})).body.data.map((t) => [t.name, t]));
  });

  it('starts on a new lead whose source and conditions fit, and runs every step in order', async () => {
    const flow = await workflow({
      name: 'New IndiaMART lead',
      trigger: { type: 'lead.created', params: { sources: ['IndiaMART'] } },
      conditions: [{ field: 'owner', op: 'none' }, { field: 'tag', op: 'hasNot', value: 'Blocked' }],
      steps: [
        { type: 'tag.add', params: { tag: 'IndiaMART lead' } },
        { type: 'assign', params: { memberId: salesId } },
        { type: 'task.create', params: { title: 'Call {{contact.name}} about {{lead.title}}', dueInDays: 1 } },
        { type: 'agent.notify', params: { to: 'owner', message: 'New lead for you: {{contact.name}}' } },
        { type: 'whatsapp.text', params: { text: 'Hello' } },
      ],
    });
    const lead = await simulateLead({ source: 'IndiaMART', name: 'Ravi Traders', phone: '98290 30001', product: 'Cumin Seeds' });
    await simulateLead({ source: 'Website', name: 'Web buyer', phone: '98290 30002' });
    await settle();

    const [run] = await runsOf(flow.id);
    expect(await AutomationRun.countDocuments({ workflowId: flow.id })).toBe(1);
    expect(run).toMatchObject({ status: 'done', trigger: 'lead.created', subject: { label: 'Ravi Traders' } });
    expect(run.steps.map((s) => [s.type, s.status])).toEqual([
      ['tag.add', 'done'], ['assign', 'done'], ['task.create', 'done'], ['agent.notify', 'done'], ['whatsapp.text', 'skipped'],
    ]);
    expect(run.steps[4].detail).toMatch(/no WhatsApp chat|24 hours/);

    expect((await Contact.findById(lead.contactId)).tags).toContain('IndiaMART lead');
    expect(String((await Lead.findById(lead.leadId)).ownerId)).toBe(salesId);
    const task = await Task.findOne({ relatedId: lead.leadId });
    expect(task).toMatchObject({ title: `Call Ravi Traders about ${(await Lead.findById(lead.leadId)).title}`, origin: 'automation', dueDate: indiaDate(1), relatedType: 'Lead' });
    expect(String(task.assigneeId)).toBe(salesId); // the step before gave the lead to Sonu
    const bell = await api().get('/api/v1/notifications').set(bearer(sales.token));
    expect(bell.body.data).toMatchObject({ unread: 1, items: [{ title: 'New lead for you: Ravi Traders', link: `customer-360.html?id=${lead.contactId}` }] });
    expect((await api().get(`/api/v1/workflows/${flow.id}`).set(bearer(owner.token))).body.data.stats).toMatchObject({ runs: 1, done: 1, failed: 0 });

    // The log, for the Sales Automation page and the lead.
    const log = await api().get(`/api/v1/automation-runs?leadId=${lead.leadId}`).set(bearer(owner.token));
    expect(log.body.data[0]).toMatchObject({ workflowName: 'New IndiaMART lead', status: 'done', steps: [{ type: 'tag.add', label: 'Add a tag to the customer' }, {}, {}, {}, {}] });
    await pause(flow.id);
  });

  it('answers a WhatsApp message with a keyword inside the 24-hour window', async () => {
    const flow = await workflow({
      name: 'Price list', trigger: { type: 'message.received', params: { keywords: ['price', 'rate'] } },
      steps: [{ type: 'whatsapp.text', params: { text: 'Namaste {{contact.name}}, {{org.name}} ki price list jaldi bhejte hain.' } }, { type: 'tag.add', params: { tag: 'Asked price' } }],
    });
    const first = await inbound({ from: '98290 30011', name: 'Meena', text: 'Hello' });
    const asked = await inbound({ from: '98290 30011', name: 'Meena', text: 'Cumin ka RATE kya hai?' });
    await settle();

    const runs = await runsOf(flow.id);
    expect(runs.map((r) => [r.status, r.event.text])).toEqual([['done', 'Cumin ka RATE kya hai?']]);
    const reply = await Message.findOne({ conversationId: asked.conversationId, direction: 'out', 'automation.kind': 'workflow' });
    expect(reply).toMatchObject({ type: 'text', status: 'sent', text: 'Namaste Meena, Yellow Traders ki price list jaldi bhejte hain.' });
    expect(String(reply.automation.ruleId)).toBe(flow.id);
    expect(reply.sentByMemberId).toBeUndefined();
    expect(first.conversationId).toEqual(asked.conversationId);
    expect((await Contact.findById(asked.contactId)).tags).toContain('Asked price');
    await pause(flow.id);
  });

  it('sends an approved template when a lead is won (and only then)', async () => {
    const flow = await workflow({
      name: 'Thank you', trigger: { type: 'lead.stage_changed', params: { toStages: ['Won'] } },
      steps: [{ type: 'whatsapp.template', params: { templateId: templates.order_update.id, variables: { body: { 1: 'contact.name', 2: 'text:for {{lead.title}}' } } } }],
    });
    const lead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Kiran Stores', phone: '98290 30021' }, title: 'Fennel 50kg' })).body.data;
    await api().patch(`/api/v1/leads/${lead.id}`).set(bearer(owner.token)).send({ stage: 'Contacted' });
    await api().patch(`/api/v1/leads/${lead.id}`).set(bearer(owner.token)).send({ stage: 'Won' });
    await settle();

    const runs = await runsOf(flow.id);
    expect(runs.map((r) => [r.status, r.event.from, r.event.to])).toEqual([['done', 'Contacted', 'Won']]);
    const sent = await Message.findOne({ contactId: lead.contactId, 'automation.kind': 'workflow' });
    expect(sent).toMatchObject({ type: 'template', status: 'sent', text: expect.stringContaining('Namaste Kiran Stores, your order for Fennel 50kg has been dispatched.') });
    // The chat goes to the lead's owner.
    expect(String((await Conversation.findById(sent.conversationId)).assigneeId)).toBe(ownerId);
    await pause(flow.id);
  });

  it('waits, carries on later, and stops when the workflow is paused or the run is cancelled', async () => {
    const flow = await workflow({
      name: 'Nudge', trigger: { type: 'lead.created' },
      steps: [{ type: 'tag.add', params: { tag: 'Step 1' } }, { type: 'wait', params: { amount: 2, unit: 'hours' } }, { type: 'tag.add', params: { tag: 'Step 2' } }],
    });
    const lead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Wait Buyer', phone: '98290 30031' } })).body.data;
    await settle();
    let [run] = await runsOf(flow.id);
    expect(run.status).toBe('waiting');
    expect(run.nextAt.getTime()).toBeGreaterThan(Date.now() + 119 * 60 * 1000);
    expect(run.steps.map((s) => [s.type, s.status])).toEqual([['tag.add', 'done'], ['wait', 'waiting']]);

    // Two hours later …
    await Job.updateMany({ name: 'automation.step', status: 'queued' }, { $set: { runAt: new Date() } });
    await settle();
    [run] = await runsOf(flow.id);
    expect(run.status).toBe('done');
    expect(run.steps.map((s) => [s.type, s.status])).toEqual([['tag.add', 'done'], ['wait', 'done'], ['tag.add', 'done']]);
    expect((await Contact.findById(lead.contactId)).tags).toEqual(['Step 1', 'Step 2']);

    // Cancelled by hand while waiting.
    await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Cancel Buyer', phone: '98290 30032' } });
    await settle();
    const waiting = (await runsOf(flow.id))[1];
    expect(waiting.status).toBe('waiting');
    const cancelled = await api().post(`/api/v1/automation-runs/${waiting._id}/cancel`).set(bearer(owner.token));
    expect(cancelled.body.data).toMatchObject({ status: 'cancelled', error: 'Stopped by Asha.' });
    expect((await api().post(`/api/v1/automation-runs/${waiting._id}/cancel`).set(bearer(owner.token))).status).toBe(409);
    expect(await Job.countDocuments({ name: 'automation.step', status: 'queued', 'data.runId': String(waiting._id) })).toBe(0);

    // Paused while waiting.
    await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Pause Buyer', phone: '98290 30033' } });
    await settle();
    expect((await runsOf(flow.id))[2].status).toBe('waiting');
    await pause(flow.id);
    const paused = (await runsOf(flow.id))[2];
    expect(paused).toMatchObject({ status: 'cancelled', error: 'Stopped: the workflow was set to Paused.' });
    await Job.updateMany({ name: 'automation.step', status: 'queued' }, { $set: { runAt: new Date() } });
    await settle();
    expect((await runsOf(flow.id))[2].steps).toHaveLength(2); // nothing ran after the pause
  });

  it('does not loop: workflows triggered by automations stop when they come round again', async () => {
    const forward = await workflow({ name: 'Forward', trigger: { type: 'lead.stage_changed', params: { toStages: ['Contacted'] } }, steps: [{ type: 'stage.change', params: { stage: 'Negotiation' } }] });
    const back = await workflow({ name: 'Back', trigger: { type: 'lead.stage_changed', params: { toStages: ['Negotiation'] } }, steps: [{ type: 'stage.change', params: { stage: 'Contacted' } }] });
    const self = await workflow({ name: 'Self', trigger: { type: 'lead.stage_changed' }, steps: [{ type: 'tag.add', params: { tag: 'Moved' } }, { type: 'stage.change', params: { stage: 'Quote Sent' } }] });
    const lead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Loop Buyer', phone: '98290 30041' } })).body.data;
    await api().patch(`/api/v1/leads/${lead.id}`).set(bearer(owner.token)).send({ stage: 'Contacted' });
    await settle();

    // Person → Contacted: Forward (→ Negotiation) and Self (→ Quote Sent) start. Forward's move starts Back
    // (→ Contacted), whose move would start Forward again — but Forward is already in its chain.
    expect((await runsOf(forward.id)).length).toBe(1);
    expect((await runsOf(back.id)).length).toBe(1);
    expect((await runsOf(self.id)).every((r) => !r.chain.map(String).includes(self.id))).toBe(true);
    const activities = (await api().get(`/api/v1/leads/${lead.id}/activities`).set(bearer(owner.token))).body.data;
    expect(activities.filter((a) => a.actorName === 'Automation "Forward"').map((a) => a.text)).toContain('Contacted → Negotiation');
    for (const id of [forward.id, back.id, self.id]) await pause(id);

    // Too long a chain starts nothing.
    const any = await workflow({ name: 'Any lead', trigger: { type: 'lead.created' }, steps: [{ type: 'tag.add', params: { tag: 'x' } }] });
    const fake = () => String(new (require('mongoose').Types.ObjectId)());
    await engine.handleEvent(queue, { type: 'lead.created', organizationId: (await Workflow.findById(any.id)).organizationId, leadId: lead.id, key: 'chain-test', chain: [fake(), fake(), fake(), fake()] });
    expect(await AutomationRun.countDocuments({ workflowId: any.id })).toBe(0);
    await pause(any.id);
  });

  it('finds quiet customers, unanswered quotations and overdue tasks once each', async () => {
    const noReply = await workflow({ name: 'No reply', trigger: { type: 'lead.no_reply', params: { hours: 24 } }, steps: [{ type: 'agent.notify', params: { to: 'managers', message: '{{contact.name}} has not replied' } }] });
    const quote = await workflow({ name: 'Quote chase', trigger: { type: 'quotation.not_accepted', params: { days: 3 } }, steps: [{ type: 'task.create', params: { title: 'Chase {{quotation.number}}' } }] });
    const overdue = await workflow({ name: 'Overdue', trigger: { type: 'task.overdue' }, steps: [{ type: 'agent.notify', params: { to: 'owner', message: 'Overdue: {{task.title}}' } }] });

    const chat = await inbound({ from: '98290 30051', name: 'Quiet Buyer', text: 'Send rates' });
    const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);
    await Conversation.updateOne({ _id: chat.conversationId }, { lastMessageDirection: 'out', lastMessageAt: hoursAgo(25) });
    const recent = await inbound({ from: '98290 30052', name: 'Recent Buyer', text: 'Hi' });
    await Conversation.updateOne({ _id: recent.conversationId }, { lastMessageDirection: 'out', lastMessageAt: hoursAgo(2) });

    const product = (await api().post('/api/v1/products').set(bearer(owner.token)).send({ name: 'Cumin 1kg', pricePaise: 25000, gstRatePct: 5 })).body.data;
    const lead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Quote Buyer', phone: '98290 30053' } })).body.data;
    const quotation = (await api().post(`/api/v1/leads/${lead.id}/quotations`).set(bearer(owner.token)).send({ items: [{ productId: product.id, quantity: 2, unitPricePaise: 25000, taxRatePct: 5 }] })).body.data;
    await Quotation.updateOne({ _id: quotation.id }, { status: 'Sent', sentAt: hoursAgo(4 * 24) });

    const task = (await api().post('/api/v1/tasks').set(bearer(owner.token)).send({ title: 'Send samples', assigneeId: salesId })).body.data;
    await Task.updateOne({ _id: task.id }, { dueDate: indiaDate(-2) });
    await settle();

    await engine.scan(queue);
    await settle();
    await engine.scan(queue); // the same things again: nothing new
    await settle();

    expect((await runsOf(noReply.id)).map((r) => [r.status, r.subject.label])).toEqual([['done', 'Quiet Buyer']]);
    expect(await Notification.exists({ title: 'Quiet Buyer has not replied', memberId: ownerId })).toBeTruthy();
    expect((await runsOf(quote.id)).map((r) => r.status)).toEqual(['done']);
    expect(await Task.exists({ title: `Chase ${quotation.number}`, origin: 'automation' })).toBeTruthy();
    expect((await runsOf(overdue.id)).map((r) => [r.status, r.subject.label])).toEqual([['done', 'Send samples']]);
    expect(await Notification.exists({ title: 'Overdue: Send samples', memberId: salesId })).toBeTruthy();
    for (const id of [noReply.id, quote.id, overdue.id]) await pause(id);
  });

  it('calls a webhook with a signature, and refuses private addresses at run time too', async () => {
    // No network in tests: the name points at a public address (checked on save and on every call).
    safeWebhook.setLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
    const hook = await workflow({ name: 'To Zapier', trigger: { type: 'lead.created' }, steps: [{ type: 'webhook.call', params: { url: 'https://hooks.example.com/catch/1' } }] });
    const secret = (await api().get(`/api/v1/workflows/${hook.id}`).set(bearer(owner.token))).body.data.webhookSecret;
    const calls = [];
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response('ok', { status: 200 });
    });
    try {
      const lead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Hook Buyer', phone: '98290 30061' } })).body.data;
      await settle();
      expect(calls).toHaveLength(1);
      const { options } = calls[0];
      expect(calls[0].url).toBe('https://hooks.example.com/catch/1');
      expect(options).toMatchObject({ method: 'POST', redirect: 'manual' });
      expect(options.headers['X-CRM-Event']).toBe('lead.created');
      expect(options.headers['X-CRM-Signature']).toBe(`sha256=${crypto.createHmac('sha256', secret).update(options.body).digest('hex')}`);
      expect(JSON.parse(options.body)).toMatchObject({ event: 'lead.created', workflow: { id: hook.id, name: 'To Zapier' }, lead: { id: lead.id }, contact: { name: 'Hook Buyer', phoneE164: '+919829030061' } });
      expect((await runsOf(hook.id))[0].steps[0]).toMatchObject({ status: 'done', detail: 'hooks.example.com answered 200' });

      // The name now points inside a private network: refused, and the run fails at once.
      safeWebhook.setLookup(async () => [{ address: '192.168.1.10', family: 4 }]);
      await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Hook Buyer 2', phone: '98290 30062' } });
      await settle();
      expect(calls).toHaveLength(1);
      const failed = (await runsOf(hook.id))[1];
      expect(failed).toMatchObject({ status: 'failed', error: expect.stringMatching(/private or local network/) });
      expect((await api().get(`/api/v1/workflows/${hook.id}`).set(bearer(owner.token))).body.data.stats).toMatchObject({ runs: 2, done: 1, failed: 1 });
    } finally {
      fetchSpy.mockRestore();
      safeWebhook.setLookup((hostname) => require('dns').promises.lookup(hostname, { all: true, verbatim: true }));
      await pause(hook.id);
    }
  });

  it('runs by hand for one lead (once per click), and only while active', async () => {
    const flow = await workflow({ name: 'By hand', trigger: { type: 'payment.received' }, steps: [{ type: 'tag.add', params: { tag: 'Tested' } }] });
    const lead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Manual Buyer', phone: '98290 30071' } })).body.data;
    const run = (key) => api().post(`/api/v1/workflows/${flow.id}/run`).set(bearer(owner.token)).set('Idempotency-Key', key).send({ leadId: lead.id });
    const started = await run('manual-1');
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({ trigger: 'manual', status: 'running', subject: { leadId: lead.id, label: 'Manual Buyer' }, event: { startedBy: 'Asha' } });
    expect((await run('manual-1')).headers['idempotent-replayed']).toBe('true');
    await settle();
    expect((await api().get(`/api/v1/workflows/${flow.id}/runs`).set(bearer(owner.token))).body.data.map((r) => r.status)).toEqual(['done']);
    expect((await Contact.findById(lead.contactId)).tags).toContain('Tested');

    const stranger = await login('engine-stranger@example.com');
    const theirs = (await api().post('/api/v1/leads').set(bearer(stranger.token)).send({ contact: { name: 'Other org', phone: '98290 30072' } })).body.data;
    expect((await api().post(`/api/v1/workflows/${flow.id}/run`).set(bearer(owner.token)).send({ leadId: theirs.id })).status).toBe(404);
    expect((await api().post(`/api/v1/workflows/${flow.id}/run`).set(bearer(stranger.token)).send({ leadId: theirs.id })).status).toBe(404);
    const runId = (await runsOf(flow.id))[0]._id;
    expect((await api().get(`/api/v1/automation-runs/${runId}`).set(bearer(stranger.token))).status).toBe(404);
    expect((await api().get('/api/v1/automation-runs').set(bearer(stranger.token))).body.data).toEqual([]);

    await pause(flow.id);
    const paused = await api().post(`/api/v1/workflows/${flow.id}/run`).set(bearer(owner.token)).send({ leadId: lead.id });
    expect(paused.status).toBe(409);
    expect(paused.body.code).toBe('NOT_ACTIVE');
  });

  it('runs order and payment workflows', async () => {
    const flow = await workflow({
      name: 'Paid', trigger: { type: 'payment.received' },
      steps: [{ type: 'agent.notify', params: { to: 'managers', message: 'Paid: {{order.number}} ({{order.total}})' } }],
    });
    const lead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Order Buyer', phone: '98290 30081' } })).body.data;
    const product = (await api().post('/api/v1/products').set(bearer(owner.token)).send({ name: 'Rice 1kg', pricePaise: 10000, gstRatePct: 0 })).body.data;
    const quotation = (await api().post('/api/v1/quotations').set(bearer(owner.token)).send({ leadId: lead.id, items: [{ productId: product.id, quantity: 1 }] })).body.data;
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(bearer(owner.token)).send({ status: 'Sent' });
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(bearer(owner.token)).send({ status: 'Accepted' });
    const order = await api().post('/api/v1/orders').set(bearer(owner.token)).send({ quotationId: quotation.id });
    if (order.status !== 201) throw new Error(JSON.stringify(order.body));
    for (const stage of ['Processing', 'Dispatched', 'Delivered', 'Payment Collected']) {
      const moved = await api().post(`/api/v1/orders/${order.body.data.id}/stage`).set(bearer(owner.token)).send({ stage });
      if (moved.status !== 200) throw new Error(`${stage}: ${JSON.stringify(moved.body)}`);
    }
    await settle();
    expect((await runsOf(flow.id)).map((r) => r.status)).toEqual(['done']);
    expect(await Notification.exists({ title: `Paid: ${order.body.data.number} (₹100.00)` })).toBeTruthy();
    await pause(flow.id);
  });
});

describe('The bell', () => {
  it('lists, marks read and pushes each member\'s own notifications', async () => {
    const owner = await login('bell-owner@example.com');
    const agent = await inviteAndJoin(owner.token, 'bell-agent@example.com', { role: 'agent', modules: ['leads'] });
    const agentId = await memberId(owner.token, 'bell-agent@example.com');
    const pushed = [];
    const listener = (event) => pushed.push(event);
    bus.on('notification:new', listener);
    const notifications = require('../services/notificationService');
    const org = (await api().get('/api/v1/organization').set(bearer(owner.token))).body.data;
    await notifications.notify(org.id, [agentId], { title: 'First', link: 'Tasks.html' });
    await notifications.notify(org.id, [agentId], { title: 'Second' });
    bus.off('notification:new', listener);
    expect(pushed.map((p) => [String(p.memberId), p.notification.title])).toEqual([[agentId, 'First'], [agentId, 'Second']]);

    const list = await api().get('/api/v1/notifications').set(bearer(agent.token));
    expect(list.body.data).toMatchObject({ unread: 2, items: [{ title: 'Second' }, { title: 'First', link: 'Tasks.html' }] });
    expect((await api().get('/api/v1/notifications').set(bearer(owner.token))).body.data).toEqual({ items: [], unread: 0 });
    const first = list.body.data.items[1].id;
    expect((await api().post(`/api/v1/notifications/${first}/read`).set(bearer(owner.token))).status).toBe(404);
    expect((await api().post(`/api/v1/notifications/${first}/read`).set(bearer(agent.token))).body.data.readAt).toBeTruthy();
    expect((await api().get('/api/v1/notifications?unread=true').set(bearer(agent.token))).body.data).toMatchObject({ unread: 1, items: [{ title: 'Second' }] });
    expect((await api().post('/api/v1/notifications/read-all').set(bearer(agent.token))).body.data).toEqual({ updated: 1 });
    expect((await api().get('/api/v1/notifications').set(bearer(agent.token))).body.data.unread).toBe(0);
  });
});

describe('Migration 003: Phase 2 workflows', () => {
  it('moves old workflows to the engine, paused, and is safe to repeat', async () => {
    const owner = await login('mig3-owner@example.com');
    const organizationId = (await api().get('/api/v1/organization').set(bearer(owner.token))).body.data.id;
    const oid = (id) => new (require('mongoose').Types.ObjectId)(id);
    const { insertedId: wonId } = await Workflow.collection.insertOne({
      organizationId: oid(organizationId), name: 'Thank you', status: 'Active', trigger: 'Deal Stage Changed to Won', runsCount: 3, lastRunAt: new Date('2026-05-01'),
      actions: [{ type: 'Create Task', detail: 'Send thank-you card' }, { type: 'Send Email (simulated)', detail: 'Thanks' }, { type: 'Update Status', detail: 'Lost' }],
      deletedAt: null,
    });
    const { insertedId: emailId } = await Workflow.collection.insertOne({
      organizationId: oid(organizationId), name: 'Mail only', status: 'Draft', trigger: 'Lead Created', actions: [{ type: 'Send Email (simulated)', detail: '' }], deletedAt: null,
    });
    expect((await migration.up()).updated).toBeGreaterThanOrEqual(2);
    const won = await Workflow.findById(wonId);
    expect(won).toMatchObject({ status: 'Paused', trigger: { type: 'lead.stage_changed', params: { toStages: ['Won'] } }, stats: { runs: 3, done: 0, failed: 0 }, schemaVersion: 2 });
    expect(won.steps.map((s) => s.toObject())).toEqual([{ type: 'task.create', params: { title: 'Send thank-you card', dueInDays: 1, assignTo: 'owner' } }]);
    expect(won.notes.join(' ')).toMatch(/paused.*Send Email: Thanks.*Update Status: Lost/s);
    const raw = await Workflow.collection.findOne({ _id: wonId });
    expect(raw.actions).toBeUndefined();
    expect(raw.runsCount).toBeUndefined();
    expect((await migration.up()).updated).toBe(0);

    // It can be turned on after a look; one without steps first needs a step.
    expect((await api().patch(`/api/v1/workflows/${wonId}`).set(bearer(owner.token)).send({ status: 'Active' })).body.data.status).toBe('Active');
    const empty = await api().patch(`/api/v1/workflows/${emailId}`).set(bearer(owner.token)).send({ status: 'Active' });
    expect(empty.body.errors[0].code).toBe('STEPS_REQUIRED');
  });
});
