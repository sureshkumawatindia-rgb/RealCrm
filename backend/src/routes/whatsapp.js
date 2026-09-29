const express = require('express');
const accountService = require('../services/whatsappAccountService');
const clickToChat = require('../services/clickToChatService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/whatsapp');

// Settings → WhatsApp: connecting numbers is for owners and admins.
const router = express.Router();
router.use(authenticate, requireRole('owner', 'admin'));

router.get('/accounts', async (req, res) => {
  res.json({ success: true, data: await accountService.list(req) });
});
router.post('/accounts', validate({ body: schemas.accountCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await accountService.create(req, req.body), message: 'WhatsApp number added' });
});
router.patch('/accounts/:id', validate({ params: idParams, body: schemas.accountPatch }), async (req, res) => {
  res.json({ success: true, data: await accountService.update(req, req.valid.params.id, req.body), message: 'WhatsApp number updated' });
});
router.post('/accounts/:id/test', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await accountService.test(req, req.valid.params.id) });
});
router.delete('/accounts/:id', validate({ params: idParams }), async (req, res) => {
  await accountService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'WhatsApp number removed' });
});

// Click-to-chat link + QR code for a number (?accountId=&text=).
router.get('/click-to-chat', validate({ query: schemas.clickToChat }), async (req, res) => {
  res.json({ success: true, data: await clickToChat.link(req, req.valid.query) });
});
router.get('/click-to-chat/qr.png', validate({ query: schemas.clickToChat }), async (req, res) => {
  const png = await clickToChat.png(req, req.valid.query);
  res.attachment('whatsapp-qr.png');
  res.type('image/png');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(png);
});

module.exports = router;
