const express = require('express');
const api = require('../services/publicApiService');
const tableExport = require('../services/tableExportService');
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

// The company's own fields (D74): contacts' with contacts:read, leads' with leads:read.
const fieldScope = (req, res, next) => requireScope(req.valid.query.object === 'lead' ? 'leads:read' : 'contacts:read')(req, res, next);
router.get('/custom-fields', validate({ query: schemas.customFieldList }), fieldScope, async (req, res) => send(res, await api.listCustomFields(req, req.valid.query)));

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

// The company's own objects and their records (D78).
router.get('/objects', requireScope('records:read'), async (req, res) => send(res, await api.listObjects(req)));
router.get('/records', requireScope('records:read'), validate({ query: schemas.recordList }), async (req, res) => send(res, await api.listRecords(req, req.valid.query)));
router.get('/records/:id', requireScope('records:read'), byId, async (req, res) => send(res, await api.getRecord(req, req.valid.params.id)));
router.post('/records', requireScope('records:write'), validate({ body: schemas.recordCreate }), async (req, res) => send(res, await api.createRecord(req, req.body), 201));
router.patch('/records/:id', requireScope('records:write'), validate({ params: idParams, body: schemas.recordPatch }), async (req, res) => send(res, await api.updateRecord(req, req.valid.params.id, req.body)));

// Feeds for Excel and Power BI (D82): every row of a table, flat, money in rupees. Each table
// needs its own read scope. ?format=csv for a CSV; ?updatedSince= for the changed rows only.
router.get('/feeds/:table', validate({ params: schemas.feedParams, query: schemas.feedQuery }), (req, res, next) => requireScope(tableExport.TABLES[req.valid.params.table].scope)(req, res, next), async (req, res) => {
  const out = await tableExport.feed(req, req.valid.params.table, req.valid.query);
  res.setHeader('Cache-Control', 'private, no-store');
  if (out.csv !== undefined) return res.type('text/csv; charset=utf-8').send(out.csv);
  return res.json({ success: true, data: out.rows });
});

router.post('/messages', requireScope('messages:write'), validate({ body: schemas.messageSend }), async (req, res) => send(res, await api.sendTemplate(req, req.body), 201));

module.exports = router;
