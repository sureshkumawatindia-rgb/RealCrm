const queue = require('./queue');
const logger = require('../config/logger');
const indiamart = require('../services/indiamartService');
const leadWebhooks = require('../services/leadWebhookService');
const leadRouting = require('../services/leadRoutingService');
const quotations = require('../services/quotationService');

// Background jobs of the CRM. Each kind of job is defined next to the code it belongs to and
// registered here, so the server starts every handler before the worker begins taking jobs.
// leadRouting also starts assigning and auto-replying to every new enquiry; quotations marks
// sent quotations past their validity Expired (hourly).
const definitions = [indiamart.register, leadWebhooks.register, leadRouting.attach, quotations.register];

function start(config) {
  definitions.forEach((register) => register(queue));
  queue.start(config);
  // Recurring pulls of active sources exist even if their job was lost (e.g. a restored database).
  indiamart.ensureSchedules(queue).catch((error) => logger.error(`Scheduling IndiaMART pulls failed: ${error.message}`));
}

module.exports = { start, stop: queue.stop, queue };
