const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const Organization = require('../models/Organization');
const { authenticate } = require('../middleware/auth');
const { validateLogoFile } = require('../utils/logoFile');
const env = require('../config/env');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

function serializeOrganization(organization) {
  return {
    id: organization._id,
    name: organization.name,
    logoUrl: organization.logoUrl || '',
    industry: organization.industry || '',
    size: organization.size || '',
    founded: organization.founded || '',
    website: organization.website || '',
    email: organization.email || '',
    phone: organization.phone || '',
    gst: organization.gst || '',
    address: organization.address || '',
    city: organization.city || '',
    state: organization.state || '',
    country: organization.country || '',
    pincode: organization.pincode || '',
    description: organization.description || '',
  };
}

function fileNameFromUrl(logoUrl) {
  if (!logoUrl) return '';
  try {
    return path.basename(new URL(logoUrl).pathname);
  } catch {
    return path.basename(logoUrl);
  }
}

async function removeStoredLogo(logoUrl) {
  const fileName = fileNameFromUrl(logoUrl);
  if (!fileName) return;
  try {
    await fs.unlink(path.resolve(env.uploadDir, fileName));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const organization = await Organization.findById(req.user.organizationId);
    if (!organization) {
      const error = new Error('Organization not found');
      error.statusCode = 404;
      error.code = 'ORGANIZATION_NOT_FOUND';
      throw error;
    }
    res.json({ success: true, data: serializeOrganization(organization) });
  } catch (error) {
    next(error);
  }
});

router.patch('/', async (req, res, next) => {
  try {
    const allowedFields = ['name', 'industry', 'size', 'founded', 'website', 'email', 'phone', 'gst', 'address', 'city', 'state', 'country', 'pincode', 'description'];
    const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowedFields.includes(key)));
    const organization = await Organization.findByIdAndUpdate(req.user.organizationId, patch, { new: true, runValidators: true });
    if (!organization) {
      const error = new Error('Organization not found');
      error.statusCode = 404;
      error.code = 'ORGANIZATION_NOT_FOUND';
      throw error;
    }
    res.json({ success: true, data: serializeOrganization(organization) });
  } catch (error) {
    next(error);
  }
});

router.post('/logo', upload.single('logo'), async (req, res, next) => {
  try {
    if (!req.file) {
      const error = new Error('Logo file is required');
      error.statusCode = 400;
      error.code = 'FILE_REQUIRED';
      throw error;
    }
    const extension = validateLogoFile(req.file);
    const organization = await Organization.findById(req.user.organizationId);
    if (!organization) {
      const error = new Error('Organization not found');
      error.statusCode = 404;
      error.code = 'ORGANIZATION_NOT_FOUND';
      throw error;
    }

    const oldLogoUrl = organization.logoUrl;
    await fs.mkdir(path.resolve(env.uploadDir), { recursive: true });
    const fileName = `${organization._id}-${crypto.randomUUID()}.${extension}`;
    await fs.writeFile(path.resolve(env.uploadDir, fileName), req.file.buffer);
    organization.logoUrl = `${env.publicUrl}/uploads/${fileName}`;
    await organization.save();
    await removeStoredLogo(oldLogoUrl);

    res.json({ success: true, data: serializeOrganization(organization) });
  } catch (error) {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      error.statusCode = 400;
      error.code = 'FILE_TOO_LARGE';
      error.message = 'File size must be less than 2 MB.';
    }
    next(error);
  }
});

router.delete('/logo', async (req, res, next) => {
  try {
    const organization = await Organization.findById(req.user.organizationId);
    if (!organization) {
      const error = new Error('Organization not found');
      error.statusCode = 404;
      error.code = 'ORGANIZATION_NOT_FOUND';
      throw error;
    }
    const oldLogoUrl = organization.logoUrl;
    organization.logoUrl = '';
    await organization.save();
    await removeStoredLogo(oldLogoUrl);
    res.json({ success: true, data: serializeOrganization(organization) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
