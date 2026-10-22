jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Pipeline = require('../models/Pipeline');
const LeadStageEvent = require('../models/LeadStageEvent');
const Task = require('../models/Task');
const migration = require('../migrations/007-lead-pipelines');
const { indiaDate } = require('../utils/dates');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 5A (D84): pipelines over the fixed stages, moves with history, the board.
const DAY = 24 * 60 * 60 * 1000;
const auth = (user) => bearer(user.token);
const call = (user, method, path, body) => api()[method](`/api/v1${path}`).set(auth(user)).send(body);
const DEALERS = { name: 'Dealer onboarding', stages: [{ name: 'Enquiry', kind: 'New' }, { name: 'Sample sent', kind: 'Contacted', quietDays: 5 }, { name: 'Price agreed', kind: 'Negotiation', probability: 80 }] };
const newLead = async (user, body) => (await call(user, 'post', '/leads', { contact: { name: body.customer || 'Gupta Steels', phone: body.phone || `+9198290${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}` }, title: body.title || 'Order', ...body.extra })).body.data;

describe('Pipelines, moves and the board (Phase 5A)', () => {
  it('gives every company a default pipeline, keeps companies apart and lets only managers change pipelines', async () => {
    const owner = await login('pipe-owner@example.com', { name: 'Anil' });
    const agent = await inviteAndJoin(owner.token, 'pipe-agent@example.com', { role: 'agent' });
    const list = (await call(owner, 'get', '/pipelines')).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Sales', isDefault: true, openLeads: 0 });
    expect(list[0].stages.map((s) => [s.name, s.kind, s.probability, s.quietDays])).toEqual([['New', 'New', 10, 7], ['Contacted', 'Contacted', 25, 7], ['Quote Sent', 'Quote Sent', 50, 7], ['Negotiation', 'Negotiation', 75, 7]]);
    expect((await call(agent, 'get', '/pipelines')).body.data).toHaveLength(1);
    expect((await call(agent, 'post', '/pipelines', DEALERS)).status).toBe(403);
    const made = await call(owner, 'post', '/pipelines', DEALERS);
    expect(made.status).toBe(201);
    expect(made.body.data.stages.map((s) => s.probability)).toEqual([10, 25, 80]);
    expect((await call(owner, 'post', '/pipelines', DEALERS)).body.code).toBe('NAME_TAKEN');
    expect((await call(owner, 'post', '/pipelines', { name: 'One', stages: [{ name: 'Only', kind: 'New' }] })).status).toBe(400);
    expect((await call(owner, 'post', '/pipelines', { name: 'Twins', stages: [{ name: 'A', kind: 'New' }, { name: 'a', kind: 'Contacted' }] })).body.errors[0].code).toBe('DUPLICATE_STAGE');

    // Another company sees none of it.
    const other = await login('pipe-other@example.com', { name: 'Other' });
    expect((await call(other, 'get', `/pipelines/${made.body.data.id}`)).status).toBe(404);
    expect((await call(other, 'get', `/pipelines/${made.body.data.id}/board`)).status).toBe(404);
    const lead = await newLead(owner, { extra: { pipelineId: made.body.data.id } });
    expect((await call(other, 'post', `/leads/${lead.id}/stage`, { pipelineStageId: made.body.data.stages[1].id })).status).toBe(404);
    const theirs = (await call(other, 'get', '/pipelines')).body.data[0];
    expect((await call(owner, 'post', `/leads/${lead.id}/stage`, { pipelineId: theirs.id })).status).toBe(404);
  });

  it('moves a lead on the board with its version, refuses wrong moves, and records every move once', async () => {
    const owner = await login('move-owner@example.com', { name: 'Bela' });
    const dealers = (await call(owner, 'post', '/pipelines', DEALERS)).body.data;
    const sales = (await call(owner, 'get', '/pipelines')).body.data.find((p) => p.isDefault);
    const lead = await newLead(owner, { title: 'Distributorship', extra: { pipelineId: dealers.id, expectedValuePaise: 20000000 } });
    expect(lead).toMatchObject({ pipelineId: dealers.id, pipelineStageId: dealers.stages[0].id, stage: 'New' });

    const moved = await call(owner, 'post', `/leads/${lead.id}/stage`, { pipelineStageId: dealers.stages[1].id, version: lead.version });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ stage: 'Contacted', pipelineStageId: dealers.stages[1].id, probability: 25 });
    // A stale version, a stage of another pipeline, both a stage and a fixed stage, Lost without a reason.
    expect((await call(owner, 'post', `/leads/${lead.id}/stage`, { pipelineStageId: dealers.stages[2].id, version: lead.version })).body.code).toBe('VERSION_CONFLICT');
    expect((await call(owner, 'post', `/leads/${lead.id}/stage`, { pipelineStageId: sales.stages[2].id })).body.code).toBe('STAGE_NOT_IN_PIPELINE');
    expect((await call(owner, 'post', `/leads/${lead.id}/stage`, { stage: 'Won', pipelineStageId: dealers.stages[2].id })).status).toBe(400);
    expect((await call(owner, 'post', `/leads/${lead.id}/stage`, { stage: 'Lost' })).body.code).toBe('LOST_REASON_REQUIRED');

    // A quotation sent: this pipeline has no "Quote Sent" step, so the lead stays at "Sample sent".
    const quote = (await call(owner, 'post', `/leads/${lead.id}/quotations`, { items: [{ name: 'Starter stock', quantity: 1, unitPricePaise: 20000000 }] })).body.data;
    expect((await call(owner, 'patch', `/quotations/${quote.id}`, { status: 'Sent' })).status).toBe(200);
    const afterQuote = (await call(owner, 'get', `/leads/${lead.id}`)).body.data;
    expect(afterQuote).toMatchObject({ stage: 'Quote Sent', pipelineStageId: dealers.stages[1].id });
    // On to "Price agreed", then Won; Won keeps the last open stage.
    await call(owner, 'post', `/leads/${lead.id}/stage`, { pipelineStageId: dealers.stages[2].id });
    const won = (await call(owner, 'post', `/leads/${lead.id}/stage`, { stage: 'Won' })).body.data;
    expect(won).toMatchObject({ stage: 'Won', pipelineStageId: dealers.stages[2].id, pipelineId: dealers.id });
    // Into another pipeline: the default's stage of its kind (reopened to New there).
    const reopened = (await call(owner, 'post', `/leads/${lead.id}/stage`, { pipelineId: sales.id })).body.data;
    expect(reopened).toMatchObject({ pipelineId: sales.id, pipelineStageId: sales.stages[0].id, stage: 'New' });

    const history = (await call(owner, 'get', `/leads/${lead.id}/stage-history`)).body.data;
    expect(history.map((h) => [h.from.name, h.to.name, h.source])).toEqual([
      ['', 'Enquiry', 'create'],
      ['Enquiry', 'Sample sent', 'board'],
      ['Sample sent', 'Sample sent', 'quotation'],
      ['Sample sent', 'Price agreed', 'board'],
      ['Price agreed', 'Won', 'board'],
      ['Won', 'New', 'board'],
    ]);
    expect(history[2]).toMatchObject({ from: { kind: 'Contacted' }, to: { kind: 'Quote Sent' } });
    expect(history.slice(1).every((h) => h.msInFrom >= 0 && h.actorName === 'Bela')).toBe(true);
    expect(history[5].pipelineName).toBe('Sales');

    // The history cannot be changed or deleted.
    await expect(LeadStageEvent.updateOne({ leadId: lead.id }, { $set: { source: 'edit' } })).rejects.toMatchObject({ code: 'HISTORY_IMMUTABLE' });
    await expect(LeadStageEvent.deleteMany({ leadId: lead.id })).rejects.toMatchObject({ code: 'HISTORY_IMMUTABLE' });
    const entry = await LeadStageEvent.findOne({ leadId: lead.id });
    entry.source = 'edit';
    await expect(entry.save()).rejects.toMatchObject({ code: 'HISTORY_IMMUTABLE' });
  });

  it('shows each column\'s count, value and weighted value, and flags overdue, no next step and gone quiet', async () => {
    const owner = await login('board-owner@example.com', { name: 'Chetan' });
    const agent = await inviteAndJoin(owner.token, 'board-agent@example.com', { role: 'agent' });
    const dealers = (await call(owner, 'post', '/pipelines', DEALERS)).body.data;
    const organizationId = owner.data.organizationId;
    const a = await newLead(owner, { title: 'A', extra: { pipelineId: dealers.id, expectedValuePaise: 1000000, followUpAt: new Date(Date.now() - 2 * DAY).toISOString() } });
    const b = await newLead(owner, { title: 'B', extra: { pipelineId: dealers.id, expectedValuePaise: 3000000 } });
    const c = await newLead(owner, { title: 'C', extra: { pipelineId: dealers.id, expectedValuePaise: 5000000 } });
    await Task.create({ organizationId, title: 'Send the price list', dueDate: indiaDate(1), relatedType: 'Lead', relatedId: b.id });
    await call(owner, 'post', `/leads/${c.id}/stage`, { pipelineStageId: dealers.stages[1].id });
    await Lead.updateOne({ _id: c.id }, { $set: { lastActivityAt: new Date(Date.now() - 6 * DAY) } }); // "Sample sent" goes quiet after 5
    await newLead(agent, { title: 'Agent own', extra: { pipelineId: dealers.id, expectedValuePaise: 700000 } });

    const board = (await call(owner, 'get', `/pipelines/${dealers.id}/board`)).body.data;
    const [enquiry, sample] = board.columns;
    expect(enquiry).toMatchObject({ count: 3, valuePaise: 4700000, weightedPaise: 470000, flags: { overdue: 1, noNextStep: 1, quiet: 0 } });
    expect(sample).toMatchObject({ count: 1, valuePaise: 5000000, weightedPaise: 1250000, flags: { overdue: 0, noNextStep: 1, quiet: 1 } });
    const card = (id) => board.columns.flatMap((col) => col.leads).find((l) => String(l.id) === String(id));
    expect(card(a.id)).toMatchObject({ flags: { overdue: true, noNextStep: false, quiet: false }, nextActivity: { type: 'followUp' } });
    expect(card(b.id)).toMatchObject({ flags: { overdue: false, noNextStep: false }, nextActivity: { type: 'task', title: 'Send the price list', date: indiaDate(1) } });
    expect(card(c.id)).toMatchObject({ flags: { noNextStep: true, quiet: true }, idleDays: 6, owner: 'Chetan' });
    expect(board.totals).toMatchObject({ count: 4, valuePaise: 9700000 });

    // An agent who sees only their own leads sees only their card and totals.
    const theirs = (await call(agent, 'get', `/pipelines/${dealers.id}/board`)).body.data;
    expect(theirs.totals).toMatchObject({ count: 1, valuePaise: 700000 });
    // The summary is the board without cards; won leads count in the last 30 days.
    await call(owner, 'post', `/leads/${b.id}/stage`, { stage: 'Won' });
    const summary = (await call(owner, 'get', `/pipelines/${dealers.id}/summary`)).body.data;
    expect(summary.columns[0].leads).toBeUndefined();
    expect(summary.last30Days.won).toEqual({ count: 1, valuePaise: 3000000 });
  });

  it('moves open leads when a stage goes away or a pipeline is deleted, and never drops one', async () => {
    const owner = await login('edit-owner@example.com', { name: 'Divya' });
    const dealers = (await call(owner, 'post', '/pipelines', DEALERS)).body.data;
    const sales = (await call(owner, 'get', '/pipelines')).body.data.find((p) => p.isDefault);
    const one = await newLead(owner, { title: 'One', extra: { pipelineId: dealers.id } });
    await call(owner, 'post', `/leads/${one.id}/stage`, { pipelineStageId: dealers.stages[1].id });
    const [enquiry, sample, price] = dealers.stages;

    // "Sample sent" goes away: its lead needs a target.
    const without = [{ id: enquiry.id, name: enquiry.name, kind: 'New' }, { id: price.id, name: price.name, kind: 'Negotiation' }];
    expect((await call(owner, 'patch', `/pipelines/${dealers.id}`, { stages: without })).body.code).toBe('MOVE_TARGET_REQUIRED');
    const saved = await call(owner, 'patch', `/pipelines/${dealers.id}`, { stages: without, moveStages: { [sample.id]: price.id } });
    expect(saved.status).toBe(200);
    expect((await call(owner, 'get', `/leads/${one.id}`)).body.data).toMatchObject({ pipelineStageId: price.id, stage: 'Negotiation' });
    // A kept stage given another kind takes its lead's fixed stage along.
    await call(owner, 'patch', `/pipelines/${dealers.id}`, { stages: [{ id: enquiry.id, name: 'Enquiry', kind: 'New' }, { id: price.id, name: 'Price talk', kind: 'Quote Sent' }] });
    expect((await call(owner, 'get', `/leads/${one.id}`)).body.data.stage).toBe('Quote Sent');
    const history = (await call(owner, 'get', `/leads/${one.id}/stage-history`)).body.data;
    expect(history.slice(-2).map((h) => [h.from.name, h.to.name, h.source])).toEqual([['Sample sent', 'Price agreed', 'pipeline'], ['Price agreed', 'Price talk', 'pipeline']]);

    // Deleting: never the default; not with open leads unless they have somewhere to go.
    expect((await call(owner, 'delete', `/pipelines/${sales.id}`)).body.code).toBe('DEFAULT_PIPELINE');
    expect((await call(owner, 'delete', `/pipelines/${dealers.id}`)).body.code).toBe('PIPELINE_IN_USE');
    const gone = await call(owner, 'delete', `/pipelines/${dealers.id}?moveTo=${sales.id}`);
    expect(gone.body.data).toEqual({ deleted: true, moved: 1 });
    expect((await call(owner, 'get', `/leads/${one.id}`)).body.data).toMatchObject({ pipelineId: sales.id, pipelineStageId: sales.stages[2].id, stage: 'Quote Sent' });
    expect((await call(owner, 'get', '/pipelines')).body.data.map((p) => p.name)).toEqual(['Sales']);
    expect(await Pipeline.countDocuments({ organizationId: owner.data.organizationId, deletedAt: { $ne: null } })).toBe(1);
    // At most 10 pipelines.
    for (let i = 0; i < 9; i += 1) await call(owner, 'post', '/pipelines', { name: `P${i}`, stages: DEALERS.stages });
    expect((await call(owner, 'post', '/pipelines', { name: 'Eleven', stages: DEALERS.stages })).body.code).toBe('LIMIT');
  });

  it('puts old leads into the default pipeline once, by their kind (migration 007)', async () => {
    const owner = await login('migrate-owner@example.com', { name: 'Esha' });
    const organizationId = new mongoose.Types.ObjectId(owner.data.organizationId);
    const old = (stage) => ({ _id: new mongoose.Types.ObjectId(), organizationId, contactId: new mongoose.Types.ObjectId(), title: `Old ${stage}`, stage, createdAt: new Date(Date.now() - 20 * DAY), stageChangedAt: new Date(Date.now() - 10 * DAY), deletedAt: null });
    const rows = [old('New'), old('Negotiation'), old('Won')];
    await Lead.collection.insertMany(rows);
    const first = await migration.up();
    expect(first.leads).toBe(3);
    const sales = await Pipeline.findOne({ organizationId, isDefault: true });
    const placed = await Lead.find({ _id: { $in: rows.map((r) => r._id) } }).sort({ title: 1 }).lean();
    const nameOf = (lead) => sales.stages.id(lead.pipelineStageId).name;
    expect(placed.map((l) => [l.title, nameOf(l)])).toEqual([['Old Negotiation', 'Negotiation'], ['Old New', 'New'], ['Old Won', 'Negotiation']]);
    expect(placed.every((l) => String(l.pipelineId) === String(sales._id) && l.pipelineStageAt.getTime() === rows[0].stageChangedAt.getTime())).toBe(true);
    expect((await migration.up()).leads).toBe(0);
    expect(await Pipeline.countDocuments({ organizationId, isDefault: true })).toBe(1);
  });
});
