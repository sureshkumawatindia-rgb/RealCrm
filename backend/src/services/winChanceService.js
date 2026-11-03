const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const { OPEN_STAGES } = require('../constants/crm');

// A lead's chance to be won, from the company's own closed leads (Phase 3B, D81). No AI vendor, no
// customer data sent anywhere: it counts how many leads like this one were won.
//   "Like this one": closed in the last 365 days, reached at least this lead's stage, and where
//   there are enough of them, the same source and the same value band. It uses the most precise
//   group with at least MIN_SIMILAR closed leads, and says which one ("12 of 30 similar leads").
//   Fewer than MIN_SIMILAR at even the widest group: no number at all, "not enough history".
// A lost lead reached the furthest open stage of its stage changes (LeadActivity "Stage changed");
// a won lead counts as having passed every open stage.
const MIN_SIMILAR = 20;
const LOOKBACK_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
// Value bands in paise: under ₹10,000; ₹10,000–1 lakh; ₹1–10 lakh; above ₹10 lakh.
const BANDS = Object.freeze([['under_10k', 1000000], ['10k_1l', 10000000], ['1l_10l', 100000000], ['over_10l', Infinity]]);
const bandOf = (paise) => (paise > 0 ? BANDS.find(([, below]) => paise < below)[0] : 'none');
const LAST_OPEN = OPEN_STAGES.length - 1;

// The closed leads to learn from: [{ won, source, band, reached }].
async function historyOf(organizationId, { valueOf, filter = {}, now = new Date() }) {
  const closed = await Lead.find({ organizationId, stage: { $in: ['Won', 'Lost'] }, stageChangedAt: { $gte: new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS) }, ...filter })
    .select('stage source expectedValuePaise').lean();
  const lostIds = closed.filter((lead) => lead.stage === 'Lost').map((lead) => lead._id);
  const reachedOf = new Map();
  if (lostIds.length) {
    const rows = await LeadActivity.aggregate([
      { $match: { organizationId: new mongoose.Types.ObjectId(String(organizationId)), leadId: { $in: lostIds }, type: 'Stage changed' } },
      { $project: { leadId: 1, stages: ['$meta.from', '$meta.to'] } },
      { $unwind: '$stages' },
      { $group: { _id: '$leadId', stages: { $addToSet: '$stages' } } },
    ]);
    for (const row of rows) reachedOf.set(String(row._id), Math.max(0, ...row.stages.map((stage) => OPEN_STAGES.indexOf(stage))));
  }
  const values = await valueOf(closed);
  return closed.map((lead) => ({
    won: lead.stage === 'Won',
    source: lead.source || '',
    band: bandOf(values(lead)),
    reached: lead.stage === 'Won' ? LAST_OPEN : reachedOf.get(String(lead._id)) ?? 0,
  }));
}

// { pct, enough, similar, won, by: ['stage','source','value'] } or { pct: null, enough: false, … }.
// Every lead with the same stage, source and value band gets the same answer: it is worked out
// once per history (Phase 3, D115; AI Insights asks for each of a company's 30,000 open leads).
const answers = new WeakMap(); // history → Map("stage|source|band" → answer)
function chanceOf(lead, valuePaise, history) {
  const stageIndex = Math.max(OPEN_STAGES.indexOf(lead.stage), 0);
  const band = bandOf(valuePaise);
  const key = `${stageIndex}|${lead.source || ''}|${band}`;
  let known = answers.get(history);
  if (!known) answers.set(history, (known = new Map()));
  if (!known.has(key)) known.set(key, chanceFor(stageIndex, lead.source || '', band, history));
  return { ...known.get(key) };
}

function chanceFor(stageIndex, source, band, history) {
  const atStage = history.filter((h) => h.reached >= stageIndex);
  const levels = [
    { by: ['stage', 'source', 'value'], pool: atStage.filter((h) => h.source === source && h.band === band) },
    { by: ['stage', 'source'], pool: atStage.filter((h) => h.source === source) },
    { by: ['stage'], pool: atStage },
  ];
  const level = levels.find((l) => l.pool.length >= MIN_SIMILAR);
  if (!level) return { pct: null, enough: false, similar: atStage.length, won: atStage.filter((h) => h.won).length, needed: MIN_SIMILAR, by: ['stage'], band };
  const won = level.pool.filter((h) => h.won).length;
  return { pct: Math.round((won * 100) / level.pool.length), enough: true, similar: level.pool.length, won, needed: MIN_SIMILAR, by: level.by, band };
}

// The next step from the lead's own facts, most urgent first: { code, text, days?, at? }.
// The text is English for the API; the page shows it in its own language by code.
const STAGE_STEP = {
  New: 'Call or message today to qualify', Contacted: 'Send a quotation', 'Quote Sent': 'Follow up on the quotation', Negotiation: 'Close: send a payment link',
};
const daysSince = (date, now) => Math.floor((now - new Date(date).getTime()) / DAY_MS);

function nextActionOf(lead, now = new Date()) {
  const at = now.getTime();
  if (lead.followUpAt && new Date(lead.followUpAt).getTime() < at) {
    const days = daysSince(lead.followUpAt, at);
    return { code: 'follow_up_due', days, at: lead.followUpAt, text: days ? `The follow-up was due ${days} day${days === 1 ? '' : 's'} ago` : 'The follow-up is due today' };
  }
  if (lead.stage === 'Quote Sent' && lead.lastQuoteSentAt && daysSince(lead.lastQuoteSentAt, at) >= 3
    && (!lead.lastCustomerReplyAt || new Date(lead.lastCustomerReplyAt) < new Date(lead.lastQuoteSentAt))) {
    const days = daysSince(lead.lastQuoteSentAt, at);
    return { code: 'quote_no_reply', days, text: `Call: no reply ${days} days after the quotation` };
  }
  const idle = daysSince(lead.lastActivityAt || lead.createdAt, at);
  if (idle >= 7) return { code: 'idle', days: idle, text: `Follow up: nothing for ${idle} days` };
  if (!lead.ownerId) return { code: 'assign', text: 'Give it an owner' };
  return { code: 'stage', stage: lead.stage, text: STAGE_STEP[lead.stage] || '' };
}

module.exports = { historyOf, chanceOf, nextActionOf, bandOf, MIN_SIMILAR, LOOKBACK_DAYS, STAGE_STEP };
