const mongoose = require('mongoose');
const BotSettings = require('../../models/BotSettings');
const Conversation = require('../../models/Conversation');
const FaqRule = require('../../models/FaqRule');
const OrganizationMember = require('../../models/OrganizationMember');
const logger = require('../../config/logger');
const conversations = require('../conversationService');
const notifications = require('../notificationService');
const { businessHoursOf, isOpen } = require('../../utils/businessHours');
const { fill } = require('./actions');
const { loadContext, leadOfContact } = require('./context');

// The WhatsApp FAQ bot (Phase 6C). It looks at each customer message (the engine calls
// handleMessage first for "message.received") and answers only while no agent has the chat and
// the customer has not asked for a person (D33). In order: a tapped bot button or list row, a
// hand-off keyword, the first FAQ rule whose keyword is in the message, then the away message
// (outside working hours) or the greeting — each of those two at most once per chat every
// repeatAfterHours. Answers are text, reply buttons (1–3 options) or a list (4–10 options).
const HANDOFF_ID = 'bot:handoff';
const RULE_PREFIX = 'bot:rule:';
const HOUR = 60 * 60 * 1000;
const BOT = (ruleId) => ({ kind: 'bot', ...(ruleId && { ruleId }) });

// Whole words or phrases, in any script, capitals ignored ("rate" does not match "accurate").
function matchesAny(keywords = [], text = '') {
  const haystack = String(text).toLowerCase();
  return keywords.some((keyword) => {
    const needle = String(keyword || '').trim().toLowerCase();
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}])${escaped}($|[^\\p{L}\\p{M}\\p{N}])`, 'u').test(haystack);
  });
}

// The options as WhatsApp ids; options pointing to a rule that was removed or switched off go.
async function optionsOf(answer, organizationId) {
  const ruleIds = (answer.options || []).filter((o) => o.action === 'rule' && o.ruleId).map((o) => o.ruleId);
  const live = new Set((await FaqRule.find({ _id: { $in: ruleIds }, organizationId, active: true }).select('_id')).map((r) => String(r._id)));
  return (answer.options || [])
    .filter((o) => o.action === 'handoff' || live.has(String(o.ruleId)))
    .map((o) => ({ id: o.action === 'handoff' ? HANDOFF_ID : `${RULE_PREFIX}${o.ruleId}`, title: o.title, description: o.description || '' }))
    .slice(0, 10);
}

async function sendAnswer(conversation, answer, ctx, automation) {
  const body = fill(answer?.text || '', ctx).trim().slice(0, 1024);
  if (!body) return null;
  const options = await optionsOf(answer, conversation.organizationId);
  if (!options.length) return conversations.sendTextAutomatically({ conversation, text: body, automation });
  const kind = options.length <= 3 ? 'button' : 'list';
  return conversations.sendInteractiveAutomatically({
    conversation,
    automation,
    interactive: {
      kind,
      body,
      footer: String(answer.footer || '').slice(0, 60),
      listButton: String(answer.listButton || 'Choose').slice(0, 20),
      options: options.map((o) => (kind === 'button'
        ? { id: o.id, title: o.title.slice(0, 20) }
        : { id: o.id, title: o.title.slice(0, 24), ...(o.description && { description: o.description.slice(0, 72) }) })),
    },
  });
}

// The customer wants a person: the bot says so, stops in this chat and rings the bell of the
// customer's owner (else the owners and admins).
async function handoff(conversation, settings, ctx, reason) {
  const text = fill(settings.handoff?.text || '', ctx).trim();
  if (text) await conversations.sendTextAutomatically({ conversation, text, automation: BOT() });
  const updated = await Conversation.findOneAndUpdate(
    { _id: conversation._id },
    { $set: { 'bot.handedOffAt': new Date(), 'bot.handoffReason': reason, 'bot.lastAnsweredAt': new Date() } },
    { returnDocument: 'after' },
  );
  conversations.announce('conversation:updated', updated, { previousAssigneeId: updated.assigneeId || null });
  const ownerId = ctx.lead?.ownerId || ctx.contact?.ownerId;
  const to = ownerId
    ? [ownerId]
    : (await OrganizationMember.find({ organizationId: conversation.organizationId, status: 'active', role: { $in: ['owner', 'admin'] } }).select('_id')).map((m) => m._id);
  await notifications.notify(conversation.organizationId, to, {
    title: `${ctx.contact?.name || 'A customer'} wants to talk to a person`,
    body: 'The WhatsApp bot handed the chat over. Reply in the Inbox.',
    link: `Inbox.html?c=${conversation._id}`,
    source: 'bot',
  });
}

async function answerWith(conversation, rule, ctx) {
  await sendAnswer(conversation, rule.answer, ctx, BOT(rule._id));
  await FaqRule.updateOne({ _id: rule._id }, { $inc: { 'stats.answered': 1 }, $set: { 'stats.lastAnsweredAt': new Date() } });
  await Conversation.updateOne({ _id: conversation._id }, { $set: { 'bot.lastAnsweredAt': new Date() } });
}

// → what the bot did: rule | handoff | away | greeting | null (nothing).
async function respond(event) {
  if (event.type !== 'message.received' || !event.conversationId) return null;
  const organizationId = event.organizationId;
  const settings = await BotSettings.findOne({ organizationId });
  if (!settings?.enabled) return null;
  const conversation = await Conversation.findOne({ _id: event.conversationId, organizationId });
  // D33: quiet once an agent has the chat or the customer asked for a person.
  if (!conversation || conversation.assigneeId || conversation.bot?.handedOffAt) return null;
  if (!conversations.serviceWindow(conversation).open) return null;
  const lead = await leadOfContact(organizationId, conversation.contactId);
  const ctx = await loadContext({ organizationId, subject: { conversationId: conversation._id, contactId: conversation.contactId, ...(lead && { leadId: lead._id }) }, event });

  // 1. A bot button or list row.
  const replyId = String(event.replyId || '');
  if (replyId === HANDOFF_ID) {
    await handoff(conversation, settings, ctx, 'The customer tapped the button to talk to a person.');
    return 'handoff';
  }
  if (replyId.startsWith(RULE_PREFIX)) {
    const ruleId = replyId.slice(RULE_PREFIX.length);
    const rule = mongoose.isValidObjectId(ruleId) ? await FaqRule.findOne({ _id: ruleId, organizationId, active: true }) : null;
    if (!rule) return null;
    await answerWith(conversation, rule, ctx);
    return 'rule';
  }
  // 2. Asking for a person.
  if (matchesAny(settings.handoff?.keywords, event.text)) {
    await handoff(conversation, settings, ctx, 'The customer asked for a person.');
    return 'handoff';
  }
  // 3. A FAQ answer.
  const rules = await FaqRule.find({ organizationId, active: true, 'keywords.0': { $exists: true } }).sort({ priority: 1, createdAt: 1 });
  const rule = rules.find((r) => matchesAny(r.keywords, event.text));
  if (rule) {
    await answerWith(conversation, rule, ctx);
    return 'rule';
  }
  // 4. Away (outside working hours) or 5. greeting, at most once per chat every repeatAfterHours.
  const now = new Date();
  const recent = (at) => Boolean(at && now - at < settings.repeatAfterHours * HOUR);
  if (settings.away?.enabled && !isOpen(businessHoursOf(ctx.organization), now)) {
    if (recent(conversation.bot?.awayAt)) return null;
    await sendAnswer(conversation, settings.away.answer, ctx, BOT());
    await Conversation.updateOne({ _id: conversation._id }, { $set: { 'bot.awayAt': now, 'bot.lastAnsweredAt': now } });
    return 'away';
  }
  if (settings.greeting?.enabled && !recent(conversation.bot?.greetedAt)) {
    await sendAnswer(conversation, settings.greeting.answer, ctx, BOT());
    await Conversation.updateOne({ _id: conversation._id }, { $set: { 'bot.greetedAt': now, 'bot.lastAnsweredAt': now } });
    return 'greeting';
  }
  return null;
}

// Best effort: a bot problem never holds up sequences and workflows for the same message (and a
// retried job must not answer twice).
async function handleMessage(event) {
  try {
    return await respond(event);
  } catch (error) {
    logger.error(`FAQ bot failed for conversation ${event.conversationId}: ${error.message}`);
    return null;
  }
}

module.exports = { handleMessage, respond, matchesAny, HANDOFF_ID, RULE_PREFIX };
