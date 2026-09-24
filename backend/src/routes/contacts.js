const express = require('express');
const crudController = require('../controllers/crudController');
const contactService = require('../services/contactService');
const noteService = require('../services/noteService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');

const router = express.Router();
const controller = crudController(contactService, 'Contact');
const can = (action) => requirePermission('customers', action);

router.use(authenticate);
router.get('/', can('view'), validate({ query: schemas.contactList }), controller.list);
router.post('/', can('create'), validate({ body: schemas.contactCreate }), controller.create);
router.get('/:id', can('view'), validate({ params: idParams }), controller.get);
router.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.contactPatch }), controller.update);
router.delete('/:id', can('delete'), validate({ params: idParams }), controller.remove);

// Customer 360 notes. Adding one counts as editing the contact.
router.get('/:id/notes', can('view'), validate({ params: idParams }), async (req, res) => {
  const contact = await contactService.findVisible(req, req.valid.params.id);
  res.json({ success: true, data: await noteService.list(req, 'contact', contact._id) });
});
router.post('/:id/notes', can('edit'), validate({ params: idParams, body: schemas.noteCreate }), async (req, res) => {
  const contact = await contactService.findVisible(req, req.valid.params.id);
  res.status(201).json({ success: true, data: await noteService.add(req, 'contact', contact._id, req.body), message: 'Note added' });
});

module.exports = router;
