jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Conversation = require('../models/Conversation');
const Job = require('../models/Job');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const queue = require('../jobs/queue');
const mock = require('../integrations/whatsapp/mock');
const messageRetry = require('../services/messageRetryService');
const inbound = require('../services/whatsappInboundService');
const httpError = require('../utils/httpError');
const { api, bearer, login } = require('./helpers/api');

// Phase 9 of the 100 phases (D151): a message that could not go because of something that may
// pass waits and is tried again by itself; a refusal fails at once; the person who wrote it can
// stop it, or try again, and hears when it finally did not go.
const MIN = 60 * 1000;
const dueNow = async () => {
  await Job.updateMany({ name: messageRetry.JOBS.RETRY, status: 'queued' }, { $set: { runAt: new Date() } });
  await queue.runDue();
};
const refusal = () => Object.assign(httpError(400, 'WHATSAPP_ERROR', 'This number is not on WhatsApp.'), { providerCode: 131026, temporary: false });

describe('Trying a message again by itself', () => {
  let owner;
  let chat;
  let number = 0;
  const auth = () => bearer(owner.token);
  const say = (conversationId, text) => api().post(`/api/v1/conversations/${conversationId}/messages`).set(auth()).send({ text });
  const messageOf = (id) => Message.findById(id).lean();
  // A new chat (each test its own), the customer having just written.
  const newChat = async () => {
    number += 1;
    const res = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(auth()).send({ from: `98290 1${String(number).padStart(4, '0')}`, text: 'Rate?', name: `Customer ${number}` });
    await inbound.idle();
    return res.body.data.conversationId;
  };

  beforeAll(async () => {
    messageRetry.register(queue);
    owner = await login('retry-owner@example.com', { name: 'Owner' });
    await api().post('/api/v1/whatsapp/accounts').set(auth()).send({ provider: 'mock' });
  });
  beforeEach(async () => {
    mock.setTrouble(false);
    jest.restoreAllMocks();
    await Job.deleteMany({ name: messageRetry.JOBS.RETRY });
    chat = await newChat();
  });
  afterAll(async () => {
    mock.setTrouble(false);
    await queue.stop();
  });

  it('Meta in trouble: the message waits, shows when it goes next, and goes when Meta is back', async () => {
    mock.setTrouble(true);
    const before = Date.now();
    const sent = await say(chat, 'Your order is ready');
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ status: 'queued', canRetry: false, retry: { attempts: 1 } });
    expect(new Date(sent.body.data.retry.nextAt).getTime()).toBeGreaterThanOrEqual(before + MIN - 50);
    expect(new Date(sent.body.data.retry.nextAt).getTime()).toBeLessThan(Date.now() + MIN + 50);
    const job = await Job.findOne({ name: messageRetry.JOBS.RETRY }).lean();
    expect(job).toMatchObject({ status: 'queued', data: { id: sent.body.data.id, attempts: 1 } });

    // Not yet: the second try also fails, and the next waits longer.
    await dueNow();
    let stored = await messageOf(sent.body.data.id);
    expect(stored).toMatchObject({ status: 'queued', retry: { attempts: 2 } });
    expect(stored.retry.nextAt.getTime() - Date.now()).toBeGreaterThan(4 * MIN);

    mock.setTrouble(false);
    const listen = jest.fn();
    require('../realtime/bus').once('message:status', listen); // eslint-disable-line global-require
    await dueNow();
    stored = await messageOf(sent.body.data.id);
    expect(stored).toMatchObject({ status: 'sent', providerMessageId: expect.stringMatching(/^wamid/) });
    expect(stored.retry).toBeUndefined();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(await Job.countDocuments({ name: messageRetry.JOBS.RETRY, status: 'queued' })).toBe(0);
    expect((await api().get(`/api/v1/conversations/${chat}/messages`).set(auth())).body.data.find((m) => m.id === sent.body.data.id)).toMatchObject({ status: 'sent', retry: null, canRetry: false });
  });

  it('after every try, it fails, and the person who wrote it is told', async () => {
    mock.setTrouble(true);
    const sent = (await say(chat, 'Last one')).body.data;
    for (let i = 0; i < messageRetry.DELAYS_MIN.length; i += 1) {
      expect((await messageOf(sent.id)).status).toBe('queued');
      await dueNow();
    }
    const stored = await messageOf(sent.id);
    expect(stored).toMatchObject({ status: 'failed', error: { message: expect.stringMatching(/Could not reach WhatsApp/) } });
    expect(stored.retry.attempts).toBe(messageRetry.DELAYS_MIN.length + 1);
    expect(stored.retry.nextAt).toBeUndefined();
    expect(await Notification.findOne({ title: 'Message not sent' }).lean()).toMatchObject({ link: `Inbox.html?c=${chat}`, body: expect.stringContaining('Last one') });
    expect(messageRetry.DELAYS_MIN).toEqual([1, 5, 15, 30, 60, 120, 240]);
  });

  it('a refusal that will not pass fails at once, with no tries; "Try again" sends it', async () => {
    jest.spyOn(mock, 'sendMessage').mockRejectedValueOnce(refusal());
    const sent = (await say(chat, 'To a wrong number')).body.data;
    expect(sent).toMatchObject({ status: 'failed', canRetry: true, retry: null, error: { message: 'This number is not on WhatsApp.' } });
    expect(await Job.countDocuments({ name: messageRetry.JOBS.RETRY })).toBe(0);
    const again = await api().post(`/api/v1/conversations/${chat}/messages/${sent.id}/retry`).set(auth()).send({});
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ status: 'sent', canRetry: false });
    expect((await api().post(`/api/v1/conversations/${chat}/messages/${sent.id}/retry`).set(auth()).send({})).status).toBe(409);
  });

  it('"Don\'t send" stops the next try, and "Try again" still works later', async () => {
    mock.setTrouble(true);
    const sent = (await say(chat, 'Wrong price')).body.data;
    const stopped = await api().post(`/api/v1/conversations/${chat}/messages/${sent.id}/stop-retry`).set(auth()).send({});
    expect(stopped.status).toBe(200);
    expect(stopped.body.data).toMatchObject({ status: 'failed', retry: null, canRetry: true, error: { title: 'stopped' } });
    expect((await api().post(`/api/v1/conversations/${chat}/messages/${sent.id}/stop-retry`).set(auth()).send({})).status).toBe(409);
    mock.setTrouble(false);
    const spy = jest.spyOn(mock, 'sendMessage');
    await dueNow();
    expect(spy).not.toHaveBeenCalled();
    expect((await messageOf(sent.id)).status).toBe('failed');
    expect((await api().post(`/api/v1/conversations/${chat}/messages/${sent.id}/retry`).set(auth()).send({})).body.data.status).toBe('sent');
  });

  it('when the 24 hours are over by the next try, it fails with the reason', async () => {
    mock.setTrouble(true);
    const sent = (await say(chat, 'Late')).body.data;
    await Conversation.updateOne({ _id: chat }, { $set: { lastInboundAt: new Date(Date.now() - 48 * 60 * MIN) } });
    mock.setTrouble(false);
    await dueNow();
    expect(await messageOf(sent.id)).toMatchObject({ status: 'failed', error: { message: expect.stringMatching(/24 hours/) } });
    const manual = await api().post(`/api/v1/conversations/${chat}/messages/${sent.id}/retry`).set(auth()).send({});
    expect(manual.status).toBe(422);
    expect(manual.body.code).toBe('WINDOW_CLOSED');
  });

  it('a click never sends a message twice', async () => {
    jest.spyOn(mock, 'sendMessage').mockRejectedValueOnce(refusal());
    const sent = (await say(chat, 'Once')).body.data;
    const send = jest.spyOn(mock, 'sendMessage');
    send.mockClear();
    const [a, b] = await Promise.all([1, 2].map(() => api().post(`/api/v1/conversations/${chat}/messages/${sent.id}/retry`).set(auth()).send({})));
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a reaction is not tried again hours later', async () => {
    const message = (await say(chat, 'Thanks')).body.data;
    mock.setTrouble(true);
    const res = await api().post(`/api/v1/conversations/${chat}/messages/${message.id}/reaction`).set(auth()).send({ emoji: '👍' });
    expect(res.status).toBe(502);
    expect(await Message.countDocuments({ type: 'reaction', status: 'queued' })).toBe(0);
    expect(await Job.countDocuments({ name: messageRetry.JOBS.RETRY })).toBe(0);
  });

  it('the sweep says a message left half-way failed, and asks again for a lost try', async () => {
    const left = (await say(chat, 'Left half-way')).body.data;
    await Message.collection.updateOne({ _id: (await Message.findById(left.id))._id }, { $set: { status: 'queued', createdAt: new Date(Date.now() - 11 * MIN) } });
    mock.setTrouble(true);
    const lost = (await say(chat, 'Job lost')).body.data;
    await Job.deleteMany({ name: messageRetry.JOBS.RETRY });
    await Message.updateOne({ _id: lost.id }, { $set: { 'retry.nextAt': new Date(Date.now() - 20 * MIN) } });
    const fresh = (await say(chat, 'Just sent')).body.data;
    const result = await messageRetry.sweep();
    expect(result).toEqual({ stuck: 1, late: 1 });
    expect(await messageOf(left.id)).toMatchObject({ status: 'failed', error: { message: 'The server restarted while sending this.' } });
    expect(await Job.countDocuments({ name: messageRetry.JOBS.RETRY, 'data.id': lost.id })).toBe(1);
    expect((await messageOf(fresh.id)).status).toBe('queued');
    expect(await messageRetry.sweep()).toEqual({ stuck: 0, late: 0 });
  });

  it('a file that could not be uploaded is uploaded on the next try, once', async () => {
    const temporary = () => Object.assign(httpError(502, 'WHATSAPP_UNREACHABLE', 'Could not reach WhatsApp (Meta).'), { temporary: true });
    const upload = jest.spyOn(mock, 'uploadMedia').mockRejectedValueOnce(temporary());
    const sent = await api().post(`/api/v1/conversations/${chat}/messages/media`).set(auth()).attach('file', Buffer.from('%PDF-1.4 retry file'), { filename: 'rate-list.pdf', contentType: 'application/pdf' });
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ status: 'queued', retry: { attempts: 1 } });
    expect((await messageOf(sent.body.data.id)).retry.body.document.id).toBe('pending');

    // The upload works, the send does not: the next try keeps the uploaded file.
    upload.mockClear();
    const send = jest.spyOn(mock, 'sendMessage').mockRejectedValueOnce(temporary());
    await dueNow();
    expect(upload).toHaveBeenCalledTimes(1);
    const after = await messageOf(sent.body.data.id);
    expect(after.status).toBe('queued');
    expect(after.retry.body.document.id).not.toBe('pending');
    await dueNow();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toMatchObject({ type: 'document', document: { id: after.retry.body.document.id, filename: 'rate-list.pdf' } });
    expect((await messageOf(sent.body.data.id)).status).toBe('sent');
  });
});
