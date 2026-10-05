// The SaaS plans (from the brief), as data: limits are read from here, never written into the
// logic. Until billing arrives (Phase 10) every organization is on the free trial, which has
// the Growth limits (D34).
const PLANS = Object.freeze({
  starter: { name: 'Starter', pricePaise: 99900, users: 2, whatsappNumbers: 1, contacts: 3000, broadcastsPerMonth: 10, templates: 50 },
  pro: { name: 'Pro', pricePaise: 299900, users: 5, whatsappNumbers: 2, contacts: 10000, broadcastsPerMonth: 100 },
  growth: { name: 'Growth', pricePaise: 599900, users: 10, whatsappNumbers: 2, contacts: 40000, broadcastsPerMonth: 500, quotesPerMonth: 10000 },
  scale: { name: 'Scale', pricePaise: 999900, users: 15, whatsappNumbers: 3, contacts: 100000, broadcastsPerMonth: 1000, quotesPerMonth: 25000 },
});
const PLAN_KEYS = Object.freeze(Object.keys(PLANS));
const TRIAL_PLAN = 'growth';

const planOf = (organization) => PLANS[organization?.plan] || PLANS[TRIAL_PLAN];

module.exports = { PLANS, PLAN_KEYS, TRIAL_PLAN, planOf };
