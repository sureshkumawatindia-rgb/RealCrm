// Roles, modules and the permission rules shared by middleware, services and tests.
// Module keys match the "Account Champions" access grid (crm/frontend/js/accounts.js MODULES).

const ROLES = Object.freeze(['owner', 'admin', 'agent', 'viewer']);
const INVITABLE_ROLES = Object.freeze(['admin', 'agent', 'viewer']);

const MODULES = Object.freeze([
  'dashboard', 'customers', 'leads', 'accounts', 'deals', 'tasks', 'calendar', 'marketing',
  'automation', 'support', 'reports', 'insights', 'documents', 'products', 'settings',
]);

// The page names the Account Champions grid shows (old browser data stored these labels).
const MODULE_LABELS = Object.freeze({
  dashboard: 'Dashboard', customers: 'Customers', leads: 'Leads', accounts: 'Accounts', deals: 'Deals',
  tasks: 'Tasks', calendar: 'Calendar', marketing: 'Marketing', automation: 'Sales Automation', support: 'Support',
  reports: 'Reports & Analytics', insights: 'AI Insights', documents: 'Documents', products: 'Products', settings: 'Settings',
});

const ACTIONS = Object.freeze(['view', 'create', 'edit', 'delete']);

// Extra grants for agents/viewers: "<module>:delete" and "<module>:view_all" (see every record,
// not only assigned ones). Owners and admins have all of them implicitly.
const PERMISSION_PATTERN = new RegExp(`^(${MODULES.join('|')}):(delete|view_all)$`);

const DEFAULT_MODULES = Object.freeze({
  agent: ['dashboard', 'customers', 'leads', 'deals', 'tasks', 'calendar', 'support', 'documents', 'products'],
  viewer: ['dashboard', 'customers', 'leads', 'deals', 'reports'],
});

function isManager(member) {
  return member?.role === 'owner' || member?.role === 'admin';
}

function can(member, module, action) {
  if (!member || member.status !== 'active') return false;
  if (isManager(member)) return true;
  if (!member.modules?.includes(module)) return false;
  if (action === 'view') return true;
  if (member.role === 'viewer') return false;
  if (action === 'delete') return member.permissions?.includes(`${module}:delete`) || false;
  return true;
}

function canViewAll(member, module) {
  return isManager(member) || member?.permissions?.includes(`${module}:view_all`) || false;
}

module.exports = {
  ROLES, INVITABLE_ROLES, MODULES, MODULE_LABELS, ACTIONS, PERMISSION_PATTERN, DEFAULT_MODULES, isManager, can, canViewAll,
};
