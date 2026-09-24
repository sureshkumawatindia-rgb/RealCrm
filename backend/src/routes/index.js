const express = require('express');
const healthRoutes = require('./health');
const authRoutes = require('./auth');
const organizationRoutes = require('./organization');
const memberRoutes = require('./members');
const inviteRoutes = require('./invites');
const gmailRoutes = require('./gmail');
const contactRoutes = require('./contacts');
const productRoutes = require('./products');
const leadRoutes = require('./leads');
const quotationRoutes = require('./quotations');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/organization', organizationRoutes);
router.use('/members', memberRoutes);
router.use('/invites', inviteRoutes);
router.use('/gmail', gmailRoutes);
router.use('/contacts', contactRoutes);
router.use('/products', productRoutes);
router.use('/leads', leadRoutes);
router.use('/quotations', quotationRoutes);

module.exports = router;
