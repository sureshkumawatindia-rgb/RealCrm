jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const EmailDelivery = require('../models/EmailDelivery');
const Job = require('../models/Job');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const User = require('../models/User');
const env = require('../config/env');
const queue = require('../jobs/queue');
const emailService = require('../services/emailService');
const billingService = require('../services/billingService');
const organizationDeletion = require('../services/organizationDeletionService');
const loginAlertService = require('../services/loginAlertService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// D104: the platform's emails through Resend — nothing without the keys, an invite in the
// inviter's language with the link (stored encrypted until sent), Resend's rate limit and outages
// tried again with the same Idempotency-Key, trial / payment / invoice (with the PDF) / deletion
// emails to the owners and admins, and the new-login email unless it is switched off.
const DAY = 24 * 60 * 60 * 1000;
const KEY = 're_test_platform_key_123';
const FROM = 'YELLOW CRM <hello@mail.example.in>';

describe('Platform emails through Resend (D104)', () => {
  let owner;
  let adminMember;
  let sent = [];
  let replies = [];
  const keysOn = () => Object.assign(env.email, { resendApiKey: KEY, from: FROM });
  const keysOff = () => Object.assign(env.email, { resendApiKey: '', from: '' });
  // Every queued email job is due now.
  const runEmails = async () => {
    await Job.updateMany({ name: emailService.JOB, status: 'queued' }, { $set: { runAt: new Date() } });
    await queue.runDue();
  };
  const deliveries = (filter = {}) => EmailDelivery.find({ organizationId: owner.data.organizationId, ...filter }).sort({ createdAt: 1 });

  beforeAll(async () => {
    emailService.register(queue);
    const realFetch = global.fetch;
    jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      if (String(url) !== 'https://api.resend.com/emails') return realFetch(url, options);
      sent.push({ headers: options.headers, body: JSON.parse(options.body) });
      const [status, body] = replies.shift() || [200, { id: `re_${sent.length}` }];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    });
    owner = await login('mail-owner@example.com', { name: 'Asha' });
    await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ name: 'Yellow Traders' });
    const admin = await inviteAndJoin(owner.token, 'mail-admin@example.com', { role: 'admin' });
    adminMember = await OrganizationMember.findById(admin.data.member.id);
    await api().patch('/api/v1/auth/preferences').set(bearer(admin.token)).send({ language: 'hi' });
  });
  afterAll(() => {
    keysOff();
    jest.restoreAllMocks();
  });
  beforeEach(() => {
    sent = [];
    replies = [];
  });

  it('sends nothing without RESEND_API_KEY and EMAIL_FROM, and nothing breaks', async () => {
    keysOff();
    const res = await api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: 'no-key@example.com', role: 'agent' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(expect.objectContaining({ link: expect.stringContaining('invite='), emailed: false }));
    const [delivery] = await deliveries({ to: 'no-key@example.com' });
    expect(delivery).toEqual(expect.objectContaining({ kind: 'invite', status: 'skipped', error: 'RESEND_API_KEY or EMAIL_FROM is not set.' }));
    expect(JSON.stringify(delivery.data)).not.toMatch(/invite=/);
    await runEmails();
    expect(sent).toHaveLength(0);
  });

  it('emails an invite in the inviter\'s language with the link, which is kept encrypted until sent', async () => {
    keysOn();
    await api().patch('/api/v1/auth/preferences').set(bearer(owner.token)).send({ language: 'hi' });
    const res = await api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: 'ravi@example.com', role: 'agent' });
    expect(res.body.data.emailed).toBe(true);
    const token = new URL(res.body.data.link).searchParams.get('invite');
    let [delivery] = await deliveries({ to: 'ravi@example.com' });
    expect(delivery.status).toBe('queued');
    expect(JSON.stringify(delivery.data)).not.toContain(token); // encrypted
    expect(delivery.data.linkEnc).toEqual(expect.any(String));

    await runEmails();
    expect(sent).toHaveLength(1);
    const [{ headers, body }] = sent;
    expect(headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${KEY}`, 'Idempotency-Key': `crm-email-${delivery._id}` }));
    expect(body).toEqual(expect.objectContaining({ from: FROM, to: ['ravi@example.com'], tags: [{ name: 'kind', value: 'invite' }] }));
    expect(body.subject).toBe('Asha ने आपको YELLOW CRM पर Yellow Traders में बुलाया है');
    expect(body.html).toContain(token);
    expect(body.html).toContain('<html lang="hi">');
    expect(body.text).toContain(res.body.data.link);
    [delivery] = await deliveries({ to: 'ravi@example.com' });
    expect(delivery).toEqual(expect.objectContaining({ status: 'sent', providerId: 're_1', attempts: 1 }));
    expect(delivery.data.linkEnc).toBeUndefined(); // gone once sent
    await api().patch('/api/v1/auth/preferences').set(bearer(owner.token)).send({ language: 'en' });
  });

  it('tries again on Resend\'s rate limit and outages with the same key, never on a refusal', async () => {
    keysOn();
    const invite = (email) => api().post('/api/v1/invites').set(bearer(owner.token)).send({ email, role: 'viewer' });

    replies = [[429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }], [200, { id: 're_after_wait' }]];
    await invite('busy@example.com');
    await runEmails();
    let [delivery] = await deliveries({ to: 'busy@example.com' });
    expect(delivery).toEqual(expect.objectContaining({ status: 'queued', attempts: 1, error: '429 rate_limit_exceeded: Too many requests' }));
    await runEmails();
    [delivery] = await deliveries({ to: 'busy@example.com' });
    expect(delivery).toEqual(expect.objectContaining({ status: 'sent', providerId: 're_after_wait', attempts: 2 }));
    expect(sent.map((s) => s.headers['Idempotency-Key'])).toEqual([`crm-email-${delivery._id}`, `crm-email-${delivery._id}`]);

    sent = [];
    replies = [[422, { statusCode: 422, name: 'validation_error', message: 'The `from` field is invalid.' }]];
    await invite('refused@example.com');
    await runEmails();
    await runEmails();
    [delivery] = await deliveries({ to: 'refused@example.com' });
    expect(delivery).toEqual(expect.objectContaining({ status: 'failed', attempts: 1, error: '422 validation_error: The `from` field is invalid.' }));
    expect(delivery.data.linkEnc).toBeUndefined();
    expect(sent).toHaveLength(1);

    sent = [];
    replies = Array.from({ length: emailService.MAX_ATTEMPTS }, () => [503, { name: 'service_unavailable', message: 'Down' }]);
    await invite('down@example.com');
    for (let i = 0; i < emailService.MAX_ATTEMPTS; i += 1) await runEmails();
    [delivery] = await deliveries({ to: 'down@example.com' });
    expect(delivery).toEqual(expect.objectContaining({ status: 'failed', attempts: emailService.MAX_ATTEMPTS }));
    expect(sent).toHaveLength(emailService.MAX_ATTEMPTS);
  });

  it('emails the owners and admins about the trial, a failed payment and the invoice (with its PDF)', async () => {
    keysOn();
    const orgId = owner.data.organizationId;
    // Made in the same moment for both people: compared in a fixed order.
    const kinds = async (kind) => (await deliveries({ kind })).map((d) => [d.to, d.language, d.data.stage || d.data.daysLeft || '']).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    await Organization.updateOne({ _id: orgId }, { $set: { 'subscription.status': 'trialing', 'subscription.trialEndsAt': new Date(Date.now() + 2.5 * DAY) }, $unset: { 'subscription.remindedFor': 1 } });
    await billingService.remindTrials();
    await billingService.remindTrials(); // once per level
    expect(await kinds('trial_reminder')).toEqual([['mail-admin@example.com', 'hi', 3], ['mail-owner@example.com', 'en', 3]]);

    await Organization.updateOne({ _id: orgId }, { $set: { plan: 'pro', subscription: { status: 'active', provider: 'mock', providerSubscriptionId: 'sub_mail_1' } } });
    await billingService.applySubscription(orgId, { id: 'sub_mail_1', status: 'pending' });
    await billingService.applySubscription(orgId, { id: 'sub_mail_1', status: 'halted' });
    expect(await kinds('payment_failed')).toEqual([
      ['mail-admin@example.com', 'hi', 'retrying'], ['mail-admin@example.com', 'hi', 'stopped'],
      ['mail-owner@example.com', 'en', 'retrying'], ['mail-owner@example.com', 'en', 'stopped'],
    ]);

    const invoice = await billingService.recordCharge(orgId, { subscriptionId: 'sub_mail_1', payment: { id: 'pay_mail_1', amountPaise: 294882, paidAt: new Date() }, periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * DAY) });
    expect(invoice.number).toMatch(/\/0001$/);
    sent = [];
    await runEmails();
    const mail = sent.find((s) => s.body.to[0] === 'mail-owner@example.com' && s.body.tags[0].value === 'plan_invoice');
    expect(mail.body.subject).toBe(`Invoice ${invoice.number} for your Pro plan`);
    expect(mail.body.attachments).toEqual([{ filename: `${invoice.number.replace(/\//g, '-')}.pdf`, content: expect.stringMatching(/^JVBERi0/) }]); // %PDF-
    const hindi = sent.find((s) => s.body.to[0] === 'mail-admin@example.com' && s.body.tags[0].value === 'plan_invoice');
    expect(hindi.body.subject).toBe(`आपके Pro प्लान का इनवॉइस ${invoice.number}`);
    expect(hindi.body.text).toContain('₹2,948.82');
  });

  it('warns when the company is set to be deleted, and again on its last day', async () => {
    keysOn();
    const res = await api().delete('/api/v1/organization').set(bearer(owner.token)).send({ confirmName: 'Yellow Traders' });
    expect(res.status).toBe(200);
    expect((await deliveries({ kind: 'deletion_scheduled' })).map((d) => d.to).sort()).toEqual(['mail-admin@example.com', 'mail-owner@example.com']);

    await organizationDeletion.remindDue(); // a week left: nothing yet
    expect(await deliveries({ kind: 'deletion_tomorrow' })).toHaveLength(0);
    await Organization.updateOne({ _id: owner.data.organizationId }, { $set: { 'deletion.scheduledFor': new Date(Date.now() + 12 * 60 * 60 * 1000) } });
    await organizationDeletion.remindDue();
    await organizationDeletion.remindDue(); // once
    expect((await deliveries({ kind: 'deletion_tomorrow' })).map((d) => d.to).sort()).toEqual(['mail-admin@example.com', 'mail-owner@example.com']);
    await api().post('/api/v1/organization/deletion/cancel').set(bearer(owner.token));
  });

  it('emails a new login unless the person switched it off', async () => {
    keysOn();
    const alerts = await api().get('/api/v1/auth/login-alerts').set(bearer(owner.token));
    expect(alerts.body.data).toEqual({ email: true, emailsOn: true });
    const user = await User.findOne({ email: 'mail-owner@example.com' });
    const member = await OrganizationMember.findOne({ organizationId: owner.data.organizationId, userId: user._id });
    const fakeReq = { get: () => 'Mozilla/5.0', ip: '127.0.0.1', user };
    await loginAlertService.alertNewLogin(fakeReq, { user, member, device: 'Chrome on Windows' });
    expect((await deliveries({ kind: 'login_alert' })).map((d) => [d.to, d.data.device])).toEqual([['mail-owner@example.com', 'Chrome on Windows']]);

    expect((await api().patch('/api/v1/auth/login-alerts').set(bearer(owner.token)).send({ email: false })).body.data).toEqual({ email: false, emailsOn: true });
    await loginAlertService.alertNewLogin(fakeReq, { user: await User.findById(user._id), member, device: 'Safari on iPhone' });
    expect(await deliveries({ kind: 'login_alert' })).toHaveLength(1);
    expect((await api().patch('/api/v1/auth/login-alerts').set(bearer(owner.token)).send({ email: 'yes' })).status).toBe(400);

    sent = [];
    await runEmails();
    const mail = sent.find((s) => s.body.tags[0].value === 'login_alert');
    expect(mail.body.subject).toBe('New login to YELLOW CRM: Chrome on Windows');
    expect(mail.body.text).toContain('Settings → Your profile');
    expect(adminMember.role).toBe('admin');
  });
});
