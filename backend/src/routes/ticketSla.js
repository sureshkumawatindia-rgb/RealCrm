const express = require('express');
const ticketSla = require('../services/ticketSlaService');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const schemas = require('../validators/crm');

// Ticket SLA (G3, D107): how soon tickets get a first reply and are resolved, by priority. Everyone
// on Support may read the limits (the page shows the due times); owners and admins change them.
const router = express.Router();
router.use(authenticate);

router.get('/', requirePermission('support', 'view'), async (req, res) => {
  res.json({ success: true, data: await ticketSla.get(req) });
});
router.patch('/', requireRole('owner', 'admin'), validate({ body: schemas.ticketSla }), async (req, res) => {
  res.json({ success: true, data: await ticketSla.update(req, req.valid.body), message: 'SLA saved' });
});

module.exports = router;
