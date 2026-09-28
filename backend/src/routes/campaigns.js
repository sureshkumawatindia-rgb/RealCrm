const campaignService = require('../services/campaignService');
const noteService = require('../services/noteService');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');
const { resourceRouter } = require('./workItems');

// Campaigns: read by Marketing, the dashboard and reports; changed from the Marketing page.
const router = resourceRouter(campaignService, 'Campaign', {
  view: campaignService.MODULES,
  write: ['marketing'],
  remove: ['marketing'],
  list: schemas.campaignList,
  create: schemas.campaignCreate,
  patch: schemas.campaignPatch,
});

// The campaign's activity notes (the timeline in its modal).
router.get('/:id/notes', requirePermission(campaignService.MODULES, 'view'), validate({ params: idParams }), async (req, res) => {
  const campaign = await campaignService.findVisible(req, req.valid.params.id);
  res.json({ success: true, data: await noteService.list(req, 'campaign', campaign._id) });
});
router.post('/:id/notes', requirePermission('marketing', 'edit'), validate({ params: idParams, body: schemas.noteCreate }), async (req, res) => {
  const campaign = await campaignService.findVisible(req, req.valid.params.id);
  res.status(201).json({ success: true, data: await noteService.add(req, 'campaign', campaign._id, req.body), message: 'Note added' });
});

module.exports = router;
