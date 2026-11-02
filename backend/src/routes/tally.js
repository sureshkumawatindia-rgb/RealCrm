const express = require('express');
const tally = require('../services/tallyService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const schemas = require('../validators/tally');

// Tally (G5, D109): tax invoices, credit notes and receipts as Tally import XML. Owners and admins:
// the files hold every invoice and payment of the company.
const router = express.Router();
const managers = requireRole('owner', 'admin');
router.use(authenticate);

router.get('/', managers, validate({ query: schemas.range }), async (req, res) => {
  res.json({ success: true, data: await tally.get(req, req.valid.query) });
});
router.patch('/', managers, validate({ body: schemas.settings }), async (req, res) => {
  res.json({ success: true, data: await tally.update(req, req.valid.body), message: 'Tally ledgers saved' });
});
router.get('/export', managers, validate({ query: schemas.export }), async (req, res) => {
  const { fileName, body } = await tally.exportXml(req, req.valid.query);
  res.attachment(fileName);
  res.type('application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(body);
});

module.exports = router;
