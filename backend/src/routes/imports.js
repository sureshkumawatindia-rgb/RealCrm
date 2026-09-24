const express = require('express');
const Joi = require('joi');
const importService = require('../services/importService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');

const router = express.Router();

// Values are the raw localStorage strings (or already-parsed lists) keyed by crm_* name.
const importBody = Joi.object({
  data: Joi.object().pattern(/^crm_[a-z0-9_]+$/, Joi.alternatives(Joi.string().max(25 * 1024 * 1024), Joi.array())).required(),
  dryRun: Joi.boolean().required(),
});

router.use(authenticate, requireRole('owner', 'admin'));
router.post('/localstorage', validate({ body: importBody }), async (req, res) => {
  const result = await importService.importLocalStorage(req, req.body);
  res.status(req.body.dryRun ? 200 : 201).json({ success: true, data: result });
});
router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await importService.get(req, req.valid.params.id) });
});

module.exports = router;
