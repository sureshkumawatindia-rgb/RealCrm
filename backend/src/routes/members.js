const express = require('express');
const controller = require('../controllers/teamController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams, pageQuery } = require('../validators/common');
const { memberPatch } = require('../validators/team');

const router = express.Router();

router.use(authenticate);
// Every member may see the team list (needed for assigning work); only owners/admins manage it.
router.get('/', validate({ query: pageQuery }), controller.listMembers);
router.patch('/:id', requireRole('owner', 'admin'), validate({ params: idParams, body: memberPatch }), controller.updateMember);
// A teammate lost the phone with their authenticator app (F7).
router.post('/:id/totp-reset', requireRole('owner', 'admin'), validate({ params: idParams }), controller.resetMemberTotp);
router.delete('/:id', requireRole('owner', 'admin'), validate({ params: idParams }), controller.removeMember);

module.exports = router;
