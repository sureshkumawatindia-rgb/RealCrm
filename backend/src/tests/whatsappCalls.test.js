jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mock = require('../integrations/whatsapp/mock');
const bus = require('../realtime/bus');
const Call = require('../models/Call');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const LeadActivity = require('../models/LeadActivity');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const OrganizationMember = require('../models/OrganizationMember');
const User = require('../models/User');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const inbound = require('../services/whatsappInboundService');
const calls = require('../services/whatsappCallService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// G7 (D111): WhatsApp calls (Meta's Calling API, offered for Indian numbers) — a number's calls are
// switched on in Settings; a customer's call rings in the Inbox and the first teammate to answer
// takes it; a teammate calls a customer who allowed it; every call is in the call log and the chat.
describe('WhatsApp calls (G7, D111)', () => {
  let owner;
  let agent;
  let agentMemberId;
  let account;
  let sent = [];
  let events = [];
  const as = (user) => bearer(user.token);
  const post = (path, body = {}, user = owner) => api().post(`/api/v1${path}`).set(as(user)).send(body);
  const put = (path, body, user = owner) => api().put(`/api/v1${path}`).set(as(user)).send(body);
  const get = (path, user = owner) => api().get(`/api/v1${path}`).set(as(user));
  // What WhatsApp would send: a call webhook (the simulator), processed like a real one.
  const simulate = async (body) => {
    const res = await post('/dev/simulate/whatsapp-call', body);
    expect(res.status).toBe(201);
    await inbound.idle();
    return res.body.data;
  };
  const write = async (from, text) => {
    const data = (await post('/dev/simulate/whatsapp-inbound', { from, text })).body.data;
    await inbound.idle();
    return data;
  };
  // The audio set-up a browser makes (here: the simulator's sample).
  const browserSdp = () => mock.sampleSdp('offer');
  const actionsOf = (callId) => mock.callActions().filter((a) => a.callId === callId);
  const listen = (name) => {
    const listener = (payload) => events.push({ name, payload });
    bus.on(name, listener);
    return () => bus.off(name, listener);
  };
  let stopListening = [];

  beforeAll(async () => {
    owner = await login('calls-owner@example.com', { name: 'Asha Owner' });
    await post('/whatsapp/accounts', { provider: 'mock' });
    agent = await inviteAndJoin(owner.token, 'calls-agent@example.com', { role: 'agent', modules: ['inbox', 'customers'] });
    const user = await User.findOne({ email: 'calls-agent@example.com' });
    agentMemberId = String((await OrganizationMember.findOne({ userId: user._id }))._id);
    account = await WhatsAppAccount.findOne({ provider: 'mock' }).sort({ createdAt: -1 });
  });
  beforeEach(() => {
    sent = [];
    events = [];
    stopListening = ['call:incoming', 'call:updated', 'call:answer'].map(listen);
    jest.spyOn(mock, 'sendMessage').mockImplementation(async (credentials, body) => {
      sent.push(body);
      return { providerMessageId: `wamid.CALL${sent.length}${Date.now()}` };
    });
  });
  afterEach(() => {
    stopListening.forEach((stop) => stop());
    jest.restoreAllMocks();
  });

  it('lets owners and admins switch WhatsApp calls on a number with Meta', async () => {
    expect((await put(`/whatsapp/accounts/${account._id}/calling`, { enabled: true }, agent)).status).toBe(403);
    const on = await put(`/whatsapp/accounts/${account._id}/calling`, { enabled: true, callbackPermission: true });
    expect(on.status).toBe(200);
    expect(on.body.data.calling).toMatchObject({ enabled: true, callbackPermission: true });
    expect(mock.callSettings(account.phoneNumberId)).toEqual({ enabled: true, callbackPermission: true });
    const listed = (await get('/whatsapp/accounts')).body.data;
    expect(listed.find((a) => a.id === String(account._id)).calling).toMatchObject({ enabled: true, callbackPermission: true });
  });

  it("rings a customer's call for those who see the chat; the first to answer takes it and WhatsApp gets the answer", async () => {
    const { callId } = await simulate({ event: 'incoming', from: '98290 71111', name: 'Ravi Kumar' });
    const call = await Call.findById(callId);
    expect(call).toMatchObject({ provider: 'whatsapp', direction: 'in', status: 'ringing', fromNumber: '+919829071111' });
    expect(call.whatsapp.offer).toMatch(/^v=0\r\n/);
    // A new number is a contact and a lead, and the chat shows the call (unread, no 24-hour window).
    const contact = await Contact.findById(call.contactId);
    expect(contact.name).toBe('Ravi Kumar');
    expect(await LeadActivity.findOne({ contactId: contact._id, text: 'First WhatsApp call' })).toBeTruthy();
    const chat = await Conversation.findById(call.whatsapp.conversationId);
    expect(chat).toMatchObject({ unreadCount: 1, lastMessagePreview: 'WhatsApp call', status: 'open' });
    expect(chat.lastInboundAt).toBeFalsy();
    // "Customers who call can be called back" is on: 7 days of permission.
    expect(chat.callPermission).toMatchObject({ status: 'granted', source: 'call' });
    expect(chat.callPermission.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    const line = await Message.findById(call.whatsapp.messageId);
    expect(line).toMatchObject({ type: 'call', direction: 'in', status: 'received', text: 'WhatsApp call' });
    const ring = events.find((e) => e.name === 'call:incoming');
    expect(ring.payload.call).toMatchObject({ id: call._id, status: 'ringing', conversationId: chat._id });
    expect(ring.payload.call.sdp).toBe(call.whatsapp.offer);

    // An Inbox opened while it rings shows it too.
    const ringing = (await get('/whatsapp-calls/ringing', agent)).body.data;
    expect(ringing).toHaveLength(1);
    expect(ringing[0].conversation).toMatchObject({ id: String(chat._id), account: { calling: true }, callPermission: { status: 'granted' } });
    expect(ringing[0].call.sdp).toMatch(/^v=0/);

    const answer = browserSdp();
    const answered = await post(`/whatsapp-calls/${callId}/answer`, { sdp: answer }, agent);
    expect(answered.status).toBe(200);
    expect(answered.body.data).toMatchObject({ status: 'in_progress', memberId: agentMemberId });
    expect(actionsOf(call.providerCallId).map((a) => [a.action, a.sdp === answer])).toEqual([['pre_accept', true], ['accept', true]]);
    // Answering takes the unassigned chat, and everyone hears the call was answered.
    expect(String((await Conversation.findById(chat._id)).assigneeId)).toBe(agentMemberId);
    expect(events.find((e) => e.name === 'call:updated' && e.payload.call.status === 'in_progress').payload.previousAssigneeId).toBeNull();
    const late = await post(`/whatsapp-calls/${callId}/answer`, { sdp: browserSdp() });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('CALL_NOT_RINGING');
    expect((await get('/whatsapp-calls/ringing', agent)).body.data).toEqual([]);

    // The customer hangs up after 75 seconds: Meta's length.
    await simulate({ event: 'end', callId: call.providerCallId, duration: 75 });
    const done = await Call.findById(callId);
    expect(done).toMatchObject({ status: 'completed', durationSec: 75 });
    expect(done.whatsapp.offer).toBeUndefined();
    expect(await Message.findById(call.whatsapp.messageId)).toMatchObject({ text: 'WhatsApp call, 1 min 15 s', call: { status: 'completed', durationSec: 75 } });
    expect((await Contact.findById(contact._id)).lastContactedAt).toBeTruthy();
    // The customer's history has the call (and not its line twice).
    const timeline = (await get(`/contacts/${contact._id}/timeline`)).body.data.items;
    expect(timeline.filter((i) => i.source === 'call')).toEqual([expect.objectContaining({ provider: 'whatsapp', title: 'WhatsApp call from the customer', durationSec: 75 })]);
    expect(timeline.some((i) => i.source === 'whatsapp' && /WhatsApp call/.test(i.detail))).toBe(false);
  });

  it('makes a call nobody answers a missed call (a bell note), and lets a teammate decline one', async () => {
    const { callId } = await simulate({ event: 'incoming', from: '98290 73333', name: 'Meena' });
    const call = await Call.findById(callId);
    await simulate({ event: 'end', callId: call.providerCallId });
    const missed = await Call.findById(callId);
    expect(missed).toMatchObject({ status: 'no_answer', durationSec: 0 });
    expect(await Message.findById(call.whatsapp.messageId)).toMatchObject({ text: 'Missed WhatsApp call', call: { status: 'no_answer' } });
    expect((await Conversation.findById(call.whatsapp.conversationId)).lastMessagePreview).toBe('Missed WhatsApp call');
    const note = await Notification.findOne({ title: 'Missed WhatsApp call from Meena' });
    expect(note).toBeTruthy();
    expect(note.link).toBe(`Inbox.html?c=${call.whatsapp.conversationId}`);

    const second = await simulate({ event: 'incoming', from: '98290 73333', name: 'Meena' });
    const declined = await post(`/whatsapp-calls/${second.callId}/decline`, {}, agent);
    expect(declined.status).toBe(200);
    expect(declined.body.data).toMatchObject({ status: 'busy', memberId: agentMemberId });
    const ringingCall = await Call.findById(second.callId);
    expect(actionsOf(ringingCall.providerCallId).map((a) => a.action)).toEqual(['reject']);
    expect(await Message.findById(ringingCall.whatsapp.messageId)).toMatchObject({ text: 'WhatsApp call, declined' });
    expect(await Notification.countDocuments({ title: 'Missed WhatsApp call from Meena' })).toBe(1);
  });

  it('calls a customer who allowed it: asked in the chat first; WhatsApp\'s answer goes to that teammate', async () => {
    const { conversationId } = await write('98290 72222', 'Please call me about the price');
    const tooSoon = await post('/whatsapp-calls', { conversationId, sdp: browserSdp() }, agent);
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.code).toBe('NO_CALL_PERMISSION');

    const asked = await post('/whatsapp-calls/permission', { conversationId, text: 'May we call you on WhatsApp about your enquiry?' }, agent);
    expect(asked.status).toBe(201);
    expect(sent[0]).toMatchObject({
      to: '919829072222',
      type: 'interactive',
      interactive: { type: 'call_permission_request', action: { name: 'call_permission_request' }, body: { text: 'May we call you on WhatsApp about your enquiry?' } },
    });
    expect((await get(`/conversations/${conversationId}`, agent)).body.data.callPermission).toMatchObject({ status: 'requested' });
    const again = await post('/whatsapp-calls/permission', { conversationId, text: 'Please?' }, agent);
    expect(again.body.code).toBe('ASKED_TODAY');

    await simulate({ event: 'permission', from: '98290 72222', response: 'accept' });
    const allowed = (await get(`/conversations/${conversationId}`, agent)).body.data.callPermission;
    expect(allowed).toMatchObject({ status: 'granted', permanent: false });
    expect(new Date(allowed.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await Message.findOne({ conversationId, callPermission: { $exists: true } })).toMatchObject({ text: 'Allowed WhatsApp calls', callPermission: { response: 'accept' } });

    const offer = browserSdp();
    const placed = await post('/whatsapp-calls', { conversationId, sdp: offer }, agent);
    expect(placed.status).toBe(201);
    expect(placed.body.data).toMatchObject({ direction: 'out', status: 'queued', memberId: agentMemberId });
    expect(placed.body.data.toNumber).toBe('+91 98••• ••222'); // agents see customers' numbers hidden (D65)
    const call = await Call.findById(placed.body.data.id);
    expect(call.toNumber).toBe('+919829072222');
    expect(actionsOf(call.providerCallId)).toEqual([expect.objectContaining({ action: 'connect', to: '919829072222', sdp: offer, tag: String(call._id) })]);
    expect(await Message.findById(call.whatsapp.messageId)).toMatchObject({ type: 'call', direction: 'out', text: 'WhatsApp call' });

    await simulate({ event: 'ringing', callId: call.providerCallId });
    expect((await Call.findById(call._id)).status).toBe('ringing');
    await simulate({ event: 'answer', callId: call.providerCallId });
    const answer = events.find((e) => e.name === 'call:answer');
    expect(String(answer.payload.memberId)).toBe(agentMemberId);
    expect(answer.payload.call.sdp).toMatch(/^v=0/);
    expect((await Call.findById(call._id)).status).toBe('in_progress');
    expect((await get(`/whatsapp-calls/${call._id}`, agent)).body.data.sdp).toBe(answer.payload.call.sdp);
    expect((await get(`/whatsapp-calls/${call._id}`)).body.data.sdp).toBeUndefined(); // only for who called

    const hungUp = await post(`/whatsapp-calls/${call._id}/end`, {}, agent);
    expect(hungUp.body.data.status).toBe('completed');
    expect(actionsOf(call.providerCallId).map((a) => a.action)).toEqual(['connect', 'terminate']);
    await simulate({ event: 'end', callId: call.providerCallId, duration: 42 });
    expect(await Call.findById(call._id)).toMatchObject({ status: 'completed', durationSec: 42 });
    expect((await Message.findById(call.whatsapp.messageId)).text).toBe('WhatsApp call, 42 s');
  });

  it('refuses calls on a number with calls off, and closes calls whose end never came', async () => {
    const { conversationId } = await write('98290 74444', 'Hello');
    await post('/whatsapp-calls/permission', { conversationId, text: 'May we call you?' }, agent);
    await simulate({ event: 'permission', from: '98290 74444', response: 'accept', permanent: true });
    expect((await get(`/conversations/${conversationId}`, agent)).body.data.callPermission).toMatchObject({ status: 'granted', permanent: true, expiresAt: null });
    await put(`/whatsapp/accounts/${account._id}/calling`, { enabled: false });
    expect(mock.callSettings(account.phoneNumberId)).toEqual({ enabled: false, callbackPermission: false });
    const off = await post('/whatsapp-calls', { conversationId, sdp: browserSdp() }, agent);
    expect(off.body.code).toBe('CALLING_OFF');
    expect((await get(`/conversations/${conversationId}`, agent)).body.data.account.calling).toBe(false);

    // A customer's call whose end WhatsApp never sent: missed after a few minutes.
    const { callId } = await simulate({ event: 'incoming', from: '98290 75555', name: 'Kiran' });
    await Call.updateOne({ _id: callId }, { $set: { startedAt: new Date(Date.now() - 5 * 60 * 1000) } });
    expect((await calls.sweep()).closed).toBe(1);
    expect(await Call.findById(callId)).toMatchObject({ status: 'no_answer' });
    expect(await Notification.findOne({ title: 'Missed WhatsApp call from Kiran' })).toBeTruthy();
    expect((await calls.sweep()).closed).toBe(0);
  });
});
