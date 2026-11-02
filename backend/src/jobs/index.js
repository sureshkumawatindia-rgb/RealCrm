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
const push = require('../services/pushService');
const organizationDeletion = require('../services/organizationDeletionService');
const whatsappConnect = require('../services/whatsappConnectService');
const teamSummary = require('../services/teamSummaryService');
const usage = require('../services/usageService');
const outlook = require('../services/outlookService');
const teamsChannels = require('../services/teamsChannelService');
const gmailSync = require('../services/gmailSyncService');
const googleCalendar = require('../services/googleCalendarService');
const projects = require('../services/projectService');
const backups = require('../services/backupService');
const bulk = require('../services/bulkService');
const scheduledMessages = require('../services/scheduledMessageService');
const emails = require('../services/emailService');
const leadScores = require('../services/leadScoreService');
const ticketSla = require('../services/ticketSlaService');
const sheetSync = require('../services/sheetSyncService');

// Background jobs of the CRM. Each kind of job is defined next to the code it belongs to and
// registered here, so the server starts every handler before the worker begins taking jobs.
// leadRouting also starts assigning and auto-replying to every new enquiry; quotations marks
// sent quotations past their validity Expired (hourly); automation runs the workflows and
// sequences the follow-ups (Phase 6); broadcasts send WhatsApp campaigns (Phase 7); payment
// links handle gateway webhooks and check open links every 10 minutes, and the WhatsApp catalog
// syncs products daily and turns carts into orders (Phase 8); billing follows the plan subscriptions
// (webhooks, a check every 6 hours, trial reminders) and outbound webhooks send business events
// to the companies' own systems, lead stages to Meta's Conversions API, and the AI assistant answers
// customers when a company lets it (Phase 10); a WhatsApp Business app number connected with Meta's
// popup asks Meta for its contacts and chats (D60); owners get the evening team summary (D61);
// bulk actions on more than 200 leads or customers run row by row (D100); "send later" texts go at
// their time (D103); the platform's emails go through Resend (D104); open leads are scored hot,
// warm or cold after each reply, quotation view or order, and every day (D106); tickets past their
// SLA's first reply or resolution time are flagged every 5 minutes (D107); new leads and orders go
// to the companies' Google Sheets every 2 minutes (D108).
const definitions = [indiamart.register, leadWebhooks.register, leadRouting.attach, quotations.register, automation.register, sequences.register, broadcasts.register, paymentLinks.register, catalog.register, billing.register, outboundWebhooks.register, metaConversions.register, ai.register, push.register, organizationDeletion.register, whatsappConnect.register, teamSummary.register, usage.register, outlook.register, teamsChannels.register, gmailSync.register, googleCalendar.register, projects.register, backups.register, bulk.register, scheduledMessages.register, emails.register, leadScores.register, ticketSla.register, sheetSync.register];

function start(config) {
  definitions.forEach((register) => register(queue));
  queue.start(config);
  // Recurring pulls of active sources exist even if their job was lost (e.g. a restored database).
  indiamart.ensureSchedules(queue).catch((error) => logger.error(`Scheduling IndiaMART pulls failed: ${error.message}`));
  sheetSync.ensureSchedules().catch((error) => logger.error(`Scheduling Google Sheets failed: ${error.message}`));
}

module.exports = { start, stop: queue.stop, queue };
