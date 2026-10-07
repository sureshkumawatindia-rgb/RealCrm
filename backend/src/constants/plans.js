// The SaaS plans (from the brief), as data: limits are read from here, never written into the
// logic (services/planService.js applies them). A limit left out means "no limit"; a feature
// left out means the plan does not have it. Prices are per month, before 18% GST.
// quotesPerMonth for Starter and Pro is not in the brief: editable defaults (D48).
const PLANS = Object.freeze({
  starter: {
    name: 'Starter', pricePaise: 99900,
    users: 2, whatsappNumbers: 1, contacts: 3000, broadcastsPerMonth: 10, quotesPerMonth: 300, templates: 50,
  },
  pro: {
    name: 'Pro', pricePaise: 299900,
    users: 5, whatsappNumbers: 2, contacts: 10000, broadcastsPerMonth: 100, quotesPerMonth: 2000,
    paymentLinks: true, conversionsApi: true,
  },
  growth: {
    name: 'Growth', pricePaise: 599900,
    users: 10, whatsappNumbers: 2, contacts: 40000, broadcastsPerMonth: 500, quotesPerMonth: 10000,
    paymentLinks: true, conversionsApi: true, catalog: true, advancedAutomation: true, api: true,
  },
  scale: {
    name: 'Scale', pricePaise: 999900,
    users: 15, whatsappNumbers: 3, contacts: 100000, broadcastsPerMonth: 1000, quotesPerMonth: 25000,
    paymentLinks: true, conversionsApi: true, catalog: true, advancedAutomation: true, api: true,
  },
});
const PLAN_KEYS = Object.freeze(Object.keys(PLANS));
// A new organization tries the Growth plan for 30 days (D48).
const TRIAL_PLAN = 'growth';
const TRIAL_DAYS = 30;
const PLAN_GST_PCT = 18;

// What is counted, in the order the usage meters show it. monthly: counted from the 1st (India).
const LIMITS = Object.freeze({
  users: { label: 'Users', noun: 'users' },
  whatsappNumbers: { label: 'WhatsApp numbers', noun: 'WhatsApp numbers' },
  contacts: { label: 'Contacts', noun: 'contacts' },
  broadcastsPerMonth: { label: 'Broadcasts this month', noun: 'broadcasts a month', monthly: true },
  quotesPerMonth: { label: 'Quotations this month', noun: 'quotations a month', monthly: true },
  templates: { label: 'Message templates', noun: 'message templates' },
});
// Features that come with some plans only. Everything else (inbox, leads and lead sources,
// quotations, orders, FAQ bot, auto-replies, follow-up sequences, reports) is in every plan.
const FEATURES = Object.freeze({
  paymentLinks: 'Payment links',
  conversionsApi: 'Meta Conversions API',
  catalog: 'The WhatsApp catalog',
  advancedAutomation: 'Automation workflows',
  api: 'The public API and webhooks',
});

// Subscription states (Organization.subscription.status). comped: an organization that does not
// pay (those that existed before billing, D48); it keeps its plan without an end date.
const SUBSCRIPTION_STATUSES = Object.freeze(['trialing', 'active', 'past_due', 'halted', 'cancelled', 'expired', 'comped']);

const planOf = (organization) => PLANS[organization?.plan] || PLANS[TRIAL_PLAN];

module.exports = { PLANS, PLAN_KEYS, TRIAL_PLAN, TRIAL_DAYS, PLAN_GST_PCT, LIMITS, FEATURES, SUBSCRIPTION_STATUSES, planOf };
