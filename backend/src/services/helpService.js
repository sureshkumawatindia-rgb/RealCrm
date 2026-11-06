const PlatformSetting = require('../models/PlatformSetting');
const Organization = require('../models/Organization');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { normalizePhone } = require('../utils/phone');

// Help inside the CRM (100 phases, phase 6, D118, docs/HELP.md). The platform's own support
// contact — a WhatsApp number, an email and the hours someone answers — is set by a platform
// admin (Platform admin → Support) and shown in every company's help: the "?" box on each page
// and the help centre. Nothing set: no WhatsApp button.
const KEY = 'support';
const EMPTY = Object.freeze({ whatsapp: '', email: '', hours: '' });

async function contact() {
  const stored = await PlatformSetting.findOne({ key: KEY }).lean();
  const value = stored?.value || {};
  return { whatsapp: value.whatsapp || '', email: value.email || '', hours: value.hours || '' };
}

// GET /help/support — any member: the contact, and the company's name and workspace code for the
// message they send (so support knows who is asking).
async function support(req) {
  const [found, organization] = await Promise.all([
    contact(),
    Organization.findById(req.tenant.organizationId).select('name slug').lean(),
  ]);
  return { ...found, company: { name: organization?.name || '', code: organization?.slug || '' } };
}

// GET /platform/support — a platform admin.
const getSupport = () => contact();

// PUT /platform/support { whatsapp, email, hours } — a platform admin. The number is kept as
// +<country><number> (10 digits on their own are Indian); empty fields clear it.
async function setSupport(req, body) {
  const whatsapp = normalizePhone(body.whatsapp ?? '');
  if (whatsapp === null) throw httpError(400, 'VALIDATION_ERROR', 'That is not a phone number.', [{ field: 'whatsapp', code: 'INVALID_PHONE', message: 'Enter a mobile number, like 98290 12345 or +91 98290 12345.' }]);
  const value = { ...EMPTY, whatsapp, email: body.email || '', hours: body.hours || '' };
  await PlatformSetting.updateOne({ key: KEY }, { $set: { value } }, { upsert: true });
  // In the admin's own company, like the platform page's other actions.
  await audit(req, { action: 'platform.support_updated', entityType: 'PlatformSetting', entityId: KEY, changes: { whatsapp: Boolean(whatsapp), email: Boolean(value.email), hours: Boolean(value.hours) } });
  return value;
}

module.exports = { support, getSupport, setSupport };
