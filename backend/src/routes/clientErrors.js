const express = require('express');
const Joi = require('joi');
const validate = require('../middleware/validate');
const { clientErrorLimiter } = require('../middleware/rateLimit');
const errorReporter = require('../services/errorReporter');

// Errors in the pages (F3). app.js sends at most 5 from one page; they go to Sentry like the
// server's, with phone numbers, emails and secrets taken out. No sign-in needed (the login page
// can fail too); a strict limit per address.
const router = express.Router();

const schema = Joi.object({
  message: Joi.string().trim().min(1).max(500).required(),
  stack: Joi.string().max(4000).allow(''),
  source: Joi.string().max(300).allow(''),
  line: Joi.number().integer().min(0).max(1e7),
  column: Joi.number().integer().min(0).max(1e7),
  page: Joi.string().max(300).allow(''),
});

router.post('/', clientErrorLimiter, validate({ body: schema }), (req, res) => {
  const { message, stack, source, line, column, page } = req.body;
  // "Uncaught TypeError: x is not a function" → TypeError, "x is not a function".
  const named = /^(?:Uncaught\s+)?(?:\(in promise\)\s+)?([A-Z][A-Za-z]*Error):\s*([\s\S]*)$/.exec(message);
  const error = {
    name: named ? named[1] : 'Error',
    message: named ? named[2] : message,
    stack: stack || (source ? `    at ${source}:${line || 0}:${column || 0}` : ''),
  };
  errorReporter.capture(error, { source: 'page', platform: 'javascript', page });
  res.status(204).end();
});

module.exports = router;
