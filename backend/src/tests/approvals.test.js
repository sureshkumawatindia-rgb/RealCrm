jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const ApprovalRule = require('../models/ApprovalRule');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { MAX_APPROVAL_RULES } = require('../constants/approvals');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 1E (D77): limits on quotations that an owner or admin must approve before the quotation
// reaches the customer.
const as = (user) => ({
  get: (url) => api().get(`/api/v1${url}`).set(bearer(user.token)),
  post: (url, body) => api().post(`/api/v1${url}`).set(bearer(user.token)).send(body),
  patch: (url, body) => api().patch(`/api/v1${url}`).set(bearer(user.token)).send(body),
});
const codes = (res) => Object.fromEntries((res.body.errors || []).map((e) => [e.field, e.code]));
// ₹10,000 × 10 = ₹1,00,000 before the discount.
const lines = (discount, quantity = 10) => [{ name: 'Monoblock pump', quantity, unitPricePaise: 1000000, discountType: 'percent', discountValue: discount, gstRatePct: 18 }];

describe('Approval rules for quotations', () => {
  let owner;
  let admin;
  let admin2;
  let agent;
  let viewer;
  let other;
  let customer;
  let discountRule;
  let bigRule;
  const quotationFor = async (user, discount, quantity) => (await as(user).post('/quotations', { contactId: customer.id, items: lines(discount, quantity) })).body.data;
  const unread = async (user) => Notification.countDocuments({ memberId: user.data.member.id, source: 'approval' });

  beforeAll(async () => {
    owner = await login('ap-owner@example.com');
    admin = await inviteAndJoin(owner.token, 'ap-admin@example.com', { role: 'admin' });
    admin2 = await inviteAndJoin(owner.token, 'ap-admin2@example.com', { role: 'admin' });
    agent = await inviteAndJoin(owner.token, 'ap-agent@example.com', { role: 'agent' });
    viewer = await inviteAndJoin(owner.token, 'ap-viewer@example.com', { role: 'viewer' });
    other = await login('ap-other@example.com');
    customer = (await as(agent).post('/contacts', { name: 'Ajmer Agro', phone: '98290 61000', lifecycle: 'customer' })).body.data;
  });

  describe('Rules', () => {
    it('owners and admins make them; agents and viewers read the active ones', async () => {
      const made = await as(owner).post('/approval-rules', { name: 'Dealer discount', discountPercentAbove: 10 });
      expect(made.status).toBe(201);
      expect(made.body.data).toMatchObject({ name: 'Dealer discount', discountPercentAbove: 10, grandTotalAbovePaise: null, appliesTo: ['agent'], status: 'active' });
      discountRule = made.body.data;
      bigRule = (await as(admin).post('/approval-rules', { name: 'Big orders', grandTotalAbovePaise: 50000000, appliesTo: ['admin'] })).body.data;
      expect(bigRule.appliesTo.sort()).toEqual(['admin', 'agent']); // agents always
      for (const user of [agent, viewer]) expect((await as(user).post('/approval-rules', { name: 'X', discountPercentAbove: 1 })).status).toBe(403);
      expect((await as(agent).get('/approval-rules')).body.data.map((r) => r.name)).toEqual(['Dealer discount', 'Big orders']);
      expect((await as(viewer).get('/approval-rules')).status).toBe(200);
      expect((await as(agent).get('/approval-rules?status=all')).status).toBe(403);
    });

    it('a rule needs a condition, known values and the latest version', async () => {
      expect(codes(await as(owner).post('/approval-rules', { name: 'Empty' }))).toEqual({ discountPercentAbove: 'NO_CONDITION' });
      expect((await as(owner).post('/approval-rules', { name: 'Odd', discountPercentAbove: 101 })).status).toBe(400);
      expect((await as(owner).post('/approval-rules', { name: 'Odd', grandTotalAbovePaise: -5 })).status).toBe(400);
      expect((await as(owner).post('/approval-rules', { name: 'Odd', discountPercentAbove: 5, appliesTo: ['owner'] })).status).toBe(400);
      expect(codes(await as(owner).patch(`/approval-rules/${discountRule.id}`, { discountPercentAbove: null }))).toEqual({ discountPercentAbove: 'NO_CONDITION' });
      const renamed = await as(owner).patch(`/approval-rules/${discountRule.id}`, { name: 'Dealer discount limit', version: 0 });
      expect(renamed.body.data).toMatchObject({ name: 'Dealer discount limit', version: 1 });
      expect((await as(admin).patch(`/approval-rules/${discountRule.id}`, { name: 'Late', version: 0 })).status).toBe(409);
    });

    it(`allows ${MAX_APPROVAL_RULES} active rules, archived ones not counted, also in parallel`, async () => {
      const boss = await login('ap-limit@example.com');
      const first = (await as(boss).post('/approval-rules', { name: 'R0', discountPercentAbove: 1 })).body.data;
      const { organizationId } = await ApprovalRule.findById(first.id);
      await ApprovalRule.insertMany(Array.from({ length: MAX_APPROVAL_RULES - 2 }, (_, i) => ({ organizationId, name: `Bulk ${i}`, discountPercentAbove: 5 })));
      const old = (await as(boss).post('/approval-rules', { name: 'Old', discountPercentAbove: 2 })).body.data;
      expect((await as(boss).post('/approval-rules', { name: 'Too many', discountPercentAbove: 3 })).body.code).toBe('RULE_LIMIT');
      await as(boss).post(`/approval-rules/${old.id}/archive`);
      const results = await Promise.all(['A', 'B', 'C'].map((name) => as(boss).post('/approval-rules', { name, discountPercentAbove: 4 })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 422, 422]);
      expect((await as(boss).post(`/approval-rules/${old.id}/restore`)).body.code).toBe('RULE_LIMIT');
    });
  });

  describe('Quotations', () => {
    let quote;

    it('the editor knows before saving; owners are never stopped', async () => {
      const preview = (user, discount) => as(user).post('/pricing/preview', { contactId: customer.id, items: lines(discount) });
      const forAgent = (await preview(agent, 18)).body.data.approval;
      expect(forAgent.needed).toBe(true);
      expect(forAgent.reasons).toEqual([expect.objectContaining({ kind: 'discount', value: 18, limit: 10, ruleName: 'Dealer discount limit' })]);
      expect((await preview(agent, 10)).body.data.approval.needed).toBe(false); // "more than" 10%
      expect((await preview(owner, 50)).body.data.approval.needed).toBe(false);
      expect((await preview(admin, 18)).body.data.approval.needed).toBe(false); // that rule is for agents
    });

    it('an agent cannot send, mark sent or accepted, or download it before approval', async () => {
      quote = await quotationFor(agent, 18);
      expect(quote.approval).toMatchObject({ needed: true, blocked: true, state: null, canAsk: true, canDecide: false });
      for (const status of ['Sent', 'Accepted']) {
        const res = await as(agent).patch(`/quotations/${quote.id}`, { status });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('APPROVAL_REQUIRED');
      }
      expect((await as(agent).get(`/quotations/${quote.id}/pdf`)).body.code).toBe('APPROVAL_REQUIRED');
      expect((await as(agent).post(`/quotations/${quote.id}/send`, { mode: 'document', caption: 'Hi' })).body.code).toBe('APPROVAL_REQUIRED');
      // The owner opens and downloads it as always.
      expect((await as(owner).get(`/quotations/${quote.id}/pdf`)).status).toBe(200);
      expect((await as(owner).get(`/quotations/${quote.id}`)).body.data.approval).toMatchObject({ needed: false, blocked: false, state: null, canDecide: false });
    });

    it('asking tells every owner and admin, once', async () => {
      const before = await Promise.all([owner, admin, admin2, agent].map(unread));
      const asked = await as(agent).post(`/quotations/${quote.id}/approval`);
      expect(asked.status).toBe(200);
      expect(asked.body.data.approval).toMatchObject({ state: 'pending', blocked: true, canAsk: false, requestedBy: { name: expect.any(String) } });
      expect((await as(agent).post(`/quotations/${quote.id}/approval`)).body.data.approval.state).toBe('pending');
      const after = await Promise.all([owner, admin, admin2, agent].map(unread));
      expect(after.map((n, i) => n - before[i])).toEqual([1, 1, 1, 0]);
      expect((await as(agent).get(`/quotations/${quote.id}/pdf`)).body.message).toMatch(/waiting/);
      expect((await as(owner).get(`/quotations/${quote.id}`)).body.data.approval).toMatchObject({ state: 'pending', canDecide: true, reasons: [expect.objectContaining({ kind: 'discount', value: 18 })] });
      expect((await as(owner).get('/quotations?approval=pending')).body.data.map((q) => q.id)).toEqual([quote.id]);
      expect(await AuditLog.exists({ action: 'quotation.approval_requested' })).toBeTruthy();
    });

    it('only an owner or admin decides, and the first decision wins', async () => {
      expect((await as(agent).post(`/quotations/${quote.id}/approval/decision`, { decision: 'approve' })).status).toBe(403);
      const results = await Promise.all([admin, owner].map((user) => as(user).post(`/quotations/${quote.id}/approval/decision`, { decision: 'approve' })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409).body.code).toBe('ALREADY_DECIDED');
      const seen = (await as(agent).get(`/quotations/${quote.id}`)).body.data.approval;
      expect(seen).toMatchObject({ state: 'approved', needed: true, blocked: false, decidedBy: { name: expect.any(String) } });
      expect(await unread(agent)).toBe(1);
      expect((await as(agent).get(`/quotations/${quote.id}/pdf`)).status).toBe(200);
    });

    it('changing the lines after approval needs a new one; changing only the notes does not', async () => {
      expect((await as(agent).patch(`/quotations/${quote.id}`, { notes: 'Delivery in 7 days' })).body.data.approval.state).toBe('approved');
      const changed = (await as(agent).patch(`/quotations/${quote.id}`, { items: lines(19) })).body.data.approval;
      expect(changed).toMatchObject({ state: null, blocked: true, canAsk: true });
      expect((await as(agent).patch(`/quotations/${quote.id}`, { status: 'Sent' })).body.code).toBe('APPROVAL_REQUIRED');
    });

    it('a refusal needs a reason, reaches the agent, and they may ask again', async () => {
      await as(agent).post(`/quotations/${quote.id}/approval`);
      expect((await as(owner).post(`/quotations/${quote.id}/approval/decision`, { decision: 'reject' })).status).toBe(400);
      const before = await unread(agent);
      const rejected = await as(owner).post(`/quotations/${quote.id}/approval/decision`, { decision: 'reject', comment: 'Keep it at 12%' });
      expect(rejected.body.data.approval).toMatchObject({ state: 'rejected', comment: 'Keep it at 12%', canDecide: false });
      expect(await unread(agent)).toBe(before + 1);
      const seen = (await as(agent).get(`/quotations/${quote.id}`)).body.data.approval;
      expect(seen).toMatchObject({ state: 'rejected', blocked: true, canAsk: true, comment: 'Keep it at 12%' });
      expect((await as(agent).post(`/quotations/${quote.id}/approval`)).body.data.approval.state).toBe('pending');
    });

    it('editing a pending quotation cancels the request', async () => {
      const edited = (await as(agent).patch(`/quotations/${quote.id}`, { terms: 'Advance 50%' })).body.data.approval;
      expect(edited).toMatchObject({ state: null, canAsk: true });
      expect((await as(owner).post(`/quotations/${quote.id}/approval/decision`, { decision: 'approve' })).body.code).toBe('ALREADY_DECIDED');
    });

    it('below every limit, or once its rule is archived, a quotation goes as before', async () => {
      const small = await quotationFor(agent, 5);
      expect(small.approval).toMatchObject({ needed: false, blocked: false });
      expect((await as(agent).patch(`/quotations/${small.id}`, { status: 'Sent' })).status).toBe(200);
      expect((await as(agent).post(`/quotations/${quote.id}/approval`)).status).toBe(200);
      await as(owner).post(`/approval-rules/${discountRule.id}/archive`);
      expect((await as(agent).get(`/quotations/${quote.id}`)).body.data.approval).toMatchObject({ needed: false, blocked: false });
      expect((await as(agent).patch(`/quotations/${quote.id}`, { status: 'Sent' })).status).toBe(200);
      expect((await as(owner).post(`/approval-rules/${discountRule.id}/restore`)).body.data.status).toBe('active');
    });

    it('a revision is asked for afresh', async () => {
      const revised = (await as(agent).post(`/quotations/${quote.id}/revise`)).body.data;
      expect(revised.status).toBe('Draft');
      expect(revised.approval).toMatchObject({ state: null, needed: true, blocked: true });
    });

    it('a rule for admins: an admin cannot approve their own; another admin can; owners never need it', async () => {
      const big = await quotationFor(admin, 0, 60); // ₹6,00,000 + GST
      expect(big.approval).toMatchObject({ needed: true, blocked: true, reasons: [expect.objectContaining({ kind: 'total', ruleName: 'Big orders' })] });
      await as(admin).post(`/quotations/${big.id}/approval`);
      expect((await as(admin).get(`/quotations/${big.id}`)).body.data.approval.canDecide).toBe(false);
      expect((await as(admin).post(`/quotations/${big.id}/approval/decision`, { decision: 'approve' })).body.code).toBe('OWN_REQUEST');
      expect((await as(admin2).post(`/quotations/${big.id}/approval/decision`, { decision: 'approve' })).status).toBe(200);
      expect((await as(admin).patch(`/quotations/${big.id}`, { status: 'Sent' })).status).toBe(200);
      const ownersOwn = await quotationFor(owner, 40, 60);
      expect(ownersOwn.approval.needed).toBe(false);
      expect((await as(owner).patch(`/quotations/${ownersOwn.id}`, { status: 'Sent' })).status).toBe(200);
      expect((await as(agent).post(`/quotations/${ownersOwn.id}/approval`)).body.code).toBe('NOT_DRAFT'); // sent already
    });

    it('a quotation that needs nothing cannot be sent for approval', async () => {
      const small = await quotationFor(agent, 2);
      expect((await as(agent).post(`/quotations/${small.id}/approval`)).body.code).toBe('NOT_NEEDED');
    });
  });

  it('another company never sees or uses these rules and approvals', async () => {
    expect((await as(other).get('/approval-rules')).body.data).toEqual([]);
    expect((await as(other).patch(`/approval-rules/${discountRule.id}`, { name: 'Mine' })).status).toBe(404);
    const pending = await quotationFor(agent, 25);
    await as(agent).post(`/quotations/${pending.id}/approval`);
    expect((await as(other).post(`/quotations/${pending.id}/approval/decision`, { decision: 'approve' })).status).toBe(404);
    const theirs = (await as(other).post('/contacts', { name: 'Their customer', phone: '98290 61099', lifecycle: 'customer' })).body.data;
    const theirQuote = (await as(other).post('/quotations', { contactId: theirs.id, items: lines(90) })).body.data;
    expect(theirQuote.approval.needed).toBe(false);
  });

  it('the full export has the rules, and changes are audited', async () => {
    const res = await api().get('/api/v1/exports/crm').set(bearer(owner.token));
    expect(res.body.approvalRules.map((r) => r.name)).toEqual(expect.arrayContaining(['Dealer discount limit', 'Big orders']));
    for (const action of ['approval_rule.created', 'approval_rule.updated', 'approval_rule.archived', 'approval_rule.restored', 'quotation.approved', 'quotation.approval_rejected']) {
      expect(await AuditLog.exists({ action })).toBeTruthy();
    }
  });
});
