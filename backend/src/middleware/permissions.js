const { can } = require('../constants/permissions');
const httpError = require('../utils/httpError');

const forbidden = () => httpError(403, 'FORBIDDEN', 'You do not have permission to do this.');

// Use after authenticate.
function requireRole(...roles) {
  return (req, res, next) => (roles.includes(req.member?.role) ? next() : next(forbidden()));
}

function requirePermission(module, action) {
  return (req, res, next) => (can(req.member, module, action) ? next() : next(forbidden()));
}

module.exports = { requireRole, requirePermission };
