const express = require('express');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const sampleData = require('../services/sampleDataService');

// Staging only (F2), and development with DEV_TOOLS: never in production (404).
const router = express.Router();
router.use((req, res, next) => next(env.isStaging || env.devTools ? undefined : httpError(404, 'NOT_FOUND', 'Resource not found')));
router.use(authenticate, requireRole('owner', 'admin'));

// Fills the signed-in company with made-up data, once.
router.post('/sample-data', async (req, res) => {
  res.status(201).json({ success: true, data: await sampleData.fill(req), message: 'Sample data added' });
});

module.exports = router;
