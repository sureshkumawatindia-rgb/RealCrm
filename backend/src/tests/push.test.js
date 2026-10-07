jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const PushSubscription = require('../models/PushSubscription');
const PlatformSetting = require('../models/PlatformSetting');
const queue = require('../jobs/queue');
const webPush = require('../utils/webPush');
const pushService = require('../services/pushService');
const notificationService = require('../services/notificationService');
const { api, bearer, login } = require('./helpers/api');

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    await queue.runDue();
  }
};

// The browser's side of RFC 8291: decrypts what the CRM sent.
function decrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const asPublic = body.subarray(21, 21 + idLength);
  const data = body.subarray(21 + idLength);
  const prkKey = hmac(authSecret, uaEcdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8');
}

describe('Web push (Phase 10E)', () => {
  it('encrypts exactly like RFC 8291, Appendix A', () => {
    const body = webPush.encrypt(Buffer.from('When I grow up, I want to be a watermelon'), {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    }, { serverPrivateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: 'DGv6ra1nlYgDCS1FRnbzlw' });
    expect(b64u(body)).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  it('sends the bell\'s notes to the member\'s devices, signed and encrypted', async () => {
    pushService.register(queue);
    const owner = await login('push-owner@example.com', { name: 'Asha' });
    const key = (await api().get('/api/v1/push/key').set(bearer(owner.token))).body.data.publicKey;
    expect(Buffer.from(key, 'base64url')).toHaveLength(65);
    expect((await api().get('/api/v1/push/key').set(bearer(owner.token))).body.data.publicKey).toBe(key);
    expect((await PlatformSetting.findOne({ key: 'vapid' })).value.privateKeyEnc).toBeTruthy();
    expect((await api().post('/api/v1/push/test').set(bearer(owner.token))).body.code).toBe('NO_DEVICES');

    // A browser subscribes.
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const endpoint = 'https://push.example.com/send/device-1';
    expect((await api().post('/api/v1/push/subscriptions').set(bearer(owner.token)).send({ endpoint: 'http://push.example.com/x', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) } })).status).toBe(400);
    expect((await api().post('/api/v1/push/subscriptions').set(bearer(owner.token)).send({ endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) } })).body.data.devices).toBe(1);

    const sent = [];
    let answer = 201;
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      sent.push({ url: String(url), options });
      return new Response('', { status: answer });
    });
    try {
      await notificationService.notify(owner.data.organizationId, [owner.data.member.id], { title: 'New lead from IndiaMART', body: 'Ravi Traders wants 10 bags', link: 'leads.html' });
      await settle();
      expect(sent).toHaveLength(1);
      const { url, options } = sent[0];
      expect(url).toBe(endpoint);
      expect(options.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '86400', 'Content-Type': 'application/octet-stream' });
      // The VAPID header: a JWT for the push service's origin, signed with the CRM's key.
      const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(options.headers.Authorization);
      expect(k).toBe(key);
      const [head, claims, signature] = jwt.split('.');
      expect(JSON.parse(Buffer.from(claims, 'base64url'))).toMatchObject({ aud: 'https://push.example.com', sub: expect.stringMatching(/^(mailto:|https:)/) });
      const point = Buffer.from(key, 'base64url');
      const publicKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) }, format: 'jwk' });
      expect(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
      // Only the browser can read it.
      expect(JSON.parse(decrypt(Buffer.from(options.body), ua, authSecret))).toMatchObject({ title: 'New lead from IndiaMART', body: 'Ravi Traders wants 10 bags', url: 'leads.html' });
      expect((await PushSubscription.findOne({ endpoint })).lastSuccessAt).toBeTruthy();

      // The test button; then the push service says the device is gone: it is removed.
      expect((await api().post('/api/v1/push/test').set(bearer(owner.token))).body.data).toEqual({ sent: 1, removed: 0 });
      answer = 410;
      await notificationService.notify(owner.data.organizationId, [owner.data.member.id], { title: 'Another' });
      await settle();
      expect(await PushSubscription.countDocuments()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps each member\'s devices to themselves', async () => {
    const one = await login('push-one@example.com');
    const two = await login('push-two@example.com');
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const keys = { p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };
    await api().post('/api/v1/push/subscriptions').set(bearer(one.token)).send({ endpoint: 'https://push.example.com/send/shared', keys });
    expect((await api().delete('/api/v1/push/subscriptions').set(bearer(two.token)).send({ endpoint: 'https://push.example.com/send/shared' })).body.data.devices).toBe(0);
    expect((await api().get('/api/v1/push/devices').set(bearer(one.token))).body.data.devices).toBe(1);
    expect((await api().delete('/api/v1/push/subscriptions').set(bearer(one.token)).send({ endpoint: 'https://push.example.com/send/shared' })).body.data.devices).toBe(0);
  });
});
