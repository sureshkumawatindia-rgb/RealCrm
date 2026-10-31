const ticketService = require('../services/ticketService');
const noteService = require('../services/noteService');
const ticketSla = require('../services/ticketSlaService');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');
const { resourceRouter } = require('./workItems');

// Support tickets: read by Support, Customer 360 and reports; changed from the Support page.
const router = resourceRouter(ticketService, 'Ticket', {
  view: ticketService.MODULES,
  write: ['support'],
  remove: ['support'],
  list: schemas.ticketList,
  create: schemas.ticketCreate,
  patch: schemas.ticketPatch,
});

// The ticket's reply timeline. Anyone who may see the ticket may read it; adding needs support.
// The first note is the ticket's first reply for the SLA (D107).
router.get('/:id/notes', requirePermission(ticketService.MODULES, 'view'), validate({ params: idParams }), async (req, res) => {
  const ticket = await ticketService.findVisible(req, req.valid.params.id);
  res.json({ success: true, data: await noteService.list(req, 'ticket', ticket._id) });
});
router.post('/:id/notes', requirePermission('support', 'edit'), validate({ params: idParams, body: schemas.noteCreate }), async (req, res) => {
  const ticket = await ticketService.findVisible(req, req.valid.params.id);
  const note = await noteService.add(req, 'ticket', ticket._id, req.body);
  await ticketSla.noteAdded(ticket);
  res.status(201).json({ success: true, data: note, message: 'Note added' });
});

module.exports = router;
