const express = require('express');
const Joi = require('joi');
const privateNumbers = require('../services/privateNumberService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');

// Private numbers (D61): owners only — not admins.
const router = express.Router();
router.use(authenticate, requireRole('owner'));

const numberBody = Joi.object({
  phone: Joi.string().trim().min(6).max(30).required(),
  note: Joi.string().trim().max(60).allow(''),
});

router.get('/numbers', async (req, res) => {
  res.json({ success: true, data: await privateNumbers.list(req) });
});
router.post('/numbers', validate({ body: numberBody }), async (req, res) => {
  res.status(201).json({ success: true, data: await privateNumbers.add(req, req.body), message: 'Number made private' });
});
router.delete('/numbers/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await privateNumbers.remove(req, req.valid.params.id), message: 'Number visible to the team again' });
});

module.exports = router;
