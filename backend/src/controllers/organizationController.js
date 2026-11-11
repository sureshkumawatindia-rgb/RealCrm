const organizationService = require('../services/organizationService');
const crmTypeService = require('../services/crmTypeService');

async function get(req, res) {
  res.json({ success: true, data: await organizationService.get(req) });
}

async function update(req, res) {
  if (req.body.crmType) {
    const { crmType: from } = await organizationService.get(req);
    if (from !== req.body.crmType) await crmTypeService.change(req, from, req.body.crmType);
  }
  res.json({ success: true, data: await organizationService.update(req, req.body) });
}

async function uploadLogo(req, res) {
  res.json({ success: true, data: await organizationService.setLogo(req, req.file) });
}

async function deleteLogo(req, res) {
  res.json({ success: true, data: await organizationService.removeLogo(req) });
}

module.exports = { get, update, uploadLogo, deleteLogo };
