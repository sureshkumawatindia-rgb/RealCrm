const LeadSourceConnection = require('../models/LeadSourceConnection');
const Organization = require('../models/Organization');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const WidgetClick = require('../models/WidgetClick');
const env = require('../config/env');
const { businessHoursOf } = require('../utils/businessHours');
const { scriptFor } = require('../views/whatsappButton');
const { widgetSettings } = require('./leadSourceService');
const { originAllowed } = require('./publicFormService');

// The website's WhatsApp button (D102, Settings → Lead sources): the script a site includes
// (/api/v1/public/widget/<publicKey>/widget.js, the button drawn by views/whatsappButton.js) and
// the clicks it reports. The code in the click comes back in the customer's first WhatsApp
// message; services/whatsappInboundService.js turns it into the lead's source and page.

async function findButton(publicKey) {
  if (!/^[a-f0-9]{24}$/.test(String(publicKey || ''))) return null;
  return LeadSourceConnection.findOne({ publicKey, type: 'whatsapp_button' });
}

// The number the button opens: the chosen one, else the company's default.
async function accountOf(connection) {
  const { accountId } = widgetSettings(connection.settings);
  const filter = { organizationId: connection.organizationId };
  const chosen = accountId ? await WhatsAppAccount.findOne({ ...filter, _id: accountId }) : null;
  return chosen || WhatsAppAccount.findOne(filter).sort({ isDefault: -1, createdAt: 1 });
}

// The script, with the button's settings, the company's name and working hours in it. preview:
// for the Settings page (drawn there with the settings being edited), even while switched off.
async function script(connection, { preview = false } = {}) {
  if (connection.status !== 'active' && !preview) return '/* This WhatsApp button is switched off in the CRM. */\n';
  const [account, organization] = await Promise.all([accountOf(connection), Organization.findById(connection.organizationId).select('name businessHours')]);
  const phone = String(account?.displayPhone || '').replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(phone) && !preview) return '/* Add a WhatsApp number in the CRM (Settings → WhatsApp) first. */\n';
  const s = widgetSettings(connection.settings);
  const hours = businessHoursOf(organization);
  return scriptFor({
    phone,
    name: organization?.name || '',
    color: s.color,
    position: s.position,
    language: s.language,
    greeting: s.greeting,
    message: s.message,
    agentName: s.agentName,
    agentPhotoUrl: s.agentPhotoUrl,
    replyTime: s.replyTime,
    showHours: s.showHours,
    hours: { timezone: hours.timezone, days: hours.days, start: hours.start, end: hours.end },
    clickUrl: `${env.publicUrl}/api/v1/public/widget/${connection.publicKey}/click`,
  });
}

const link = (value) => (/^https?:\/\//i.test(String(value || '')) ? String(value).slice(0, 500) : '');
const cut = (value) => String(value || '').slice(0, 200);

// POST /public/widget/<key>/click (body: the validated beacon). Nothing is kept for a switched-off
// button or another website than the ones listed. A code sent twice is kept once.
async function recordClick(connection, body, { origin } = {}) {
  if (connection.status !== 'active' || !originAllowed(connection, origin)) return false;
  try {
    await WidgetClick.create({
      organizationId: connection.organizationId,
      connectionId: connection._id,
      code: body.code,
      page: link(body.page),
      referrer: link(body.referrer),
      utm: { source: cut(body.utm_source), medium: cut(body.utm_medium), campaign: cut(body.utm_campaign), term: cut(body.utm_term), content: cut(body.utm_content) },
      clickIds: { gclid: cut(body.gclid), fbclid: cut(body.fbclid) },
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  await LeadSourceConnection.updateOne({ _id: connection._id }, { $inc: { 'stats.received': 1 } }); // clicks
  return true;
}

module.exports = { findButton, accountOf, script, recordClick };
