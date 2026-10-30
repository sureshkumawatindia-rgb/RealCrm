jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AuditLog = require('../models/AuditLog');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const CsatSurvey = require('../models/CsatSurvey');
const Job = require('../models/Job');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const ScheduledMessage = require('../models/ScheduledMessage');
const queue = require('../jobs/queue');
const mock = require('../integrations/whatsapp/mock');
const automationEvents = require('../services/automation/events');
const leadIntake = require('../services/leadIntakeService');
const scheduledMessages = require('../services/scheduledMessageService');
const segmentService = require('../services/segmentService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// D103: Inbox extras — quick replies with a file, "send later", the customer-feedback question
// after a resolved chat (CSAT) and blocking a customer.
const HOUR = 60 * 60 * 1000;
const simulate = async (token, body) => {
  const res = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(token)).send(body);
  if (res.status !== 201) throw new Error(`simulate: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const messages = async (token, conversationId) => (await api().get(`/api/v1/conversations/${conversationId}/messages`).set(bearer(token))).body.data;
// Every queued "send later" job is due now.
const runScheduledNow = async () => {
  await Job.updateMany({ name: scheduledMessages.JOB, status: 'queued' }, { $set: { runAt: new Date() } });
  await queue.runDue();
};
const interactiveSends = (spy) => spy.mock.calls.filter(([, payload]) => payload.type === 'interactive');

describe('Inbox extras: quick-reply files, send later, customer feedback, blocking (D103)', () => {
  let owner;
  let agent;
  let other;
  const as = (who) => bearer(who.token);
  const memberOf = (who) => who.data.member.id;

  beforeAll(async () => {
    scheduledMessages.register(queue);
    owner = await login('extras-owner@example.com', { name: 'Asha' });
    await api().post('/api/v1/whatsapp/accounts').set(as(owner)).send({ provider: 'mock' });
    agent = await inviteAndJoin(owner.token, 'extras-agent@example.com', { role: 'agent', modules: ['inbox'] });
    other = await inviteAndJoin(owner.token, 'extras-other@example.com', { role: 'agent', modules: ['inbox'] });
  });
  afterEach(() => jest.restoreAllMocks());

  describe('quick replies with a file', () => {
    const upload = (name, content) => api().post('/api/v1/documents').set(as(owner)).field('name', name).attach('file', Buffer.from(content), name);
    let reply;
    let chat;

    it('takes a photo, video or document from Documents that WhatsApp can carry', async () => {
      const pdf = (await upload('price-list.pdf', '%PDF-1.4 jeera 250, dhaniya 120')).body.data;
      const created = await api().post('/api/v1/quick-replies').set(as(owner)).send({ shortcut: 'price', title: 'Price list', body: 'Our price list is attached.', documentId: pdf.id });
      expect(created.status).toBe(201);
      expect(created.body.data.attachment).toEqual({ documentId: pdf.id, name: 'price-list.pdf', fileName: 'price-list.pdf', sizeBytes: expect.any(Number), type: 'document' });
      reply = created.body.data;

      // A zip cannot go on WhatsApp.
      const zip = (await upload('photos.zip', 'PK zip')).body.data;
      const refused = await api().post('/api/v1/quick-replies').set(as(owner)).send({ shortcut: 'zip', body: 'All photos', documentId: zip.id });
      expect(refused.status).toBe(400);
      expect(refused.body.errors[0]).toEqual(expect.objectContaining({ field: 'documentId', code: 'NOT_SENDABLE' }));

      // A teammate attaches only files they may open (this agent has no Documents page).
      const notTheirs = await api().post('/api/v1/quick-replies').set(as(agent)).send({ shortcut: 'theirs', body: 'Price list', documentId: pdf.id });
      expect(notTheirs.status).toBe(400);
      expect(notTheirs.body.errors[0]).toEqual(expect.objectContaining({ field: 'documentId', code: 'NOT_FOUND' }));
      expect((await api().get('/api/v1/quick-replies').set(as(agent))).body.data.find((r) => r.id === reply.id).attachment.fileName).toBe('price-list.pdf');
    });

    it('sends the file with the text as its caption, also for a teammate without the Documents page', async () => {
      chat = await simulate(owner.token, { from: '98290 40001', name: 'Meena', text: 'Rate list bhejo' });
      const uploadMedia = jest.spyOn(mock, 'uploadMedia');
      const send = jest.spyOn(mock, 'sendMessage');
      const res = await api().post(`/api/v1/conversations/${chat.conversationId}/messages/quick-reply-file`).set(as(agent)).send({ quickReplyId: reply.id, caption: 'Our price list is attached.' });
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(expect.objectContaining({ type: 'document', text: 'Our price list is attached.', direction: 'out' }));
      expect(uploadMedia).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fileName: 'price-list.pdf', mimeType: 'application/pdf' }));
      expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'document', document: expect.objectContaining({ caption: 'Our price list is attached.', filename: 'price-list.pdf' }) }));
    });

    it('sends a text longer than a caption first, then the file', async () => {
      const long = `Rates for this week: ${'jeera ₹250/kg, dhaniya ₹120/kg; '.repeat(40)}`.trim();
      expect(long.length).toBeGreaterThan(1024);
      const res = await api().post(`/api/v1/conversations/${chat.conversationId}/messages/quick-reply-file`).set(as(owner)).send({ quickReplyId: reply.id, caption: long });
      expect(res.status).toBe(201);
      const thread = (await messages(owner.token, chat.conversationId)).filter((m) => m.direction === 'out');
      expect(thread.slice(-2).map((m) => [m.type, m.text])).toEqual([['text', long], ['document', '']]);
    });

    it('a quick reply without its file any more cannot send one', async () => {
      const removed = await api().patch(`/api/v1/quick-replies/${reply.id}`).set(as(owner)).send({ documentId: null });
      expect(removed.status).toBe(200);
      expect(removed.body.data.attachment).toBeNull();
      const res = await api().post(`/api/v1/conversations/${chat.conversationId}/messages/quick-reply-file`).set(as(owner)).send({ quickReplyId: reply.id, caption: 'x' });
      expect(res.status).toBe(404);
    });
  });

  describe('send later', () => {
    let chat;
    const schedule = (who, body) => api().post(`/api/v1/conversations/${chat.conversationId}/scheduled`).set(as(who)).send(body);
    const inHours = (hours) => new Date(Date.now() + hours * HOUR).toISOString();

    beforeAll(async () => {
      chat = await simulate(owner.token, { from: '98290 40002', name: 'Ravi', text: 'Kal subah rate batana' });
    });

    it('takes a time from a minute to 30 days ahead, and warns when the 24-hour window will have closed', async () => {
      const tooSoon = await schedule(agent, { text: 'Hi', sendAt: new Date(Date.now() + 10 * 1000).toISOString() });
      expect(tooSoon.status).toBe(400);
      expect(tooSoon.body.errors[0].code).toBe('TOO_SOON');
      const tooLate = await schedule(agent, { text: 'Hi', sendAt: inHours(31 * 24) });
      expect(tooLate.body.errors[0].code).toBe('TOO_LATE');

      const late = await schedule(agent, { text: 'Day after', sendAt: inHours(30) });
      expect(late.status).toBe(201);
      expect(late.body.data.warning).toMatch(/24-hour window/);
      await api().delete(`/api/v1/scheduled-messages/${late.body.data.id}`).set(as(agent));
    });

    it('sends it at its time as its writer; until then it can be changed (by them or a manager) or cancelled', async () => {
      const made = await schedule(agent, { text: 'Good morning! Jeera is ₹250/kg today.', sendAt: inHours(2) });
      expect(made.status).toBe(201);
      expect(made.body.data).toEqual(expect.objectContaining({ status: 'scheduled', text: 'Good morning! Jeera is ₹250/kg today.', warning: '' }));
      expect((await api().get(`/api/v1/conversations/${chat.conversationId}/scheduled`).set(as(owner))).body.data.map((s) => s.id)).toEqual([made.body.data.id]);
      expect(await Job.exists({ name: scheduledMessages.JOB, 'data.id': made.body.data.id, status: 'queued' })).toBeTruthy();

      // Another agent may not change it; its writer and a manager may.
      expect((await api().patch(`/api/v1/scheduled-messages/${made.body.data.id}`).set(as(other)).send({ text: 'Mine now' })).status).toBe(403);
      const changed = await api().patch(`/api/v1/scheduled-messages/${made.body.data.id}`).set(as(agent)).send({ text: 'Good morning! Jeera is ₹245/kg today.' });
      expect(changed.status).toBe(200);
      expect((await api().patch(`/api/v1/scheduled-messages/${made.body.data.id}`).set(as(owner)).send({ sendAt: inHours(3) })).status).toBe(200);

      // A second one, cancelled: it never goes.
      const cancelled = await schedule(agent, { text: 'Never mind', sendAt: inHours(2) });
      expect((await api().delete(`/api/v1/scheduled-messages/${cancelled.body.data.id}`).set(as(agent))).body.data.status).toBe('cancelled');
      expect((await api().delete(`/api/v1/scheduled-messages/${cancelled.body.data.id}`).set(as(agent))).body.code).toBe('NOT_SCHEDULED');

      // The jobs of the old versions find nothing to do; the last one sends the last text, once.
      const send = jest.spyOn(mock, 'sendMessage');
      await runScheduledNow();
      expect(send).toHaveBeenCalledTimes(1);
      const item = await ScheduledMessage.findById(made.body.data.id);
      expect(item.status).toBe('sent');
      const sent = await Message.findById(item.messageId);
      expect(sent).toEqual(expect.objectContaining({ direction: 'out', type: 'text', text: 'Good morning! Jeera is ₹245/kg today.' }));
      expect(String(sent.sentByMemberId)).toBe(memberOf(agent));
      expect(String((await Conversation.findById(chat.conversationId)).assigneeId)).toBe(memberOf(agent)); // like their own reply
      expect((await ScheduledMessage.findById(cancelled.body.data.id)).status).toBe('cancelled');
      expect((await api().get(`/api/v1/conversations/${chat.conversationId}/scheduled`).set(as(owner))).body.data).toEqual([]);
    });

    it('does not send when the window has closed by then, and tells its writer to send a template', async () => {
      const made = await schedule(agent, { text: 'Are you still interested?', sendAt: inHours(2) });
      await Conversation.updateOne({ _id: chat.conversationId }, { $set: { lastInboundAt: new Date(Date.now() - 25 * HOUR) } });
      const send = jest.spyOn(mock, 'sendMessage');
      await runScheduledNow();
      expect(send).not.toHaveBeenCalled();
      expect(await ScheduledMessage.findById(made.body.data.id)).toEqual(expect.objectContaining({ status: 'window_closed' }));
      const note = await Notification.findOne({ memberId: memberOf(agent), title: 'Scheduled message not sent' });
      expect(note.body).toContain('"Are you still interested?" to Ravi did not go');
      expect(note.link).toBe(`Inbox.html?c=${chat.conversationId}&template=1`);
    });
  });

  describe('customer feedback after a resolved chat (CSAT)', () => {
    let chat;
    let survey;
    const close = (id) => api().patch(`/api/v1/conversations/${id}`).set(as(owner)).send({ status: 'closed' });

    it('is off by default: resolving asks nothing', async () => {
      expect((await api().get('/api/v1/organization/settings').set(as(owner))).body.data.csat).toEqual({ enabled: false, question: '' });
      chat = await simulate(owner.token, { from: '98290 40003', name: 'Kiran', text: 'Order kab aayega?' });
      await api().post(`/api/v1/conversations/${chat.conversationId}/messages`).set(as(agent)).send({ text: 'Kal tak pahunch jayega.' });
      const send = jest.spyOn(mock, 'sendMessage');
      expect((await close(chat.conversationId)).status).toBe(200);
      expect(interactiveSends(send)).toHaveLength(0);
      expect(await CsatSurvey.countDocuments()).toBe(0);
    });

    it('when on, asks once with three buttons for the chat\'s teammate; the chat stays resolved', async () => {
      const on = await api().patch('/api/v1/organization/settings').set(as(owner)).send({ csat: { enabled: true, question: 'Hamari service kaisi lagi?' } });
      expect(on.body.data.csat).toEqual({ enabled: true, question: 'Hamari service kaisi lagi?' });
      await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(as(owner)).send({ status: 'open' });
      const send = jest.spyOn(mock, 'sendMessage');
      await close(chat.conversationId);

      survey = await CsatSurvey.findOne({ conversationId: chat.conversationId });
      expect(String(survey.memberId)).toBe(memberOf(agent));
      expect(interactiveSends(send)).toHaveLength(1);
      expect(interactiveSends(send)[0][1].interactive).toEqual({
        type: 'button',
        body: { text: 'Hamari service kaisi lagi?' },
        action: { buttons: [['good', 'Good'], ['okay', 'Okay'], ['bad', 'Bad']].map(([rating, title]) => ({ type: 'reply', reply: { id: `csat:${survey._id}:${rating}`, title } })) },
      });
      expect((await Conversation.findById(chat.conversationId)).status).toBe('closed');
    });

    it('records the tap without reopening the chat or waking the bot; the first tap counts', async () => {
      const emit = jest.spyOn(automationEvents, 'emit');
      await simulate(owner.token, { from: '98290 40003', type: 'interactive', replyId: `csat:${survey._id}:good`, text: 'Good' });
      await simulate(owner.token, { from: '98290 40003', type: 'interactive', replyId: `csat:${survey._id}:bad`, text: 'Bad' });
      expect(await CsatSurvey.findById(survey._id)).toEqual(expect.objectContaining({ rating: 'good', answeredAt: expect.any(Date) }));
      expect((await Conversation.findById(chat.conversationId)).status).toBe('closed');
      expect(emit.mock.calls.filter(([event]) => event === 'message.received')).toHaveLength(0);
    });

    it('shows the score in Reports, Team live, My performance and the CSV', async () => {
      const agents = (await api().get('/api/v1/reports/agents').set(as(owner))).body.data;
      expect(agents.items.find((r) => r.memberId === memberOf(agent))).toEqual(expect.objectContaining({ csatAnswers: 1, csatGood: 1, csatOkay: 0, csatBad: 0, csatScorePct: 100 }));
      expect(agents.team.csat).toEqual({ answers: 1, good: 1, okay: 0, bad: 0, scorePct: 100 });
      const live = (await api().get('/api/v1/reports/team-live').set(as(owner))).body.data;
      expect(live.items.find((r) => r.memberId === memberOf(agent))).toEqual(expect.objectContaining({ csatAnswersToday: 1, csatScorePctToday: 100 }));
      expect(live.today.csat).toEqual(expect.objectContaining({ answers: 1, scorePct: 100 }));
      expect((await api().get('/api/v1/reports/me').set(as(agent))).body.data.me).toEqual(expect.objectContaining({ csatAnswers: 1, csatScorePct: 100 }));
      const csv = await api().get('/api/v1/reports/export?type=agents').set(as(owner));
      expect(csv.text).toContain('CSAT answers,CSAT good %');
    });

    it('asks a customer at most once a day, only inside the 24-hour window, never on a private number', async () => {
      const send = jest.spyOn(mock, 'sendMessage');
      // The same customer again today.
      await simulate(owner.token, { from: '98290 40003', text: 'Ek aur order' });
      await close(chat.conversationId);
      // A customer who wrote 25 hours ago.
      const old = await simulate(owner.token, { from: '98290 40008', name: 'Old customer', text: 'Hello' });
      await Conversation.updateOne({ _id: old.conversationId }, { $set: { lastInboundAt: new Date(Date.now() - 25 * HOUR) } });
      await close(old.conversationId);
      // A private number (D61).
      await api().post('/api/v1/privacy/numbers').set(as(owner)).send({ phone: '98290 40009', note: 'Family' });
      const family = await simulate(owner.token, { from: '98290 40009', text: 'Ghar kab aaoge?' });
      expect((await close(family.conversationId)).status).toBe(200);

      expect(interactiveSends(send)).toHaveLength(0);
      expect(await CsatSurvey.countDocuments()).toBe(1);
    });
  });

  describe('blocking a customer', () => {
    let chat;
    let contactId;
    const blockPath = () => `/api/v1/conversations/${chat.conversationId}/block`;

    beforeAll(async () => {
      chat = await simulate(owner.token, { from: '98290 40004', name: 'Spammer', text: 'Buy 10k followers cheap' });
      contactId = String(chat.contactId);
    });

    it('blocks on WhatsApp too, cancels what was scheduled, and is in the audit log', async () => {
      const later = await api().post(`/api/v1/conversations/${chat.conversationId}/scheduled`).set(as(owner)).send({ text: 'Follow-up', sendAt: new Date(Date.now() + HOUR).toISOString() });
      const meta = jest.spyOn(mock, 'blockUsers');
      const res = await api().post(blockPath()).set(as(owner)).send({ reason: 'Spam' });
      expect(res.status).toBe(200);
      expect(res.body.data.blocked).toEqual(expect.objectContaining({ byName: 'Asha', reason: 'Spam', onWhatsApp: true, whatsappNote: '' }));
      expect(res.body.data.conversation.blocked).toBe(true);
      expect(meta).toHaveBeenCalledWith(expect.anything(), ['919829040004'], { unblock: false });
      expect((await api().get(blockPath()).set(as(owner))).body.data.blocked).toEqual(expect.objectContaining({ reason: 'Spam', onWhatsApp: true }));
      expect((await ScheduledMessage.findById(later.body.data.id)).status).toBe('cancelled');
      expect(await AuditLog.exists({ action: 'contact.blocked', entityId: contactId })).toBeTruthy();
    });

    it('sends nothing to them, from a teammate or the CRM, and resolving asks no feedback', async () => {
      const text = await api().post(`/api/v1/conversations/${chat.conversationId}/messages`).set(as(owner)).send({ text: 'Hello?' });
      expect(text.status).toBe(409);
      expect(text.body.code).toBe('CONTACT_BLOCKED');
      const later = await api().post(`/api/v1/conversations/${chat.conversationId}/scheduled`).set(as(owner)).send({ text: 'Later', sendAt: new Date(Date.now() + HOUR).toISOString() });
      expect(later.body.code).toBe('CONTACT_BLOCKED');
      const send = jest.spyOn(mock, 'sendMessage');
      await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(as(owner)).send({ status: 'closed' }); // CSAT is on (above)
      expect(send).not.toHaveBeenCalled();
    });

    it('moves their chats to the Blocked list', async () => {
      const ids = async (query) => (await api().get(`/api/v1/conversations${query}`).set(as(owner))).body.data.map((c) => c.id);
      expect(await ids('?status=any')).not.toContain(chat.conversationId);
      expect(await ids('?view=blocked&status=any')).toEqual([chat.conversationId]);
    });

    it('keeps their messages quietly: no reopening, automation, lead or broadcast', async () => {
      const leadsBefore = await Lead.countDocuments({ contactId });
      const emit = jest.spyOn(automationEvents, 'emit');
      await simulate(owner.token, { from: '98290 40004', text: 'Reply karo!!' });
      const conversation = await Conversation.findById(chat.conversationId);
      expect(conversation.status).toBe('closed');
      expect(conversation.lastMessagePreview).toBe('Reply karo!!');
      expect(emit.mock.calls.filter(([event]) => event === 'message.received')).toHaveLength(0);

      const enquiry = await leadIntake.intake({ organizationId: owner.data.organizationId, source: 'IndiaMART', sourceRef: 'blocked-enquiry-1', person: { name: 'Spammer', phone: '+919829040004' }, enquiry: { message: 'Need 10 bags' } });
      expect(enquiry.outcome).toBe('rejected');
      expect(await Lead.countDocuments({ contactId })).toBe(leadsBefore);

      const everyone = await segmentService.contactFilter(owner.data.organizationId, {}, { withConsent: false });
      expect(await Contact.exists({ $and: [everyone, { _id: contactId }] })).toBeNull();
    });

    it('keeps the CRM block when WhatsApp refuses, with WhatsApp\'s reason', async () => {
      const second = await simulate(owner.token, { from: '98290 40005', name: 'Old number', text: 'hi' });
      jest.spyOn(mock, 'blockUsers').mockResolvedValueOnce({ done: [], failed: [{ input: '919829040005', errors: [{ code: 131047, message: 'Only someone who wrote in the last 24 hours can be blocked.' }] }] });
      const res = await api().post(`/api/v1/conversations/${second.conversationId}/block`).set(as(owner)).send({});
      expect(res.body.data.blocked).toEqual(expect.objectContaining({ onWhatsApp: false, whatsappNote: 'Only someone who wrote in the last 24 hours can be blocked.' }));
      expect(res.body.data.conversation.blocked).toBe(true);
    });

    it('unblocking undoes it here and on WhatsApp', async () => {
      const meta = jest.spyOn(mock, 'blockUsers');
      const res = await api().delete(blockPath()).set(as(owner));
      expect(res.status).toBe(200);
      expect(res.body.data.blocked).toBeNull();
      expect(res.body.data.conversation.blocked).toBe(false);
      expect(meta).toHaveBeenCalledWith(expect.anything(), ['919829040004'], { unblock: true });
      expect((await Contact.findById(contactId)).blocked?.at ?? null).toBeNull();
      expect(await AuditLog.exists({ action: 'contact.unblocked', entityId: contactId })).toBeTruthy();

      const everyone = await segmentService.contactFilter(owner.data.organizationId, {}, { withConsent: false });
      expect(await Contact.exists({ $and: [everyone, { _id: contactId }] })).toBeTruthy();
      const text = await api().post(`/api/v1/conversations/${chat.conversationId}/messages`).set(as(owner)).send({ text: 'Sorry, aap ka order dekh liya.' });
      expect(text.status).toBe(201);
    });
  });
});
