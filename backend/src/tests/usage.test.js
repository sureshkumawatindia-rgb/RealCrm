jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const MessageTemplate = require('../models/MessageTemplate');
const Quotation = require('../models/Quotation');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const UsageSnapshot = require('../models/UsageSnapshot');
const Document = require('../models/Document');
const planService = require('../services/planService');
const usageService = require('../services/usageService');
const aiService = require('../services/aiService');
const AiUsage = require('../models/AiUsage');
const { indiaDate } = require('../utils/dates');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 3A (D80): entitlements, extras given by the platform owner, the usage meters, their daily
// history and the 80% / 100% alerts.
const DAY = 24 * 60 * 60 * 1000;
const orgOf = (user) => Organization.findById(user.data.organizationId);
const setPlan = (organizationId, plan) => Organization.updateOne({ _id: organizationId }, { $set: { plan, subscription: { status: 'active' } } });
const templates = (organizationId, count, from = 0) => MessageTemplate.insertMany(Array.from({ length: count }, (_, i) => ({
  organizationId, whatsappAccountId: new mongoose.Types.ObjectId(), name: `t_${from + i}`, language: 'en', category: 'UTILITY', status: 'APPROVED',
})));
const meters = async (token) => Object.fromEntries((await api().get('/api/v1/billing/subscription').set(bearer(token))).body.data.usage.map((m) => [m.metric, m]));
const notes = (organizationId) => Notification.find({ organizationId, source: 'usage' }).sort({ createdAt: 1 });

describe('Plan entitlements and usage meters (Phase 3A)', () => {
  it('tells every member what the plan has and which plan has the rest, without usage numbers', async () => {
    const owner = await login('ent-owner@example.com', { name: 'Asha' });
    const agent = await inviteAndJoin(owner.token, 'ent-agent@example.com', { role: 'agent' });
    await setPlan(owner.data.organizationId, 'starter');
    const other = await login('ent-other@example.com', { name: 'Other' }); // a Growth trial

    const seen = (await api().get('/api/v1/billing/entitlements').set(bearer(agent.token))).body.data;
    expect(seen).toMatchObject({ plan: { key: 'starter', name: 'Starter' }, status: 'active', locked: false });
    const features = Object.fromEntries(seen.features.map((f) => [f.key, f]));
    expect(features.paymentLinks).toMatchObject({ on: true, from: 'plan', needs: null, message: '' });
    expect(features.api).toMatchObject({ on: false, from: null, needs: { key: 'scale', name: 'Scale' } });
    expect(features.api.message).toBe('The public API and webhooks come with the Scale plan and above (you are on Starter). Upgrade in Settings → Plan & usage.');
    expect(features.catalog.needs).toEqual({ key: 'pro', name: 'Pro' });
    expect(Object.fromEntries(seen.limits.map((l) => [l.metric, l.limit]))).toMatchObject({ users: 5, contacts: 5000, templates: 50 });
    expect(JSON.stringify(seen)).not.toMatch(/"used"/);

    // Another company sees its own plan only.
    const theirs = (await api().get('/api/v1/billing/entitlements').set(bearer(other.token))).body.data;
    expect(theirs.plan.key).toBe('growth');
    expect(theirs.features.find((f) => f.key === 'advancedAutomation')).toMatchObject({ on: true, from: 'plan' }); // Growth: workflows, not the API (D125)

    // A locked company: nothing is on, and it says why.
    await Organization.updateOne({ _id: owner.data.organizationId }, { $set: { subscription: { status: 'trialing', trialEndsAt: new Date(Date.now() - DAY) } } });
    const locked = (await api().get('/api/v1/billing/entitlements').set(bearer(agent.token))).body.data;
    expect(locked).toMatchObject({ locked: true, status: 'expired' });
    expect(locked.features.every((f) => !f.on && /free trial ended/.test(f.message))).toBe(true);
  });

  it('applies an extra on every server check at once, ends it on its date, and audits it', async () => {
    const owner = await login('grant-owner@example.com', { name: 'Bina' });
    const organizationId = owner.data.organizationId;
    await setPlan(organizationId, 'starter');
    await templates(organizationId, 50);
    await expect(planService.assertRoom(organizationId, 'templates')).rejects.toMatchObject({ code: 'PLAN_LIMIT' });
    const flow = () => api().post('/api/v1/workflows').set(bearer(owner.token)).send({ name: 'Flow', trigger: { type: 'lead.created' }, steps: [{ type: 'tag.add', params: { tag: 'new' } }] });
    expect((await flow()).body.code).toBe('PLAN_LIMIT');

    // Bad grants are refused.
    await expect(planService.grant(organizationId, { key: 'everything', extra: 1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(planService.grant(organizationId, { key: 'templates' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(planService.grant(organizationId, { key: 'api', extra: 5 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(planService.grant(new mongoose.Types.ObjectId(), { key: 'api' })).rejects.toMatchObject({ statusCode: 404 });

    const extra = await planService.grant(organizationId, { key: 'templates', extra: 5, days: 30, reason: 'Diwali offers', by: 'Suresh' });
    await planService.grant(organizationId, { key: 'advancedAutomation', days: 14, reason: 'Pilot' });
    await expect(planService.assertRoom(organizationId, 'templates', { adding: 5 })).resolves.toBeUndefined();
    await expect(planService.assertRoom(organizationId, 'templates', { adding: 6 })).rejects.toMatchObject({
      message: 'The Starter plan with its 5 extra allows 55 message templates; you have room for 5 more (50 used), not 6. Upgrade in Settings → Plan & usage.',
    });
    expect((await flow()).status).toBe(201);

    const usage = await meters(owner.token);
    expect(usage.templates).toMatchObject({ used: 50, limit: 55, left: 5, extra: 5, group: 'limit' });
    expect(new Date(usage.templates.until).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    const seen = (await api().get('/api/v1/billing/entitlements').set(bearer(owner.token))).body.data;
    expect(seen.features.find((f) => f.key === 'advancedAutomation')).toMatchObject({ on: true, from: 'grant', needs: null });
    expect(seen.limits.find((l) => l.metric === 'templates')).toMatchObject({ limit: 55, extra: 5 });

    // The audit log has who, what and why.
    const granted = await AuditLog.find({ organizationId, action: 'entitlement.granted' }).sort({ createdAt: 1 });
    expect(granted).toHaveLength(2);
    expect(granted[0].changes).toMatchObject({ entitlement: 'templates', extra: 5, reason: 'Diwali offers', by: 'Suresh' });

    // When it ends, the plan's own number is back; ended grants stay as history.
    await Organization.updateOne({ _id: organizationId, 'entitlementGrants._id': extra._id }, { $set: { 'entitlementGrants.$.until': new Date(Date.now() - 1000) } });
    await expect(planService.assertRoom(organizationId, 'templates')).rejects.toMatchObject({ code: 'PLAN_LIMIT' });
    expect((await meters(owner.token)).templates).toMatchObject({ limit: 50, extra: 0 });
    expect((await orgOf(owner)).entitlementGrants).toHaveLength(2);

    // Revoking the feature: refused again by the server, and audited.
    const automation = (await orgOf(owner)).entitlementGrants.find((g) => g.key === 'advancedAutomation');
    await planService.revokeGrant(organizationId, automation._id, { by: 'Suresh' });
    expect((await flow()).body.code).toBe('PLAN_LIMIT');
    expect(await AuditLog.countDocuments({ organizationId, action: 'entitlement.revoked', 'changes.entitlement': 'advancedAutomation' })).toBe(1);
    await expect(planService.revokeGrant(organizationId, automation._id)).rejects.toMatchObject({ statusCode: 404 });

    // An extra on a limit the plan does not have changes nothing.
    await setPlan(organizationId, 'infinite');
    await planService.grant(organizationId, { key: 'contacts', extra: 100 });
    expect((await meters(owner.token)).contacts).toMatchObject({ limit: null, extra: 0 });
  });

  it('counts API calls at the same moment exactly, and shows every meter to managers only', async () => {
    const owner = await login('meter-owner@example.com', { name: 'Chitra' });
    const agent = await inviteAndJoin(owner.token, 'meter-agent@example.com', { role: 'agent' });
    await setPlan(owner.data.organizationId, 'scale'); // the API comes with Scale and above (D125)
    const key = (await api().post('/api/v1/api-keys').set(bearer(owner.token)).send({ name: 'Zapier', scopes: ['contacts:read'] })).body.data.key;
    const calls = await Promise.all(Array.from({ length: 20 }, () => api().get('/api/public/v1/me').set('Authorization', `Bearer ${key}`)));
    expect(calls.every((call) => call.status === 200)).toBe(true);
    expect((await api().get('/api/public/v1/me').set('Authorization', 'Bearer ycrm_wrong')).status).toBe(401); // not counted
    await Document.create([
      { organizationId: owner.data.organizationId, name: 'Price list.pdf', sizeBytes: 2048, storageKey: 'a', mimeType: 'application/pdf' },
      { organizationId: owner.data.organizationId, name: 'Old.pdf', sizeBytes: 1000, storageKey: 'b', mimeType: 'application/pdf', deletedAt: new Date() },
    ]);

    const usage = await meters(owner.token);
    expect(usage.apiCallsPerMonth).toMatchObject({ used: 20, limit: null, group: 'counted', unit: 'count', monthly: true });
    expect(Object.keys(usage)).toEqual(expect.arrayContaining(['users', 'contacts', 'templates', 'webhookSendsPerMonth', 'workflowRunsPerMonth', 'fileBytes', 'customFields', 'customObjects']));
    expect(usage.fileBytes).toMatchObject({ used: 2048, unit: 'bytes' }); // deleted files do not count
    expect(usage.users.group).toBe('limit');
    expect((await api().get('/api/v1/billing/subscription').set(bearer(agent.token))).body.data.usage).toBeUndefined();

    // Another company's counter is its own.
    const other = await login('meter-other@example.com', { name: 'Other' });
    expect((await meters(other.token)).apiCallsPerMonth.used).toBe(0);
  });

  it('takes one snapshot a day and keeps the history for owners and admins', async () => {
    const owner = await login('hist-owner@example.com', { name: 'Divya' });
    const agent = await inviteAndJoin(owner.token, 'hist-agent@example.com', { role: 'agent' });
    const organizationId = owner.data.organizationId;
    await templates(organizationId, 3);
    // Two earlier days, as the job would have left them.
    await UsageSnapshot.create([
      { organizationId, day: indiaDate(-2), plan: 'growth', meters: [{ metric: 'templates', used: 1, limit: null }, { metric: 'contacts', used: 0, limit: 80000 }], expireAt: new Date(Date.now() + 400 * DAY) },
      { organizationId, day: indiaDate(-1), plan: 'growth', meters: [{ metric: 'templates', used: 2, limit: null }, { metric: 'contacts', used: 0, limit: 80000 }], expireAt: new Date(Date.now() + 400 * DAY) },
    ]);

    const first = await usageService.run();
    expect(first.snapshots).toBeGreaterThanOrEqual(1);
    await Promise.all([usageService.run(), usageService.run()]); // the same hour again, twice at once
    expect(await UsageSnapshot.countDocuments({ organizationId, day: indiaDate(0) })).toBe(1);
    const today = await UsageSnapshot.findOne({ organizationId, day: indiaDate(0) });
    expect(today.meters.find((m) => m.metric === 'templates')).toMatchObject({ used: 3, limit: null });
    expect(today.meters.map((m) => m.metric)).toEqual(expect.arrayContaining(['apiCallsPerMonth', 'fileBytes', 'customObjects']));

    const history = (await api().get('/api/v1/billing/usage/history?days=30').set(bearer(owner.token))).body.data;
    expect(history).toMatchObject({ from: indiaDate(-29), to: indiaDate(0) });
    const tpl = history.meters.find((m) => m.metric === 'templates');
    expect(tpl.points.map((p) => p.used)).toEqual([1, 2, 3]);
    expect(tpl.points.map((p) => p.day)).toEqual([indiaDate(-2), indiaDate(-1), indiaDate(0)]);
    expect(history.meters[0].metric).toBe('users'); // in the order of the meters

    expect((await api().get('/api/v1/billing/usage/history').set(bearer(agent.token))).status).toBe(403);
    expect((await api().get('/api/v1/billing/usage/history?days=5').set(bearer(owner.token))).status).toBe(400);
    const other = await login('hist-other@example.com', { name: 'Other' });
    const theirs = (await api().get('/api/v1/billing/usage/history').set(bearer(other.token))).body.data;
    expect(theirs.meters.find((m) => m.metric === 'templates')?.points.some((p) => p.used === 3)).toBeFalsy();
  });

  it('tells owners and admins at 80% and 100%, once each, and again after a fall or a new month', async () => {
    const owner = await login('alert-owner@example.com', { name: 'Esha' });
    const admin = await inviteAndJoin(owner.token, 'alert-admin@example.com', { role: 'admin' });
    const agent = await inviteAndJoin(owner.token, 'alert-agent@example.com', { role: 'agent' });
    const organizationId = owner.data.organizationId;
    await setPlan(organizationId, 'starter');
    await templates(organizationId, 40);

    await usageService.run();
    let sent = await notes(organizationId);
    expect(sent.map((n) => n.title)).toEqual(['Message templates: 80% of your plan used', 'Message templates: 80% of your plan used']);
    expect(sent.map((n) => String(n.memberId)).sort()).toEqual([owner.data.member.id, admin.data.member.id].sort());
    expect(sent.some((n) => String(n.memberId) === agent.data.member.id)).toBe(false);
    expect(sent[0]).toMatchObject({ link: 'Settings.html?tab=plan', body: '40 of 50 message templates on the Starter plan. See Settings → Plan & usage to upgrade.' });

    await Promise.all([usageService.run(), usageService.run()]);
    expect(await notes(organizationId)).toHaveLength(2); // once per level

    await templates(organizationId, 10, 40);
    await usageService.run();
    sent = await notes(organizationId);
    expect(sent).toHaveLength(4);
    expect(sent[3].title).toBe("Message templates: your plan's limit is reached");
    expect(sent[3].body).toMatch(/^50 of 50 message templates on the Starter plan\. Adding more stops until you upgrade/);

    // Below 80% again, then back up: a new note.
    await MessageTemplate.deleteMany({ organizationId, name: { $in: Array.from({ length: 15 }, (_, i) => `t_${i}`) } });
    await usageService.run();
    expect((await orgOf(owner)).usageAlerts?.templates).toBeUndefined();
    await templates(organizationId, 5, 200);
    await usageService.run();
    expect(await notes(organizationId)).toHaveLength(6);

    // A monthly meter alerts again in a new month (last month's 100% does not hold it back).
    const filler = (i) => ({ organizationId: new mongoose.Types.ObjectId(String(organizationId)), number: `F-${i}`, createdAt: new Date(), deletedAt: null });
    await Quotation.collection.insertMany(Array.from({ length: 850 }, (_, i) => filler(i)));
    await Organization.updateOne({ _id: organizationId }, { $set: { 'usageAlerts.quotesPerMonth': { level: 100, period: '2000-01' } } });
    await usageService.run();
    const quoteNotes = (await notes(organizationId)).filter((n) => /^Quotations this month/.test(n.title));
    expect(quoteNotes).toHaveLength(2);
    expect(quoteNotes[0].body).toMatch(/^850 of 1,000 quotations a month on the Starter plan\. See Settings → Plan & usage to upgrade; the count starts again on 1 /);
    expect((await orgOf(owner)).usageAlerts.quotesPerMonth).toEqual({ level: 80, period: indiaDate(0).slice(0, 7) });

    // A locked company gets no usage notes (its banner says it).
    await Organization.updateOne({ _id: organizationId }, { $set: { subscription: { status: 'expired' } }, $unset: { usageAlerts: 1 } });
    await usageService.run();
    expect(await notes(organizationId)).toHaveLength(8);
  });

  it('adds the AI budget to the meters where the platform has AI, and warns at 80%', async () => {
    const owner = await login('ai-owner@example.com', { name: 'Gita' });
    const organizationId = owner.data.organizationId;
    expect((await meters(owner.token)).aiBudget).toBeUndefined(); // no AI on this platform yet
    aiService.setClient({});
    try {
      await AiUsage.create({ organizationId, feature: 'suggest', outcome: 'suggested', costMicros: 4200000 });
      const usage = await meters(owner.token);
      expect(usage.aiBudget).toMatchObject({ used: 4200000, limit: 5000000, unit: 'budget', group: 'limit', monthly: true }); // Growth trial: all of $5
      await usageService.run();
      expect((await notes(organizationId)).map((n) => n.title)).toEqual(["AI assistant: 80% of this month's budget used"]);
    } finally {
      aiService.setClient(null);
    }
  });

  it('shows on Connections which plan a locked feature needs', async () => {
    const owner = await login('conn-owner@example.com', { name: 'Farah' });
    await setPlan(owner.data.organizationId, 'starter');
    const { items } = (await api().get('/api/v1/integrations/status').set(bearer(owner.token))).body.data;
    const byKind = Object.fromEntries(items.map((item) => [item.kind, item]));
    expect(byKind.apiKeys.plan).toMatchObject({ feature: 'api', needs: { key: 'scale', name: 'Scale' } });
    expect(byKind.webhooks.plan.needs.name).toBe('Scale');
    expect(byKind.metaCapi.plan.needs.name).toBe('Pro');
    expect(byKind.payments.plan).toBeNull();
    expect(byKind.whatsapp.plan).toBeNull();

    await planService.grant(owner.data.organizationId, { key: 'api', days: 7 });
    const after = (await api().get('/api/v1/integrations/status').set(bearer(owner.token))).body.data.items;
    expect(after.find((item) => item.kind === 'apiKeys').plan).toBeNull();
  });
});
