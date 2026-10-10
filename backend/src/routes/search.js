const express = require('express');
const Joi = require('joi');
const searchService = require('../services/searchService');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');

// The top bar's search (every member; each group follows that module's own permissions).
const router = express.Router();
router.use(authenticate);

const searchQuery = Joi.object({
  q: Joi.string().trim().min(2).max(100).required(),
  limit: Joi.number().integer().min(1).max(10).default(5),
});

router.get('/', validate({ query: searchQuery }), async (req, res) => {
  res.json({ success: true, data: await searchService.search(req, req.valid.query) });
});

module.exports = router;
