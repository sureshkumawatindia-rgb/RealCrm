const express = require('express');
const controller = require('../controllers/teamController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const { authLimiter } = require('../middleware/rateLimit');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/team');

const router = express.Router();

// Public: the login page shows who invited you. POST keeps the token out of URL logs.
router.post('/lookup', authLimiter, validate({ body: schemas.inviteLookup }), controller.lookupInvite);

router.use(authenticate, requireRole('owner', 'admin'));
router.get('/', validate({ query: schemas.inviteList }), controller.listInvites);
router.post('/', idempotency, validate({ body: schemas.inviteCreate }), controller.createInvite);
router.post('/:id/resend', validate({ params: idParams }), controller.resendInvite);
router.delete('/:id', validate({ params: idParams }), controller.revokeInvite);

module.exports = router;
