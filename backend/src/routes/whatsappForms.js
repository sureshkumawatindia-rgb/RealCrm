const express = require('express');
const forms = require('../services/whatsappFormService');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/whatsappForms');

// WhatsApp forms (G6, D110): owners and admins make and publish them; everyone on the Inbox sees
// the ones they can send (sending: POST /conversations/:id/form).
const router = express.Router();
const managers = requireRole('owner', 'admin');
const byId = validate({ params: idParams });
router.use(authenticate);

router.get('/', requirePermission('inbox', 'view'), async (req, res) => {
  res.json({ success: true, data: await forms.list(req) });
});
router.post('/', managers, validate({ body: schemas.create }), async (req, res) => {
  res.status(201).json({ success: true, data: await forms.create(req, req.valid.body), message: 'Form saved' });
});
router.patch('/:id', managers, validate({ params: idParams, body: schemas.update }), async (req, res) => {
  res.json({ success: true, data: await forms.update(req, req.valid.params.id, req.valid.body), message: 'Form saved' });
});
router.post('/:id/publish', managers, byId, async (req, res) => {
  res.json({ success: true, data: await forms.publish(req, req.valid.params.id) });
});
router.delete('/:id', managers, byId, async (req, res) => {
  res.json({ success: true, data: await forms.remove(req, req.valid.params.id), message: 'Form deleted' });
});

module.exports = router;
