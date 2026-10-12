// The SaaS plans, as data: limits are read from here, never written into the logic
// (services/planService.js applies them). A limit left out means "no limit"; a feature left out
// means the plan does not have it. Prices are per month, before 18% GST.
// D67 (2026-10-10): below BizNuma's ₹999 / 2,999 / 5,999 / 9,999 at every level, with more users,
// numbers and limits, and the paid features one plan earlier. Change the numbers here only.
// aiBudgetShare: the part of AI_MONTHLY_BUDGET_USD a company may spend on the AI assistant a
// month (the Growth plan, also the trial, gets all of it).
// D68: users are the whole team (admins, agents and viewers; the owner is one of them) and
// agents (the agent role) are a limit of their own within it; a WhatsApp number per agent, up to
// 20, Meta's maximum for one business. Infinite has no limits but those two.
// D69 (2026-10-12): contacts, broadcasts, quotations and templates are twice BizNuma's
// (3,000 / 10,000 / 40,000 / 1,00,000 contacts; 10 / 100 / 500 / 1,000 broadcasts; 1,000 / 2,500 /
// 10,000 / 25,000 quotations; 50 templates on Starter); prices stay below BizNuma's.
const MAX_WHATSAPP_NUMBERS = 20;
const PLANS = Object.freeze({
  starter: {
    name: 'Starter', pricePaise: 79900,
    users: 8, agents: 8, whatsappNumbers: 8, contacts: 6000, broadcastsPerMonth: 20, quotesPerMonth: 2000, templates: 100,
    paymentLinks: true,
    aiBudgetShare: 0.25,
  },
  pro: {
    name: 'Pro', pricePaise: 249900,
    users: 16, agents: 12, whatsappNumbers: 12, contacts: 20000, broadcastsPerMonth: 200, quotesPerMonth: 5000,
    paymentLinks: true, conversionsApi: true, catalog: true, agentNumbers: true,
    aiBudgetShare: 0.5,
  },
  growth: {
    name: 'Growth', pricePaise: 499900,
    users: 30, agents: 20, whatsappNumbers: MAX_WHATSAPP_NUMBERS, contacts: 80000, broadcastsPerMonth: 1000, quotesPerMonth: 20000,
    paymentLinks: true, conversionsApi: true, catalog: true, agentNumbers: true, advancedAutomation: true, api: true,
    aiBudgetShare: 1,
  },
  scale: {
    name: 'Scale', pricePaise: 849900,
    users: 50, agents: 40, whatsappNumbers: MAX_WHATSAPP_NUMBERS, contacts: 200000, broadcastsPerMonth: 2000, quotesPerMonth: 50000,
    paymentLinks: true, conversionsApi: true, catalog: true, agentNumbers: true, advancedAutomation: true, api: true,
    aiBudgetShare: 2,
  },
  infinite: {
    name: 'Infinite', pricePaise: 1499900,
    whatsappNumbers: MAX_WHATSAPP_NUMBERS,
    paymentLinks: true, conversionsApi: true, catalog: true, agentNumbers: true, advancedAutomation: true, api: true,
    aiBudgetShare: 4,
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
  agents: { label: 'Agents', noun: 'agents' },
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

module.exports = { PLANS, PLAN_KEYS, MAX_WHATSAPP_NUMBERS, TRIAL_PLAN, TRIAL_DAYS, PLAN_GST_PCT, LIMITS, FEATURES, INCLUDED, SUBSCRIPTION_STATUSES, planOf };
