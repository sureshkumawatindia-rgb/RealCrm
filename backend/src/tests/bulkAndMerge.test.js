jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const AutomationRun = require('../models/AutomationRun');
const BulkJob = require('../models/BulkJob');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const ConsentEvent = require('../models/ConsentEvent');
const queue = require('../jobs/queue');
const engine = require('../services/automation/engine');
const leadRouting = require('../services/leadRoutingService');
const bulkService = require('../services/bulkService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Checkpoint B of the last 5% (D100): bulk actions on the Leads and Customers lists (up to
// 5,000, more than 200 in a background job), and possible duplicates with a merge that loses
// nothing and doubles nothing.
const as = (user) => ({
  get: (path) => api().get(`/api/v1${path}`).set(bearer(user.token)),
  post: (path, body = {}, key) => {
    const req = api().post(`/api/v1${path}`).set(bearer(user.token));
    return (key ? req.set('Idempotency-Key', key) : req).send(body);
  },
  patch: (path, body) => api().patch(`/api/v1${path}`).set(bearer(user.token)).send(body),
});
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};

beforeAll(() => {
  leadRouting.attach(queue);
  engine.register(queue);
  bulkService.register(queue);
});
afterAll(() => queue.stop());

describe('Bulk actions on the lists (D100)', () => {
  let owner;
  let agent; // leads and customers, no deleting
  let organizationId;
  let ownerMember;
  beforeAll(async () => {
    owner = await login('bulk100-owner@example.com', { name: 'Neha' });
    agent = await inviteAndJoin(owner.token, 'bulk100-agent@example.com', { role: 'agent', modules: ['leads', 'customers'], permissions: ['leads:view_all', 'customers:view_all'] });
    organizationId = new mongoose.Types.ObjectId(owner.data.organizationId);
    ownerMember = new mongoose.Types.ObjectId(owner.data.member.id);
  });

  const makeLeads = async (n, prefix) => {
    const contacts = await Contact.insertMany(Array.from({ length: n }, (_, i) => ({ organizationId, name: `${prefix} ${i}`, phoneE164: `+91983${prefix.length}${String(i).padStart(6, '0')}`, ownerId: ownerMember })));
    const leads = await Lead.insertMany(contacts.map((c, i) => ({ organizationId, contactId: c._id, title: `${prefix} lead ${i}`, stage: 'New', ownerId: ownerMember })));
    return { contacts, leads, ids: leads.map((l) => String(l._id)) };
  };

  it('does more than 200 rows in the background, leaves private numbers alone and reports why', async () => {
    const { leads, ids, contacts } = await makeLeads(201, 'Job');
    await Lead.updateOne({ _id: leads[5]._id }, { $set: { private: true } });
    const started = await as(owner).post('/bulk/leads', { action: 'tag', ids, params: { tag: 'Diwali' } }, 'bulk100-job');
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({ status: 'queued', object: 'lead', action: 'tag', total: 201, done: 0 });
    // The same key gives the same job; another big one waits for this one.
    expect((await as(owner).post('/bulk/leads', { action: 'tag', ids, params: { tag: 'Diwali' } }, 'bulk100-job')).body.data.jobId).toBe(started.body.data.jobId);
    expect((await as(owner).post('/bulk/leads', { action: 'untag', ids, params: { tag: 'x' } })).body.code).toBe('BULK_BUSY');
    await settle();
    const job = (await as(owner).get(`/bulk/jobs/${started.body.data.jobId}`)).body.data;
    expect(job).toMatchObject({ status: 'done', total: 201, position: 201, done: 200, failedCount: 1, reasons: { PRIVATE: 1 } });
    expect(job.failed).toEqual([{ id: ids[5], code: 'PRIVATE', message: expect.stringMatching(/private/i) }]);
    expect(await Contact.countDocuments({ _id: { $in: contacts.map((c) => c._id) }, tags: 'Diwali' })).toBe(200);
    // One history entry per customer changed, and one for the whole action.
    expect(await AuditLog.countDocuments({ organizationId, action: 'contact.updated', entityId: { $in: contacts.map((c) => String(c._id)) } })).toBe(200);
    expect(await AuditLog.countDocuments({ organizationId, action: 'lead.bulk_tag' })).toBe(1);
    // Someone else cannot read the job.
    expect((await as(agent).get(`/bulk/jobs/${job.jobId}`)).status).toBe(404);

    // Removing the tag ignores capitals; up to 200 rows are done at once.
    const untagged = (await as(owner).post('/bulk/leads', { action: 'untag', ids: ids.slice(0, 3), params: { tag: 'diwali' } })).body.data;
    expect(untagged).toMatchObject({ status: 'done', total: 3, done: 3 });
    expect(await Contact.countDocuments({ _id: { $in: contacts.slice(0, 3).map((c) => c._id) }, tags: 'Diwali' })).toBe(0);
  });

  it('starts workflows on a bulk move only when "Run automations too" is ticked; sequences still end', async () => {
    const { ids } = await makeLeads(4, 'Auto');
    const flow = await as(owner).post('/workflows', { name: 'Moved', status: 'Active', trigger: { type: 'lead.stage_changed', params: { toStages: ['Contacted'] } }, steps: [{ type: 'tag.add', params: { tag: 'moved' } }] });
    expect(flow.status).toBe(201);
    await as(owner).post('/bulk/leads', { action: 'stage', ids: ids.slice(0, 2), params: { stage: 'Contacted' } });
    await settle();
    expect(await AutomationRun.countDocuments({ workflowId: flow.body.data.id })).toBe(0);
    await as(owner).post('/bulk/leads', { action: 'stage', ids: ids.slice(2), params: { stage: 'Contacted' }, runAutomations: true });
    await settle();
    expect(await AutomationRun.countDocuments({ workflowId: flow.body.data.id })).toBe(2);

    // A sequence still stops when its lead is won, ticked or not.
    const sequence = (await as(owner).post('/sequences', { name: 'Chase', steps: [{ day: 3, type: 'tag.add', params: { tag: 'chased' } }] })).body.data;
    expect((await as(owner).post('/bulk/leads', { action: 'sequence', ids: ids.slice(0, 1), params: { sequenceId: sequence.id } })).body.data.done).toBe(1);
    await as(owner).post('/bulk/leads', { action: 'stage', ids: ids.slice(0, 1), params: { stage: 'Won' } });
    await settle();
    expect((await SequenceEnrollment.findOne({ sequenceId: sequence.id })).status).toBe('stopped');
  });

  it('does the customers list too: owner, tags, sequence and delete, each as the member may', async () => {
    const made = [];
    for (const [i, name] of ['Asha Traders', 'Bharat Steel', 'Chopra & Sons'].entries()) {
      made.push((await as(owner).post('/contacts', { name, phone: `98290400${i}0`, lifecycle: 'customer', tags: ['old'] })).body.data);
    }
    const ids = made.map((c) => c.id);
    const agentId = agent.data.member.id;
    // Only owners and admins give records to someone else.
    expect((await as(agent).post('/bulk/contacts', { action: 'assign', ids, params: { ownerId: agentId } })).status).toBe(403);
    expect((await as(owner).post('/bulk/contacts', { action: 'assign', ids, params: { ownerId: agentId } })).body.data.done).toBe(3);
    expect((await Contact.find({ _id: { $in: ids } })).every((c) => String(c.ownerId) === agentId)).toBe(true);
    expect((await as(agent).post('/bulk/contacts', { action: 'tag', ids, params: { tag: 'OLD' } })).body.data.done).toBe(3);
    expect((await Contact.findById(ids[0])).tags).toEqual(['old']); // already had it, any capitals
    expect((await as(agent).post('/bulk/contacts', { action: 'untag', ids, params: { tag: 'Old' } })).body.data.done).toBe(3);
    expect((await Contact.findById(ids[0])).tags).toEqual([]);
    // Stage and SMS are not customer actions; deleting needs the permission.
    expect((await as(owner).post('/bulk/contacts', { action: 'stage', ids, params: { stage: 'Won' } })).status).toBe(400);
    expect((await as(agent).post('/bulk/contacts', { action: 'delete', ids })).status).toBe(403);
    await Contact.updateOne({ _id: ids[2] }, { $set: { private: true } });
    const deleted = (await as(owner).post('/bulk/contacts', { action: 'delete', ids })).body.data;
    expect(deleted).toMatchObject({ done: 2, failed: [{ id: ids[2], code: 'PRIVATE' }] });
    expect(await Contact.countDocuments({ _id: { $in: ids } })).toBe(1);
  });

  it('downloads the ticked rows as Excel for owners and admins', async () => {
    const { ids } = await makeLeads(3, 'Xl');
    const res = await as(owner).post('/leads/export', { ids: ids.slice(0, 2) }).buffer(true).parse((stream, done) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.body.length).toBeGreaterThan(500);
    const entry = await AuditLog.findOne({ organizationId, action: 'leads.exported' }).sort({ createdAt: -1 });
    expect(entry.changes).toMatchObject({ rows: 2, selected: 2, filtered: true });
    expect((await as(agent).post('/leads/export', { ids })).status).toBe(403);
  });
});

describe('Possible duplicates and merging customers (D100)', () => {
  let owner;
  let agent;
  let organizationId;
  beforeAll(async () => {
    owner = await login('merge-owner@example.com', { name: 'Ravi' });
    agent = await inviteAndJoin(owner.token, 'merge-agent@example.com', { role: 'agent', modules: ['customers', 'inbox', 'leads'] });
    organizationId = new mongoose.Types.ObjectId(owner.data.organizationId);
    await as(owner).post('/whatsapp/accounts', { provider: 'mock' });
  });

  it('lists customers sharing an email, a GSTIN or a mobile number, once per group', async () => {
    const a = (await as(owner).post('/contacts', { name: 'Sunil Gupta', email: 'sunil@gupta.example', phone: '9829050001', lifecycle: 'customer' })).body.data;
    const b = (await as(owner).post('/contacts', { name: 'Sunil G', email: 'SUNIL@gupta.example', phone: '9829050002', lifecycle: 'customer', gstin: '08ABCDE1234F1Z5' })).body.data;
    const c = (await as(owner).post('/contacts', { name: 'Gupta Steels', gstin: '08ABCDE1234F1Z5', lifecycle: 'customer' })).body.data;
    // A number saved without its country code before the CRM checked numbers.
    const old = await Contact.collection.insertOne({ organizationId, name: 'Old import', phone: '09829050001', email: '', gstin: '', tags: [], lifecycle: 'lead', deletedAt: null, createdAt: new Date(), updatedAt: new Date() });
    const hidden = (await as(owner).post('/contacts', { name: 'Private', email: 'sunil@gupta.example', lifecycle: 'customer' })).body.data;
    await Contact.updateOne({ _id: hidden.id }, { $set: { private: true } });

    expect((await as(agent).get('/contacts/duplicates')).status).toBe(403);
    const { groups } = (await as(owner).get('/contacts/duplicates')).body.data;
    const idsOf = (group) => group.contacts.map((x) => x.id).sort();
    const find = (reason) => groups.find((g) => g.reasons.some((r) => r.reason === reason));
    expect(idsOf(find('email'))).toEqual([a.id, b.id].sort());
    expect(find('email').reasons).toEqual([{ reason: 'email', value: 'sunil@gupta.example' }]);
    expect(idsOf(find('gstin'))).toEqual([b.id, c.id].sort());
    expect(idsOf(find('phone'))).toEqual([a.id, String(old.insertedId)].sort());
    expect(groups.some((g) => g.contacts.some((x) => x.id === hidden.id))).toBe(false);
    expect(find('email').contacts[0]).toMatchObject({ id: a.id, leads: 0, chats: 0, orders: 0 });
  });

  it('merges one customer into another: everything moves once, chats on one number join, nothing is left or doubled', async () => {
    // Two customers who each wrote on the same WhatsApp number, from two mobile numbers.
    const kept = (await as(owner).post('/dev/simulate/whatsapp-inbound', { from: '98290 60001', text: 'Rate of 40 mm pipes?', name: 'Mahesh Kumar' })).body.data;
    const gone = (await as(owner).post('/dev/simulate/whatsapp-inbound', { from: '98290 60002', text: 'Mahesh here, new number', name: 'Mahesh K' })).body.data;
    await as(owner).post('/dev/simulate/whatsapp-inbound', { from: '98290 60002', text: 'Please call', name: 'Mahesh K' });
    const mainId = kept.contactId;
    const otherId = gone.contactId;
    const main = new mongoose.Types.ObjectId(mainId);
    const other = new mongoose.Types.ObjectId(otherId);
    // Their own fields, a link to the other, consent and tags.
    await as(owner).post('/custom-fields', { object: 'contact', label: 'Zone', type: 'text' });
    await as(owner).post('/custom-fields', { object: 'contact', label: 'Grade', type: 'text' });
    const dealer = (await as(owner).post('/custom-fields', { object: 'lead', label: 'Referred by', type: 'lookup', lookupTarget: 'contact' })).body.data;
    await as(owner).patch(`/contacts/${mainId}`, { customFields: { zone: 'North', grade: 'A' }, tags: ['vip'], email: 'mahesh@old.example' });
    await as(owner).patch(`/contacts/${otherId}`, { customFields: { zone: 'West' }, tags: ['VIP', 'pipes'], marketingConsent: 'opted_out', email: 'mahesh@new.example', notes: 'Prefers calls after 6' });
    const referred = (await as(owner).post('/leads', { contact: { name: 'Third Party', phone: '9829060003' }, title: 'Valves', customFields: { [dealer.key]: otherId } })).body.data;

    // Records of every kind on the other customer, some also on the kept one.
    // Raw rows, with the unique numbers some collections need.
    let n = 0;
    const raw = (Model, doc) => {
      n += 1;
      const unique = { number: `T-${n}`, referenceId: `ref-${n}`, provider: 'mock', providerLinkId: `link-${n}`, source: 'API', sourceRef: `ref-${n}`, gmailMessageId: `g-${n}` };
      return Model.collection.insertOne({ organizationId, createdAt: new Date(), ...unique, ...doc });
    };
    const models = Object.fromEntries(['Quotation', 'Order', 'PaymentLink', 'Ticket', 'Call', 'SmsMessage', 'Project', 'CustomRecord', 'Touchpoint', 'LeadActivity', 'LeadIntake', 'AssignmentHistory', 'Task', 'CalendarEvent', 'Document', 'Note', 'EmailMessage', 'DialerSession', 'AutomationRun', 'BroadcastRecipient', 'Sequence']
      .map((name) => [name, mongoose.model(name)]));
    for (const name of ['Quotation', 'Order', 'PaymentLink', 'Ticket', 'Call', 'SmsMessage', 'Project', 'CustomRecord', 'Touchpoint', 'LeadActivity', 'LeadIntake', 'AssignmentHistory']) {
      await raw(models[name], { contactId: other });
      await raw(models[name], { contactId: main });
    }
    await raw(models.Order, { contactId: other, deletedAt: new Date() }); // a deleted one moves too
    for (const name of ['Task', 'CalendarEvent', 'Document']) await raw(models[name], { relatedType: 'Customer', relatedId: other, relatedName: 'Mahesh K' });
    await raw(models.Note, { parentType: 'contact', parentId: other, text: 'Met at the fair' });
    await raw(models.EmailMessage, { contactIds: [other, main] });
    await raw(models.EmailMessage, { contactIds: [other] });
    await raw(models.DialerSession, { items: [{ contactId: other }, { contactId: main }] });
    await raw(models.AutomationRun, { subject: { contactId: other } });
    const shared = new mongoose.Types.ObjectId();
    await raw(models.BroadcastRecipient, { broadcastId: shared, contactId: main });
    await raw(models.BroadcastRecipient, { broadcastId: shared, contactId: other });
    await raw(models.BroadcastRecipient, { broadcastId: new mongoose.Types.ObjectId(), contactId: other });
    const both = new mongoose.Types.ObjectId();
    const alone = new mongoose.Types.ObjectId();
    await SequenceEnrollment.collection.insertMany([
      { organizationId, sequenceId: both, contactId: main, status: 'active' },
      { organizationId, sequenceId: both, contactId: other, status: 'active' },
      { organizationId, sequenceId: alone, contactId: other, status: 'active' },
    ]);

    // Counts by contact, before.
    const ALL = ['Quotation', 'Order', 'PaymentLink', 'Ticket', 'Call', 'SmsMessage', 'Project', 'CustomRecord', 'Touchpoint', 'LeadActivity', 'LeadIntake', 'AssignmentHistory'];
    const count = (name, filter) => models[name].collection.countDocuments({ organizationId, ...filter });
    const before = {};
    for (const name of [...ALL, 'Lead', 'Message', 'ConsentEvent']) {
      const Model = mongoose.model(name);
      before[name] = { total: await Model.collection.countDocuments({ organizationId }), main: await Model.collection.countDocuments({ organizationId, contactId: main }), other: await Model.collection.countDocuments({ organizationId, contactId: other }) };
    }
    const messagesBefore = await Message.countDocuments({ organizationId });
    const [mainChat, otherChat] = [await Conversation.findById(kept.conversationId), await Conversation.findById(gone.conversationId)];

    // The preview shows both sides and what moves.
    expect((await as(agent).get(`/contacts/${mainId}/merge-preview?with=${otherId}`)).status).toBe(403);
    const preview = (await as(owner).get(`/contacts/${mainId}/merge-preview?with=${otherId}`)).body.data;
    expect(preview.fields.find((f) => f.key === 'cf.zone')).toMatchObject({ label: 'Zone', main: 'North', other: 'West', same: false, default: 'main' });
    expect(preview.fields.find((f) => f.key === 'cf.grade')).toMatchObject({ main: 'A', other: '', default: 'main' });
    expect(preview.moves).toMatchObject({ chats: 0, chatsJoined: 1, quotations: 1, orders: 2, tasks: 1, notes: 1, emails: 2, sequences: 2 });
    expect(preview.differentPhones).toBe(true);

    // Merge: the other's number and zone are kept.
    const res = await as(owner).post(`/contacts/${mainId}/merge`, { otherId, keep: { phone: 'other', 'cf.zone': 'other' } }, 'merge-one-key');
    expect(res.status).toBe(200);
    expect((await as(owner).post(`/contacts/${mainId}/merge`, { otherId, keep: { phone: 'other', 'cf.zone': 'other' } }, 'merge-one-key')).body).toEqual(res.body);
    const merged = await Contact.findById(mainId);
    expect(merged).toMatchObject({ name: 'Mahesh Kumar', phoneE164: '+919829060002', email: 'mahesh@old.example' });
    expect(merged.customFields).toEqual({ zone: 'West', grade: 'A' });
    expect(merged.tags).toEqual(['vip', 'pipes']);
    expect(merged.consent.marketing).toBe('opted_out'); // the stricter one
    expect(merged.notes).toMatch(/Prefers calls after 6/);
    expect(merged.notes).toMatch(/\+919829060001/); // its old number is kept in the notes
    expect(merged.notes).toMatch(/mahesh@new\.example/);
    // The other's own opt-out moved over, and the kept customer's change is written down.
    expect(await ConsentEvent.countDocuments({ contactId: main, to: 'opted_out' })).toBe(2);
    expect(await ConsentEvent.countDocuments({ contactId: main, to: 'opted_out', detail: 'Merged with Mahesh K' })).toBe(1);
    const deleted = await Contact.findOne({ _id: otherId, deletedAt: { $ne: null } });
    expect(deleted.mergedIntoId.toString()).toBe(mainId);
    expect(deleted.phoneE164).toBeUndefined();
    expect((await as(owner).get(`/contacts/${otherId}`)).status).toBe(404);

    // Nothing left on the other customer, nothing lost or doubled.
    for (const name of [...ALL, 'Lead', 'Message']) {
      const Model = mongoose.model(name);
      const total = await Model.collection.countDocuments({ organizationId });
      expect({ name, total }).toEqual({ name, total: before[name].total });
      expect({ name, other: await Model.collection.countDocuments({ organizationId, contactId: other }) }).toEqual({ name, other: 0 });
      expect({ name, main: await Model.collection.countDocuments({ organizationId, contactId: main }) }).toEqual({ name, main: before[name].main + before[name].other });
    }
    for (const name of ['Task', 'CalendarEvent', 'Document']) expect(await count(name, { relatedId: main, relatedName: 'Mahesh Kumar' })).toBe(1);
    expect(await count('Note', { parentType: 'contact', parentId: main })).toBe(1);
    expect(await count('EmailMessage', { contactIds: other })).toBe(0);
    expect(await count('EmailMessage', { contactIds: main })).toBe(2);
    const session = await models.DialerSession.collection.findOne({ organizationId });
    expect(session.items.map((i) => String(i.contactId))).toEqual([mainId, mainId]);
    expect(await count('AutomationRun', { 'subject.contactId': main })).toBe(1);
    // The broadcast both got stays in the other's history; the other one moves.
    expect(await count('BroadcastRecipient', { contactId: other })).toBe(1);
    expect(await count('BroadcastRecipient', { contactId: main })).toBe(2);
    // The sequence both were in: the other's line stopped; the other sequence moved over.
    expect((await SequenceEnrollment.find({ contactId: main, sequenceId: both })).map((e) => e.status).sort()).toEqual(['active', 'stopped']);
    expect((await SequenceEnrollment.findOne({ sequenceId: alone })).contactId.toString()).toBe(mainId);
    // The link field points to the kept customer.
    expect((await Lead.findById(referred.id)).customFields[dealer.key]).toBe(mainId);

    // One chat on the number: all messages in it, unread counts added, the other chat gone.
    expect(await Conversation.countDocuments({ _id: gone.conversationId })).toBe(0);
    const chat = await Conversation.findById(kept.conversationId);
    expect(await Message.countDocuments({ conversationId: chat._id })).toBe(messagesBefore);
    expect(chat.unreadCount).toBe(mainChat.unreadCount + otherChat.unreadCount);
    const newest = [mainChat, otherChat].sort((x, y) => y.lastMessageAt - x.lastMessageAt)[0];
    expect(chat.lastMessagePreview).toBe(newest.lastMessagePreview);
    expect(chat.lastMessageAt.getTime()).toBe(newest.lastMessageAt.getTime());
    // Their number was kept, so the 24-hour window is the one of their chat.
    expect(chat.lastInboundAt.getTime()).toBe(otherChat.lastInboundAt.getTime());
    expect(res.body.data.moved).toMatchObject({ chatsJoined: 1, chats: 0, quotations: 1, orders: 2, notes: 1, broadcasts: 1, sequences: 2 });
    expect(await AuditLog.countDocuments({ organizationId, action: 'contact.merged', entityId: mainId })).toBe(1);
  });

  it('refuses private numbers, the same customer twice and agents', async () => {
    const a = (await as(owner).post('/contacts', { name: 'One', phone: '9829070001', lifecycle: 'customer' })).body.data;
    const b = (await as(owner).post('/contacts', { name: 'Two', phone: '9829070002', lifecycle: 'customer' })).body.data;
    expect((await as(owner).post(`/contacts/${a.id}/merge`, { otherId: a.id })).status).toBe(400);
    expect((await as(agent).post(`/contacts/${a.id}/merge`, { otherId: b.id })).status).toBe(403);
    await Contact.updateOne({ _id: b.id }, { $set: { private: true } });
    expect((await as(owner).post(`/contacts/${a.id}/merge`, { otherId: b.id })).body.code).toBe('PRIVATE');
    expect(await Contact.countDocuments({ _id: { $in: [a.id, b.id] } })).toBe(2);
    await BulkJob.deleteMany({});
  });
});
