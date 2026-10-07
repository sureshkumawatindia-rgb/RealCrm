const express = require('express');
const api = require('../services/publicApiService');
const { apiKeyAuth, requireScope } = require('../middleware/apiKey');
const { apiLimiter, publicApiLimiter } = require('../middleware/rateLimit');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/integrations');

// The public REST API (Phase 10C) at /api/public/v1: an API key from Settings → API & webhooks
// (Authorization: Bearer ycrm_…), each route needing its scope. Per address before the key is
// known, then per key (RATE_LIMIT_PUBLIC_API_PER_MINUTE). Answers { success, data, pagination? }.
const router = express.Router();
router.use(apiLimiter, apiKeyAuth, publicApiLimiter);
const byId = validate({ params: idParams });
const send = (res, data, status = 200) => res.status(status).json({ success: true, ...(data?.items && data?.pagination ? { data: data.items, pagination: data.pagination } : { data }) });

router.get('/me', async (req, res) => send(res, await api.me(req)));

router.get('/contacts', requireScope('contacts:read'), validate({ query: schemas.contactList }), async (req, res) => send(res, await api.listContacts(req, req.valid.query)));
router.get('/contacts/:id', requireScope('contacts:read'), byId, async (req, res) => send(res, await api.getContact(req, req.valid.params.id)));
router.post('/contacts', requireScope('contacts:write'), validate({ body: schemas.contactCreate }), async (req, res) => send(res, await api.createContact(req, req.body), 201));
router.patch('/contacts/:id', requireScope('contacts:write'), validate({ params: idParams, body: schemas.contactPatch }), async (req, res) => send(res, await api.updateContact(req, req.valid.params.id, req.body)));

router.get('/leads', requireScope('leads:read'), validate({ query: schemas.leadList }), async (req, res) => send(res, await api.listLeads(req, req.valid.query)));
router.get('/leads/:id', requireScope('leads:read'), byId, async (req, res) => send(res, await api.getLead(req, req.valid.params.id)));
router.post('/leads', requireScope('leads:write'), validate({ body: schemas.leadCreate }), async (req, res) => {
  const result = await api.createLead(req, req.body);
  send(res, result, result.outcome === 'created' ? 201 : 200);
});
router.post('/leads/:id/stage', requireScope('leads:write'), validate({ params: idParams, body: schemas.leadStage }), async (req, res) => send(res, await api.changeLeadStage(req, req.valid.params.id, req.body)));

router.get('/quotations', requireScope('quotations:read'), validate({ query: schemas.quotationList }), async (req, res) => send(res, await api.listQuotations(req, req.valid.query)));
router.get('/quotations/:id', requireScope('quotations:read'), byId, async (req, res) => send(res, await api.getQuotation(req, req.valid.params.id)));
router.get('/orders', requireScope('orders:read'), validate({ query: schemas.orderList }), async (req, res) => send(res, await api.listOrders(req, req.valid.query)));
router.get('/orders/:id', requireScope('orders:read'), byId, async (req, res) => send(res, await api.getOrder(req, req.valid.params.id)));
router.get('/products', requireScope('products:read'), validate({ query: schemas.productList }), async (req, res) => send(res, await api.listProducts(req, req.valid.query)));

router.post('/messages', requireScope('messages:write'), validate({ body: schemas.messageSend }), async (req, res) => send(res, await api.sendTemplate(req, req.body), 201));

module.exports = router;
