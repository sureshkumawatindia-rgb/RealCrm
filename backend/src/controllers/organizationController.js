const organizationService = require('../services/organizationService');

async function get(req, res) {
  res.json({ success: true, data: await organizationService.get(req) });
}

async function update(req, res) {
  res.json({ success: true, data: await organizationService.update(req, req.body) });
}

async function uploadLogo(req, res) {
  res.json({ success: true, data: await organizationService.setLogo(req, req.file) });
}

async function deleteLogo(req, res) {
  res.json({ success: true, data: await organizationService.removeLogo(req) });
}

module.exports = { get, update, uploadLogo, deleteLogo };
