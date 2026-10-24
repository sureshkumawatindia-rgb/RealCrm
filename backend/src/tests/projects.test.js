jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Project = require('../models/Project');
const Task = require('../models/Task');
const queue = require('../jobs/queue');
const projectService = require('../services/projectService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Projects after the sale (Phase 10, D92): templates, "start the project" on a won deal (once),
// the automatic one on Won, progress on the deal and customer, and permissions apart from sales.
const req = (token) => ({
  get: (path) => api().get(`/api/v1${path}`).set(bearer(token)),
  post: (path, body) => api().post(`/api/v1${path}`).set(bearer(token)).send(body),
  put: (path, body) => api().put(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, body) => api().patch(`/api/v1${path}`).set(bearer(token)).send(body),
  del: (path) => api().delete(`/api/v1${path}`).set(bearer(token)),
});
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};
const TEMPLATE = {
  name: 'Solar installation', days: 30,
  milestones: [{ name: 'Site survey', dueAfterDays: 3 }, { name: 'Installation', dueAfterDays: 20 }, { name: 'Handover', dueAfterDays: 30 }],
  tasks: [
    { title: 'Visit the site', milestone: 0, dueAfterDays: 2, priority: 'High' },
    { title: 'Order the panels', milestone: 1, dueAfterDays: 5 },
    { title: 'Train the customer', milestone: 2, dueAfterDays: 30, forManager: false },
  ],
};

beforeAll(() => projectService.register(queue));
afterAll(() => queue.stop());

describe('Projects from won deals', () => {
  it('starts once from a won deal with its template, in one go, and shows the progress', async () => {
    const owner = await login('pj-owner@example.com', { name: 'Meera' });
    const o = req(owner.token);
    expect((await o.post('/project-templates', { ...TEMPLATE, tasks: [{ title: 'x', milestone: 5 }] })).body.errors[0].code).toBe('INVALID_MILESTONE');
    const template = (await o.post('/project-templates', TEMPLATE)).body.data;
    const lead = (await o.post('/leads', { title: 'Rooftop 10 kW', contact: { name: 'Bhatia Farms', phone: '+919829080901' }, expectedValuePaise: 45000000 })).body.data;

    expect((await o.post(`/leads/${lead.id}/project`, { templateId: template.id })).body.code).toBe('DEAL_NOT_WON');
    await o.post(`/leads/${lead.id}/stage`, { stage: 'Won' });
    const first = await o.post(`/leads/${lead.id}/project`, { templateId: template.id });
    expect(first.status).toBe(201);
    const project = first.body.data;
    expect(project).toMatchObject({ number: 'PR-0001', name: 'Rooftop 10 kW — Bhatia Farms', status: 'not_started', valuePaise: 45000000, progress: 0, tasks: { total: 3, done: 0 } });
    expect(project.milestones.map((m) => m.name)).toEqual(['Site survey', 'Installation', 'Handover']);
    // Again (a double click): the same project.
    const again = await o.post(`/leads/${lead.id}/project`, { templateId: template.id });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(project.id);
    expect(await Project.countDocuments({ leadId: lead.id })).toBe(1);

    const tasks = (await o.get(`/projects/${project.id}/tasks`)).body.data;
    expect(tasks.map((t) => [t.title, Boolean(t.milestoneId), Boolean(t.assigneeId)])).toEqual([['Visit the site', true, true], ['Order the panels', true, true], ['Train the customer', true, false]]);
    expect(tasks[0].relatedType).toBe('Project');
    // The Tasks page's form cannot take a project's task off its project.
    await o.patch(`/tasks/${tasks[1].id}`, { title: 'Order the panels (40)', relatedType: '', relatedName: '' });
    expect((await o.get(`/projects/${project.id}/tasks`)).body.data.map((t) => t.title)).toContain('Order the panels (40)');
    await o.patch(`/projects/${project.id}/tasks/${tasks[0].id}`, { status: 'Done' });
    const after = (await o.get(`/projects/${project.id}`)).body.data;
    expect(after).toMatchObject({ status: 'in_progress', progress: 33, tasks: { total: 3, done: 1 } });
    // The deal and the customer show it.
    expect((await o.get(`/projects/summary?leadId=${lead.id}`)).body.data).toMatchObject({ canView: true, count: 1, items: [{ id: project.id, progress: 33, status: 'in_progress' }] });
    expect((await o.get(`/projects/summary?contactId=${lead.contactId}`)).body.data.items).toHaveLength(1);

    // A milestone ticked; a project with no tasks counts milestones.
    const bare = (await o.post('/projects', { name: 'Annual maintenance', contactId: lead.contactId })).body.data;
    const withMilestone = (await o.post(`/projects/${bare.id}/milestones`, { name: 'First visit' })).body.data;
    await o.post(`/projects/${bare.id}/milestones`, { name: 'Second visit' });
    const ticked = (await o.patch(`/projects/${bare.id}/milestones/${withMilestone.milestones[0].id}`, { done: true })).body.data;
    expect(ticked.progress).toBe(50);

    // Deleted: the deal may start a new one; its tasks go too.
    await o.del(`/projects/${project.id}`);
    expect(await Task.countDocuments({ relatedType: 'Project', relatedId: project.id })).toBe(0);
    const restart = await o.post(`/leads/${lead.id}/project`, {});
    expect(restart.status).toBe(201);
    expect(restart.body.data.id).not.toBe(project.id);
  });

  it('never makes two projects when the button and others race', async () => {
    const owner = await login('pj-race@example.com');
    const o = req(owner.token);
    const lead = (await o.post('/leads', { title: 'Borewell pump', contact: { name: 'Gill Agro', phone: '+919829080902' } })).body.data;
    await o.post(`/leads/${lead.id}/stage`, { stage: 'Won' });
    const answers = await Promise.all([1, 2, 3, 4].map(() => o.post(`/leads/${lead.id}/project`, {})));
    expect(answers.map((a) => a.status).sort()).toEqual([200, 200, 200, 201]);
    expect(new Set(answers.map((a) => a.body.data.id)).size).toBe(1);
    expect(await Project.countDocuments({ leadId: lead.id })).toBe(1);
  });

  it('starts the project by itself on Won when switched on, once', async () => {
    const owner = await login('pj-auto@example.com');
    const agent = await inviteAndJoin(owner.token, 'pj-auto-agent@example.com', { role: 'agent', modules: ['leads', 'deals', 'projects'] });
    const o = req(owner.token);
    const template = (await o.post('/project-templates', TEMPLATE)).body.data;
    expect((await req(agent.token).put('/projects/settings', { onWon: { enabled: true } })).status).toBe(403);
    expect((await o.put('/projects/settings', { onWon: { enabled: true, templateId: template.id } })).body.data).toEqual({ onWon: { enabled: true, templateId: template.id } });
    const lead = (await o.post('/leads', { title: 'Cold room', contact: { name: 'Patel Dairy', phone: '+919829080903' } })).body.data;
    await o.post(`/leads/${lead.id}/stage`, { stage: 'Won' });
    await settle();
    expect(await Project.countDocuments({ leadId: lead.id })).toBe(1);
    expect(await Task.countDocuments({ relatedType: 'Project', relatedId: (await Project.findOne({ leadId: lead.id }))._id })).toBe(3);
    // Lost and won again, and the job run twice: still one.
    await o.post(`/leads/${lead.id}/stage`, { stage: 'Lost', lostReason: 'Price' });
    await o.post(`/leads/${lead.id}/stage`, { stage: 'Won' });
    await settle();
    await projectService.runWonJob({ organizationId: lead.organizationId || (await Project.findOne({ leadId: lead.id })).organizationId, leadId: lead.id });
    expect(await Project.countDocuments({ leadId: lead.id })).toBe(1);
    // Switched off: a won deal starts nothing.
    await o.put('/projects/settings', { onWon: { enabled: false } });
    const other = (await o.post('/leads', { title: 'Second cold room', contact: { name: 'Shah Dairy', phone: '+919829080904' } })).body.data;
    await o.post(`/leads/${other.id}/stage`, { stage: 'Won' });
    await settle();
    expect(await Project.countDocuments({ leadId: other.id })).toBe(0);
  });
});

describe('Project permissions', () => {
  it('keeps projects apart from sales, and companies apart', async () => {
    const owner = await login('pj-perm@example.com', { name: 'Raj' });
    const seller = await inviteAndJoin(owner.token, 'pj-seller@example.com', { role: 'agent', modules: ['leads', 'deals', 'customers'], permissions: ['leads:view_all'] });
    const doer = await inviteAndJoin(owner.token, 'pj-doer@example.com', { role: 'agent', modules: ['projects'] });
    const outsider = await inviteAndJoin(owner.token, 'pj-out@example.com', { role: 'agent', modules: ['projects', 'leads'] });
    const doerId = (await req(owner.token).get('/members')).body.data.find((m) => m.email === 'pj-doer@example.com').id;
    const o = req(owner.token);
    const lead = (await o.post('/leads', { title: 'Office fit-out', contact: { name: 'Kapoor Legal', phone: '+919829080905' } })).body.data;
    await o.post(`/leads/${lead.id}/stage`, { stage: 'Won' });

    // Sales access is not project access.
    expect((await req(seller.token).post(`/leads/${lead.id}/project`, {})).status).toBe(403);
    expect((await req(seller.token).get('/projects')).status).toBe(403);
    const project = (await o.post(`/leads/${lead.id}/project`, { managerId: doerId })).body.data;
    expect((await req(seller.token).get(`/projects/summary?leadId=${lead.id}`)).body.data).toEqual({ canView: false, count: 1, items: [] });
    // Project access is not sales access: the deal must be visible to start from it.
    expect((await req(outsider.token).post(`/leads/${lead.id}/project`, {})).status).toBe(404);
    // A member sees the projects they are on.
    expect((await req(doer.token).get('/projects')).body.data.map((p) => p.id)).toEqual([project.id]);
    expect((await req(outsider.token).get('/projects')).body.data).toEqual([]);
    expect((await req(outsider.token).get(`/projects/${project.id}`)).status).toBe(404);
    // The manager changes it; a teammate on it only ticks.
    expect((await req(doer.token).patch(`/projects/${project.id}`, { status: 'on_hold' })).body.data.status).toBe('on_hold');
    const stranger = await login('pj-stranger@example.com');
    expect((await req(stranger.token).get(`/projects/${project.id}`)).status).toBe(404);
    expect((await req(stranger.token).post(`/leads/${lead.id}/project`, {})).status).toBe(404);
    expect((await req(stranger.token).get(`/projects/summary?leadId=${lead.id}`)).body.data.count).toBe(0);
  });
});
