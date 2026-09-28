const express = require('express');
const exportService = require('../services/exportService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');

const router = express.Router();

// The whole organization's data: owners and admins only.
router.get('/crm', authenticate, requireRole('owner', 'admin'), (req, res) => exportService.streamExport(req, res));

module.exports = router;
