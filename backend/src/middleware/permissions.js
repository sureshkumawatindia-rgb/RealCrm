const { can } = require('../constants/permissions');
const httpError = require('../utils/httpError');

const forbidden = () => httpError(403, 'FORBIDDEN', 'You do not have permission to do this.');

// Use after authenticate.
function requireRole(...roles) {
  return (req, res, next) => (roles.includes(req.member?.role) ? next() : next(forbidden()));
}

// module may be a list: access to any of them is enough (e.g. leads are used by the
// Leads and the Deals pages).
function requirePermission(module, action) {
  const modules = Array.isArray(module) ? module : [module];
  return (req, res, next) => (modules.some((item) => can(req.member, item, action)) ? next() : next(forbidden()));
}

module.exports = { requireRole, requirePermission };
