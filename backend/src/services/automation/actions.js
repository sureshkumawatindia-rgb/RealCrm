const Contact = require('../../models/Contact');
const Conversation = require('../../models/Conversation');
const Lead = require('../../models/Lead');
const LeadActivity = require('../../models/LeadActivity');
const MessageTemplate = require('../../models/MessageTemplate');
const OrganizationMember = require('../../models/OrganizationMember');
const Task = require('../../models/Task');
const WhatsAppAccount = require('../../models/WhatsAppAccount');
const bus = require('../../realtime/bus');
const httpError = require('../../utils/httpError');
const { indiaDate } = require('../../utils/dates');
const { formatRupees } = require('../../utils/money');
const { callWebhook } = require('../../utils/safeWebhook');
const { isManager } = require('../../constants/permissions');
const templateService = require('../templateService');
const conversations = require('../conversationService');
const notifications = require('../notificationService');
const leadService = require('../leadService');

// What each workflow step does (Phase 6). Every action gets the run's context (the lead, the
// customer, the order … loaded fresh), returns { status: done | skipped, detail } for the run
// log, and throws for a failure (a 4xx httpError is final; anything else is retried by the job).
// Texts may use {{contact.name}}, {{lead.title}}, {{owner.name}}, {{order.number}} … (fill()).
const done = (detail) => ({ status: 'done', detail });
const skipped = (detail) => ({ status: 'skipped', detail });

const PLACEHOLDER = /\{\{\s*([a-z]+)\.([a-zA-Z]+)\s*\}\}/g;
function valuesOf(ctx) {
  return {
    contact: { name: ctx.contact?.name, company: ctx.contact?.company, city: ctx.contact?.city, phone: ctx.contact?.phone || ctx.contact?.phoneE164 },
    lead: { title: ctx.lead?.title, stage: ctx.lead?.stage, source: ctx.lead?.source, product: ctx.lead?.title },
    owner: { name: ctx.ownerName },
    org: { name: ctx.organization?.name },
    order: { number: ctx.order?.number, stage: ctx.order?.stage, total: ctx.order ? formatRupees(ctx.order.totals?.grandTotalPaise) : '' },
    quotation: { number: ctx.quotation?.number, total: ctx.quotation ? formatRupees(ctx.quotation.totals?.grandTotalPaise) : '' },
    task: { title: ctx.task?.title, due: ctx.task?.dueDate },
    message: { text: ctx.event?.text },
  };
}
function fill(text, ctx) {
  const values = valuesOf(ctx);
  return String(text || '').replace(PLACEHOLDER, (match, group, key) => String(values[group]?.[key] ?? ''));
}

// What fills a template variable: a CRM value, or fixed words ("text:…").
const VARIABLE_VALUES = ['contact.name', 'contact.company', 'contact.city', 'lead.product', 'owner.name', 'org.name', 'order.number', 'quotation.number'];
function resolveVariables(variables = {}, ctx) {
  const values = valuesOf(ctx);
  const valueOf = (spec) => {
    const text = String(spec || '');
    if (text.startsWith('text:')) return fill(text.slice(5), ctx);
    const [group, key] = text.split('.');
    return String(values[group]?.[key] ?? '');
  };
  return Object.fromEntries(['header', 'body', 'buttons'].map((part) => [part, Object.fromEntries(Object.entries(variables[part] || {}).map(([name, spec]) => [name, valueOf(spec)]))]));
}

async function activity(ctx, workflow, type, text) {
  if (!ctx.lead) return;
  await LeadActivity.create({ organizationId: ctx.lead.organizationId, leadId: ctx.lead._id, contactId: ctx.lead.contactId, type, text, actorName: `Automation "${workflow.name}"` });
}

// The customer's latest chat (any number).
async function latestChat(ctx) {
  if (!ctx.contact) return null;
  if (ctx.conversation) return ctx.conversation;
  return Conversation.findOne({ organizationId: ctx.contact.organizationId, contactId: ctx.contact._id }).sort({ lastMessageAt: -1, updatedAt: -1 });
}

const memberName = (member) => member?.displayName || member?.userId?.name || 'a teammate';

const ACTIONS = {
  async 'whatsapp.text'({ ctx, params, workflow }) {
    if (!ctx.contact?.phoneE164) return skipped('The customer has no mobile number.');
    const conversation = await latestChat(ctx);
    if (!conversation) return skipped('There is no WhatsApp chat with this customer yet (a template step can start one).');
    if (!conversations.serviceWindow(conversation).open) return skipped('The customer has not written in the last 24 hours, so only a template may go.');
    const text = fill(params.text, ctx).trim();
    if (!text) return skipped('The message came out empty.');
    const message = await conversations.sendTextAutomatically({ conversation, text, automation: { kind: 'workflow', ruleId: workflow._id } });
    if (message.status === 'failed') throw httpError(422, 'WHATSAPP_REFUSED', `WhatsApp refused it: ${message.error?.message || 'unknown reason'}`);
    await activity(ctx, workflow, 'Automation', `WhatsApp message sent: "${text.slice(0, 120)}"`);
    return done(`Sent "${text.slice(0, 80)}"`);
  },

  async 'whatsapp.template'({ ctx, params, workflow }) {
    if (!ctx.contact?.phoneE164) return skipped('The customer has no mobile number.');
    const template = await MessageTemplate.findOne({ _id: params.templateId, organizationId: workflow.organizationId });
    if (!template) throw httpError(422, 'TEMPLATE_GONE', 'The template was removed.');
    const shape = templateService.shapeOf(template);
    if (!shape.sendable) throw httpError(422, 'TEMPLATE_NOT_SENDABLE', shape.notSendableReason);
    if (template.category === 'MARKETING' && ctx.contact.consent?.marketing === 'opted_out') return skipped('The customer opted out of marketing messages.');
    const account = await WhatsAppAccount.findOne({ _id: template.whatsappAccountId, organizationId: workflow.organizationId });
    if (!account) throw httpError(422, 'NUMBER_REMOVED', 'The template\'s WhatsApp number was removed.');
    const conversation = await conversations.ensureConversation({ organizationId: workflow.organizationId, contactId: ctx.contact._id, accountId: account._id, assigneeId: ctx.lead?.ownerId || null });
    const message = await conversations.sendTemplateAutomatically({ conversation, template, variables: resolveVariables(params.variables, ctx), automation: { kind: 'workflow', ruleId: workflow._id } });
    if (message.status === 'failed') throw httpError(422, 'WHATSAPP_REFUSED', `WhatsApp refused it: ${message.error?.message || 'unknown reason'}`);
    await activity(ctx, workflow, 'Automation', `WhatsApp template "${template.name}" sent`);
    return done(`Sent template "${template.name}"`);
  },

  async assign({ ctx, params, workflow }) {
    if (!ctx.lead) return skipped('There is no lead to give.');
    const member = await OrganizationMember.findOne({ _id: params.memberId, organizationId: workflow.organizationId, status: 'active' }).populate('userId', 'name');
    if (!member) throw httpError(422, 'MEMBER_GONE', 'That person is no longer an active team member.');
    if (!isManager(member) && !member.modules?.some((m) => m === 'leads' || m === 'deals')) throw httpError(422, 'MEMBER_NO_LEADS', `${memberName(member)} cannot open Leads.`);
    if (String(ctx.lead.ownerId) === String(member._id)) return skipped(`The lead is already ${memberName(member)}'s.`);
    await Lead.updateOne({ _id: ctx.lead._id }, { $set: { ownerId: member._id }, $inc: { version: 1 } });
    await Contact.updateOne({ _id: ctx.lead.contactId, ownerId: null }, { $set: { ownerId: member._id } });
    const chats = await Conversation.find({ organizationId: workflow.organizationId, contactId: ctx.lead.contactId, assigneeId: null });
    for (const chat of chats) {
      const assigned = await Conversation.findOneAndUpdate({ _id: chat._id, assigneeId: null }, { $set: { assigneeId: member._id } }, { returnDocument: 'after' });
      if (assigned) bus.emit('conversation:updated', { organizationId: workflow.organizationId, conversation: assigned, previousAssigneeId: null });
    }
    await activity(ctx, workflow, 'Assigned', `Assigned to ${memberName(member)} by automation "${workflow.name}"`);
    return done(`Given to ${memberName(member)}`);
  },

  async 'tag.add'({ ctx, params }) {
    if (!ctx.contact) return skipped('There is no customer to tag.');
    const tag = String(params.tag).trim();
    if ((ctx.contact.tags || []).some((t) => t.toLowerCase() === tag.toLowerCase())) return skipped(`Already tagged "${tag}".`);
    await Contact.updateOne({ _id: ctx.contact._id }, { $addToSet: { tags: tag } });
    return done(`Tagged "${tag}"`);
  },

  async 'tag.remove'({ ctx, params }) {
    if (!ctx.contact) return skipped('There is no customer.');
    const tag = String(params.tag).trim().toLowerCase();
    const current = (ctx.contact.tags || []).filter((t) => t.toLowerCase() === tag);
    if (!current.length) return skipped(`Not tagged "${params.tag}".`);
    await Contact.updateOne({ _id: ctx.contact._id }, { $pull: { tags: { $in: current } } });
    return done(`Tag "${params.tag}" removed`);
  },

  async 'stage.change'({ ctx, params, req }) {
    if (!ctx.lead) return skipped('There is no lead to move.');
    if (ctx.lead.stage === params.stage) return skipped(`The lead is already at ${params.stage}.`);
    // Through the lead service: the probability, the customer on Won, the timeline and the
    // "stage changed" event (with this run in its chain) all happen as for a person.
    await leadService.update(req, ctx.lead._id, { stage: params.stage, ...(params.lostReason && { lostReason: params.lostReason }) });
    return done(`${ctx.lead.stage} → ${params.stage}`);
  },

  async 'task.create'({ ctx, params, workflow }) {
    let assigneeId = params.assignTo === 'owner' ? ctx.lead?.ownerId : params.assignTo;
    if (assigneeId && !(await OrganizationMember.exists({ _id: assigneeId, organizationId: workflow.organizationId, status: 'active' }))) assigneeId = undefined;
    const related = ctx.lead
      ? { relatedType: 'Lead', relatedId: ctx.lead._id, relatedName: ctx.contact?.name || ctx.lead.title }
      : ctx.contact ? { relatedType: 'Customer', relatedId: ctx.contact._id, relatedName: ctx.contact.name } : {};
    const task = await Task.create({
      organizationId: workflow.organizationId,
      title: fill(params.title, ctx).slice(0, 300) || 'Follow up',
      description: [fill(params.description || '', ctx), `Created by automation "${workflow.name}"`].filter(Boolean).join('\n\n'),
      assigneeId,
      dueDate: indiaDate(Number(params.dueInDays) || 0),
      priority: params.priority || 'Medium',
      status: 'To Do',
      origin: 'automation',
      ...related,
    });
    await activity(ctx, workflow, 'Automation', `Task "${task.title}" created`);
    return done(`Task "${task.title}" due ${task.dueDate}`);
  },

  async 'agent.notify'({ ctx, params, workflow }) {
    let to = [];
    if (params.to === 'owner' && ctx.lead?.ownerId) to = [ctx.lead.ownerId];
    else if (params.to === 'owner' && ctx.task?.assigneeId) to = [ctx.task.assigneeId];
    else if (params.to === 'owner' || params.to === 'managers') {
      to = (await OrganizationMember.find({ organizationId: workflow.organizationId, status: 'active', role: { $in: ['owner', 'admin'] } }).select('_id')).map((m) => m._id);
    } else to = [params.to];
    const link = ctx.conversation ? `Inbox.html?c=${ctx.conversation._id}`
      : ctx.order ? `Orders.html?id=${ctx.order._id}`
        : ctx.quotation ? `Quotations.html?id=${ctx.quotation._id}`
          : ctx.contact ? `customer-360.html?id=${ctx.contact._id}`
            : ctx.task ? 'Tasks.html' : '';
    const sent = await notifications.notify(workflow.organizationId, to, {
      title: fill(params.message, ctx).slice(0, 200) || workflow.name,
      body: [ctx.contact?.name, ctx.lead && `${ctx.lead.title} · ${ctx.lead.stage}`].filter(Boolean).join(' — '),
      link,
      source: `workflow:${workflow._id}`,
    });
    if (!sent.length) return skipped('Nobody active to notify.');
    return done(`Notified ${sent.length} ${sent.length === 1 ? 'person' : 'people'}`);
  },

  async 'webhook.call'({ ctx, params, workflow, run }) {
    const pick = (doc, fields) => (doc ? Object.fromEntries(fields.map((f) => [f, doc[f] ?? null])) : null);
    const payload = {
      event: run.trigger,
      at: new Date().toISOString(),
      workflow: { id: String(workflow._id), name: workflow.name },
      run: { id: String(run._id) },
      lead: ctx.lead ? { id: String(ctx.lead._id), ...pick(ctx.lead, ['title', 'stage', 'source']), ownerId: ctx.lead.ownerId ? String(ctx.lead.ownerId) : null } : null,
      contact: ctx.contact ? { id: String(ctx.contact._id), ...pick(ctx.contact, ['name', 'phoneE164', 'email', 'company', 'city', 'state', 'tags']) } : null,
      order: ctx.order ? { id: String(ctx.order._id), number: ctx.order.number, stage: ctx.order.stage, totalPaise: ctx.order.totals?.grandTotalPaise } : null,
      quotation: ctx.quotation ? { id: String(ctx.quotation._id), number: ctx.quotation.number, status: ctx.quotation.status, totalPaise: ctx.quotation.totals?.grandTotalPaise } : null,
      task: ctx.task ? { id: String(ctx.task._id), title: ctx.task.title, dueDate: ctx.task.dueDate } : null,
      message: ctx.event?.text ? { text: ctx.event.text } : null,
    };
    const { status } = await callWebhook(params.url, payload, workflow.webhookSecret);
    return done(`${new URL(params.url).host} answered ${status}`);
  },
};

module.exports = { ACTIONS, fill, resolveVariables, VARIABLE_VALUES };
