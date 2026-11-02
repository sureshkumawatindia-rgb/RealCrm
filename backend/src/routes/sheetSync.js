const express = require('express');
const sheetSync = require('../services/sheetSyncService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const schemas = require('../validators/google');

// Google Sheets (G4, D108): the company's new leads or orders go to a Google Sheet by themselves.
// Owners and admins only: the sheets get every lead or order of the company.
const router = express.Router();
const managers = requireRole('owner', 'admin');
const byKind = validate({ params: schemas.sheetSyncKind });
router.use(authenticate);

router.get('/', managers, async (req, res) => {
  res.json({ success: true, data: await sheetSync.list(req) });
});
router.post('/', managers, validate({ body: schemas.sheetSyncStart }), async (req, res) => {
  res.status(201).json({ success: true, data: await sheetSync.start(req, req.valid.body), message: 'Sheet made' });
});
router.post('/:kind/resume', managers, byKind, async (req, res) => {
  res.json({ success: true, data: await sheetSync.resume(req, req.valid.params.kind), message: 'Sheet resumed' });
});
router.delete('/:kind', managers, byKind, async (req, res) => {
  res.json({ success: true, data: await sheetSync.stop(req, req.valid.params.kind), message: 'Sheet stopped' });
});

module.exports = router;
