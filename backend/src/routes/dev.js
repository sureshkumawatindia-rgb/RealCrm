const crypto = require('crypto');
const express = require('express');
const env = require('../config/env');
const Message = require('../models/Message');
const accountService = require('../services/whatsappAccountService');
const inbound = require('../services/whatsappInboundService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const httpError = require('../utils/httpError');
const { normalizePhone } = require('../utils/phone');
const schemas = require('../validators/whatsapp');

// Development helpers. They do not exist in production (404).
const router = express.Router();
router.use((req, res, next) => next(env.isProduction ? httpError(404, 'NOT_FOUND', 'Resource not found') : undefined));
router.use(authenticate, requireRole('owner', 'admin'));

// Pretends a customer sent a WhatsApp text: the same processing as a real webhook, without Meta.
router.post('/simulate/whatsapp-inbound', validate({ body: schemas.simulateInbound }), async (req, res) => {
  const { accountId, from, name, text } = req.body;
  const account = accountId
    ? await accountService.findInOrg(req, accountId)
    : await accountService.defaultAccount(req.tenant.organizationId);
  if (!account) throw httpError(400, 'NO_WHATSAPP_NUMBER', 'Add a WhatsApp number in Settings → WhatsApp first.');
  const phone = normalizePhone(from);
  if (!phone) throw httpError(400, 'VALIDATION_ERROR', 'That is not a valid phone number.', [{ field: 'from', code: 'INVALID_PHONE', message: 'Use a number like 98290 12345 or +91 98290 12345.' }]);

  const waId = phone.slice(1);
  const messageId = `wamid.SIM${crypto.randomBytes(12).toString('hex')}`;
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: account.wabaId || 'simulated',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: account.displayPhone, phone_number_id: account.phoneNumberId },
          contacts: [{ profile: { name: name || '' }, wa_id: waId }],
          messages: [{ from: waId, id: messageId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
        },
      }],
    }],
  };
  await inbound.processNow(await inbound.ingest(account, payload));
  const message = await Message.findOne({ providerMessageId: messageId, organizationId: account.organizationId });
  if (!message) throw httpError(500, 'SIMULATION_FAILED', 'The simulated message was not stored.');
  res.status(201).json({ success: true, data: { conversationId: message.conversationId, messageId: message._id, contactId: message.contactId } });
});

module.exports = router;
