const PushSubscription = require('../models/PushSubscription');
const PlatformSetting = require('../models/PlatformSetting');
const env = require('../config/env');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { encrypt, decrypt } = require('../utils/secretBox');
const webPush = require('../utils/webPush');

// Web push (Phase 10E): every bell note also reaches the member's phones and computers where
// they switched on notifications (Settings → Your Profile), even with no CRM tab open. The VAPID
// keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or are made once and kept in the
// database. Sent by a job (one per note); a subscription the push service says is gone is
// removed, one that keeps failing (10 times) too.
const JOB = 'push.send';
const MAX_FAILURES = 10;
const MAX_PER_MEMBER = 10;

let cachedKeys = null;
async function vapidKeys() {
  if (cachedKeys) return cachedKeys;
  if (env.push.publicKey && env.push.privateKey) {
    cachedKeys = { publicKey: env.push.publicKey, privateKey: env.push.privateKey };
    return cachedKeys;
  }
  let stored = await PlatformSetting.findOne({ key: 'vapid' });
  if (!stored) {
    const made = webPush.generateVapidKeys();
    try {
      stored = await PlatformSetting.create({ key: 'vapid', value: { publicKey: made.publicKey, privateKeyEnc: encrypt(made.privateKey) } });
    } catch (error) {
      if (error.code !== 11000) throw error;
      stored = await PlatformSetting.findOne({ key: 'vapid' }); // made by another process at the same moment
    }
  }
  cachedKeys = { publicKey: stored.value.publicKey, privateKey: decrypt(stored.value.privateKeyEnc) };
  return cachedKeys;
}

const subject = () => env.push.subject || (env.publicUrl.startsWith('https://') ? env.publicUrl : 'mailto:admin@example.com');

// GET /push/key — what the browser subscribes with.
async function publicKey() {
  return { publicKey: (await vapidKeys()).publicKey };
}

// POST /push/subscriptions { endpoint, keys { p256dh, auth } } — this browser, for this member.
async function subscribe(req, { endpoint, keys }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw httpError(400, 'VALIDATION_ERROR', 'A push address must be https.');
  try {
    webPush.encrypt('{}', keys); // the keys must be usable
  } catch (error) {
    throw httpError(400, 'VALIDATION_ERROR', error.message);
  }
  const subscription = await PushSubscription.findOneAndUpdate(
    { endpoint },
    {
      $set: {
        organizationId: req.tenant.organizationId, memberId: req.member._id, userId: req.user._id, keys,
        userAgent: String(req.get('user-agent') || '').slice(0, 300), failures: 0,
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  // Keep the newest few per member (old browsers are often never unsubscribed).
  const extra = await PushSubscription.find({ memberId: req.member._id }).sort({ updatedAt: -1 }).skip(MAX_PER_MEMBER).select('_id');
  if (extra.length) await PushSubscription.deleteMany({ _id: { $in: extra.map((s) => s._id) } });
  return { id: subscription._id, devices: await PushSubscription.countDocuments({ memberId: req.member._id }) };
}

async function unsubscribe(req, { endpoint }) {
  await PushSubscription.deleteOne({ endpoint, memberId: req.member._id });
  return { devices: await PushSubscription.countDocuments({ memberId: req.member._id }) };
}

async function devices(req) {
  return { devices: await PushSubscription.countDocuments({ memberId: req.member._id }) };
}

// Sends one payload to every subscription of a member. → { sent, removed }
async function sendToMember(memberId, payload) {
  const subscriptions = await PushSubscription.find({ memberId });
  if (!subscriptions.length) return { sent: 0, removed: 0 };
  const keys = await vapidKeys();
  let sent = 0;
  let removed = 0;
  for (const subscription of subscriptions) {
    let status = 0;
    try {
      ({ status } = await webPush.sendNotification(subscription, payload, { vapidKeys: keys, subject: subject() }));
    } catch (error) {
      logger.warn(`Web push to ${subscription._id} failed: ${error.message}`);
    }
    if (status >= 200 && status < 300) {
      sent += 1;
      await PushSubscription.updateOne({ _id: subscription._id }, { $set: { lastSuccessAt: new Date(), failures: 0 } });
    } else if (status === 404 || status === 410 || subscription.failures + 1 >= MAX_FAILURES) {
      removed += 1;
      await PushSubscription.deleteOne({ _id: subscription._id });
    } else {
      await PushSubscription.updateOne({ _id: subscription._id }, { $inc: { failures: 1 } });
    }
  }
  return { sent, removed };
}

// POST /push/test — a note to this member's devices now.
async function test(req) {
  const result = await sendToMember(req.member._id, { title: 'YELLOW CRM', body: 'Notifications work on this device.', url: 'Settings.html', tag: 'test' });
  if (!result.sent && !(await PushSubscription.exists({ memberId: req.member._id }))) throw httpError(409, 'NO_DEVICES', 'Switch on notifications on this device first.');
  return result;
}

// The bell (notificationService) calls this for each new note.
function queueForNote(memberId, notification) {
  const queue = require('../jobs/queue'); // eslint-disable-line global-require
  return queue.enqueue(JOB, {
    memberId: String(memberId),
    payload: { title: notification.title, body: notification.body || '', url: notification.link || 'dashboard.html', tag: String(notification.id || notification._id || '') },
  }, { organizationId: notification.organizationId, maxAttempts: 2 });
}

async function hasDevices(memberIds) {
  return PushSubscription.distinct('memberId', { memberId: { $in: memberIds } });
}

function register(queue) {
  queue.define(JOB, ({ memberId, payload }) => sendToMember(memberId, payload), { maxAttempts: 2 });
}

module.exports = { JOB, vapidKeys, publicKey, subscribe, unsubscribe, devices, sendToMember, test, queueForNote, hasDevices, register };
