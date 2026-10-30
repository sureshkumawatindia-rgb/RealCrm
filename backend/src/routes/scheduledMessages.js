const express = require('express');
const scheduledMessages = require('../services/scheduledMessageService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/inbox');

// "Send later" (D103): change or cancel a scheduled WhatsApp text (its writer, or an owner or
// admin). New ones are made in the chat: POST /conversations/:id/scheduled.
const router = express.Router();
const can = (action) => requirePermission('inbox', action);

router.use(authenticate);
router.patch('/:id', can('create'), validate({ params: idParams, body: schemas.schedulePatch }), async (req, res) => {
  res.json({ success: true, data: await scheduledMessages.update(req, req.valid.params.id, req.body), message: 'Scheduled message changed' });
});
router.delete('/:id', can('create'), validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await scheduledMessages.cancel(req, req.valid.params.id), message: 'Scheduled message cancelled' });
});

module.exports = router;
