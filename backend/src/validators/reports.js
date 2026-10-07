const Joi = require('joi');

// Report ranges are calendar days in India (YYYY-MM-DD), both ends included (Phase 9).
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'Use a date like 2026-10-07.' });
const range = { from: day, to: day };
const EXPORT_TYPES = ['overview', 'trend', 'agents', 'sources', 'quotations', 'broadcasts', 'payments'];

module.exports = {
  range: Joi.object(range),
  export: Joi.object({ ...range, type: Joi.string().valid(...EXPORT_TYPES).default('overview') }),
  EXPORT_TYPES,
};
