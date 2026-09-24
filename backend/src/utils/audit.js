const AuditLog = require('../models/AuditLog');
const logger = require('../config/logger');

const REDACTED_KEYS = /token|secret|password|key|credential/i;

function redact(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, REDACTED_KEYS.test(key) ? '[redacted]' : redact(inner)]));
}

// Writes an audit entry. Failures are logged, never thrown: auditing must not break the request.
async function audit(req, { organizationId, action, entityType, entityId, changes }) {
  try {
    await AuditLog.create({
      organizationId: organizationId || req.tenant?.organizationId,
      actorUserId: req.user?._id,
      action,
      entityType,
      entityId: entityId ? String(entityId) : undefined,
      changes: redact(changes),
      requestId: req.id,
      ip: req.ip,
      userAgent: String(req.get('user-agent') || '').slice(0, 300),
    });
  } catch (error) {
    logger.error(`Audit log write failed for ${action}: ${error.message}`);
  }
}

module.exports = { audit, redact };
