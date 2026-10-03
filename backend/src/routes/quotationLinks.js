const express = require('express');
const quotationService = require('../services/quotationService');
const { linkLimiter } = require('../middleware/rateLimit');
const { quotationPage, notFoundPage } = require('../views/quotationPage');

// The customer's quotation link (public, no sign-in): /q/<signed id> shows the quotation and
// counts the view (?preview=1 — the CRM's own "open customer view" — does not); /q/<id>/pdf
// gives the PDF. The page runs no scripts, cannot be framed and is kept out of search engines.
const router = express.Router();
router.use(linkLimiter, (req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/:token', async (req, res) => {
  const found = await quotationService.openShared(req.params.token, { count: req.query.preview !== '1' });
  if (!found) return res.status(404).type('html').send(notFoundPage());
  return res.type('html').send(await quotationPage({ ...found, token: req.params.token }));
});

router.get('/:token/pdf', async (req, res) => {
  const found = await quotationService.openShared(req.params.token, { count: false });
  if (!found || found.quotation.status === 'Draft') return res.status(404).type('html').send(notFoundPage());
  const { buffer, fileName } = await quotationService.pdfFor(found.quotation);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  return res.send(buffer);
});

module.exports = router;
