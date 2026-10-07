const MessageTemplate = require('../models/MessageTemplate');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { normalizePhone } = require('../utils/phone');
const { providerFor } = require('../integrations/whatsapp');
const accountService = require('./whatsappAccountService');
const planService = require('./planService');

// WhatsApp message templates (Settings → WhatsApp → Templates, and the Inbox template picker).
// Meta's rules checked 2026-09-29 (Template API, template components, template messages):
// name = lower-case letters, digits and "_"; header ≤ 60 characters with at most one variable;
// body ≤ 1024; footer ≤ 60; button text ≤ 25; variables are {{1}}, {{2}} … (positional) or
// {{first_name}} (named), and every variable needs an example value.
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const NAMED = /^[a-z][a-z0-9_]*$/;
const SENDABLE_BUTTONS = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'];
// Template status webhook events that mean "can be sent again".
const BACK_TO_APPROVED = ['REINSTATED', 'UNARCHIVED'];

const placeholdersOf = (text) => [...new Set([...String(text || '').matchAll(PLACEHOLDER)].map((m) => m[1]))];
const upper = (value) => String(value || '').toUpperCase();
const fieldError = (field, message, code = 'INVALID_TEMPLATE') => httpError(400, 'VALIDATION_ERROR', message, [{ field, code, message }]);

// What a template is made of, in a form the page and the sender can use. withDocument: the
// caller has a PDF for a DOCUMENT header (a quotation); the inbox has none.
function shapeOf(template, { withDocument = false } = {}) {
  const components = Array.isArray(template.components) ? template.components : [];
  const find = (type) => components.find((c) => upper(c?.type) === type) || null;
  const header = find('HEADER');
  const body = find('BODY');
  const footer = find('FOOTER');
  const buttons = (find('BUTTONS')?.buttons || []).map((button, index) => ({
    index, type: upper(button.type), text: String(button.text || ''), url: button.url || '', phoneNumber: button.phone_number || '',
    variables: upper(button.type) === 'URL' ? placeholdersOf(button.url) : [],
  }));
  const headerFormat = header ? upper(header.format || 'TEXT') : '';
  const shape = {
    header: header ? { format: headerFormat, text: headerFormat === 'TEXT' ? String(header.text || '') : '', variables: headerFormat === 'TEXT' ? placeholdersOf(header.text) : [] } : null,
    body: { text: String(body?.text || ''), variables: placeholdersOf(body?.text) },
    footer: footer ? String(footer.text || '') : '',
    buttons,
  };

  const documentHeader = headerFormat === 'DOCUMENT';
  let notSendableReason = '';
  if (template.status !== 'APPROVED') notSendableReason = `Meta has not approved this template (status: ${template.status || 'unknown'}).`;
  else if (upper(template.category) === 'AUTHENTICATION') notSendableReason = 'Authentication (one-time code) templates are not sent from the inbox.';
  else if (documentHeader && !withDocument) notSendableReason = 'This template carries a PDF: send it from a quotation (Quotations → Send on WhatsApp).';
  else if (header && headerFormat !== 'TEXT' && !documentHeader) notSendableReason = 'Templates with a photo, video or location header cannot be sent from the CRM yet.';
  else if (buttons.some((b) => !SENDABLE_BUTTONS.includes(b.type) || b.variables.length > 1)) notSendableReason = 'This template has a button type the CRM cannot fill in yet.';
  else if (!body) notSendableReason = 'This template has no message text.';
  return { ...shape, documentHeader, sendable: !notSendableReason, notSendableReason };
}

function serializeTemplate(template) {
  const shape = shapeOf(template);
  return {
    id: template._id,
    accountId: template.whatsappAccountId,
    name: template.name,
    language: template.language,
    category: template.category,
    status: template.status,
    parameterFormat: template.parameterFormat,
    rejectedReason: template.rejectedReason,
    qualityScore: template.qualityScore,
    header: shape.header,
    body: shape.body,
    footer: shape.footer,
    buttons: shape.buttons,
    documentHeader: shape.documentHeader,
    sendable: shape.sendable,
    notSendableReason: shape.notSendableReason,
    lastSyncedAt: template.lastSyncedAt || null,
    updatedAt: template.updatedAt,
  };
}

async function accountFor(req, accountId) {
  const account = accountId
    ? await accountService.findInOrg(req, accountId)
    : await accountService.defaultAccount(req.tenant.organizationId);
  if (!account) throw httpError(400, 'NO_WHATSAPP_NUMBER', 'Add a WhatsApp number in Settings → WhatsApp first.');
  if (account.provider !== 'mock' && !account.wabaId) {
    throw httpError(400, 'WABA_ID_MISSING', 'Add the WhatsApp Business Account ID of this number in Settings → WhatsApp first (templates belong to it).');
  }
  return account;
}
const credentialsOf = (account) => ({ ...accountService.credentials(account), wabaId: account.wabaId });

// status: e.g. APPROVED (the inbox picker asks only for those).
async function list(req, { accountId, status } = {}) {
  const accounts = await WhatsAppAccount.find({ organizationId: req.tenant.organizationId }).select('_id');
  const filter = { organizationId: req.tenant.organizationId, whatsappAccountId: { $in: accounts.map((a) => a._id) } };
  if (accountId) filter.whatsappAccountId = accountId;
  if (status) filter.status = upper(status);
  const templates = await MessageTemplate.find(filter).sort({ name: 1, language: 1 });
  return templates.map(serializeTemplate);
}

// Brings the number's templates in line with Meta: new and changed ones are saved, templates
// no longer at Meta are removed here.
async function sync(req, { accountId } = {}) {
  const account = await accountFor(req, accountId);
  const remote = await providerFor(account).listTemplates(credentialsOf(account));
  const now = new Date();
  const kept = [];
  for (const template of remote) {
    if (!template.name || !template.language) continue;
    const saved = await MessageTemplate.findOneAndUpdate(
      { organizationId: account.organizationId, whatsappAccountId: account._id, name: template.name, language: template.language },
      { $set: { ...template, lastSyncedAt: now } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    kept.push(saved._id);
  }
  const removed = await MessageTemplate.deleteMany({ organizationId: account.organizationId, whatsappAccountId: account._id, _id: { $nin: kept } });
  await audit(req, { action: 'whatsapp.templates.synced', entityType: 'WhatsAppAccount', entityId: account._id, changes: { count: kept.length, removed: removed.deletedCount } });
  return list(req, { accountId: account._id });
}

// --- creating a template ------------------------------------------------------------
function variableFormat(headerVars, bodyVars) {
  const all = [...headerVars, ...bodyVars];
  if (!all.length) return 'POSITIONAL';
  if (all.every((v) => /^\d+$/.test(v))) return 'POSITIONAL';
  if (all.every((v) => NAMED.test(v))) return 'NAMED';
  throw fieldError('bodyText', 'Use either numbers ({{1}}, {{2}}) or names ({{customer_name}}) for all variables, not both. Names use lower-case letters, digits and "_".');
}

function checkPositional(vars, field) {
  const numbers = vars.map(Number).sort((a, b) => a - b);
  if (numbers.some((n, i) => n !== i + 1)) throw fieldError(field, 'Number the variables {{1}}, {{2}}, {{3}} … without gaps.');
}

function exampleFor(examples, name, field) {
  const value = String(examples?.[name] ?? '').trim();
  if (!value) throw fieldError(field, `Give an example value for {{${name}}} (Meta reviews templates with examples).`, 'EXAMPLE_REQUIRED');
  return value;
}

// body: { accountId?, name, language, category, headerText?, headerExample?, bodyText,
// bodyExamples?, footerText?, buttons? } → Meta's template object.
function buildTemplate(body) {
  const headerVars = placeholdersOf(body.headerText);
  const bodyVars = placeholdersOf(body.bodyText);
  if (headerVars.length > 1) throw fieldError('headerText', 'The header can have only one variable.');
  if (placeholdersOf(body.footerText).length) throw fieldError('footerText', 'The footer cannot have variables.');
  if ((body.buttons || []).some((b) => placeholdersOf(b.url).length)) throw fieldError('buttons', 'Links with variables are not supported here yet; use a fixed link.');
  const format = variableFormat(headerVars, bodyVars);
  if (format === 'POSITIONAL') {
    checkPositional(headerVars, 'headerText');
    checkPositional(bodyVars, 'bodyText');
  }
  const trimmedBody = body.bodyText.trim();
  if (bodyVars.length && (/^\{\{[^}]+\}\}/.test(trimmedBody) || /\{\{[^}]+\}\}$/.test(trimmedBody))) {
    throw fieldError('bodyText', 'Meta does not accept a message that starts or ends with a variable. Add some words before and after it.');
  }

  const components = [];
  if (body.headerText) {
    const header = { type: 'HEADER', format: 'TEXT', text: body.headerText };
    if (headerVars.length) {
      const value = exampleFor({ [headerVars[0]]: body.headerExample }, headerVars[0], 'headerExample');
      header.example = format === 'NAMED' ? { header_text_named_params: [{ param_name: headerVars[0], example: value }] } : { header_text: [value] };
    }
    components.push(header);
  }
  const bodyComponent = { type: 'BODY', text: body.bodyText };
  if (bodyVars.length) {
    const ordered = format === 'NAMED' ? bodyVars : [...bodyVars].sort((a, b) => Number(a) - Number(b));
    const values = ordered.map((name) => exampleFor(body.bodyExamples, name, 'bodyExamples'));
    bodyComponent.example = format === 'NAMED'
      ? { body_text_named_params: ordered.map((name, i) => ({ param_name: name, example: values[i] })) }
      : { body_text: [values] };
  }
  components.push(bodyComponent);
  if (body.footerText) components.push({ type: 'FOOTER', text: body.footerText });
  if (body.buttons?.length) {
    // WhatsApp wants quick replies grouped together.
    const sorted = [...body.buttons].sort((a, b) => (a.type === 'QUICK_REPLY' ? 0 : 1) - (b.type === 'QUICK_REPLY' ? 0 : 1));
    components.push({
      type: 'BUTTONS',
      buttons: sorted.map((button) => {
        if (button.type === 'URL') return { type: 'URL', text: button.text, url: button.url };
        if (button.type === 'PHONE_NUMBER') {
          const phone = normalizePhone(button.phoneNumber);
          if (!phone) throw fieldError('buttons', `"${button.text}": use a phone number with the country code, e.g. +91 98290 12345.`);
          return { type: 'PHONE_NUMBER', text: button.text, phone_number: phone.slice(1) };
        }
        return { type: 'QUICK_REPLY', text: button.text };
      }),
    });
  }
  return { name: body.name, language: body.language, category: body.category, parameter_format: format, components };
}

async function create(req, body) {
  await planService.assertRoom(req.tenant.organizationId, 'templates', { action: 'add message templates' });
  const account = await accountFor(req, body.accountId);
  const template = buildTemplate(body);
  if (await MessageTemplate.exists({ organizationId: account.organizationId, whatsappAccountId: account._id, name: template.name, language: template.language })) {
    throw httpError(409, 'TEMPLATE_EXISTS', 'This number already has a template with this name and language.');
  }
  const created = await providerFor(account).createTemplate(credentialsOf(account), template);
  const saved = await MessageTemplate.create({
    organizationId: account.organizationId,
    whatsappAccountId: account._id,
    providerTemplateId: created.providerTemplateId,
    name: template.name,
    language: template.language,
    category: upper(created.category || template.category),
    status: upper(created.status || 'PENDING'),
    parameterFormat: template.parameter_format,
    components: template.components,
    createdById: req.user._id,
  });
  await audit(req, { action: 'whatsapp.template.created', entityType: 'MessageTemplate', entityId: saved._id, changes: { name: saved.name, language: saved.language, category: saved.category } });
  return serializeTemplate(saved);
}

async function remove(req, id) {
  const template = await MessageTemplate.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!template) throw httpError(404, 'NOT_FOUND', 'Template not found');
  const account = await WhatsAppAccount.findOne({ _id: template.whatsappAccountId, organizationId: template.organizationId });
  if (account && (account.provider === 'mock' || account.wabaId)) {
    await providerFor(account).deleteTemplate(credentialsOf(account), { name: template.name, providerTemplateId: template.providerTemplateId });
  }
  await template.deleteOne();
  await audit(req, { action: 'whatsapp.template.deleted', entityType: 'MessageTemplate', entityId: template._id, changes: { name: template.name, language: template.language } });
}

async function findSendable(organizationId, id) {
  const template = await MessageTemplate.findOne({ _id: id, organizationId });
  if (!template) throw httpError(404, 'NOT_FOUND', 'Template not found');
  return template;
}

// --- sending --------------------------------------------------------------------
function checkValue(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw fieldError('variables', `Fill in ${label}.`, 'VARIABLE_REQUIRED');
  if (text.length > 1024) throw fieldError('variables', `${label} is too long (1024 characters at most).`);
  // WhatsApp refuses variables with line breaks, tabs or more than four spaces in a row.
  if (/[\n\t]/.test(text) || / {5,}/.test(text)) throw fieldError('variables', `${label} cannot have line breaks, tabs or long runs of spaces.`);
  return text;
}
const fill = (text, values) => String(text || '').replace(PLACEHOLDER, (match, name) => values[name] ?? match);

// variables: { header: { name: value }, body: { name: value }, buttons: { index: value } }.
// document: { id (uploaded media), filename } for a DOCUMENT header (PDF only, says Meta).
// Returns the Cloud API template object and the text shown in the chat.
function buildSend(template, variables = {}, { document } = {}) {
  const shape = shapeOf(template, { withDocument: Boolean(document) });
  if (!shape.sendable) throw httpError(422, 'TEMPLATE_NOT_SENDABLE', shape.notSendableReason);
  const named = template.parameterFormat === 'NAMED';
  const param = (name, text) => (named ? { type: 'text', parameter_name: name, text } : { type: 'text', text });
  const components = [];

  const headerValues = {};
  if (shape.documentHeader) {
    components.push({ type: 'header', parameters: [{ type: 'document', document: { id: document.id, filename: document.filename } }] });
  } else if (shape.header?.variables.length) {
    const name = shape.header.variables[0];
    headerValues[name] = checkValue(variables.header?.[name], `the header {{${name}}}`);
    components.push({ type: 'header', parameters: [param(name, headerValues[name])] });
  }
  const bodyValues = {};
  if (shape.body.variables.length) {
    const ordered = named ? shape.body.variables : [...shape.body.variables].sort((a, b) => Number(a) - Number(b));
    ordered.forEach((name) => {
      bodyValues[name] = checkValue(variables.body?.[name], `{{${name}}}`);
    });
    components.push({ type: 'body', parameters: ordered.map((name) => param(name, bodyValues[name])) });
  }
  shape.buttons.filter((b) => b.variables.length).forEach((button) => {
    const value = checkValue(variables.buttons?.[button.index], `the "${button.text}" button link`);
    components.push({ type: 'button', sub_type: 'url', index: String(button.index), parameters: [{ type: 'text', text: value }] });
  });

  const header = shape.header ? fill(shape.header.text, headerValues) : '';
  if (header.length > 60) throw fieldError('variables', 'The header is longer than 60 characters with this value.');
  const text = [header, fill(shape.body.text, bodyValues), shape.footer].filter(Boolean).join('\n\n');
  return {
    payload: { name: template.name, language: { code: template.language }, ...(components.length && { components }) },
    text,
    values: [...Object.values(headerValues), ...Object.values(bodyValues)],
  };
}

// Template status webhook (field message_template_status_update).
async function applyStatusUpdate(account, value) {
  const event = upper(value.event);
  const set = { lastSyncedAt: new Date() };
  if (event === 'FLAGGED') set.qualityScore = 'FLAGGED';
  else set.status = BACK_TO_APPROVED.includes(event) ? 'APPROVED' : event;
  if (value.reason && upper(value.reason) !== 'NONE') set.rejectedReason = String(value.reason).slice(0, 200);
  else if (set.status === 'APPROVED') set.rejectedReason = '';
  const result = await MessageTemplate.updateMany(
    { organizationId: account.organizationId, providerTemplateId: String(value.message_template_id) },
    { $set: set },
  );
  return result.matchedCount ? 'processed' : 'ignored';
}

module.exports = {
  list, sync, create, remove, findSendable, buildSend, buildTemplate, applyStatusUpdate, serializeTemplate, shapeOf, placeholdersOf,
};
