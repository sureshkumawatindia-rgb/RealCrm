jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const WhatsAppAccount = require('../models/WhatsAppAccount');
const AuditLog = require('../models/AuditLog');
const queue = require('../jobs/queue');
const connectService = require('../services/whatsappConnectService');
const fakeMeta = require('./helpers/fakeMeta');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// "Connect WhatsApp" with Meta's Embedded Signup popup (D60, checkpoint 2): the page sends what
// the popup gave it; the server exchanges the code, reads the number, subscribes the app and —
// for a WhatsApp Business app number — asks for its contacts and chats.
describe('Connect WhatsApp (Embedded Signup)', () => {
  let restoreApp;
  let meta;
  beforeAll(() => {
    connectService.register(queue);
  });
  afterEach(() => {
    meta?.restore();
    meta = null;
    restoreApp?.();
    restoreApp = null;
  });
  const connect = (token, body) => api().post('/api/v1/whatsapp/accounts/embedded-signup').set(bearer(token)).send(body);

  it('says it is not available until the platform has set up its Meta app', async () => {
    const owner = await login('connect-off@example.com');
    expect((await api().get('/api/v1/whatsapp/connect').set(bearer(owner.token))).body.data).toMatchObject({ available: false, appId: '', configId: '', connected: false });
    expect((await connect(owner.token, { code: 'abcdefghijkl', wabaId: '1100000000001' })).body.code).toBe('CONNECT_NOT_AVAILABLE');
  });

  it('connects a WhatsApp Business app number (coexistence) and asks Meta for its contacts and chats', async () => {
    restoreApp = fakeMeta.enable();
    meta = fakeMeta.install();
    const owner = await login('coexist@example.com');
    const agent = await inviteAndJoin(owner.token, 'coexist-agent@example.com');
    expect((await api().get('/api/v1/whatsapp/connect').set(bearer(owner.token))).body.data).toMatchObject({ available: true, appId: fakeMeta.APP.appId, configId: fakeMeta.APP.esConfigId, graphVersion: expect.stringMatching(/^v\d+\.\d+$/) });
    expect((await connect(agent.token, { code: 'abcdefghijkl', wabaId: meta.wabaId })).status).toBe(403);

    const res = await connect(owner.token, { code: 'popup-code-123456', wabaId: meta.wabaId, mode: 'coexistence' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ connectionType: 'coexistence', phoneNumberId: meta.phoneNumberId, displayPhone: '+91 98290 10001', verifiedName: 'Shree Traders', status: 'connected', messagingLimit: 'TIER_1K', sync: { status: 'pending' }, verifyToken: '' });
    expect(JSON.stringify(res.body)).not.toContain(meta.token);
    expect(JSON.stringify(res.body)).not.toContain(fakeMeta.APP.appSecret);
    const exchange = meta.calls.find((call) => call.path === 'oauth/access_token');
    expect(exchange.query).toMatchObject({ client_id: fakeMeta.APP.appId, client_secret: fakeMeta.APP.appSecret, code: 'popup-code-123456' });
    expect(meta.calls.some((call) => call.method === 'POST' && call.path === `${meta.wabaId}/subscribed_apps` && call.auth === `Bearer ${meta.token}`)).toBe(true);
    expect(meta.calls.some((call) => call.path.endsWith('/register'))).toBe(false); // already on the app

    const stored = await WhatsAppAccount.findOne({ phoneNumberId: meta.phoneNumberId });
    expect(stored.accessTokenEnc).toBeTruthy();
    expect(stored.accessTokenEnc).not.toContain(meta.token);

    await queue.runDue();
    const syncs = meta.calls.filter((call) => call.path === `${meta.phoneNumberId}/smb_app_data`).map((call) => call.body.sync_type);
    expect(syncs).toEqual(['smb_app_state_sync', 'history']); // contacts first, then the history
    expect((await WhatsAppAccount.findById(stored._id)).sync.status).toBe('importing');
    expect((await api().get('/api/v1/whatsapp/connect').set(bearer(owner.token))).body.data.connected).toBe(true);
    expect(await AuditLog.exists({ action: 'whatsapp.account.connected', 'changes.connectionType': 'coexistence' })).toBeTruthy();

    // The same number again: this company reconnects it; another company cannot take it.
    const again = await connect(owner.token, { code: 'popup-code-654321', wabaId: meta.wabaId, mode: 'coexistence' });
    expect(again.body.data.id).toBe(String(stored._id));
    expect(await WhatsAppAccount.countDocuments({ phoneNumberId: meta.phoneNumberId })).toBe(1);
    const other = await login('coexist-other@example.com');
    expect((await connect(other.token, { code: 'popup-code-777777', wabaId: meta.wabaId })).body.code).toBe('NUMBER_IN_USE');
  });

  it('registers a new number with a PIN, and explains an expired popup code without secrets', async () => {
    restoreApp = fakeMeta.enable();
    meta = fakeMeta.install({ wabaId: '1100000000002', phoneNumberId: '2200000000002', displayPhone: '+91 98290 10002' });
    const owner = await login('new-number@example.com');
    const expired = await connect(owner.token, { code: 'expired-code-0000', wabaId: meta.wabaId, phoneNumberId: meta.phoneNumberId, mode: 'new' });
    expect(expired.body).toMatchObject({ code: 'WHATSAPP_CONNECT_FAILED' });
    expect(JSON.stringify(expired.body)).not.toContain(fakeMeta.APP.appSecret);

    const res = await connect(owner.token, { code: 'popup-code-222222', wabaId: meta.wabaId, phoneNumberId: meta.phoneNumberId, mode: 'new' });
    expect(res.body.data).toMatchObject({ connectionType: 'embedded', sync: null });
    const register = meta.calls.find((call) => call.path === `${meta.phoneNumberId}/register`);
    expect(register.body).toMatchObject({ messaging_product: 'whatsapp', pin: expect.stringMatching(/^\d{6}$/) });
    const stored = await WhatsAppAccount.findById(res.body.data.id);
    expect(stored.registrationPinEnc).toBeTruthy();
    expect(stored.registrationPinEnc).not.toContain(register.body.pin);
  });

  it('marks the import failed when Meta keeps refusing the sync, and can ask again', async () => {
    restoreApp = fakeMeta.enable();
    meta = fakeMeta.install({ wabaId: '1100000000003', phoneNumberId: '2200000000003' });
    meta.state.failSync = true;
    const owner = await login('sync-fail@example.com');
    const { id } = (await connect(owner.token, { code: 'popup-code-333333', wabaId: meta.wabaId })).body.data;
    for (let i = 0; i < 5; i += 1) {
      await queue.runDue();
      await require('../models/Job').updateMany({ status: 'queued' }, { $set: { runAt: new Date(Date.now() - 1000) } });
    }
    expect((await WhatsAppAccount.findById(id)).sync).toMatchObject({ status: 'failed', error: expect.stringContaining('Sync window') });
    meta.state.failSync = false;
    expect((await api().post(`/api/v1/whatsapp/accounts/${id}/sync`).set(bearer(owner.token))).body.data.sync.status).toBe('pending');
    await queue.runDue();
    expect((await WhatsAppAccount.findById(id)).sync.status).toBe('importing');
  });
});
