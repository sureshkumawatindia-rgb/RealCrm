jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Job = require('../models/Job');
const Lead = require('../models/Lead');
const Order = require('../models/Order');
const Quotation = require('../models/Quotation');
const queue = require('../jobs/queue');
const automationEvents = require('../services/automation/events');
const leadScores = require('../services/leadScoreService');
const { api, bearer, login } = require('./helpers/api');

// G2 (D106): how warm an open lead is — hot, warm or cold — from its stage, the company's record
// with its source, how the customer answers on WhatsApp, the latest quotation, past orders and our
// own follow-up; worked out again a minute after something happens, and by a daily sweep.
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = new Date('2026-10-31T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);
const codes = (score) => score.reasons.map((r) => `${r.code} ${r.points > 0 ? '+' : ''}${r.points}`);

describe('Lead scoring (G2, D106)', () => {
  describe('the points', () => {
    const lead = (extra = {}) => ({ stage: 'New', source: 'WhatsApp', lastActivityAt: ago(DAY), createdAt: ago(2 * DAY), ...extra });

    it('starts cold, and adds what the stage, the source, the replies, the quotation and orders say', () => {
      expect(leadScores.scoreOf(lead(), {}, NOW)).toEqual({ points: 30, band: 'cold', reasons: [] });

      const keen = leadScores.scoreOf(lead({ stage: 'Contacted', source: 'WhatsApp Ad' }), {
        replies: leadScores.replySignals([
          { d: 'out', at: ago(2 * DAY) }, { d: 'in', at: ago(2 * DAY - 20 * MIN) },
          { d: 'out', at: ago(DAY) }, { d: 'in', at: ago(DAY - 10 * MIN) },
        ]),
      }, NOW);
      expect(keen.points).toBe(70); // 30 + 5 + 5 + 20 + 10
      expect(keen.band).toBe('hot');
      expect(codes(keen)).toEqual(['reply_fast +20', 'wrote_recently +10', 'stage +5', 'source_intent +5']);
      expect(keen.reasons[0].params).toEqual({ minutes: 15 });

      const buyer = leadScores.scoreOf(lead({ stage: 'Quote Sent' }), { quotation: { status: 'Viewed', viewCount: 3, number: 'QT/26-27/0007', sentAt: ago(DAY) }, orders: 1 }, NOW);
      expect(buyer).toEqual(expect.objectContaining({ points: 72, band: 'hot' })); // 30 + 10 + 20 + 12
      expect(codes(buyer)).toEqual(['quote_viewed_often +20', 'bought_before +12', 'stage +10']);

      const fading = leadScores.scoreOf(lead({ stage: 'Quote Sent', lastActivityAt: ago(25 * DAY), followUpAt: ago(4 * DAY) }), {
        quotation: { status: 'Sent', viewCount: 0, number: 'QT/26-27/0008', sentAt: ago(5 * DAY) },
        replies: leadScores.replySignals([{ d: 'in', at: ago(20 * DAY) }, { d: 'out', at: ago(6 * DAY) }]),
      }, NOW);
      expect(fading).toEqual(expect.objectContaining({ points: 5, band: 'cold' })); // 30 + 10 − 10 − 10 − 10 − 5
      expect(codes(fading)).toEqual(['stage +10', 'no_reply -10', 'quote_unopened -10', 'stale -10', 'follow_up_overdue -5']);
    });

    it('reads the company\'s own record with a source, once it has enough closed leads', () => {
      const sources = { rate: 0.25, bySource: new Map([['IndiaMART', { closed: 20, won: 9 }], ['JustDial', { closed: 12, won: 1 }], ['Facebook', { closed: 4, won: 4 }]]) };
      expect(codes(leadScores.scoreOf(lead({ source: 'IndiaMART' }), { sources }, NOW))).toEqual(['source_strong +12']);
      expect(leadScores.scoreOf(lead({ source: 'IndiaMART' }), { sources }, NOW).reasons[0].params).toEqual({ source: 'IndiaMART', pct: 45, averagePct: 25 });
      expect(codes(leadScores.scoreOf(lead({ source: 'JustDial' }), { sources }, NOW))).toEqual(['source_weak -8']);
      expect(codes(leadScores.scoreOf(lead({ source: 'Facebook' }), { sources }, NOW))).toEqual([]); // too few closed leads to say
    });

    it('stays within 0 and 100, and leaves out messages that expect no answer', () => {
      const best = leadScores.scoreOf(lead({ stage: 'Negotiation', source: 'Website' }), {
        quotation: { status: 'Accepted', number: 'Q1', sentAt: ago(DAY) }, orders: 5,
        replies: leadScores.replySignals([{ d: 'out', at: ago(DAY) }, { d: 'in', at: ago(DAY - MIN) }]),
      }, NOW);
      expect(best).toEqual(expect.objectContaining({ points: 100, band: 'hot' }));
      const signals = leadScores.replySignals([{ d: 'out', at: ago(6 * DAY), k: 'broadcast' }, { d: 'out', at: ago(5 * DAY), k: 'csat' }, { d: 'out', at: ago(4 * DAY), t: 'reaction' }]);
      expect(signals).toEqual({ delays: [], waitingSince: null, lastIn: null });
      const worst = leadScores.scoreOf(lead({ source: 'JustDial', lastActivityAt: ago(40 * DAY), followUpAt: ago(9 * DAY) }), {
        sources: { rate: 0.5, bySource: new Map([['JustDial', { closed: 30, won: 3 }]]) },
        quotation: { status: 'Rejected', number: 'Q2', sentAt: ago(9 * DAY) }, lastInboundAt: ago(60 * DAY),
      }, NOW);
      expect(worst).toEqual(expect.objectContaining({ points: 0, band: 'cold' })); // 30 − 8 − 15 − 10 − 10 − 5
    });
  });

  describe('in the CRM', () => {
    let owner;
    let chat;
    const as = () => bearer(owner.token);
    // An event queues its job without being waited for: wait for the job, then make it due now.
    const runScores = async () => {
      for (let i = 0; i < 40 && !(await Job.exists({ name: leadScores.JOB, status: 'queued' })); i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 25); });
      }
      await Job.updateMany({ name: leadScores.JOB, status: 'queued' }, { $set: { runAt: new Date() } });
      await queue.runDue();
    };

    beforeAll(async () => {
      leadScores.register(queue);
      await Job.deleteMany({ name: leadScores.SWEEP }); // the sweep is run by hand below
      owner = await login('score-owner@example.com', { name: 'Asha' });
      await api().post('/api/v1/whatsapp/accounts').set(as()).send({ provider: 'mock' });
    });

    it('scores a new WhatsApp lead a minute after the customer writes, and again when they reply', async () => {
      const simulate = (text) => api().post('/api/v1/dev/simulate/whatsapp-inbound').set(as()).send({ from: '98290 50001', name: 'Meena Stores', text });
      chat = (await simulate('Jeera ka rate?')).body.data;
      const job = await Job.findOne({ name: leadScores.JOB, status: 'queued' });
      expect(job).toEqual(expect.objectContaining({ data: { organizationId: String(owner.data.organizationId), contactId: String(chat.contactId) } }));
      expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 30 * 1000); // after a minute, not at once
      await runScores();
      let lead = await Lead.findOne({ contactId: chat.contactId });
      expect(lead.score).toEqual(expect.objectContaining({ points: 40, band: 'warm', at: expect.any(Date) }));
      expect(codes(lead.score)).toEqual(['wrote_recently +10']);

      // We answer, they answer back within minutes: hot.
      await api().post(`/api/v1/conversations/${chat.conversationId}/messages`).set(as()).send({ text: '₹250/kg' });
      await simulate('Theek hai, 500 kg chahiye');
      await runScores();
      lead = await Lead.findOne({ contactId: chat.contactId });
      expect(codes(lead.score)).toEqual(['reply_fast +20', 'wrote_recently +10']);
      expect(lead.score).toEqual(expect.objectContaining({ points: 60, band: 'warm' }));

      // The list shows it; a score is not an edit (updatedAt and version stay).
      const listed = (await api().get(`/api/v1/leads?contactId=${chat.contactId}`).set(as())).body.data[0];
      expect(listed.score).toEqual({ points: 60, band: 'warm', reasons: [expect.objectContaining({ code: 'reply_fast', points: 20 }), expect.objectContaining({ code: 'wrote_recently', points: 10 })], at: expect.any(String) });
      const before = await Lead.findById(lead._id).lean();
      await leadScores.scoreDue({ organizationId: owner.data.organizationId, leadId: lead._id });
      const after = await Lead.findById(lead._id).lean();
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.version).toBe(before.version);
    });

    it('counts the lead\'s latest quotation and the customer\'s orders, and drops the score when the lead closes', async () => {
      const lead = await Lead.findOne({ contactId: chat.contactId });
      const organizationId = owner.data.organizationId;
      await Quotation.collection.insertOne({ organizationId: lead.organizationId, leadId: lead._id, contactId: lead.contactId, number: 'QT/26-27/0101', status: 'Viewed', viewCount: 4, sentAt: new Date(Date.now() - DAY), deletedAt: null, createdAt: new Date() });
      await Order.collection.insertMany([
        { organizationId: lead.organizationId, number: 'SO/26-27/0901', contactId: lead.contactId, stage: 'Delivered', deletedAt: null, createdAt: new Date() },
        { organizationId: lead.organizationId, number: 'SO/26-27/0902', contactId: lead.contactId, stage: 'Cancelled', deletedAt: null, createdAt: new Date() },
      ]);
      automationEvents.emit('quotation.status_changed', { organizationId, contactId: lead.contactId, leadId: lead._id, from: 'Sent', to: 'Viewed' });
      await runScores();
      const scored = await Lead.findById(lead._id);
      expect(codes(scored.score)).toEqual(expect.arrayContaining(['quote_viewed_often +20', 'bought_before +12']));
      expect(scored.score.band).toBe('hot');

      const won = await api().patch(`/api/v1/leads/${lead._id}`).set(as()).send({ stage: 'Won' });
      expect(won.status).toBe(200);
      await runScores();
      expect((await Lead.findById(lead._id)).score?.band).toBeUndefined();
    });

    it('scores leads that were never scored (an import) in the sweep, and older scores again after a day', async () => {
      const contact = (await api().post('/api/v1/contacts').set(as()).send({ name: 'Imported Kirana', phone: '98290 50002' })).body.data;
      const imported = await Lead.create({ organizationId: owner.data.organizationId, contactId: contact.id, stage: 'Contacted', source: 'Import', lastActivityAt: new Date() });
      const old = await Lead.findOneAndUpdate({ contactId: chat.contactId }, { $set: { stage: 'Negotiation', score: { points: 1, band: 'cold', reasons: [], at: new Date(Date.now() - 2 * DAY) } } }, { returnDocument: 'after' });
      const result = await leadScores.sweep();
      expect(result.scored).toBeGreaterThanOrEqual(2);
      expect((await Lead.findById(imported._id)).score).toEqual(expect.objectContaining({ points: 35, band: 'cold' }));
      expect((await Lead.findById(old._id)).score.points).toBeGreaterThan(1);
      expect((await leadScores.sweep()).scored).toBe(0); // all fresh now
    });
  });
});
