const express = require('express');
const forms = require('../services/publicFormService');
const buttons = require('../services/whatsappButtonService');
const { formLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators/leadSources');
const Organization = require('../models/Organization');

// Public endpoints for the organization's own websites (no sign-in): the enquiry form and the
// script that draws it. Any site may call them (CORS without cookies); a form can still be
// limited to its listed websites. Mounted before the API rate limit, with its own.
const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '20kb' }));

function allowAnySite(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}
router.use(allowAnySite);

router.get('/forms/:publicKey/embed.js', async (req, res) => {
  const form = await forms.findForm(req.params.publicKey);
  res.type('application/javascript; charset=utf-8');
  if (!form) return res.status(404).send('/* This enquiry form does not exist any more. */\n');
  res.set('Cache-Control', 'public, max-age=300');
  // D120: the company's privacy notice under the form.
  const organization = await Organization.findById(form.organizationId).select('settings.privacy.noticeUrl').lean();
  return res.send(forms.embedScript(form, { privacyUrl: organization?.settings?.privacy?.noticeUrl || '' }));
});

// D102: the website's WhatsApp button — its script, and the click it reports (a beacon; always 204).
router.get('/widget/:publicKey/widget.js', async (req, res) => {
  const button = await buttons.findButton(req.params.publicKey);
  res.type('application/javascript; charset=utf-8');
  if (!button) return res.status(404).send('/* This WhatsApp button does not exist any more. */\n');
  const preview = req.query.preview === '1'; // the Settings page's preview
  res.set('Cache-Control', preview ? 'no-store' : 'public, max-age=300');
  return res.send(await buttons.script(button, { preview }));
});
router.post('/widget/:publicKey/click', formLimiter, async (req, res) => {
  const button = await buttons.findButton(req.params.publicKey);
  const { error, value } = schemas.widgetClick.validate(req.body || {}, { stripUnknown: true });
  if (button && !error) await buttons.recordClick(button, value, { origin: req.get('origin') });
  res.sendStatus(204);
});

// JSON (from embed.js) is answered with JSON; a plain HTML form gets a page or a redirect.
router.post('/forms/:publicKey', formLimiter, async (req, res) => {
  const wantsJson = req.is('application/json');
  const fail = (status, message, extra = {}) => (wantsJson
    ? res.status(status).json({ success: false, message, ...extra })
    : res.status(status).type('html').send(forms.resultPage('Not sent', message)));

  const form = await forms.findForm(req.params.publicKey);
  if (!form) return fail(404, 'This enquiry form does not exist any more.', { code: 'NOT_FOUND' });
  const { error, value } = schemas.formSubmit.validate(req.body || {}, { abortEarly: false, stripUnknown: true });
  if (error) {
    const errors = error.details.map((d) => ({ field: d.path.join('.'), code: 'INVALID', message: d.message.replace(/"/g, '') }));
    return fail(400, errors[0].message, { code: 'VALIDATION_ERROR', errors });
  }
  try {
    const result = await forms.submit(form, value, { origin: req.get('origin'), userAgent: req.get('user-agent') });
    if (wantsJson) return res.status(201).json({ success: true, data: result });
    const redirect = form.settings?.redirectUrl;
    if (redirect) return res.redirect(303, redirect);
    return res.type('html').send(forms.resultPage('Thank you', result.message));
  } catch (err) {
    if (!err.statusCode || err.statusCode >= 500) throw err;
    return fail(err.statusCode, err.message, { code: err.code, ...(err.errors && { errors: err.errors }) });
  }
});

module.exports = router;
