const express = require('express');
const healthRoutes = require('./health');
const authRoutes = require('./auth');
const organizationRoutes = require('./organization');
const memberRoutes = require('./members');
const inviteRoutes = require('./invites');
const gmailRoutes = require('./gmail');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/organization', organizationRoutes);
router.use('/members', memberRoutes);
router.use('/invites', inviteRoutes);
router.use('/gmail', gmailRoutes);

module.exports = router;
