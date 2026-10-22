jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Call = require('../models/Call');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const OrganizationMember = require('../models/OrganizationMember');
const TelephonyConnection = require('../models/TelephonyConnection');
const exotel = require('../integrations/telephony/exotel');
const { mock } = require('../integrations/telephony');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 6 (D85): one customer history, calls logged and dialled, the status webhook, Exotel.
const DAY = 24 * 60 * 60 * 1000;
const auth = (user) => bearer(user.token);
const call = (user, method, path, body) => api()[method](`/api/v1${path}`).set(auth(user)).send(body);
const newContact = async (user, body = {}) => (await call(user, 'post', '/contacts', { name: 'Gupta Steels', phone: '+919829080201', ...body })).body.data;
const webhook = (key, body, type = 'application/json') => api().post(`/api/v1/webhooks/calls/${key}`).set('Content-Type', type).send(typeof body === 'string' ? body : JSON.stringify(body));

describe('Customer history and calls (Phase 6)', () => {
  beforeEach(() => mock.reset());
  afterEach(() => jest.restoreAllMocks());

  it('merges every kind of history, newest first, pages without gaps and filters by kind', async () => {
    const owner = await login('tl-owner@example.com', { name: 'Kiran' });
    const organizationId = new mongoose.Types.ObjectId(owner.data.organizationId);
    const contact = await newContact(owner, { marketingConsent: 'opted_in' });
    const contactId = new mongoose.Types.ObjectId(contact.id);
    const conversationId = new mongoose.Types.ObjectId();
    const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000);
    await Message.collection.insertMany([
      { organizationId, conversationId, contactId, direction: 'in', type: 'text', text: 'Rate for 5 tonnes?', status: 'received', createdAt: at(50), updatedAt: at(50) },
      { organizationId, conversationId, contactId, direction: 'out', type: 'text', text: '₹52,000 per tonne', status: 'read', createdAt: at(45), updatedAt: at(45) },
    ]);
    await call(owner, 'post', `/contacts/${contact.id}/notes`, { text: 'Prefers morning calls' });
    const lead = (await call(owner, 'post', '/leads', { contactId: contact.id, title: 'TMT bars', expectedValuePaise: 26000000 })).body.data;
    await call(owner, 'post', `/leads/${lead.id}/stage`, { stage: 'Contacted' });
    await call(owner, 'post', `/leads/${lead.id}/quotations`, { items: [{ name: 'TMT 12mm', quantity: 5, unitPricePaise: 5200000 }] });
    await call(owner, 'post', '/calls', { contactId: contact.id, leadId: lead.id, outcome: 'interested', durationSec: 240, notes: 'Wants delivery by Friday' });
    await call(owner, 'post', '/tickets', { subject: 'Bent bars', contactId: contact.id });
    await call(owner, 'post', '/tasks', { title: 'Send the test certificate', relatedType: 'Lead', relatedId: lead.id, relatedName: 'TMT bars' });

    const all = (await call(owner, 'get', `/contacts/${contact.id}/timeline`)).body.data;
    const sources = new Set(all.items.map((i) => i.source));
    expect([...sources].sort()).toEqual(['call', 'consent', 'lead', 'note', 'quotation', 'stage', 'task', 'ticket', 'whatsapp']);
    expect(all.next).toBeNull();
    const times = all.items.map((i) => new Date(i.at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(all.items.find((i) => i.source === 'call')).toMatchObject({ kind: 'talk', outcome: 'interested', durationSec: 240, detail: 'Wants delivery by Friday', actorName: 'Kiran' });
    expect(all.items.find((i) => i.source === 'whatsapp' && i.direction === 'in')).toMatchObject({ kind: 'talk', detail: 'Rate for 5 tonnes?' });
    expect(all.items.find((i) => i.source === 'stage')).toMatchObject({ kind: 'sales', title: 'TMT bars: New → Contacted' });
    // `name` is the record's own words, for a translated label in front; tasks carry their due date.
    expect(all.items.find((i) => i.source === 'lead')).toMatchObject({ name: 'TMT bars' });
    expect(all.items.find((i) => i.source === 'task')).toMatchObject({ name: 'Send the test certificate', due: null });

    // Pages of 3 give the same items, once each.
    const paged = [];
    let before = null;
    do {
      const page = (await call(owner, 'get', `/contacts/${contact.id}/timeline?limit=3${before ? `&before=${encodeURIComponent(before)}` : ''}`)).body.data;
      paged.push(...page.items);
      before = page.next;
    } while (before);
    expect(paged.map((i) => i.id)).toEqual(all.items.map((i) => i.id));

    const talk = (await call(owner, 'get', `/contacts/${contact.id}/timeline?kinds=talk`)).body.data.items;
    expect(new Set(talk.map((i) => i.source))).toEqual(new Set(['whatsapp', 'call']));
    expect((await call(owner, 'get', `/contacts/${contact.id}/timeline?before=not-a-time`)).status).toBe(400);
  });

  it('shows each member only what they may see, and nothing of another company', async () => {
    const owner = await login('tl-scope@example.com', { name: 'Lalit' });
    const agent = await inviteAndJoin(owner.token, 'tl-scope-agent@example.com', { role: 'agent', modules: ['customers', 'leads'], permissions: ['customers:view_all'] });
    const organizationId = new mongoose.Types.ObjectId(owner.data.organizationId);
    const contact = await newContact(owner, { phone: '+919829080202' });
    await Message.collection.insertOne({ organizationId, conversationId: new mongoose.Types.ObjectId(), contactId: new mongoose.Types.ObjectId(contact.id), direction: 'in', type: 'text', text: 'Hello', status: 'received', createdAt: new Date(), updatedAt: new Date() });
    await call(owner, 'post', '/leads', { contactId: contact.id, title: 'Owner lead' });
    const seen = (await call(agent, 'get', `/contacts/${contact.id}/timeline`)).body.data.items;
    expect(seen.some((i) => i.source === 'whatsapp')).toBe(false); // no Inbox for this agent
    expect(seen.some((i) => i.source === 'lead')).toBe(false); // someone else's lead
    // With "hide customer numbers from agents", a call's numbers are masked for the agent.
    expect((await call(owner, 'patch', '/organization/settings', { hidePhonesFromAgents: true })).status).toBe(200);
    await call(owner, 'post', '/calls', { contactId: contact.id, outcome: 'connected' });
    const agentCalls = (await call(agent, 'get', `/calls?contactId=${contact.id}`)).body.data;
    expect(agentCalls[0].toNumber).toMatch(/•/);
    expect(JSON.stringify(agentCalls)).not.toContain('9829080202');
    expect((await call(owner, 'get', `/calls?contactId=${contact.id}`)).body.data[0].toNumber).toBe('+919829080202');
    const other = await login('tl-other@example.com', { name: 'Other' });
    expect((await call(other, 'get', `/contacts/${contact.id}/timeline`)).status).toBe(404);
    expect((await call(other, 'post', '/calls', { contactId: contact.id, outcome: 'connected' })).status).toBe(404);
  });

  it('logs a call once per key, moves the lead\'s last activity, and lets only its maker change it', async () => {
    const owner = await login('log-owner@example.com', { name: 'Mohan' });
    const agent = await inviteAndJoin(owner.token, 'log-agent@example.com', { role: 'agent' });
    const contact = await newContact(owner, { phone: '+919829080203' });
    const lead = (await call(owner, 'post', '/leads', { contactId: contact.id, title: 'Order' })).body.data;
    await Lead.updateOne({ _id: lead.id }, { $set: { lastActivityAt: new Date(Date.now() - 9 * DAY) } });
    const logIt = () => api().post('/api/v1/calls').set(auth(owner)).set('Idempotency-Key', 'call-log-1').send({ contactId: contact.id, leadId: lead.id, outcome: 'callback', durationSec: 75, notes: 'Call after 5 pm' });
    const first = await logIt();
    const again = await logIt();
    expect(first.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await Call.countDocuments({ contactId: contact.id })).toBe(1);
    expect(first.body.data).toMatchObject({ provider: 'manual', status: 'completed', outcome: 'callback', durationSec: 75, direction: 'out' });
    expect(Date.now() - new Date((await Lead.findById(lead.id)).lastActivityAt).getTime()).toBeLessThan(60000);
    expect((await call(owner, 'post', '/calls', { contactId: contact.id, outcome: 'maybe' })).status).toBe(400);
    expect((await call(agent, 'patch', `/calls/${first.body.data.id}`, { notes: 'mine now' })).status).toBe(403);
    expect((await call(owner, 'patch', `/calls/${first.body.data.id}`, { outcome: 'interested' })).body.data.outcome).toBe('interested');
    expect((await call(owner, 'get', `/calls?contactId=${contact.id}`)).body.data).toHaveLength(1);
  });

  it('places a call through the provider, finishes it by the webhook, never goes back and stores no recording', async () => {
    const owner = await login('dial-owner@example.com', { name: 'Neeraj' });
    const agent = await inviteAndJoin(owner.token, 'dial-agent@example.com', { role: 'agent' });
    const contact = await newContact(owner, { phone: '+919829080204' });
    expect((await call(owner, 'post', '/calls/dial', { contactId: contact.id })).body.code).toBe('NOT_CONNECTED');
    expect((await call(agent, 'put', '/telephony', { provider: 'mock' })).status).toBe(403);
    const connected = (await call(owner, 'put', '/telephony', { provider: 'mock', callerId: '+918069000000' })).body.data;
    expect(connected).toMatchObject({ connected: true, provider: 'mock', callerId: '+918069000000' });
    expect((await call(agent, 'get', '/telephony')).body.data).toEqual({ connected: true, provider: 'mock' });
    expect((await call(owner, 'post', '/calls/dial', { contactId: contact.id })).body.code).toBe('MEMBER_NO_PHONE');
    await OrganizationMember.updateOne({ _id: owner.data.member.id }, { $set: { mobile: '98290 80299' } });

    const placed = await call(owner, 'post', '/calls/dial', { contactId: contact.id });
    expect(placed.status).toBe(201);
    expect(placed.body.data).toMatchObject({ status: 'queued', provider: 'mock', toNumber: '+919829080204', fromNumber: '+919829080299' });
    const [sent] = mock.placed();
    expect(sent).toMatchObject({ from: '+919829080299', to: '+919829080204', callerId: '+918069000000' });
    const key = (await TelephonyConnection.findOne({ organizationId: owner.data.organizationId })).webhookKey;
    expect(sent.statusCallback).toMatch(new RegExp(`/api/v1/webhooks/calls/${key}$`));

    expect((await webhook('0'.repeat(32), { CallSid: sent.providerCallId, Status: 'completed' })).status).toBe(404);
    expect((await webhook(key, `CallSid=${sent.providerCallId}&Status=in-progress`, 'application/x-www-form-urlencoded')).status).toBe(200);
    expect((await Call.findById(placed.body.data.id)).status).toBe('in_progress');
    await webhook(key, { CallSid: sent.providerCallId, Status: 'completed', ConversationDuration: '95', RecordingUrl: 'https://recordings.example.com/a.mp3' });
    await webhook(key, { CallSid: sent.providerCallId, Status: 'completed', ConversationDuration: '95' }); // again
    await webhook(key, { CallSid: sent.providerCallId, Status: 'ringing' }); // late
    const done = await Call.findById(placed.body.data.id).lean();
    expect(done).toMatchObject({ status: 'completed', durationSec: 95 });
    expect(JSON.stringify(done)).not.toMatch(/recording/i);
    expect((await webhook(key, { CallSid: 'unknown-call', Status: 'completed' })).status).toBe(200);
    expect((await webhook(key, '{broken', 'application/json')).status).toBe(400);

    // The provider refuses: the call is saved as failed and the answer says why.
    mock.failNext({ message: 'Exotel answered 503.' });
    const refused = await call(owner, 'post', '/calls/dial', { contactId: contact.id });
    expect(refused.status).toBe(502);
    expect(refused.body.code).toBe('CALL_FAILED');
    expect(await Call.countDocuments({ contactId: contact.id, status: 'failed', error: 'Exotel answered 503.' })).toBe(1);
  });

  it('keeps Exotel keys encrypted and sends Exotel the documented request', async () => {
    const owner = await login('exo-owner@example.com', { name: 'Om' });
    const saved = (await call(owner, 'put', '/telephony', { provider: 'exotel', accountSid: 'acme1', apiKey: 'KEY-123', apiToken: 'TOKEN-456', callerId: '080 6900 0000' })).body.data;
    expect(saved).toMatchObject({ provider: 'exotel', accountSid: 'acme1', callerId: '+918069000000', hasKeys: true, subdomain: 'api.exotel.com' });
    expect(JSON.stringify(saved)).not.toMatch(/KEY-123|TOKEN-456/);
    const row = await TelephonyConnection.findOne({ organizationId: owner.data.organizationId }).lean();
    expect(JSON.stringify(row)).not.toMatch(/KEY-123|TOKEN-456/);
    expect((await call(owner, 'put', '/telephony', { provider: 'exotel', accountSid: 'acme1', callerId: '+918069000000', subdomain: 'evil.example.com' })).status).toBe(400);

    const sent = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      sent.push({ url: String(url), options });
      return new Response(JSON.stringify({ Call: { Sid: 'exo-sid-1', Status: 'in-progress' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await exotel.connect({ accountSid: 'acme1', apiKey: 'KEY-123', apiToken: 'TOKEN-456', subdomain: 'api.exotel.com', callerId: '+918069000000' }, { from: '+919829080299', to: '+919829080204', statusCallback: 'https://crm.example.com/api/v1/webhooks/calls/abc' });
    expect(result).toEqual({ providerCallId: 'exo-sid-1', status: 'in_progress' });
    expect(sent[0].url).toBe('https://api.exotel.com/v1/Accounts/acme1/Calls/connect');
    expect(sent[0].options.method).toBe('POST');
    expect(sent[0].options.headers.Authorization).toBe(`Basic ${Buffer.from('KEY-123:TOKEN-456').toString('base64')}`);
    const body = new URLSearchParams(sent[0].options.body);
    expect(Object.fromEntries(body)).toMatchObject({ From: '+919829080299', To: '+919829080204', CallerId: '+918069000000', Record: 'false', StatusCallback: 'https://crm.example.com/api/v1/webhooks/calls/abc', StatusCallbackContentType: 'application/json' });
    expect(body.getAll('StatusCallbackEvents[]')).toEqual(['answered', 'terminal']);

    global.fetch.mockImplementation(async () => new Response('{}', { status: 401 }));
    await expect(exotel.connect({ accountSid: 'acme1', apiKey: 'x', apiToken: 'y', callerId: '+918069000000' }, { from: '1', to: '2', statusCallback: 's' })).rejects.toMatchObject({ statusCode: 400 });
    expect(exotel.parseStatus({ CallSid: 'a', Status: 'no-answer', DateUpdated: '2026-10-22 10:00:00' })).toMatchObject({ providerCallId: 'a', status: 'no_answer' });
  });
});
