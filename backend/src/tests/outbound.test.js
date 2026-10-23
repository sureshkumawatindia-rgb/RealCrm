jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Call = require('../models/Call');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const User = require('../models/User');
const telephony = require('../integrations/telephony');
const sms = require('../integrations/sms');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// The power dialer and bulk actions (Phase 8B, D89).
const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;
const req = (token) => ({
  get: (path) => api().get(`/api/v1${path}`).set(bearer(token)),
  post: (path, body, key) => {
    const r = api().post(`/api/v1${path}`).set(bearer(token));
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  },
  put: (path, body) => api().put(`/api/v1${path}`).set(bearer(token)).send(body),
});
const newLead = async (o, title, phone, extra = {}) => (await o.post('/leads', { title, contact: { name: `${title} Co`, ...(phone && { phone }) }, ...extra })).body.data;

beforeEach(() => {
  telephony.mock.reset();
  sms.mock.reset();
});

describe('The power dialer', () => {
  it('builds a session of callable leads, logs outcomes once, sets follow-ups, and never dials by itself', async () => {
    const owner = await login('dial-owner@example.com', { name: 'Ramesh' });
    const o = req(owner.token);
    const a = await newLead(o, 'Cement', '+919829080701');
    const b = await newLead(o, 'Sand', '+919829080702');
    const c = await newLead(o, 'Bricks'); // no phone
    const other = await login('dial-other@example.com');
    const theirs = await newLead(req(other.token), 'Not yours', '+919829080703');

    const created = await o.post('/dialer/sessions', { leadIds: [a.id, c.id, theirs.id, b.id], name: 'Monday calls' });
    expect(created.status).toBe(201);
    const s = created.body.data;
    expect(s.items.map((i) => [i.title, i.status])).toEqual([['Cement', 'pending'], ['Sand', 'pending']]);
    expect(s.leftOut.map((x) => x.code)).toEqual(['NO_PHONE', 'NOT_FOUND']);
    expect(s).toMatchObject({ next: 0, calling: false, stats: { total: 2, pending: 2 } });
    expect(telephony.mock.placed()).toHaveLength(0);

    // No calling account: the outcome is a call logged by hand; a second tap logs nothing.
    const result = (n, body) => o.post(`/dialer/sessions/${s.id}/items/${n}/result`, body);
    const first = await result(0, { outcome: 'interested', notes: 'Wants 200 bags', minutes: 3, followUpInDays: 2 });
    expect(first.body.data.session).toMatchObject({ next: 1, stats: { done: 1, talked: 1 } });
    expect(first.body.data.call).toMatchObject({ provider: 'manual', outcome: 'interested', durationSec: 180, notes: 'Wants 200 bags' });
    expect(await Call.countDocuments({ leadId: a.id })).toBe(1);
    expect((await result(0, { outcome: 'busy' })).body.data.alreadyDone).toBe(true);
    expect(await Call.countDocuments({ leadId: a.id })).toBe(1);
    const followUp = (await Lead.findById(a.id)).followUpAt;
    expect(Math.round((followUp - Date.now()) / (24 * 60 * 60 * 1000))).toBeGreaterThanOrEqual(1);

    const skipped = (await o.post(`/dialer/sessions/${s.id}/items/1/skip`, { reason: 'Shop closed' })).body.data;
    expect(skipped).toMatchObject({ next: null, stats: { done: 1, skipped: 1, pending: 0 } });
    expect((await o.post(`/dialer/sessions/${s.id}/finish`, {})).body.data.status).toBe('finished');
    expect((await req(other.token).get(`/dialer/sessions/${s.id}`)).status).toBe(404);
    expect((await o.post('/dialer/sessions', { leadIds: [c.id] })).body.code).toBe('NOTHING_TO_CALL');
  });

  it('places a call only when Call is pressed, and puts the outcome on that call', async () => {
    const owner = await login('dial-tel@example.com', { name: 'Seema' });
    const o = req(owner.token);
    await o.put('/telephony', { provider: 'mock', callerId: '08069000000' });
    await User.updateOne({ email: 'dial-tel@example.com' }, { $set: { phoneE164: '+919414000009' } });
    const lead = await newLead(o, 'Steel', '+919829080711');
    const s = (await o.post('/dialer/sessions', { leadIds: [lead.id] })).body.data;
    expect(s.calling).toBe(true);
    expect(telephony.mock.placed()).toHaveLength(0);
    const placed = await o.post(`/dialer/sessions/${s.id}/items/0/call`, {});
    expect(placed.body.data.call).toMatchObject({ provider: 'mock', status: 'queued' });
    expect(telephony.mock.placed()).toHaveLength(1);
    const done = (await o.post(`/dialer/sessions/${s.id}/items/0/result`, { outcome: 'callback' })).body.data;
    expect(done.call).toMatchObject({ id: placed.body.data.call.id, outcome: 'callback' });
    expect(await Call.countDocuments({ leadId: lead.id })).toBe(1);
    expect((await o.post(`/dialer/sessions/${s.id}/items/0/call`, {})).status).toBe(409);
  });

  it('starts from a board of leads, in its order', async () => {
    const owner = await login('dial-board@example.com');
    const o = req(owner.token);
    await newLead(o, 'Small', '+919829080721', { source: 'IndiaMART', expectedValuePaise: 100000 });
    await newLead(o, 'Big', '+919829080722', { source: 'IndiaMART', expectedValuePaise: 900000 });
    await newLead(o, 'Website one', '+919829080723', { source: 'Website' });
    const board = (await o.post('/boards', { object: 'lead', name: 'IndiaMART by value', filters: { sources: ['IndiaMART'] }, sort: '-expectedValuePaise' })).body.data;
    const s = (await o.post('/dialer/sessions', { boardId: board.id })).body.data;
    expect(s).toMatchObject({ name: 'IndiaMART by value' });
    expect(s.items.map((i) => i.title)).toEqual(['Big', 'Small']);
    await o.post('/boards', { object: 'lead', name: 'Cal', layout: 'calendar' });
    const cal = (await o.get('/boards')).body.data.find((b) => b.name === 'Cal');
    expect((await o.post('/dialer/sessions', { boardId: cal.id })).status).toBe(400);
  });
});

describe('Bulk actions on leads', () => {
  it('does each row through the usual rules and lists the ones that failed', async () => {
    const owner = await login('bulk-owner@example.com', { name: 'Kiran' });
    const agent = await inviteAndJoin(owner.token, 'bulk-agent@example.com', { role: 'agent', modules: ['leads'] });
    const agentId = await memberId(owner.token, 'bulk-agent@example.com');
    const o = req(owner.token);
    const leads = [];
    for (const [i, phone] of ['+919829080731', '+919829080732', '+919829080733'].entries()) leads.push(await newLead(o, `Lead ${i + 1}`, phone));
    const ids = leads.map((l) => l.id);

    const assigned = (await o.post('/bulk/leads', { action: 'assign', ids, params: { ownerId: agentId } }, 'bulk-assign-1')).body.data;
    expect(assigned).toEqual({ action: 'assign', total: 3, done: 3, failed: [] });
    const replay = (await o.post('/bulk/leads', { action: 'assign', ids, params: { ownerId: agentId } }, 'bulk-assign-1')).body.data;
    expect(replay).toEqual(assigned);
    expect((await Lead.find({ _id: { $in: ids } })).every((l) => String(l.ownerId) === agentId)).toBe(true);

    // The agent can change their own leads; one taken back by the owner fails on its own.
    await Lead.updateOne({ _id: ids[2] }, { $set: { ownerId: null } });
    const moved = (await req(agent.token).post('/bulk/leads', { action: 'stage', ids, params: { stage: 'Contacted' } })).body.data;
    expect(moved).toMatchObject({ total: 3, done: 2, failed: [{ id: ids[2], code: 'NOT_FOUND' }] });
    expect((await o.post('/bulk/leads', { action: 'stage', ids, params: { stage: 'Lost' } })).status).toBe(400); // needs a reason
    expect((await o.post('/bulk/leads', { action: 'tag', ids, params: { tag: 'diwali' } })).body.data.done).toBe(3);
    expect((await Contact.find({ _id: { $in: leads.map((l) => l.contactId) } })).every((c) => c.tags.includes('diwali'))).toBe(true);
    const due = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect((await o.post('/bulk/leads', { action: 'followUp', ids: ids.slice(0, 2), params: { at: due } })).body.data.done).toBe(2);

    // Adding to a sequence needs Sales Automation.
    const sequence = (await o.post('/sequences', { name: 'Chase', steps: [{ day: 1, type: 'tag.add', params: { tag: 'chased' } }] })).body.data;
    expect((await req(agent.token).post('/bulk/leads', { action: 'sequence', ids, params: { sequenceId: sequence.id } })).status).toBe(403);
    const enrolled = (await o.post('/bulk/leads', { action: 'sequence', ids, params: { sequenceId: sequence.id } })).body.data;
    expect(enrolled.done).toBe(3);
    expect(await SequenceEnrollment.countDocuments({ sequenceId: sequence.id })).toBe(3);
    expect((await o.post('/bulk/leads', { action: 'sequence', ids: ids.slice(0, 1), params: { sequenceId: sequence.id } })).body.data.failed).toHaveLength(1); // already in it

    // Bulk SMS: the opted-out customer is listed, the others get it once.
    const saved = (await o.put('/sms/connection', { provider: 'mock', templates: [{ name: 'Offer', flowId: 'f1', text: 'Dear ##name##, Diwali offer from us.' }] })).body.data;
    await o.post(`/contacts/${leads[1].contactId}/sms-consent`, { optedOut: true });
    const smsBody = { action: 'sms', ids, params: { template: saved.templates[0].key, variables: { name: 'contact.name' } } };
    const sent = (await o.post('/bulk/leads', smsBody, 'bulk-sms-1')).body.data;
    expect(sent).toMatchObject({ done: 2, failed: [{ id: ids[1], code: 'SMS_OPTED_OUT' }] });
    expect(sms.mock.sent()).toHaveLength(2);
    expect(sms.mock.sent()[0].values).toEqual({ name: 'Lead 1 Co' });

    const stranger = await login('bulk-stranger@example.com');
    expect((await req(stranger.token).post('/bulk/leads', { action: 'tag', ids, params: { tag: 'x' } })).body.data).toMatchObject({ done: 0, failed: [{ code: 'NOT_FOUND' }, { code: 'NOT_FOUND' }, { code: 'NOT_FOUND' }] });
    expect((await o.post('/bulk/leads', { action: 'explode', ids, params: {} })).status).toBe(400);
  });
});
