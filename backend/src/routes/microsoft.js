const express = require('express');
const microsoftService = require('../services/microsoftService');
const teamsChannelService = require('../services/teamsChannelService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/microsoft');

// Microsoft 365 (Phase 4B, D83).
//   /integrations/microsoft         each member's own connection (Settings → My profile)
//   /integrations/teams-channels    the company's Teams channel notes (owners and admins)
const microsoftRoutes = express.Router();
// Microsoft's redirect after sign-in, and the stand-in's "Accept" page in tests and development:
// no CRM sign-in here; the single-use state says whose sign-in it is.
microsoftRoutes.get('/callback', async (req, res) => {
  res.redirect(await microsoftService.callback(req.query));
});
microsoftRoutes.get('/mock-consent', (req, res) => {
  res.redirect(microsoftService.mockConsentRedirect(String(req.query.state || '')));
});
microsoftRoutes.get('/', authenticate, async (req, res) => {
  res.json({ success: true, data: await microsoftService.status(req) });
});
microsoftRoutes.post('/connect', authenticate, async (req, res) => {
  res.json({ success: true, data: await microsoftService.connect(req) });
});
microsoftRoutes.delete('/', authenticate, async (req, res) => {
  res.json({ success: true, data: await microsoftService.disconnect(req), message: 'Microsoft 365 disconnected' });
});

const teamsRoutes = express.Router();
teamsRoutes.use(authenticate, requireRole('owner', 'admin'));
teamsRoutes.get('/', async (req, res) => {
  res.json({ success: true, data: await teamsChannelService.list(req) });
});
teamsRoutes.post('/', validate({ body: schemas.teamsCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await teamsChannelService.create(req, req.body), message: 'Teams channel added' });
});
teamsRoutes.patch('/:id', validate({ params: idParams, body: schemas.teamsPatch }), async (req, res) => {
  res.json({ success: true, data: await teamsChannelService.update(req, req.valid.params.id, req.body) });
});
teamsRoutes.delete('/:id', validate({ params: idParams }), async (req, res) => {
  await teamsChannelService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Teams channel removed' });
});
teamsRoutes.post('/:id/test', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await teamsChannelService.test(req, req.valid.params.id) });
});

module.exports = { microsoftRoutes, teamsRoutes };
