const express = require('express');
const reports = require('../services/reportService');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const schemas = require('../validators/reports');

// Reports (Phase 9): the Reports & Analytics page (module "reports"), the dashboard's numbers
// (module "dashboard") and the AI Insights page (module "insights"). ?from=&to= are days in India.
const router = express.Router();
const can = (module) => requirePermission(module, 'view');
const byRange = validate({ query: schemas.range });
router.use(authenticate);

const REPORTS = { overview: reports.overview, trend: reports.trend, agents: reports.agents, sources: reports.sources, quotations: reports.quotations, broadcasts: reports.broadcasts, payments: reports.payments };
for (const [name, report] of Object.entries(REPORTS)) {
  router.get(`/${name}`, can('reports'), byRange, async (req, res) => {
    res.json({ success: true, data: await report(req, req.valid.query) });
  });
}

// A CSV file of one report (Excel opens it; formulas are never run from cells).
router.get('/export', can('reports'), validate({ query: schemas.export }), async (req, res) => {
  const { fileName, csv } = await reports.exportCsv(req, req.valid.query);
  res.attachment(fileName);
  res.type('text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(csv);
});

// The live team page (D61): owners and admins.
router.get('/team-live', requireRole('owner', 'admin'), async (req, res) => {
  res.json({ success: true, data: await reports.teamLive(req) });
});
// "My performance" (D61): every member, their own figures only.
router.get('/me', byRange, async (req, res) => {
  res.json({ success: true, data: await reports.myPerformance(req, req.valid.query) });
});

router.get('/dashboard', can('dashboard'), async (req, res) => {
  res.json({ success: true, data: await reports.dashboard(req) });
});
router.get('/insights', can('insights'), async (req, res) => {
  res.json({ success: true, data: await reports.insights(req) });
});

module.exports = router;
