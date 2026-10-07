const apiKeyService = require('../services/apiKeyService');
const httpError = require('../utils/httpError');

// The public API (Phase 10C): Authorization: Bearer ycrm_… (or X-API-Key). Sets req.apiKey and,
// like a signed-in request, req.user, req.member (the owner or admin who made the key) and
// req.tenant, so the CRM's own services run with the same checks.
async function apiKeyAuth(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key');
    const { key, member, user } = await apiKeyService.authenticate(raw, req.ip);
    req.apiKey = key;
    req.user = { _id: user._id, name: `${user.name || user.email} (API key "${key.name}")`, email: user.email };
    req.member = member;
    req.tenant = { organizationId: key.organizationId, memberId: member._id, userId: user._id, role: member.role, apiKeyId: key._id };
    next();
  } catch (error) {
    next(error);
  }
}

// A route the key's scopes must include.
function requireScope(scope) {
  return (req, res, next) => (req.apiKey?.scopes.includes(scope)
    ? next()
    : next(httpError(403, 'SCOPE_MISSING', `This API key cannot do this: it needs the "${scope}" scope.`)));
}

module.exports = { apiKeyAuth, requireScope };
