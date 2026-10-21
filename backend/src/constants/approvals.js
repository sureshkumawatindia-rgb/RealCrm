// Approval rules (Phase 1E, D77): limits on quotations that an owner or admin must approve
// before the quotation reaches the customer.
const MAX_APPROVAL_RULES = 10; // active ones, every plan
const RULE_NAME_MAX = 60;
const DECISION_COMMENT_MAX = 500;
// Who a rule can stop. Owners are never stopped.
const APPROVAL_ROLES = Object.freeze(['agent', 'admin']);
const APPROVAL_STATES = Object.freeze(['pending', 'approved', 'rejected']);
const RULE_STATUSES = Object.freeze(['active', 'archived']);
// Why a quotation needs approval: its whole discount (% of the subtotal) or its grand total.
const REASON_KINDS = Object.freeze(['discount', 'total']);

module.exports = {
  MAX_APPROVAL_RULES,
  RULE_NAME_MAX,
  DECISION_COMMENT_MAX,
  APPROVAL_ROLES,
  APPROVAL_STATES,
  RULE_STATUSES,
  REASON_KINDS,
};
