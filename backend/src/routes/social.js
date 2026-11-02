const express = require('express');
const Joi = require('joi');
const accounts = require('../services/socialAccountService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');

// Instagram and Messenger accounts (G8, D112): Settings → WhatsApp → "Instagram and Messenger",
// owners and admins. Their chats are in the Inbox (/conversations).
const router = express.Router();
router.use(authenticate, requireRole('owner', 'admin'));

router.get('/', async (req, res) => {
  res.json({ success: true, data: await accounts.list(req) });
});
// The code Facebook Login for Business gave the page (valid a few seconds).
router.post('/connect', validate({ body: Joi.object({ code: Joi.string().trim().min(10).max(2000).required() }) }), async (req, res) => {
  res.json({ success: true, data: await accounts.connect(req, req.valid.body), message: 'Instagram and Messenger connected' });
});
router.post('/test', async (req, res) => {
  res.status(201).json({ success: true, data: await accounts.connectTest(req), message: 'Test Page added' });
});
router.delete('/accounts/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await accounts.disconnect(req, req.valid.params.id), message: 'Disconnected' });
});

module.exports = router;
