const express = require('express');
const healthRoutes = require('./health');
const authRoutes = require('./auth');
const organizationRoutes = require('./organization');
const gmailRoutes = require('./gmail');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/organization', organizationRoutes);
router.use('/gmail', gmailRoutes);

module.exports = router;
