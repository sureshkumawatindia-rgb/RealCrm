const crypto = require('crypto');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { normalizePhone } = require('../utils/phone');
const { intake } = require('./leadIntakeService');
const { websiteSettings } = require('./leadSourceService');

// Website enquiry forms: anyone may post to /api/v1/public/forms/<publicKey> (it sits on the
// organization's website). Protection: a per-address rate limit, a honeypot field that people
// never see, an optional list of allowed websites, and the lead intake's dedupe.
const HONEYPOT = 'website_url';

async function findForm(publicKey) {
  if (!/^[a-f0-9]{24}$/.test(String(publicKey || ''))) return null;
  return LeadSourceConnection.findOne({ publicKey, type: 'website' });
}

// With no allowed websites listed, any website may use the form.
function originAllowed(form, origin) {
  const allowed = websiteSettings(form.settings).allowedOrigins;
  if (!allowed.length || !origin) return true;
  return allowed.includes(String(origin).toLowerCase().replace(/\/+$/, ''));
}

// body: the validated form fields. Returns { accepted, message }.
async function submit(form, body, { origin, userAgent } = {}) {
  if (form.status !== 'active') throw httpError(403, 'FORM_PAUSED', 'This form is not taking enquiries right now.');
  if (!originAllowed(form, origin)) throw httpError(403, 'ORIGIN_NOT_ALLOWED', 'This form cannot be used on this website.');
  const settings = websiteSettings(form.settings);
  // A bot filled in the hidden field: answer as if all went well, keep nothing.
  if (body[HONEYPOT]) return { accepted: true, message: settings.successMessage };

  const phone = normalizePhone(body.phone);
  if (phone === null) {
    throw httpError(400, 'VALIDATION_ERROR', 'Please enter a valid mobile number.', [{ field: 'phone', code: 'INVALID_PHONE', message: 'Please enter a valid mobile number.' }]);
  }
  if (!phone && !body.email) {
    throw httpError(400, 'VALIDATION_ERROR', 'Please enter your mobile number or email.', [{ field: 'phone', code: 'REQUIRED', message: 'Please enter your mobile number or email.' }]);
  }
  const fields = ['name', 'phone', 'email', 'company', 'city', 'product', 'quantity', 'message'];
  const submitted = Object.fromEntries(fields.filter((field) => body[field]).map((field) => [field, body[field]]));
  await intake({
    organizationId: form.organizationId,
    source: 'Website',
    // The form's own id for this submission makes a double click harmless.
    sourceRef: `form:${form._id}:${body.submissionId || crypto.randomBytes(12).toString('hex')}`,
    connectionId: form._id,
    person: { name: body.name, phone: body.phone, email: body.email, company: body.company, city: body.city },
    enquiry: { product: body.product, quantity: body.quantity, message: body.message },
    raw: { fields: submitted, origin: origin || '', userAgent: String(userAgent || '').slice(0, 300) },
  });
  return { accepted: true, message: settings.successMessage };
}

// The script a website includes: it draws the form (no innerHTML, so nothing in the settings
// can inject markup) and posts it as JSON.
function embedScript(form) {
  const settings = websiteSettings(form.settings);
  const config = {
    key: form.publicKey,
    endpoint: `${env.publicUrl}/api/v1/public/forms/${form.publicKey}`,
    title: settings.title,
    button: settings.buttonText || 'Send',
    askFor: settings.askFor,
  };
  // "<" as < keeps the JSON from ever closing a <script> tag.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `/* YELLOW CRM enquiry form */
(function () {
  var cfg = ${json};
  var here = document.currentScript;
  var mount = document.querySelector('[data-yellow-crm-form="' + cfg.key + '"]');
  if (!mount) {
    mount = document.createElement('div');
    here.parentNode.insertBefore(mount, here.nextSibling);
  }
  function el(tag, props, style) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (key) { node[key] = props[key]; });
    if (style) node.setAttribute('style', style);
    return node;
  }
  var box = 'display:block;width:100%;box-sizing:border-box;margin:4px 0 12px;padding:10px 12px;border:1px solid #ccc;border-radius:8px;font:inherit;';
  var form = el('form', { noValidate: true }, 'max-width:480px;font-family:inherit;');
  if (cfg.title) form.appendChild(el('h3', { textContent: cfg.title }, 'margin:0 0 12px;'));
  var fields = [['name', 'Your name', 'text', true], ['phone', 'Mobile number', 'tel', true]];
  if (cfg.askFor.email) fields.push(['email', 'Email', 'email', false]);
  if (cfg.askFor.company) fields.push(['company', 'Company', 'text', false]);
  if (cfg.askFor.city) fields.push(['city', 'City', 'text', false]);
  if (cfg.askFor.product) fields.push(['product', 'Product you need', 'text', false]);
  if (cfg.askFor.message) fields.push(['message', 'Your requirement', 'textarea', false]);
  fields.forEach(function (f) {
    var label = el('label', { textContent: f[1] + (f[3] ? ' *' : '') }, 'display:block;font-size:14px;');
    var input = f[2] === 'textarea' ? el('textarea', { name: f[0], rows: 3 }, box) : el('input', { name: f[0], type: f[2] }, box);
    input.required = f[3];
    input.maxLength = f[2] === 'textarea' ? 2000 : 200;
    label.appendChild(input);
    form.appendChild(label);
  });
  // People never see this field; bots fill it in.
  var trap = el('input', { name: 'website_url', type: 'text', tabIndex: -1, autocomplete: 'off' }, 'position:absolute;left:-10000px;width:1px;height:1px;opacity:0;');
  trap.setAttribute('aria-hidden', 'true');
  form.appendChild(trap);
  var submissionId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2, 12);
  var button = el('button', { type: 'submit', textContent: cfg.button }, 'padding:10px 20px;border:0;border-radius:8px;background:#25d366;color:#fff;font:inherit;cursor:pointer;');
  var note = el('p', {}, 'margin:10px 0 0;font-size:14px;');
  note.setAttribute('aria-live', 'polite');
  form.appendChild(button);
  form.appendChild(note);
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var data = { submissionId: submissionId };
    Array.prototype.forEach.call(form.elements, function (input) { if (input.name) data[input.name] = input.value; });
    if (!data.name || !data.phone) { note.textContent = 'Please enter your name and mobile number.'; return; }
    button.disabled = true;
    note.textContent = 'Sending…';
    fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (result.ok) {
          var done = el('p', { textContent: (result.body.data && result.body.data.message) || 'Thank you!' }, 'font-size:15px;');
          form.replaceWith(done);
        } else {
          note.textContent = result.body.message || 'Could not send. Please try again.';
          button.disabled = false;
        }
      })
      .catch(function () { note.textContent = 'Could not send. Please check your internet and try again.'; button.disabled = false; });
  });
  mount.appendChild(form);
})();
`;
}

// A plain HTML page for forms posted without JavaScript.
function resultPage(title, message) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px"><h2>${escape(title)}</h2><p>${escape(message)}</p>`
    + '<p style="color:#666">You can go back to the previous page now.</p></body></html>';
}

module.exports = { findForm, submit, embedScript, resultPage, originAllowed, HONEYPOT };
