const Joi = require('joi');

// Tally export (G5, D109): ledger names as in the company's Tally, and a period of India days.
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'Use a date like 2026-10-05' });
const ledgerName = Joi.string().trim().min(1).max(100).pattern(/^[^\u0000-\u001F]+$/);
const LEDGER_KEYS = ['sales', 'cgst', 'sgst', 'igst', 'roundOff', 'bank', 'cash', 'gateway'];

module.exports = {
  settings: Joi.object({
    ledgers: Joi.object(Object.fromEntries(LEDGER_KEYS.map((key) => [key, ledgerName]))).min(1),
    splitByRate: Joi.boolean(),
  }).min(1),
  range: Joi.object({ from: day, to: day }),
  export: Joi.object({ from: day.required(), to: day.required(), part: Joi.string().valid('ledgers', 'vouchers').required() }),
};
