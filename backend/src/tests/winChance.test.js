jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const winChance = require('../services/winChanceService');
const { api, bearer, login } = require('./helpers/api');

// Phase 3B (D81): a win chance learned from the company's own closed leads, with what it used, or
// "not enough history"; and the next step from the lead's own facts.
const DAY = 24 * 60 * 60 * 1000;
const insights = async (token) => (await api().get('/api/v1/reports/insights').set(bearer(token))).body.data;

async function closedLeads(organizationId, count, { stage, source, valuePaise, reached }) {
  const docs = Array.from({ length: count }, () => ({ _id: new mongoose.Types.ObjectId(), organizationId, title: 'Old enquiry', stage, source, expectedValuePaise: valuePaise, stageChangedAt: new Date(Date.now() - 30 * DAY), createdAt: new Date(Date.now() - 60 * DAY), deletedAt: null }));
  await Lead.collection.insertMany(docs);
  if (reached) {
    await LeadActivity.collection.insertMany(docs.flatMap((lead) => [
      { organizationId, leadId: lead._id, type: 'Stage changed', meta: { from: 'New', to: reached } },
      { organizationId, leadId: lead._id, type: 'Stage changed', meta: { from: reached, to: 'Lost' } },
    ]));
  }
}

const openLead = (organizationId, fields) => Lead.collection.insertOne({ organizationId, title: fields.title, stage: fields.stage, source: fields.source, expectedValuePaise: fields.valuePaise, lastActivityAt: new Date(), createdAt: new Date(), deletedAt: null, ...fields.extra });

describe('Win chance and next step (Phase 3B)', () => {
  it('says "not enough history" until there are 20 similar closed leads, and never invents a number', async () => {
    const owner = await login('win-few@example.com', { name: 'Kavya' });
    const organizationId = new mongoose.Types.ObjectId(owner.data.organizationId);
    await closedLeads(organizationId, 4, { stage: 'Won', source: 'IndiaMART', valuePaise: 5000000 });
    await closedLeads(organizationId, 3, { stage: 'Lost', source: 'IndiaMART', valuePaise: 5000000, reached: 'Contacted' });
    await openLead(organizationId, { title: 'Steel order', stage: 'Contacted', source: 'IndiaMART', valuePaise: 5000000 });
    const data = await insights(owner.token);
    expect(data.winModel).toMatchObject({ closed: 7, won: 4, minSimilar: 20, lookbackDays: 365 });
    expect(data.priority[0].win).toEqual({ pct: null, enough: false, similar: 7, won: 4, needed: 20, by: ['stage'], band: '10k_1l' });
    expect(data.priority[0].probability).toBe(25); // the stage's own number stays for the forecast
  });

  it('learns from closed leads like this one, narrowing to source and value when there are enough', async () => {
    const owner = await login('win-many@example.com', { name: 'Lata' });
    const organizationId = new mongoose.Types.ObjectId(owner.data.organizationId);
    await closedLeads(organizationId, 25, { stage: 'Won', source: 'IndiaMART', valuePaise: 5000000 }); // ₹50,000
    await closedLeads(organizationId, 15, { stage: 'Lost', source: 'IndiaMART', valuePaise: 5000000, reached: 'Quote Sent' });
    await closedLeads(organizationId, 10, { stage: 'Lost', source: 'IndiaMART', valuePaise: 5000000, reached: 'Contacted' });
    await closedLeads(organizationId, 10, { stage: 'Won', source: 'Website', valuePaise: 500000 }); // ₹5,000
    // Another company's history never counts.
    const other = await login('win-other@example.com', { name: 'Other' });
    await closedLeads(new mongoose.Types.ObjectId(other.data.organizationId), 40, { stage: 'Lost', source: 'IndiaMART', valuePaise: 5000000, reached: 'Quote Sent' });

    await openLead(organizationId, { title: 'A', stage: 'Quote Sent', source: 'IndiaMART', valuePaise: 5000000 });
    await openLead(organizationId, { title: 'B', stage: 'New', source: 'Website', valuePaise: 500000 });
    await openLead(organizationId, { title: 'C', stage: 'Contacted', source: 'IndiaMART', valuePaise: 50000000 }); // ₹5 lakh: no such band yet
    const rows = Object.fromEntries((await insights(owner.token)).priority.map((r) => [r.title, r]));
    // A: reached Quote Sent, IndiaMART, ₹10k–1L → 25 won of 40.
    expect(rows.A.win).toMatchObject({ pct: 63, enough: true, similar: 40, won: 25, by: ['stage', 'source', 'value'] });
    // B: only 10 Website leads, so the whole company at New → 35 of 60.
    expect(rows.B.win).toMatchObject({ pct: 58, enough: true, similar: 60, won: 35, by: ['stage'] });
    // C: IndiaMART at Contacted, any value → 25 of 50.
    expect(rows.C.win).toMatchObject({ pct: 50, enough: true, similar: 50, won: 25, by: ['stage', 'source'] });
    expect(rows.A.probability).toBe(50); // unchanged stage number
  });

  it('picks the next step from the lead\'s facts, most urgent first', () => {
    const now = new Date('2026-10-21T06:00:00Z');
    const ago = (days) => new Date(now.getTime() - days * DAY);
    const owner = new mongoose.Types.ObjectId();
    expect(winChance.nextActionOf({ stage: 'Contacted', ownerId: owner, followUpAt: ago(2), lastActivityAt: ago(1) }, now)).toMatchObject({ code: 'follow_up_due', days: 2, text: 'The follow-up was due 2 days ago' });
    expect(winChance.nextActionOf({ stage: 'Quote Sent', ownerId: owner, lastQuoteSentAt: ago(4), lastActivityAt: ago(1) }, now)).toMatchObject({ code: 'quote_no_reply', days: 4 });
    expect(winChance.nextActionOf({ stage: 'Quote Sent', ownerId: owner, lastQuoteSentAt: ago(4), lastCustomerReplyAt: ago(1), lastActivityAt: ago(1) }, now).code).toBe('stage');
    expect(winChance.nextActionOf({ stage: 'New', ownerId: owner, lastActivityAt: ago(10) }, now)).toMatchObject({ code: 'idle', days: 10, text: 'Follow up: nothing for 10 days' });
    expect(winChance.nextActionOf({ stage: 'New', lastActivityAt: ago(1) }, now)).toMatchObject({ code: 'assign' });
    expect(winChance.nextActionOf({ stage: 'Negotiation', ownerId: owner, lastActivityAt: ago(1) }, now)).toMatchObject({ code: 'stage', text: 'Close: send a payment link' });
    expect(winChance.bandOf(0)).toBe('none');
    expect(winChance.bandOf(99999999)).toBe('1l_10l');
  });
});
