jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const ConsentEvent = require('../models/ConsentEvent');
const Contact = require('../models/Contact');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const SmsMessage = require('../models/SmsMessage');
const SmsConnection = require('../models/SmsConnection');
const Job = require('../models/Job');
const queue = require('../jobs/queue');
const engine = require('../services/automation/engine');
const sequences = require('../services/automation/sequences');
const sms = require('../integrations/sms');
const { encrypt } = require('../utils/secretBox');
const flow = require('../integrations/sms/flow');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// SMS to customers (Phase 8A, D88): the connection, sending once per key, opt-out, delivery
// reports and replies on the secret address, the SMS step in sequences, and the MSG91 adapter.
const DAY = 24 * 60 * 60 * 1000;
// Sequence steps (and their retries) are due later: make them due now (as sequences.test.js does).
const fastForward = async () => { await Job.updateMany({ name: 'sequence.step', status: 'queued' }, { $set: { runAt: new Date() } }); await queue.runDue(); };
const req = (token) => ({
  get: (path) => api().get(`/api/v1${path}`).set(bearer(token)),
  post: (path, body, key) => {
    const r = api().post(`/api/v1${path}`).set(bearer(token));
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  },
  put: (path, body) => api().put(`/api/v1${path}`).set(bearer(token)).send(body),
});
const webhook = (key, body) => api().post(`/api/v1/webhooks/sms/${key}`).set('Content-Type', 'application/json').send(JSON.stringify(body));
const TEMPLATES = [
  { name: 'Follow-up', flowId: 'flow-1', dltTemplateId: '1107160000000000001', text: 'Dear ##name##, your quote from ##org## is ready. Reply STOP to stop.' },
  { name: 'Thanks', flowId: 'flow-2', text: 'Thank you for visiting.' },
];

beforeAll(() => {
  engine.register(queue);
  sequences.register?.(queue);
});
afterAll(() => queue.stop());
beforeEach(() => sms.mock.reset());

async function setUp(email) {
  const owner = await login(email, { name: 'Pooja' });
  const o = req(owner.token);
  const saved = await o.put('/sms/connection', { provider: 'mock', senderId: 'YELLOW', templates: TEMPLATES });
  const lead = (await o.post('/leads', { title: 'Granite', contact: { name: 'Verma Stones', phone: '+919829080601', company: 'Verma Stones' } })).body.data;
  return { owner, o, connection: saved.body.data, lead, contactId: lead.contactId };
}

describe('SMS to customers', () => {
  it('connects, shows managers everything and others only the templates', async () => {
    const { owner, o, connection } = await setUp('sms-conn@example.com');
    expect(connection).toMatchObject({ connected: true, provider: 'mock', senderId: 'YELLOW', status: 'active' });
    expect(connection.templates.map((t) => [t.name, t.variables])).toEqual([['Follow-up', ['name', 'org']], ['Thanks', []]]);
    expect(connection.webhookUrl).toMatch(/\/api\/v1\/webhooks\/sms\/[a-f0-9]{32}$/);
    const agent = await inviteAndJoin(owner.token, 'sms-conn-agent@example.com', { role: 'agent', modules: ['customers'] });
    const seen = (await req(agent.token).get('/sms/connection')).body.data;
    expect(seen).toEqual({ connected: true, templates: [{ key: expect.any(String), name: 'Follow-up', text: TEMPLATES[0].text, variables: ['name', 'org'] }, { key: expect.any(String), name: 'Thanks', text: TEMPLATES[1].text, variables: [] }] });
    expect((await req(agent.token).put('/sms/connection', { provider: 'mock' })).status).toBe(403);
    // Saving again keeps the templates' keys; MSG91 needs its key and each template id.
    const again = (await o.put('/sms/connection', { provider: 'mock', templates: TEMPLATES })).body.data;
    expect(again.templates.map((t) => t.key)).toEqual(connection.templates.map((t) => t.key));
    expect((await o.put('/sms/connection', { provider: 'msg91', templates: TEMPLATES })).body.errors[0].field).toBe('authKey');
    expect((await o.put('/sms/connection', { provider: 'mock', senderId: 'TOOLONG1' })).status).toBe(400);
    expect((await o.post('/sms/connection/test', {})).body.data).toEqual({ ok: true });
  });

  it('sends once per key, refuses opted-out customers, and keeps the history', async () => {
    const { o, connection, lead, contactId } = await setUp('sms-send@example.com');
    const followUp = connection.templates[0].key;
    const send = (key, values = { name: 'Verma ji', org: 'Pooja Traders' }) => o.post('/sms', { contactId, leadId: lead.id, template: followUp, values }, key);
    const first = await send('sms-key-1');
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ status: 'sent', text: 'Dear Verma ji, your quote from Pooja Traders is ready. Reply STOP to stop.', to: '+919829080601', source: 'manual' });
    const again = await send('sms-key-1');
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(sms.mock.sent()).toHaveLength(1);
    expect((await send('sms-key-2', { name: '', org: 'x' })).body.code).toBe('SMS_BLANK_EMPTY');

    // A refusal is saved as failed; an outage can be tried again with the same key.
    sms.mock.failNext({ retryable: true });
    expect((await send('sms-key-3')).status).toBe(502);
    expect(await SmsMessage.countDocuments({ status: 'failed', retryable: true })).toBe(1);
    const retried = await send('sms-key-3b');
    expect(retried.status).toBe(201);

    // Opt-out: by hand (with its history), then nothing goes.
    expect((await o.post(`/contacts/${contactId}/sms-consent`, { optedOut: true })).body.data.smsOptOut).toMatchObject({ method: 'manual' });
    expect((await send('sms-key-4')).body.code).toBe('SMS_OPTED_OUT');
    expect((await ConsentEvent.find({ contactId, channel: 'sms' })).map((e) => e.to)).toEqual(['opted_out']);
    expect((await o.get(`/contacts/${contactId}`)).body.data.smsOptOut).toMatchObject({ method: 'manual' });
    const history = (await o.get(`/contacts/${contactId}/timeline?kinds=talk`)).body.data.items;
    expect(history.filter((i) => i.source === 'sms').map((i) => i.status)).toEqual(['sent', 'failed', 'sent']);
    const stranger = await login('sms-stranger@example.com');
    expect((await req(stranger.token).post('/sms', { contactId, template: followUp }, 'stranger-key-1')).status).toBe(404);
  });

  it('takes delivery reports and replies on the secret address only, once, never going back', async () => {
    const { o, connection, contactId } = await setUp('sms-hook@example.com');
    const res = await o.post('/sms', { contactId, template: connection.templates[1].key }, 'hook-key-1');
    const sent = res.body.data;
    const message = await SmsMessage.findById(sent.id);
    const key = connection.webhookUrl.split('/').pop();
    const other = await setUp('sms-hook-other@example.com');
    const otherKey = other.connection.webhookUrl.split('/').pop();
    const delivered = { data: [{ requestId: message.providerMessageId, report: [{ status: '1', desc: 'DELIVERED', number: '919829080601' }] }] };
    expect((await webhook('0'.repeat(32), delivered)).status).toBe(404);
    expect((await webhook(otherKey, delivered)).status).toBe(200); // another company's address: no match
    expect((await SmsMessage.findById(sent.id)).status).toBe('sent');
    expect((await webhook(key, delivered)).status).toBe(200);
    expect((await webhook(key, delivered)).status).toBe(200);
    expect((await webhook(key, { requestId: message.providerMessageId, status: 'SUBMITTED' })).status).toBe(200); // late
    const after = await SmsMessage.findById(sent.id);
    expect(after.status).toBe('delivered');
    expect(after.deliveredAt).toBeTruthy();

    // "STOP" from the customer opts them out; any other reply is kept.
    expect((await webhook(key, { sender: '919829080601', content: 'kab aaoge?' })).status).toBe(200);
    expect((await Contact.findById(contactId)).smsOptOut?.at).toBeFalsy();
    expect((await webhook(key, { sender: '9829080601', content: 'STOP' })).status).toBe(200);
    expect((await Contact.findById(contactId)).smsOptOut).toMatchObject({ method: 'sms_reply' });
    expect(await SmsMessage.countDocuments({ organizationId: message.organizationId, direction: 'in' })).toBe(2);
  });

  it('sends from a sequence once, even when the job is retried, and stops on a reply or an opt-out', async () => {
    const { o, connection, lead, contactId } = await setUp('sms-seq@example.com');
    const step = { day: 0, type: 'sms.send', params: { template: connection.templates[0].key, variables: { name: 'contact.name', org: 'org.name' } } };
    const bad = await o.post('/sequences', { name: 'Bad', steps: [{ ...step, params: { template: connection.templates[0].key, variables: { name: 'contact.name' } } }] });
    expect(bad.body.errors[0].code).toBe('VARIABLE_REQUIRED');
    const sequence = (await o.post('/sequences', { name: 'SMS chase', stopOnReply: true, workingHoursOnly: false, steps: [step, { ...step, day: 2 }, { ...step, day: 4 }] })).body.data;
    const enrollment = (await o.post(`/sequences/${sequence.id}/enroll`, { leadId: lead.id }, 'enroll-key-1')).body.data;

    sms.mock.failNext({ retryable: true });
    await queue.runDue(); // the outage: the job will try again
    expect(sms.mock.sent()).toHaveLength(0);
    await fastForward(); // the retry, with the same key
    expect(sms.mock.sent()).toHaveLength(1);
    expect(await SmsMessage.countDocuments({ enrollmentId: enrollment.id })).toBe(1);
    expect((await SmsMessage.findOne({ enrollmentId: enrollment.id })).text).toMatch(/^Dear Verma Stones, your quote from .+ is ready. Reply STOP to stop.$/);

    // An SMS reply stops the next step.
    const key = connection.webhookUrl.split('/').pop();
    await webhook(key, { sender: '919829080601', content: 'Call me' });
    await fastForward();
    const stopped = await SequenceEnrollment.findById(enrollment.id);
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'The customer replied by SMS.' });
    expect(sms.mock.sent()).toHaveLength(1);

    // An opt-out stops a sequence even without stop-on-reply.
    const quiet = (await o.post('/sequences', { name: 'No reply stop', stopOnReply: false, workingHoursOnly: false, steps: [{ ...step, day: 1 }] })).body.data;
    const second = (await o.post(`/sequences/${quiet.id}/enroll`, { leadId: lead.id }, 'enroll-key-2')).body.data;
    await o.post(`/contacts/${contactId}/sms-consent`, { optedOut: true });
    await fastForward();
    expect(await SequenceEnrollment.findById(second.id)).toMatchObject({ status: 'stopped', stopReason: 'The customer opted out.' });
    expect(sms.mock.sent()).toHaveLength(1);
  });

  it('previews the SMS step of a workflow with the text filled in, sending nothing', async () => {
    const { o, connection, lead } = await setUp('sms-preview@example.com');
    const res = await o.post('/workflows/preview', { draft: { name: '', trigger: { type: 'lead.created' }, steps: [{ type: 'sms.send', params: { template: connection.templates[0].key, variables: { name: 'contact.name', org: 'text:Pooja Traders' } } }] }, leadId: lead.id });
    expect(res.status).toBe(200); // a draft with no conditions and no name can be tried
    expect(res.body.data.steps[0]).toMatchObject({ type: 'sms.send', status: 'do', facts: { template: 'Follow-up', text: 'Dear Verma Stones, your quote from Pooja Traders is ready. Reply STOP to stop.' } });
    expect(sms.mock.sent()).toHaveLength(0);
  });

  it('talks to MSG91 as documented, and reads its reports loosely', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ type: 'success', message: 'req-123' }), { status: 200 }));
    const result = await flow.send({ authKey: 'k-1', senderId: 'YELLOW' }, { to: '+919829080601', template: { flowId: 'flow-9' }, values: { name: 'Verma' } });
    expect(result).toEqual({ providerMessageId: 'req-123', status: 'sent' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://control.msg91.com/api/v5/flow');
    expect(options.headers.authkey).toBe('k-1');
    expect(JSON.parse(options.body)).toEqual({ template_id: 'flow-9', short_url: '0', sender: 'YELLOW', recipients: [{ mobiles: '919829080601', name: 'Verma' }] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'error', message: 'Template not approved' }), { status: 200 }));
    await expect(flow.send({ authKey: 'k-1' }, { to: '+919829080601', template: { flowId: 'x' }, values: {} })).rejects.toMatchObject({ statusCode: 422, retryable: false });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(flow.send({ authKey: 'k-1' }, { to: '+919829080601', template: { flowId: 'x' }, values: {} })).rejects.toMatchObject({ statusCode: 502, retryable: true });
    fetchMock.mockRestore();
    expect(flow.parseWebhook({ data: [{ requestId: 'r1', report: [{ status: '2', desc: 'FAILED' }] }] }).reports).toEqual([{ providerMessageId: 'r1', status: 'failed', error: 'FAILED' }]);
    expect(flow.parseWebhook({ sender: '91982', content: 'STOP' }).inbound).toEqual([{ from: '91982', text: 'STOP' }]);
    // The auth key is stored encrypted.
    const stored = await SmsConnection.create({ organizationId: (await login('sms-enc@example.com')).data.organizationId, provider: 'msg91', authKeyEnc: encrypt('secret-key'), webhookKey: 'f'.repeat(32) });
    expect(stored.authKeyEnc).not.toContain('secret-key');
  });
});
