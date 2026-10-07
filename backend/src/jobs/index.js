const queue = require('./queue');
const logger = require('../config/logger');
const indiamart = require('../services/indiamartService');
const leadWebhooks = require('../services/leadWebhookService');
const leadRouting = require('../services/leadRoutingService');
const quotations = require('../services/quotationService');
const automation = require('../services/automation/engine');
const sequences = require('../services/automation/sequences');
const broadcasts = require('../services/broadcastService');
const paymentLinks = require('../services/paymentLinkService');
const catalog = require('../services/catalogService');
const billing = require('../services/billingService');
const outboundWebhooks = require('../services/outboundWebhookService');
const metaConversions = require('../services/metaConversionsService');
const ai = require('../services/aiService');

// Background jobs of the CRM. Each kind of job is defined next to the code it belongs to and
// registered here, so the server starts every handler before the worker begins taking jobs.
// leadRouting also starts assigning and auto-replying to every new enquiry; quotations marks
// sent quotations past their validity Expired (hourly); automation runs the workflows and
// sequences the follow-ups (Phase 6); broadcasts send WhatsApp campaigns (Phase 7); payment
// links handle gateway webhooks and check open links every 10 minutes, and the WhatsApp catalog
// syncs products daily and turns carts into orders (Phase 8); billing follows the plan subscriptions
// (webhooks, a check every 6 hours, trial reminders) and outbound webhooks send business events
// to the companies' own systems, lead stages to Meta's Conversions API, and the AI assistant answers
// customers when a company lets it (Phase 10).
const definitions = [indiamart.register, leadWebhooks.register, leadRouting.attach, quotations.register, automation.register, sequences.register, broadcasts.register, paymentLinks.register, catalog.register, billing.register, outboundWebhooks.register, metaConversions.register, ai.register];

function start(config) {
  definitions.forEach((register) => register(queue));
  queue.start(config);
  // Recurring pulls of active sources exist even if their job was lost (e.g. a restored database).
  indiamart.ensureSchedules(queue).catch((error) => logger.error(`Scheduling IndiaMART pulls failed: ${error.message}`));
}

module.exports = { start, stop: queue.stop, queue };
