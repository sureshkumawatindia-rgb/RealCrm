const httpError = require('../utils/httpError');

// Rejects MongoDB operator keys ("$gt", "$where", ...) and prototype keys anywhere in the
// body or query, so user input can never become a query operator.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function findUnsafeKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 20) return null;
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || FORBIDDEN_KEYS.has(key)) return key;
    const nested = findUnsafeKey(value[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

function rejectUnsafeKeys(req, res, next) {
  const key = findUnsafeKey(req.body) || findUnsafeKey(req.query);
  if (key) {
    return next(httpError(400, 'VALIDATION_ERROR', `Field name "${key.slice(0, 40)}" is not allowed.`));
  }
  next();
}

module.exports = rejectUnsafeKeys;
