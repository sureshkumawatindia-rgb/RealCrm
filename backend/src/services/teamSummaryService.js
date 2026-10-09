const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const logger = require('../config/logger');
const { indiaDate } = require('../utils/dates');
const reportService = require('./reportService');
const { notify } = require('./notificationService');

// The evening team summary (D61): at 7 pm India time, once a day, each company's owners get a
// bell note (and web push where they switched it on) with today's team in one line — replies,
// chats resolved, new leads, won, money collected, and who replied most. Nothing when nothing
// happened. The job runs every 15 minutes; Organization.teamSummarySentOn makes it once a day.
const JOB = 'reports.team-summary';
const SEND_FROM_HOUR_IST = 19;

const indiaHour = (now = new Date()) => Number(new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(11, 13));

async function sendForOrganization(organizationId, day) {
  // Claim the day first, so two workers (or a retry) never send it twice.
  const claimed = await Organization.findOneAndUpdate({ _id: organizationId, teamSummarySentOn: { $ne: day } }, { $set: { teamSummarySentOn: day } });
  if (!claimed) return false;
  const summary = await reportService.todaySummary(organizationId);
  if (!summary) return false;
  const owners = await OrganizationMember.find({ organizationId, role: 'owner', status: 'active' }).select('_id');
  await notify(organizationId, owners.map((owner) => owner._id), { title: summary.title, body: summary.body, link: 'team-live.html', source: 'team-summary' });
  return true;
}

async function run({ now } = {}) {
  const at = now ? new Date(now) : new Date();
  if (indiaHour(at) < SEND_FROM_HOUR_IST) return 0;
  const day = indiaDate(0, at);
  const due = await Organization.find({ teamSummarySentOn: { $ne: day } }).select('_id').limit(1000);
  let sent = 0;
  for (const organization of due) {
    try {
      if (await sendForOrganization(organization._id, day)) sent += 1;
    } catch (error) {
      logger.error(`Team summary for ${organization._id} failed: ${error.message}`);
    }
  }
  return sent;
}

function register(queue) {
  queue.define(JOB, () => run(), { maxAttempts: 3 });
  queue.every(JOB, 15 * 60 * 1000).catch((error) => logger.error(`Scheduling ${JOB} failed: ${error.message}`));
}

module.exports = { JOB, run, register, sendForOrganization };
