const crypto = require('crypto');
const IdempotencyRecord = require('../models/IdempotencyRecord');
const httpError = require('../utils/httpError');

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const TTL_MS = 24 * 60 * 60 * 1000;

// Optional Idempotency-Key support for retriable POSTs (use after authenticate).
// Same key + same body → the stored response is replayed; same key + different body → 422.
function idempotency(req, res, next) {
  const key = req.get('idempotency-key');
  if (!key) return next();
  if (!KEY_PATTERN.test(key)) return next(httpError(400, 'VALIDATION_ERROR', 'Idempotency-Key must be 8-128 letters, digits, ".", "_", ":" or "-".'));

  const scope = {
    organizationId: req.tenant.organizationId,
    userId: req.user._id,
    operation: `${req.method} ${req.originalUrl.split('?')[0]}`,
    key,
  };
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');

  (async () => {
    try {
      await IdempotencyRecord.create({ ...scope, requestHash, expiresAt: new Date(Date.now() + TTL_MS) });
    } catch (error) {
      if (error.code !== 11000) throw error;
      const existing = await IdempotencyRecord.findOne(scope);
      if (!existing) throw httpError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still running.');
      if (existing.requestHash !== requestHash) throw httpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used with a different request body.');
      if (!existing.statusCode) throw httpError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still running.');
      res.set('Idempotent-Replayed', 'true');
      return res.status(existing.statusCode).json(existing.body);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const done = res.statusCode < 500
        ? IdempotencyRecord.updateOne(scope, { statusCode: res.statusCode, body })
        : IdempotencyRecord.deleteOne(scope); // let the client retry after a server error
      done.catch(() => {});
      return originalJson(body);
    };
    next();
  })().catch(next);
}

module.exports = idempotency;
