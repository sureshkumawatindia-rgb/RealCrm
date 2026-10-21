const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Touchpoint = require('../models/Touchpoint');
const logger = require('../config/logger');

// Where leads come from (Phase 2, D79). Every enquiry that reaches lead intake leaves a
// Touchpoint; a new lead keeps it as its first and last touch, a repeat enquiry on an open lead
// updates only the last one, and a customer keeps their first touch for good.

const MARKETPLACES = ['IndiaMART', 'JustDial', 'TradeIndia'];
const PAID = /^(cpc|ppc|paid|paid[ _-]?search|paid[ _-]?social|cpm|cpv|display|ads?|sem)$/i;
const SEARCH_HOSTS = /(^|\.)(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia)\.[a-z.]+$/i;
const SOCIAL_HOSTS = /(^|\.)(facebook|fb|instagram|linkedin|lnkd|twitter|x|t|youtube|youtu|pinterest|reddit|quora|threads|whatsapp|wa)\.(com|me|co|in|net|be)$/i;
const SOCIAL_NAMES = /^(facebook|fb|instagram|ig|meta|linkedin|twitter|x|youtube|pinterest|whatsapp|threads)$/i;
const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'];

const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);
// Only http(s) addresses, without the part after # (it never reaches a server anyway).
function cleanUrl(value) {
  const raw = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString().slice(0, 500);
  } catch {
    return '';
  }
}
const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

// What came with an enquiry → a clean touch. Tags missing from the input are read from the
// landing page's address (?utm_source=…&gclid=…), so an API call can just send the page.
function cleanTouch(input = {}) {
  const landingPage = cleanUrl(input.landingPage);
  let params = null;
  try {
    params = landingPage ? new URL(landingPage).searchParams : null;
  } catch {
    params = null;
  }
  const fromPage = (key) => text(params?.get(key));
  const utm = Object.fromEntries(UTM_KEYS.map((key) => [key, text(input.utm?.[key] ?? input[`utm_${key}`]) || fromPage(`utm_${key}`)]));
  return {
    utm,
    clickIds: { gclid: text(input.gclid ?? input.clickIds?.gclid) || fromPage('gclid'), fbclid: text(input.fbclid ?? input.clickIds?.fbclid) || fromPage('fbclid') },
    referrer: cleanUrl(input.referrer),
    landingPage,
    ad: { id: text(input.ad?.id), name: text(input.ad?.name), formName: text(input.ad?.formName), campaignId: text(input.ad?.campaignId) },
  };
}

// The channel of a touch: the ad platforms and marketplaces by their source; then click ids,
// campaign tags and the referrer; Direct when a website visit carries nothing.
function channelOf({ source, utm = {}, clickIds = {}, referrer = '' } = {}) {
  if (source === 'Facebook') return 'paid_social'; // Lead Ads
  if (source === 'Google Ads') return 'paid_search'; // lead form extensions
  if (MARKETPLACES.includes(source)) return 'marketplace';
  if (source === 'WhatsApp') return 'whatsapp';
  const medium = String(utm.medium || '').toLowerCase();
  const tagSource = String(utm.source || '').toLowerCase();
  if (clickIds.gclid) return 'paid_search';
  if (medium && PAID.test(medium)) return SOCIAL_NAMES.test(tagSource) ? 'paid_social' : 'paid_search';
  if (medium === 'email' || tagSource === 'newsletter') return 'email';
  if (medium === 'social' || medium === 'social-media' || SOCIAL_NAMES.test(tagSource) || clickIds.fbclid) return 'social';
  if (medium === 'organic') return 'organic_search';
  if (medium === 'referral' || tagSource) return 'referral';
  const host = hostOf(referrer);
  if (host) {
    if (SEARCH_HOSTS.test(host)) return 'organic_search';
    if (SOCIAL_HOSTS.test(host)) return 'social';
    return 'referral';
  }
  if (source === 'Website') return 'direct';
  return 'other';
}

// What a lead and a customer keep of a touch.
function summaryOf(touchpoint) {
  return {
    channel: touchpoint.channel,
    source: touchpoint.source,
    medium: touchpoint.utm?.medium || '',
    campaign: touchpoint.utm?.campaign || touchpoint.ad?.formName || touchpoint.ad?.campaignId || '',
    at: touchpoint.at,
  };
}

// Called by lead intake once the contact and the lead are known. Never stops an enquiry: a
// failure is logged.
// isNewLead: the lead was made by this enquiry (first and last touch); otherwise it was attached.
async function record({ organizationId, contactId, leadId, intakeId, source, touch, at = new Date(), isNewLead }) {
  try {
    const clean = cleanTouch(touch);
    const touchpoint = await Touchpoint.create({ organizationId, contactId, leadId, intakeId, source, channel: channelOf({ source, ...clean }), ...clean, at });
    const summary = summaryOf(touchpoint);
    if (leadId) {
      await Lead.updateOne({ _id: leadId, organizationId }, { $set: isNewLead ? { 'attribution.first': summary, 'attribution.last': summary } : { 'attribution.last': summary } });
    }
    // A customer's first touch never changes once it is there.
    await Contact.updateOne({ _id: contactId, organizationId, 'firstTouch.channel': { $exists: false } }, { $set: { firstTouch: summary } });
    return touchpoint;
  } catch (error) {
    logger.error(`Touchpoint for ${source} could not be saved: ${error.message}`);
    return null;
  }
}

function serialize(t) {
  return {
    id: t._id, source: t.source, channel: t.channel, utm: t.utm || {}, clickIds: t.clickIds || {}, referrer: t.referrer || '',
    landingPage: t.landingPage || '', ad: t.ad || {}, leadId: t.leadId || null, at: t.at,
  };
}

// GET /contacts/:id/touchpoints (the caller has checked the member may see the customer).
async function forContact(req, contact) {
  const items = await Touchpoint.find({ organizationId: req.tenant.organizationId, contactId: contact._id }).sort({ at: -1 }).limit(100);
  return { firstTouch: contact.firstTouch?.channel ? contact.firstTouch : null, items: items.map(serialize) };
}

module.exports = { cleanTouch, channelOf, summaryOf, record, forContact, serialize, MARKETPLACES };
