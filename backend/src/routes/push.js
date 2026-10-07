const express = require('express');
const Joi = require('joi');
const pushService = require('../services/pushService');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');

// Web push for the bell's notes (Phase 10E): each member switches it on for their own devices
// (Settings → Your Profile).
const router = express.Router();
router.use(authenticate);

const subscription = Joi.object({
  endpoint: Joi.string().uri({ scheme: ['https'] }).max(1000).required(),
  keys: Joi.object({
    p256dh: Joi.string().pattern(/^[A-Za-z0-9_-]+={0,2}$/).max(200).required(),
    auth: Joi.string().pattern(/^[A-Za-z0-9_-]+={0,2}$/).max(100).required(),
  }).required(),
  expirationTime: Joi.any(),
});

router.get('/key', async (req, res) => {
  res.json({ success: true, data: await pushService.publicKey() });
});
router.get('/devices', async (req, res) => {
  res.json({ success: true, data: await pushService.devices(req) });
});
router.post('/subscriptions', validate({ body: subscription }), async (req, res) => {
  res.status(201).json({ success: true, data: await pushService.subscribe(req, req.body) });
});
router.delete('/subscriptions', validate({ body: Joi.object({ endpoint: Joi.string().max(1000).required() }) }), async (req, res) => {
  res.json({ success: true, data: await pushService.unsubscribe(req, req.body) });
});
router.post('/test', async (req, res) => {
  res.json({ success: true, data: await pushService.test(req) });
});

module.exports = router;
