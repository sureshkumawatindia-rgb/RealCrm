jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AutomationRun = require('../models/AutomationRun');
const Lead = require('../models/Lead');
const Notification = require('../models/Notification');
const queue = require('../jobs/queue');
const engine = require('../services/automation/engine');
const leadRouting = require('../services/leadRoutingService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Checkpoint A of the last 5% (D99): the company's own fields (D73) in automations — conditions,
// {{contact.cf.<key>}} in messages and template blanks — in quick replies, on the Inbox's
// customer panel (frontend), and written by the public API on leads.
const as = (user) => ({
  get: (path) => api().get(`/api/v1${path}`).set(bearer(user.token)),
  post: (path, body = {}) => api().post(`/api/v1${path}`).set(bearer(user.token)).send(body),
  patch: (path, body) => api().patch(`/api/v1${path}`).set(bearer(user.token)).send(body),
});
const pub = (key) => ({
  get: (path) => api().get(`/api/public/v1${path}`).set('Authorization', `Bearer ${key}`),
  post: (path, body) => api().post(`/api/public/v1${path}`).set('Authorization', `Bearer ${key}`).send(body),
  patch: (path, body) => api().patch(`/api/public/v1${path}`).set('Authorization', `Bearer ${key}`).send(body),
});
// Events reach the queue a moment after the request (bus → enqueue): wait, then run what is due.
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};

beforeAll(() => {
  leadRouting.attach(queue);
  engine.register(queue);
});
afterAll(() => queue.stop());

describe('Custom fields in automations, quick replies and the public API (D99)', () => {
  let owner;
  let agent; // automation, leads (all), customers, inbox; Margin is hidden from agents
  let noCustomers; // automation and leads only
  let fields;
  let templates;
  let dealer;

  const field = async (object, label, type, extra = {}) => {
    const res = await as(owner).post('/custom-fields', { object, label, type, ...extra });
    if (res.status !== 201) throw new Error(`field ${label}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const customer = async (name, phone, customFields) => (await as(owner).post('/contacts', { name, phone, lifecycle: 'lead', customFields })).body.data;
  const workflow = (user, body) => as(user).post('/workflows', { name: 'Flow', status: 'Active', trigger: { type: 'lead.created' }, steps: [{ type: 'tag.add', params: { tag: 'x' } }], ...body });

  beforeAll(async () => {
    owner = await login('cfa-owner@example.com', { name: 'Meena' });
    agent = await inviteAndJoin(owner.token, 'cfa-agent@example.com', { role: 'agent', modules: ['automation', 'leads', 'customers', 'inbox'], permissions: ['leads:view_all'] });
    noCustomers = await inviteAndJoin(owner.token, 'cfa-nocust@example.com', { role: 'agent', modules: ['automation', 'leads'] });
    await as(owner).post('/whatsapp/accounts', { provider: 'mock' });
    templates = Object.fromEntries((await as(owner).post('/templates/sync')).body.data.map((t) => [t.name, t]));
    fields = {
      zone: await field('contact', 'Zone', 'dropdown', { options: [{ label: 'North' }, { label: 'South' }] }),
      visit: await field('contact', 'Visit date', 'date'),
      budget: await field('lead', 'Budget', 'number'),
      requirement: await field('lead', 'Requirement', 'text'),
      approved: await field('lead', 'Approved', 'checkbox'),
      margin: await field('lead', 'Margin', 'number', { access: { agent: 'hidden' } }),
      dealer: await field('lead', 'Dealer', 'lookup', { lookupTarget: 'contact' }),
    };
    dealer = await customer('Sharma Distributors', '9829011001');
  });

  it('offers the fields to the builders as each member may use them', async () => {
    const meta = (await as(owner).get('/workflows/meta')).body.data;
    const zone = meta.conditions.find((c) => c.field === 'cf.contact.zone');
    expect(zone).toMatchObject({ label: 'Customer: Zone', ops: ['in', 'notIn', 'empty', 'filled'], customField: { object: 'contact', key: 'zone', type: 'dropdown', options: [{ value: 'o1', label: 'North' }, { value: 'o2', label: 'South' }] } });
    expect(meta.conditions.find((c) => c.field === 'cf.lead.dealer').customField).toMatchObject({ type: 'lookup', lookupTarget: 'contact' });
    expect(meta.variableValues).toEqual(expect.arrayContaining(['contact.name', 'contact.cf.zone', 'lead.cf.budget', 'lead.cf.margin']));
    expect(meta.placeholders).toEqual(expect.arrayContaining(['contact.cf.visit_date', 'lead.cf.requirement']));
    // Margin is hidden from agents (D77); customer fields need the Customers page.
    const agentMeta = (await as(agent).get('/workflows/meta')).body.data;
    expect(agentMeta.variableValues).toContain('lead.cf.budget');
    expect(agentMeta.variableValues).not.toContain('lead.cf.margin');
    expect(agentMeta.conditions.some((c) => c.field === 'cf.lead.margin')).toBe(false);
    const narrow = (await as(noCustomers).get('/workflows/meta')).body.data;
    expect(narrow.customFields.map((f) => `${f.object}.${f.key}`)).not.toContain('contact.zone');
    expect(narrow.customFields.map((f) => `${f.object}.${f.key}`)).toContain('lead.budget');
  });

  it('checks a condition on a field: the field, the words for its type and the value', async () => {
    const check = async (user, conditions, steps = [{ type: 'tag.add', params: { tag: 'x' } }]) => (await as(user).post('/workflows/check', { name: 'C', trigger: { type: 'lead.created' }, conditions, steps })).body.data;
    expect(await check(owner, [
      { field: 'cf.contact.zone', op: 'notIn', value: ['o2'] }, { field: 'cf.lead.budget', op: 'gte', value: 50000 },
      { field: 'cf.lead.approved', op: 'yes' }, { field: 'cf.contact.visit_date', op: 'before', value: '2026-12-31' },
      { field: 'cf.lead.requirement', op: 'has', value: 'pump' }, { field: 'cf.lead.dealer', op: 'is', value: dealer.id },
    ])).toEqual({ ok: true, problems: [] });
    const { problems } = await check(owner, [
      { field: 'cf.lead.nothing', op: 'filled' },
      { field: 'cf.lead.budget', op: 'has', value: 'x' },
      { field: 'cf.contact.zone', op: 'in', value: ['o9'] },
      { field: 'cf.contact.zone', op: 'in' },
      { field: 'cf.contact.visit_date', op: 'eq', value: '17/10/2026' },
      { field: 'cf.lead.dealer', op: 'is', value: '64b7f0c2a1b2c3d4e5f60718' },
    ]);
    const at = (index) => problems.find((p) => p.card === 'condition' && p.index === index);
    expect(at(0)).toMatchObject({ code: 'UNKNOWN_FIELD', path: 'conditions.0.field' });
    expect(at(1)).toMatchObject({ code: 'INVALID_OP', path: 'conditions.1.op' });
    expect(at(2)).toMatchObject({ code: 'INVALID_VALUE', path: 'conditions.2.value' });
    expect(at(3)).toMatchObject({ code: 'INVALID' });
    expect(at(3).message).toMatch(/workflow builder/);
    expect(at(4)).toMatchObject({ code: 'INVALID_VALUE' });
    expect(at(5)).toMatchObject({ code: 'INVALID_VALUE' });

    // The Sales Automation page has no input for the value: saving there says where to set it.
    const fromOldPage = await workflow(owner, { conditions: [{ field: 'cf.contact.zone', op: 'in' }] });
    expect(fromOldPage.status).toBe(400);
    expect(fromOldPage.body.errors[0].message).toMatch(/workflow builder/); // what the pages show

    // A field hidden from the member (D77) is one that does not exist, in conditions and texts.
    const hidden = await workflow(agent, { conditions: [{ field: 'cf.lead.margin', op: 'gt', value: 10 }] });
    expect(hidden.body.errors[0]).toMatchObject({ field: 'conditions.0.field', code: 'UNKNOWN_FIELD' });
    const inText = await workflow(agent, { steps: [{ type: 'agent.notify', params: { to: 'owner', message: 'Margin {{ lead.cf.margin }}' } }] });
    expect(inText.body.errors[0]).toMatchObject({ field: 'steps.0.params.message', code: 'UNKNOWN_PLACEHOLDER' });
    const inBlank = await workflow(agent, { steps: [{ type: 'whatsapp.template', params: { templateId: templates.order_update.id, variables: { body: { 1: 'lead.cf.margin', 2: 'contact.name' } } } }] });
    expect(inBlank.body.errors[0]).toMatchObject({ code: 'VARIABLE_REQUIRED' });
    const inWords = await workflow(agent, { steps: [{ type: 'whatsapp.template', params: { templateId: templates.order_update.id, variables: { body: { 1: 'contact.name', 2: 'text:{{lead.cf.margin}}' } } } }] });
    expect(inWords.body.errors[0]).toMatchObject({ code: 'UNKNOWN_PLACEHOLDER' });
    expect((await workflow(agent, { conditions: [{ field: 'cf.lead.budget', op: 'gt', value: 10 }], steps: [{ type: 'agent.notify', params: { to: 'owner', message: 'Budget {{lead.cf.budget}}' } }] })).status).toBe(201);
  });

  it('starts a workflow only for leads whose fields fit, and fills their values in as words', async () => {
    const made = await workflow(owner, {
      name: 'Big northern leads',
      conditions: [{ field: 'cf.contact.zone', op: 'in', value: ['o1'] }, { field: 'cf.lead.budget', op: 'gte', value: 50000 }],
      steps: [{ type: 'agent.notify', params: { to: 'managers', message: '{{contact.name}} ({{contact.cf.zone}}, visit {{contact.cf.visit_date}}) wants {{lead.cf.requirement}} for Rs {{lead.cf.budget}} via {{lead.cf.dealer}}{{lead.cf.approved}}' } }],
    });
    expect(made.status).toBe(201);
    const north = await customer('Ravi Traders', '9829011002', { zone: 'o1', visit_date: '2026-10-17' });
    const south = await customer('Kannan Stores', '9829011003', { zone: 'o2' });
    await as(owner).post('/leads', { contactId: north.id, title: 'Pumps', customFields: { budget: 125000, requirement: '50 pumps', dealer: dealer.id } });
    await as(owner).post('/leads', { contactId: north.id, title: 'Small', customFields: { budget: 5000 } });
    await as(owner).post('/leads', { contactId: south.id, title: 'Pumps', customFields: { budget: 125000 } });
    await settle();
    const runs = await AutomationRun.find({ workflowId: made.body.data.id });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('done');
    const note = await Notification.findOne({ title: /^Ravi Traders/ });
    expect(note.title).toBe('Ravi Traders (North, visit 17 Oct 2026) wants 50 pumps for Rs 1,25,000 via Sharma Distributors');

    // An archived field reads as empty, and the builder says so.
    const archived = await field('contact', 'Old code', 'text');
    const draft = { name: 'Old', trigger: { type: 'lead.created' }, conditions: [{ field: 'cf.contact.old_code', op: 'empty' }], steps: [{ type: 'tag.add', params: { tag: 'x' } }] };
    await as(owner).post(`/custom-fields/${archived.id}/archive`);
    const checked = (await as(owner).post('/workflows/check', draft)).body.data;
    expect(checked.ok).toBe(true);
    expect(checked.problems).toEqual([expect.objectContaining({ code: 'FIELD_ARCHIVED', level: 'warning', card: 'condition', index: 0 })]);
  });

  it('matches each kind of field the way the list filters do', () => {
    const def = (key, type, status = 'active') => ({ key, type, status });
    const ctx = {
      contact: { customFields: { name_text: 'Shree Ganesh Pumps', zone: 'o1', old: 'kept' } },
      lead: { customFields: { budget: 75000, due: '2026-10-17', ok: true, dealer: '64b7f0c2a1b2c3d4e5f60718' } },
      fields: {
        contact: [def('name_text', 'text'), def('zone', 'dropdown'), def('old', 'text', 'archived'), def('blank', 'text')],
        lead: [def('budget', 'number'), def('due', 'date'), def('ok', 'checkbox'), def('dealer', 'lookup'), def('nope', 'checkbox')],
      },
    };
    const passes = (field, op, value) => engine.conditionsMatch([{ field, op, ...(value !== undefined && { value }) }], ctx);
    expect(passes('cf.contact.name_text', 'has', 'GANESH')).toBe(true);
    expect(passes('cf.contact.name_text', 'is', 'shree ganesh pumps')).toBe(true);
    expect(passes('cf.contact.name_text', 'is', 'shree')).toBe(false);
    expect(passes('cf.contact.zone', 'in', ['o1', 'o2'])).toBe(true);
    expect(passes('cf.contact.zone', 'notIn', ['o1'])).toBe(false);
    expect(passes('cf.contact.blank', 'empty')).toBe(true);
    expect(passes('cf.contact.blank', 'filled')).toBe(false);
    expect(passes('cf.contact.old', 'empty')).toBe(true); // archived: its value is not shown
    expect(passes('cf.contact.gone', 'empty')).toBe(false); // not a field at all
    expect(['eq', 'gt', 'gte', 'lt', 'lte'].map((op) => passes('cf.lead.budget', op, 75000))).toEqual([true, false, true, false, true]);
    expect(['eq', 'before', 'after', 'from', 'to'].map((op) => passes('cf.lead.due', op, '2026-10-17'))).toEqual([true, false, false, true, true]);
    expect(passes('cf.lead.due', 'before', '2026-11-01')).toBe(true);
    expect([passes('cf.lead.ok', 'yes'), passes('cf.lead.ok', 'no'), passes('cf.lead.nope', 'no')]).toEqual([true, false, true]);
    expect(passes('cf.lead.dealer', 'is', '64b7f0c2a1b2c3d4e5f60718')).toBe(true);
    expect(passes('cf.lead.dealer', 'is', '64b7f0c2a1b2c3d4e5f60719')).toBe(false);
  });

  it('previews the fields on a real lead: what it has, and the template blanks they fill', async () => {
    const ravi = await customer('Preview Traders', '9829011004', { zone: 'o2' });
    const lead = (await as(owner).post('/leads', { contactId: ravi.id, title: 'Valves', customFields: { budget: 9000 } })).body.data;
    const res = await as(owner).post('/workflows/preview', {
      leadId: lead.id,
      draft: {
        name: 'P', trigger: { type: 'lead.created' }, conditions: [{ field: 'cf.contact.zone', op: 'in', value: ['o1'] }],
        steps: [{ type: 'whatsapp.template', params: { templateId: templates.order_update.id, variables: { body: { 1: 'contact.cf.zone', 2: 'text:Rs {{lead.cf.budget}}' } } } }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.conditions[0]).toMatchObject({ passed: false, actual: 'South' });
    expect(res.body.data.steps[0].facts.variables.body).toEqual({ 1: 'South', 2: 'Rs 9,000' });
  });

  describe('quick replies', () => {
    let chat;
    let reply;
    beforeAll(async () => {
      const inbound = await as(owner).post('/dev/simulate/whatsapp-inbound', { from: '98290 11005', text: 'Rate?', name: 'Sunita Agencies' });
      chat = inbound.body.data;
      await as(owner).patch(`/contacts/${chat.contactId}`, { customFields: { zone: 'o1' } });
      await as(owner).post('/leads', { contactId: chat.contactId, title: 'Motors', customFields: { budget: 40000, margin: 12 } });
      reply = (await as(owner).post('/quick-replies', {
        shortcut: 'hello', body: 'Namaste {{contact.name}} ({{contact.cf.zone}}), {{lead.title}} for Rs {{lead.cf.budget}}. M{{lead.cf.margin}} T{{contact.phone}}',
      })).body.data;
    });
    const fill = (user, conversationId = chat.conversationId) => as(user).post(`/quick-replies/${reply.id}/fill`, { conversationId });

    it('fills a reply for the chat\'s customer, as the member sees them', async () => {
      const mine = (await fill(owner)).body.data;
      expect(mine).toEqual({ text: 'Namaste Sunita Agencies (North), Motors for Rs 40,000. M12 T+919829011005', missing: [] });
      // The agent: Margin is hidden from agents (D77), numbers are masked for them (D65).
      const theirs = (await fill(agent)).body.data;
      expect(theirs.text).toBe('Namaste Sunita Agencies (North), Motors for Rs 40,000. M T');
      expect(theirs.missing).toEqual(['{{lead.cf.margin}}', '{{contact.phone}}']);
    });

    it('leaves out what the member may not open, and private chats stay private', async () => {
      const agentNoCustomers = await inviteAndJoin(owner.token, 'cfa-inbox@example.com', { role: 'agent', modules: ['inbox'] });
      const theirs = (await fill(agentNoCustomers)).body.data;
      expect(theirs.text).toBe('Namaste Sunita Agencies (),  for Rs . M T');
      expect(theirs.missing).toEqual(['{{contact.cf.zone}}', '{{lead.title}}', '{{lead.cf.budget}}', '{{lead.cf.margin}}', '{{contact.phone}}']);
      expect((await as(owner).post(`/conversations/${chat.conversationId}/private`, {})).status).toBe(201);
      expect((await fill(agent)).status).toBe(404);
      expect((await fill(owner)).status).toBe(200);
      expect((await fill(owner, '64b7f0c2a1b2c3d4e5f60718')).status).toBe(404);
    });
  });

  it('gives the link picker the name of one chosen record, if the member may see it', async () => {
    const found = (await as(owner).get(`/lookup?target=contact&id=${dealer.id}`)).body.data;
    expect(found).toEqual([{ id: dealer.id, name: 'Sharma Distributors', subtitle: '' }]);
    // Agents see only their own customers (no customers:view_all): nothing.
    expect((await as(agent).get(`/lookup?target=contact&id=${dealer.id}`)).body.data).toEqual([]);
  });

  describe('public API: the lead\'s own fields', () => {
    let key;
    let narrowKey;
    let workflowId;
    beforeAll(async () => {
      key = (await as(owner).post('/api-keys', { name: 'Website', scopes: ['leads:read', 'leads:write'] })).body.data.key;
      narrowKey = (await as(owner).post('/api-keys', { name: 'Read only', scopes: ['leads:read'] })).body.data.key;
      await field('lead', 'Tender no', 'text', { required: true });
      workflowId = (await workflow(owner, { name: 'API budgets', conditions: [{ field: 'cf.lead.budget', op: 'gte', value: 100000 }] })).body.data.id;
    });

    it('takes them with a new enquiry, checked before anything is saved, and automations see them', async () => {
      const before = await Lead.countDocuments();
      const bad = await pub(key).post('/leads', { contact: { name: 'Bad', phone: '9829011006' }, product: 'Pipes', customFields: { budget: 'lots' } });
      expect(bad.status).toBe(400);
      expect(bad.body.errors[0]).toMatchObject({ field: 'customFields.budget', code: 'INVALID_TYPE' });
      expect(await Lead.countDocuments()).toBe(before);

      const res = await pub(key).post('/leads', { contact: { name: 'Api Buyer', phone: '9829011007' }, product: 'Pipes', customFields: { budget: 150000, requirement: '200 pipes', approved: true } });
      expect(res.status).toBe(201);
      expect(res.body.data.lead.customFields).toEqual({ budget: 150000, requirement: '200 pipes', approved: true });
      await settle();
      expect(await AutomationRun.countDocuments({ workflowId, 'subject.leadId': res.body.data.lead.id })).toBe(1);

      // The same customer's open lead gets the next enquiry: only the sent fields change.
      const again = await pub(key).post('/leads', { contact: { name: 'Api Buyer', phone: '9829011007' }, product: 'Pipes', customFields: { requirement: '300 pipes' } });
      expect(again.body.data).toMatchObject({ outcome: 'attached', lead: { id: res.body.data.lead.id, customFields: { budget: 150000, requirement: '300 pipes', approved: true } } });
    });

    it('changes them with PATCH /leads/:id; empty clears one; a required field never stops it', async () => {
      const lead = (await pub(key).post('/leads', { contact: { name: 'Patch Buyer', phone: '9829011008' }, product: 'Taps', customFields: { budget: 20000 } })).body.data.lead;
      const res = await pub(key).patch(`/leads/${lead.id}`, { title: 'Taps, 500 pcs', expectedValuePaise: 4500000, customFields: { budget: null, requirement: 'Brass' } });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ title: 'Taps, 500 pcs', expectedValuePaise: 4500000, customFields: { requirement: 'Brass' } });
      expect(res.body.data.customFields.budget).toBeUndefined();
      expect((await pub(key).patch(`/leads/${lead.id}`, { customFields: { budget: 'x' } })).status).toBe(400);
      expect((await pub(key).patch(`/leads/${lead.id}`, { stage: 'Won' })).status).toBe(400);
      expect((await pub(narrowKey).patch(`/leads/${lead.id}`, { title: 'No' })).status).toBe(403);
      // Private numbers (D61) are never for other software.
      await Lead.updateOne({ _id: lead.id }, { $set: { private: true } });
      expect((await pub(key).patch(`/leads/${lead.id}`, { title: 'Hidden' })).status).toBe(404);
    });
  });
});
