const CsatSurvey = require('../models/CsatSurvey');
const Organization = require('../models/Organization');

// Customer feedback after a resolved chat (D103, CSAT): one question with three buttons — Good,
// Okay, Bad — only when the company switched it on (Settings → WhatsApp), inside the customer's
// 24-hour window, at most once a day per customer, never on a private number (D61) or to a
// blocked customer. The question leaves the chat resolved; the answer (a button reply whose id
// is "csat:<survey>:<rating>") counts for the chat's teammate in Team live, My performance and
// Reports, and does not reopen the chat or wake the bot.
const DAY_MS = 24 * 60 * 60 * 1000;
const RATINGS = Object.freeze(['good', 'okay', 'bad']);
const LABELS = Object.freeze({ good: 'Good', okay: 'Okay', bad: 'Bad' });
const DEFAULT_QUESTION = 'How was our service today?';
const conversations = () => require('./conversationService'); // eslint-disable-line global-require -- it uses this service

function settingsOf(organization) {
  const csat = organization?.settings?.csat || {};
  return { enabled: Boolean(csat.enabled), question: csat.question || '' };
}

// After a chat is resolved: 'asked', or why not ('off', 'private', 'blocked', 'window_closed',
// 'asked_today', 'failed').
async function askAfterClose(conversation, memberId) {
  const { organizationId, contactId } = conversation;
  const { enabled, question } = settingsOf(await Organization.findById(organizationId).select('settings').lean());
  if (!enabled) return 'off';
  if (conversation.private) return 'private';
  if (conversation.blockedAt) return 'blocked';
  const { serviceWindow, sendInteractiveAutomatically } = conversations();
  if (!serviceWindow(conversation).open) return 'window_closed';
  if (await CsatSurvey.exists({ organizationId, contactId, askedAt: { $gte: new Date(Date.now() - DAY_MS) } })) return 'asked_today';
  const survey = await CsatSurvey.create({ organizationId, conversationId: conversation._id, contactId, memberId, askedAt: new Date() });
  const message = await sendInteractiveAutomatically({
    conversation,
    interactive: { kind: 'button', body: question || DEFAULT_QUESTION, options: RATINGS.map((rating) => ({ id: `csat:${survey._id}:${rating}`, title: LABELS[rating] })) },
    automation: { kind: 'csat' },
    keepStatus: true,
  });
  if (message.status === 'failed') {
    await CsatSurvey.deleteOne({ _id: survey._id }); // WhatsApp refused it: not counted as asked
    return 'failed';
  }
  await CsatSurvey.updateOne({ _id: survey._id }, { $set: { messageId: message.id } });
  return 'asked';
}

// A button reply to the question → { surveyId, rating }, else null.
function answerOf(fields) {
  const match = /^csat:([a-f0-9]{24}):(good|okay|bad)$/.exec(fields?.reply?.id || '');
  return match ? { surveyId: match[1], rating: match[2] } : null;
}

// The customer's answer; the first tap counts.
async function recordAnswer({ organizationId, contactId, surveyId, rating, at = new Date() }) {
  return CsatSurvey.findOneAndUpdate(
    { _id: surveyId, organizationId, contactId, rating: null },
    { $set: { rating, answeredAt: at } },
    { returnDocument: 'after' },
  );
}

// The score: the share of answers that were Good.
const scoreOf = ({ good = 0, okay = 0, bad = 0 }) => {
  const answers = good + okay + bad;
  return { answers, good, okay, bad, scorePct: answers ? Math.round((good / answers) * 1000) / 10 : null };
};

// Answers in a time range by teammate: Map(memberId → { good, okay, bad }), and the whole team.
async function answersBy(organizationId, range, { memberId } = {}) {
  const rows = await CsatSurvey.aggregate([
    { $match: { organizationId, answeredAt: { $gte: range.start, $lt: range.end }, ...(memberId && { memberId }) } },
    { $group: { _id: { member: '$memberId', rating: '$rating' }, count: { $sum: 1 } } },
  ]);
  const byMember = new Map();
  const team = { good: 0, okay: 0, bad: 0 };
  for (const r of rows) {
    const key = String(r._id.member || '');
    if (!byMember.has(key)) byMember.set(key, { good: 0, okay: 0, bad: 0 });
    byMember.get(key)[r._id.rating] += r.count;
    team[r._id.rating] += r.count;
  }
  return { byMember, team };
}

module.exports = { askAfterClose, answerOf, recordAnswer, answersBy, scoreOf, settingsOf, RATINGS, DEFAULT_QUESTION };
