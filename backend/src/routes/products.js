const express = require('express');
const crudController = require('../controllers/crudController');
const productService = require('../services/productService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');

const router = express.Router();
const controller = crudController(productService, 'Product');
const can = (action) => requirePermission('products', action);

router.use(authenticate);
// Every member may read the catalog (lead forms and quotations pick products from it).
router.get('/', validate({ query: schemas.productList }), controller.list);
router.get('/:id', validate({ params: idParams }), controller.get);
router.post('/', can('create'), validate({ body: schemas.productCreate }), controller.create);
router.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.productCreate.fork(['name'], (field) => field.optional()).min(1) }), controller.update);
router.delete('/:id', can('delete'), validate({ params: idParams }), controller.remove);

module.exports = router;
