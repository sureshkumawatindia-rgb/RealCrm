jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AuditLog = require('../models/AuditLog');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// The first day (100 phases, phase 5, D117): the "Getting started" list ticks each step from the
// company's own data, and ready settings for a trader or a manufacturer fill only what the company
// has not set itself, in the person's language.
const as = (person) => bearer(person.token);
const get = (person, path) => api().get(`/api/v1${path}`).set(as(person));
const send = (person, method, path, body) => api()[method](`/api/v1${path}`).set(as(person)).send(body);
const status = async (person) => (await get(person, '/organization/getting-started')).body.data;
const doneSteps = (data) => data.steps.filter((step) => step.done).map((step) => step.key);
const defaultPipeline = async (person) => (await get(person, '/pipelines')).body.data.find((pipeline) => pipeline.isDefault);
const quickReplies = async (person) => (await get(person, '/quick-replies')).body.data;

describe('The Getting started list', () => {
  it('ticks each step from the company\'s own data', async () => {
    const owner = await login('gs-steps@example.com');
    let data = await status(owner);
    expect(data.steps.map((step) => step.key)).toEqual(['business', 'kit', 'whatsapp', 'products', 'leads', 'team', 'quote']);
    expect(data).toMatchObject({ done: 0, total: 7, kit: null, hidden: false });

    await send(owner, 'patch', '/organization', { address: '12 MI Road' });
    await send(owner, 'post', '/whatsapp/accounts', { provider: 'mock' });
    const product = (await send(owner, 'post', '/products', { name: 'Basmati rice', unit: 'bag', pricePaise: 650000, gstRatePct: 5 })).body.data;
    const lead = (await send(owner, 'post', '/leads', { contact: { name: 'Kiran Stores', phone: '98290 51001' }, title: 'Rice 50 bags' })).body.data;
    expect(doneSteps(await status(owner))).toEqual(['business', 'whatsapp', 'products', 'leads']);

    // A quotation counts once it is sent; an invitation counts at once.
    const quotation = (await send(owner, 'post', '/quotations', { leadId: lead.id, items: [{ productId: product.id, quantity: 10 }] })).body.data;
    expect(doneSteps(await status(owner))).not.toContain('quote');
    await send(owner, 'patch', `/quotations/${quotation.id}`, { status: 'Sent' });
    expect((await send(owner, 'post', '/invites', { email: 'gs-steps-helper@example.com', role: 'agent', modules: ['inbox'] })).status).toBe(201);
    data = await status(owner);
    expect(doneSteps(data)).toEqual(['business', 'whatsapp', 'products', 'leads', 'team', 'quote']);
    expect(data.done).toBe(6);
  });

  it('a lead source or an import ticks "leads" too', async () => {
    const owner = await login('gs-sources@example.com');
    await send(owner, 'post', '/lead-sources', { type: 'website' });
    expect(doneSteps(await status(owner))).toEqual(['leads']);
  });

  it('is hidden for one person on every device, and comes back when asked; only owners and admins have it', async () => {
    const owner = await login('gs-hide@example.com');
    const admin = await inviteAndJoin(owner.token, 'gs-hide-admin@example.com', { role: 'admin' });
    const agent = await inviteAndJoin(owner.token, 'gs-hide-agent@example.com', { role: 'agent', modules: ['inbox'] });
    expect((await send(owner, 'patch', '/organization/getting-started', { hidden: true })).body.data.hidden).toBe(true);
    expect((await status(owner)).hidden).toBe(true);
    expect((await status(admin)).hidden).toBe(false);
    expect((await send(owner, 'patch', '/organization/getting-started', { hidden: false })).body.data.hidden).toBe(false);
    expect((await get(agent, '/organization/getting-started')).status).toBe(403);
    expect((await send(agent, 'patch', '/organization/getting-started', { hidden: true })).status).toBe(403);
    expect((await send(owner, 'patch', '/organization/getting-started', {})).status).toBe(400);
  });
});

describe('Ready settings for the business', () => {
  it('a trader\'s stages, quick replies and terms come in the person\'s language', async () => {
    const owner = await login('gs-trader@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    const preview = (await get(owner, '/organization/business-kits')).body.data;
    expect(preview).toMatchObject({ language: 'hi', current: null, keeps: { stages: false, terms: false } });
    expect(preview.kits.map((kit) => kit.id)).toEqual(['trader', 'manufacturer']);
    expect(preview.kits[0].stages).toEqual(['नई पूछताछ', 'रेट भेजा', 'कोटेशन भेजा', 'मोलभाव']);
    expect((await get(owner, '/organization/business-kits?language=en')).body.data.kits[1].stages).toEqual(['New enquiry', 'Requirement understood', 'Sample sent', 'Quotation sent', 'Waiting for PO']);

    const before = await defaultPipeline(owner);
    const res = await send(owner, 'post', '/organization/business-kit', { kit: 'trader' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ kit: 'trader', language: 'hi', stages: 'set', quickReplies: { added: 6, kept: 0 }, terms: 'set' });

    // The stages are renamed in place: each keeps its id, kind and so its leads.
    const after = await defaultPipeline(owner);
    expect(after.stages.map((stage) => [stage.id, stage.kind, stage.name])).toEqual(before.stages.map((stage, index) => [stage.id, stage.kind, preview.kits[0].stages[index]]));
    expect(after.stages[0]).toMatchObject({ probability: 10, quietDays: 1 });
    const replies = await quickReplies(owner);
    expect(replies.map((reply) => reply.shortcut).sort()).toEqual(['dispatch', 'followup', 'moq', 'payment', 'rate', 'thanks']);
    expect(replies.find((reply) => reply.shortcut === 'rate')).toMatchObject({ title: 'रेट लिस्ट' });
    expect(replies.find((reply) => reply.shortcut === 'rate').body).toContain('{{contact.name}}');
    const billing = (await get(owner, '/organization/billing')).body.data;
    expect(billing.terms).toMatch(/^1\. रेट गोदाम से/);
    expect(billing.validityDays).toBe(7);

    const data = await status(owner);
    expect(data.kit).toBe('trader');
    expect(doneSteps(data)).toContain('kit');
    expect(await AuditLog.countDocuments({ action: 'onboarding.kit_applied' })).toBe(1);
  });

  it('never overwrites what the company set itself, and a second kit only adds what is missing', async () => {
    const owner = await login('gs-own@example.com');
    await send(owner, 'post', '/quick-replies', { shortcut: 'payment', title: 'Our bank', body: 'Pay to HDFC 1234.' });
    await send(owner, 'put', '/organization/billing', { terms: 'Our own terms.' });
    const pipeline = await defaultPipeline(owner);
    const renamed = pipeline.stages.map((stage, index) => ({ ...stage, name: index === 0 ? 'Fresh' : stage.name }));
    expect((await send(owner, 'patch', `/pipelines/${pipeline.id}`, { stages: renamed })).status).toBe(200);
    // Stages, quick replies and terms all set by hand: the step ticks without a kit.
    expect(doneSteps(await status(owner))).toEqual(['kit']);

    const made = (await send(owner, 'post', '/organization/business-kit', { kit: 'manufacturer', language: 'en' })).body.data;
    expect(made).toEqual({ kit: 'manufacturer', language: 'en', stages: 'kept', quickReplies: { added: 6, kept: 1 }, terms: 'kept' });
    expect((await defaultPipeline(owner)).stages.map((stage) => stage.name)).toEqual(['Fresh', 'Contacted', 'Quote Sent', 'Negotiation']);
    expect((await quickReplies(owner)).find((reply) => reply.shortcut === 'payment')).toMatchObject({ title: 'Our bank', body: 'Pay to HDFC 1234.' });
    expect((await get(owner, '/organization/billing')).body.data.terms).toBe('Our own terms.');
    expect((await get(owner, '/organization/business-kits')).body.data.keeps).toEqual({ stages: true, terms: true });

    // The trader's kit later: only its two shortcuts that are still free.
    const second = (await send(owner, 'post', '/organization/business-kit', { kit: 'trader', language: 'en' })).body.data;
    expect(second.quickReplies).toEqual({ added: 2, kept: 4 });
    expect((await status(owner)).kit).toBe('trader');
  });

  it('a manufacturer\'s extra stage comes after the first of its kind, and the old stages keep their ids', async () => {
    const owner = await login('gs-maker@example.com');
    const before = await defaultPipeline(owner);
    await send(owner, 'post', '/organization/business-kit', { kit: 'manufacturer', language: 'en' });
    const after = await defaultPipeline(owner);
    expect(after.stages.map((stage) => [stage.kind, stage.name])).toEqual([
      ['New', 'New enquiry'], ['Contacted', 'Requirement understood'], ['Contacted', 'Sample sent'], ['Quote Sent', 'Quotation sent'], ['Negotiation', 'Waiting for PO'],
    ]);
    const ids = after.stages.map((stage) => String(stage.id));
    expect([ids[0], ids[1], ids[3], ids[4]]).toEqual(before.stages.map((stage) => String(stage.id)));
    expect(before.stages.map((stage) => String(stage.id))).not.toContain(ids[2]);
  });

  it('only owners and admins choose, from the two kits, and another company is never touched', async () => {
    const owner = await login('gs-guard@example.com');
    const agent = await inviteAndJoin(owner.token, 'gs-guard-agent@example.com', { role: 'agent', modules: ['inbox'] });
    const other = await login('gs-other@example.com');
    expect((await get(agent, '/organization/business-kits')).status).toBe(403);
    expect((await send(agent, 'post', '/organization/business-kit', { kit: 'trader' })).status).toBe(403);
    expect((await send(owner, 'post', '/organization/business-kit', { kit: 'florist' })).status).toBe(400);
    expect((await send(owner, 'post', '/organization/business-kit', { kit: 'trader', language: 'fr' })).status).toBe(400);

    const theirs = await defaultPipeline(other);
    await send(owner, 'post', '/organization/business-kit', { kit: 'trader', language: 'en' });
    expect(await defaultPipeline(other)).toEqual(theirs);
    expect(await quickReplies(other)).toEqual([]);
    expect((await status(other)).kit).toBeNull();
  });
});
