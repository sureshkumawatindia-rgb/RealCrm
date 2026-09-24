const express = require('express');
const crudController = require('../controllers/crudController');
const contactService = require('../services/contactService');
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

module.exports = router;
