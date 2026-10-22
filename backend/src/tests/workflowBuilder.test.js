jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AutomationRun = require('../models/AutomationRun');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Task = require('../models/Task');
const Job = require('../models/Job');
const queue = require('../jobs/queue');
const engine = require('../services/automation/engine');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// The visual workflow builder (Phase 7A, D86): every problem of a draft at once, a preview on one
// lead that changes nothing, ready-made recipes; and the engine's pause, stop and test run.
const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;
const post = (token, path, body) => api().post(`/api/v1${path}`).set(bearer(token)).send(body);

beforeAll(() => engine.register(queue));
afterAll(() => queue.stop());

describe('Workflow builder: check, preview and recipes', () => {
  let owner;
  let templates;
  let lead;
  beforeAll(async () => {
    owner = await login('wfb-owner@example.com', { name: 'Ravi' });
    await post(owner.token, '/whatsapp/accounts', { provider: 'mock' });
    templates = Object.fromEntries((await post(owner.token, '/templates/sync', {})).body.data.map((t) => [t.name, t]));
    lead = (await post(owner.token, '/leads', { title: 'TMT bars', source: 'IndiaMART', contact: { name: 'Gupta Steels', phone: '+919829080301', company: 'Gupta Steels' } })).body.data;
  });

  it('lists every problem of a draft at once, on its card, and rejects what the engine does not know', async () => {
    const res = await post(owner.token, '/workflows/check', {
      name: '',
      trigger: { type: 'lead.created', params: { sources: ['Pigeon'] } },
      conditions: [{ field: 'stage', op: 'in', value: [] }, { field: 'moon', op: 'is', value: 1 }],
      steps: [
        { type: 'assign', params: {} },
        { type: 'rocket.launch' },
        { type: 'whatsapp.template', params: { templateId: templates.order_update.id, variables: { body: { 1: 'contact.name' } } } },
        { type: 'task.create', params: { title: 'Call', assignTo: '64b7f0c2a1b2c3d4e5f60718' } },
        { type: 'wait', params: { amount: 2, unit: 'days' } },
      ],
    });
    expect(res.status).toBe(200);
    const { ok, problems } = res.body.data;
    expect(ok).toBe(false);
    const at = (card, index) => problems.filter((p) => p.card === card && p.index === index);
    expect(problems.find((p) => p.path === 'name')).toMatchObject({ card: 'workflow', code: 'REQUIRED' });
    expect(problems.find((p) => p.card === 'trigger')).toMatchObject({ path: 'trigger.params.sources.0', level: 'error' });
    expect(at('condition', 0)).toHaveLength(1);
    expect(at('condition', 1)).toHaveLength(1);
    expect(at('step', 0)[0]).toMatchObject({ path: 'steps.0.params.memberId', code: 'REQUIRED', field: 'memberId' });
    expect(at('step', 1)[0]).toMatchObject({ code: 'UNSUPPORTED' });
    expect(at('step', 2)[0]).toMatchObject({ code: 'VARIABLE_REQUIRED', path: 'steps.2.params.variables.body.2' });
    expect(at('step', 3)[0]).toMatchObject({ code: 'INVALID_MEMBER', path: 'steps.3.params.assignTo' });
    expect(at('step', 4)[0]).toMatchObject({ code: 'WAIT_LAST', level: 'warning' });
    // Saving still refuses an unsupported step, as before.
    expect((await post(owner.token, '/workflows', { name: 'x', trigger: { type: 'lead.created' }, steps: [{ type: 'rocket.launch' }] })).status).toBe(400);

    const good = await post(owner.token, '/workflows/check', { name: 'Fine', trigger: { type: 'lead.created' }, steps: [{ type: 'tag.add', params: { tag: 'new' } }] });
    expect(good.body.data).toEqual({ ok: true, problems: [] });
    const late = await post(owner.token, '/workflows/check', {
      trigger: { type: 'lead.no_reply', params: { hours: 30 } },
      steps: [{ type: 'whatsapp.text', params: { text: 'Hello' } }, { type: 'payment.link', params: {} }],
    });
    expect(late.body.data.ok).toBe(true);
    expect(late.body.data.problems.map((p) => p.code)).toEqual(['OUTSIDE_WINDOW', 'NEEDS_ORDER']);
  });

  it('previews a draft on a real lead without sending, saving or starting anything', async () => {
    const ravi = await memberId(owner.token, 'wfb-owner@example.com');
    const draft = {
      name: 'Portal leads',
      trigger: { type: 'lead.created', params: { sources: ['IndiaMART'] } },
      conditions: [{ field: 'source', op: 'in', value: ['IndiaMART'] }, { field: 'tag', op: 'hasNot', value: 'vip' }],
      steps: [
        { type: 'whatsapp.template', params: { templateId: templates.order_update.id, variables: { body: { 1: 'contact.name', 2: 'text:for {{lead.title}}' } } } },
        { type: 'tag.add', params: { tag: 'portal' } },
        { type: 'tag.add', params: { tag: 'portal' } },
        { type: 'wait', params: { amount: 2, unit: 'hours' } },
        { type: 'stage.change', params: { stage: 'Contacted' } },
        { type: 'task.create', params: { title: 'Call {{contact.name}}', dueInDays: 1 } },
        { type: 'assign', params: { memberId: ravi } },
        { type: 'whatsapp.text', params: { text: 'Hi {{contact.name}}' } },
      ],
    };
    const before = await Promise.all([Message.countDocuments(), Task.countDocuments(), AutomationRun.countDocuments(), Job.countDocuments(), LeadActivity.countDocuments(), Notification.countDocuments()]);
    const res = await post(owner.token, '/workflows/preview', { draft, leadId: lead.id });
    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(p.trigger).toEqual({ type: 'lead.created', matchesLead: true });
    expect(p.conditions.map((c) => [c.field, c.passed, c.actual])).toEqual([['source', true, 'IndiaMART'], ['tag', true, '']]);
    expect(p.wouldRun).toBe(true);
    const steps = p.steps.map((s) => [s.type, s.status, s.reason]);
    expect(steps).toEqual([
      ['whatsapp.template', 'do', null], ['tag.add', 'do', null], ['tag.add', 'skip', 'ALREADY'], ['wait', 'wait', null],
      ['stage.change', 'do', null], ['task.create', 'do', null], ['assign', 'skip', 'ALREADY'], ['whatsapp.text', 'skip', 'NO_CHAT'],
    ]);
    expect(p.steps[0].facts).toMatchObject({ template: 'order_update', variables: { body: { 1: 'Gupta Steels', 2: 'for TMT bars' } }, to: '+919829080301' });
    expect(p.steps[4].facts).toEqual({ from: 'New', to: 'Contacted', deal: 'TMT bars' });
    expect(p.steps[5].facts).toMatchObject({ title: 'Call Gupta Steels', assignee: 'Ravi' });
    expect(new Date(p.steps[4].at) - new Date(p.steps[3].at)).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 1000);
    const after = await Promise.all([Message.countDocuments(), Task.countDocuments(), AutomationRun.countDocuments(), Job.countDocuments(), LeadActivity.countDocuments(), Notification.countDocuments()]);
    expect(after).toEqual(before);
    expect((await Lead.findById(lead.id)).stage).toBe('New');
    expect((await Contact.findById(lead.contactId)).tags).not.toContain('portal');

    // An invalid draft is 400 with every problem; a lead the member cannot see is 404.
    const bad = await post(owner.token, '/workflows/preview', { draft: { trigger: { type: 'lead.created' }, steps: [{ type: 'assign', params: {} }, { type: 'rocket' }] }, leadId: lead.id });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e) => e.field)).toEqual(['steps.0.params.memberId', 'steps.1']);
    const stranger = await login('wfb-stranger@example.com');
    expect((await post(stranger.token, '/workflows/preview', { draft, leadId: lead.id })).status).toBe(400); // their check: Ravi is not their member
    const strangerDraft = { ...draft, steps: [{ type: 'tag.add', params: { tag: 'x' } }] };
    expect((await post(stranger.token, '/workflows/preview', { draft: strangerDraft, leadId: lead.id })).status).toBe(404);
    const agent = await inviteAndJoin(owner.token, 'wfb-agent@example.com', { role: 'agent', modules: ['automation', 'leads'] });
    expect((await post(agent.token, '/workflows/preview', { draft: strangerDraft, leadId: lead.id })).status).toBe(404); // someone else's lead
  });

  it('offers recipes that pass the check once their choices are made', async () => {
    const recipes = (await api().get('/api/v1/workflows/recipes').set(bearer(owner.token))).body.data;
    expect(recipes.map((r) => r.id)).toEqual(['portal-lead-owner', 'welcome-template', 'no-reply-nudge', 'quotation-chase', 'payment-reminder', 'won-celebrate']);
    const ravi = await memberId(owner.token, 'wfb-owner@example.com');
    const choose = (recipe) => ({
      name: recipe.name,
      trigger: recipe.trigger,
      conditions: recipe.conditions,
      steps: recipe.steps.map((s) => {
        if (s.type === 'assign') return { ...s, params: { memberId: ravi } };
        if (s.type === 'whatsapp.template') return { ...s, params: { templateId: templates.order_update.id, variables: { body: { 1: 'contact.name', 2: 'text:hello' } } } };
        return s;
      }),
    });
    const portal = recipes[0];
    const unchosen = (await post(owner.token, '/workflows/check', portal)).body.data;
    expect(unchosen.problems.map((p) => p.path)).toEqual(['steps.0.params.memberId']);
    for (const recipe of recipes) {
      const { ok, problems } = (await post(owner.token, '/workflows/check', choose(recipe))).body.data;
      expect({ id: recipe.id, ok, errors: problems.filter((p) => p.level === 'error') }).toEqual({ id: recipe.id, ok: true, errors: [] });
      expect((await post(owner.token, '/workflows', choose(recipe))).status).toBe(201);
    }
  });

  it('pauses (stopping waiting runs), stops one run, and runs a test once per key', async () => {
    const flow = (await post(owner.token, '/workflows', { name: 'Waits', trigger: { type: 'lead.created' }, steps: [{ type: 'wait', params: { amount: 1, unit: 'days' } }, { type: 'tag.add', params: { tag: 'later' } }] })).body.data;
    const run = (key) => api().post(`/api/v1/workflows/${flow.id}/run`).set(bearer(owner.token)).set('Idempotency-Key', key).send({ leadId: lead.id });
    const first = await run('wfb-test-1');
    const again = await run('wfb-test-1');
    expect(first.status).toBe(202);
    expect(again.body.data.id).toBe(first.body.data.id);
    const second = (await run('wfb-test-2')).body.data;
    await queue.runDue();
    expect((await AutomationRun.findById(first.body.data.id)).status).toBe('waiting');

    const stopped = await post(owner.token, `/automation-runs/${second.id}/cancel`, {});
    expect(stopped.body.data.status).toBe('cancelled');
    expect((await post(owner.token, `/automation-runs/${second.id}/cancel`, {})).status).toBe(409);

    await api().patch(`/api/v1/workflows/${flow.id}`).set(bearer(owner.token)).send({ status: 'Paused' });
    expect((await AutomationRun.findById(first.body.data.id)).status).toBe('cancelled');
    expect((await run('wfb-test-3')).status).toBe(409); // a paused workflow does not run
  });
});
