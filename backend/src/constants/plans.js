// The SaaS plans, as data: limits are read from here, never written into the logic
// (services/planService.js applies them). A limit left out means "no limit"; a feature left out
// means the plan does not have it. Prices are per month, before 18% GST.
// D67 (2026-10-10): below BizNuma's ₹999 / 2,999 / 5,999 / 9,999 at every level, with more users,
// numbers and limits, and the paid features one plan earlier. Change the numbers here only.
// aiBudgetShare: the part of AI_MONTHLY_BUDGET_USD a company may spend on the AI assistant a
// month (the Growth plan, also the trial, gets all of it).
const PLANS = Object.freeze({
  starter: {
    name: 'Starter', pricePaise: 79900,
    users: 3, whatsappNumbers: 1, contacts: 5000, broadcastsPerMonth: 20, quotesPerMonth: 1000, templates: 100,
    paymentLinks: true,
    aiBudgetShare: 0.25,
  },
  pro: {
    name: 'Pro', pricePaise: 249900,
    users: 8, whatsappNumbers: 3, contacts: 15000, broadcastsPerMonth: 200, quotesPerMonth: 3000,
    paymentLinks: true, conversionsApi: true, catalog: true, agentNumbers: true,
    aiBudgetShare: 0.5,
  },
  growth: {
    name: 'Growth', pricePaise: 499900,
    users: 15, whatsappNumbers: 5, contacts: 50000, broadcastsPerMonth: 750, quotesPerMonth: 12000,
    paymentLinks: true, conversionsApi: true, catalog: true, agentNumbers: true, advancedAutomation: true, api: true,
    aiBudgetShare: 1,
  },
  scale: {
    name: 'Scale', pricePaise: 849900,
    users: 25, whatsappNumbers: 10, contacts: 150000, broadcastsPerMonth: 1500, quotesPerMonth: 30000,
    paymentLinks: true, conversionsApi: true, catalog: true, agentNumbers: true, advancedAutomation: true, api: true,
    aiBudgetShare: 2,
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
  agentNumbers: "An agent's own WhatsApp number", // its chats go to that agent (D67)
  advancedAutomation: 'Automation workflows',
  api: 'The public API and webhooks',
});
// What every plan has (shown once under the plans). Only what the CRM really does.
const INCLUDED = Object.freeze([
  'WhatsApp for every user: the whole team replies from the shared inbox',
  'Unlimited chats, with the full chat history',
  'The AI reply assistant',
  'Leads from IndiaMART, JustDial, TradeIndia, Facebook, Google Ads and your website',
  'GST quotations, orders, follow-ups and the FAQ bot',
  'Reports, the phone app and notifications',
  "No markup on Meta's WhatsApp charges (Meta bills you directly)",
]);

// Subscription states (Organization.subscription.status). comped: an organization that does not
// pay (those that existed before billing, D48); it keeps its plan without an end date.
const SUBSCRIPTION_STATUSES = Object.freeze(['trialing', 'active', 'past_due', 'halted', 'cancelled', 'expired', 'comped']);

const planOf = (organization) => PLANS[organization?.plan] || PLANS[TRIAL_PLAN];

module.exports = { PLANS, PLAN_KEYS, TRIAL_PLAN, TRIAL_DAYS, PLAN_GST_PCT, LIMITS, FEATURES, INCLUDED, SUBSCRIPTION_STATUSES, planOf };
