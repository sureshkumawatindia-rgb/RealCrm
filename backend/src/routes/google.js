const express = require('express');
const googleDrive = require('../services/googleDriveService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const schemas = require('../validators/google');

// Google Drive (Phase 9B, D90): a new Google Doc or Sheet for a customer or a deal, attached as a
// CRM document (the Documents permission, like any document).
const router = express.Router();
router.use(authenticate);
router.post('/drive/files', requirePermission('documents', 'create'), validate({ body: schemas.driveFile }), async (req, res) => {
  res.status(201).json({ success: true, data: await googleDrive.createFile(req, req.body), message: 'Google file made' });
});

module.exports = router;
