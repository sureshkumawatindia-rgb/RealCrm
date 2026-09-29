const express = require('express');
const multer = require('multer');
const controller = require('../controllers/organizationController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { organizationPatch } = require('../validators/organization');
const routingSchemas = require('../validators/routing');
const assignment = require('../services/assignmentService');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

function uploadLogo(req, res, next) {
  upload.single('logo')(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      error.statusCode = 400;
      error.code = 'FILE_TOO_LARGE';
      error.message = 'File size must be less than 2 MB.';
    }
    next(error);
  });
}

router.use(authenticate);
router.get('/', controller.get);
// Working hours (assignment rules can send leads outside them to a fallback person).
router.get('/business-hours', async (req, res) => {
  res.json({ success: true, data: await assignment.getBusinessHours(req) });
});
router.put('/business-hours', requireRole('owner', 'admin'), validate({ body: routingSchemas.businessHours }), async (req, res) => {
  res.json({ success: true, data: await assignment.setBusinessHours(req, req.body), message: 'Working hours saved' });
});
router.patch('/', requireRole('owner', 'admin'), validate({ body: organizationPatch }), controller.update);
router.post('/logo', requireRole('owner', 'admin'), uploadLogo, controller.uploadLogo);
router.delete('/logo', requireRole('owner', 'admin'), controller.deleteLogo);

module.exports = router;
