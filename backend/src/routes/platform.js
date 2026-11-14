const express = require('express');
const platformService = require('../services/platformService');
const emailService = require('../services/emailService');
const helpService = require('../services/helpService');
const backups = require('../services/backupService');
const serviceStatus = require('../services/serviceStatusService');
const platformHealth = require('../services/platformHealthService');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/platform');

// The platform admin page (D104): only the emails in PLATFORM_ADMIN_EMAILS with the
// authenticator app, after a code on this login (30 minutes). Others get 404.
const router = express.Router();

router.use(authenticate);
router.get('/status', async (req, res) => {
  res.json({ success: true, data: await platformService.status(req) });
});
router.post('/unlock', authLimiter, validate({ body: schemas.unlock }), async (req, res) => {
  res.json({ success: true, data: await platformService.unlock(req, req.body), message: 'Platform admin page open for 30 minutes' });
});
router.post('/lock', async (req, res) => {
  res.json({ success: true, data: await platformService.lock(req) });
});

router.use(platformService.requireAdmin);
router.get('/overview', async (req, res) => {
  res.json({ success: true, data: await platformService.overview() });
});
router.get('/companies', validate({ query: schemas.companies }), async (req, res) => {
  res.json({ success: true, data: await platformService.companies(req.valid.query) });
});
router.post('/companies/:id/actions', validate({ params: idParams, body: schemas.action }), async (req, res) => {
  res.json({ success: true, data: await platformService.act(req, req.valid.params.id, req.body), message: 'Done' });
});
router.get('/emails', validate({ query: schemas.emails }), async (req, res) => {
  res.json({ success: true, data: await emailService.stats(req.valid.query) });
});
router.get('/checklist', async (req, res) => {
  res.json({ success: true, data: platformService.checklist() });
});
// D118: the support contact every company's help shows.
router.get('/support', async (req, res) => {
  res.json({ success: true, data: await helpService.getSupport() });
});
router.put('/support', validate({ body: schemas.support }), async (req, res) => {
  res.json({ success: true, data: await helpService.setSupport(req, req.body), message: 'Support contact saved' });
});

// D151: is everything working, what could not be processed, and notices (docs/RELIABILITY.md).
router.get('/health', async (req, res) => {
  res.json({ success: true, data: { ...(await serviceStatus.health()), ...(await platformHealth.problems()) } });
});
router.post('/health/inbound/retry', async (req, res) => {
  res.json({ success: true, data: await platformHealth.retryInbound(req), message: 'Trying them again' });
});
router.post('/health/jobs/:id/retry', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await platformHealth.retryJob(req, req.valid.params.id), message: 'Trying it again' });
});
router.post('/notices', validate({ body: schemas.notice }), async (req, res) => {
  res.status(201).json({ success: true, data: await serviceStatus.postNotice(req, req.body), message: 'Notice posted' });
});
router.post('/incidents/:id/end', validate({ params: idParams }), async (req, res) => {
  await serviceStatus.endIncident(req, req.valid.params.id);
  res.json({ success: true, data: { ended: true }, message: 'Ended' });
});

// D120: the backups and the restore drill (docs/DATA_TRUST.md).
router.get('/backups', async (req, res) => {
  res.json({ success: true, data: await backups.status() });
});
router.post('/backups/drill', async (req, res) => {
  if (!backups.configured()) throw httpError(409, 'BACKUPS_NOT_SET_UP', 'Backups are not set up: R2_BACKUP_BUCKET and its keys are needed first.');
  const { started } = await backups.startDrill(req.user.email);
  if (started) await audit(req, { action: 'platform.restore_drill_started', entityType: 'PlatformSetting', entityId: 'backupDrill' });
  res.status(202).json({ success: true, data: await backups.status(), message: started ? 'Restore drill started' : 'A restore drill is already running' });
});

module.exports = router;
