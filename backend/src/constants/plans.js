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
// D125 (2026-11-11, the launch plans, the owner's own numbers): ₹799 / 1,999 / 3,999 / 7,999 /
// 14,999 a month; Starter 1 WhatsApp number, Pro 3, Growth 5, Scale 10, Infinite 20; the API
// from Scale up. Yearly: Infinite ₹79,999 (the owner's price); the others at the same share of
// twelve months (about 5.3 months' price, rounded to ...99). yearlyPricePaise is before GST too.
const MAX_WHATSAPP_NUMBERS = 20;
const PLANS = Object.freeze({
  starter: {
    name: 'Starter', pricePaise: 79900, yearlyPricePaise: 429900,
    users: 5, agents: 4, whatsappNumbers: 1, contacts: 5000, broadcastsPerMonth: 20, quotesPerMonth: 1000, templates: 50,
    paymentLinks: true,
    aiBudgetShare: 0.25,
  },
  pro: {
    name: 'Pro', pricePaise: 199900, yearlyPricePaise: 1069900,
    users: 15, agents: 12, whatsappNumbers: 3, contacts: 20000, broadcastsPerMonth: 200, quotesPerMonth: 5000, templates: 200,
    paymentLinks: true, conversionsApi: true, catalog: true, agentNumbers: true,
    aiBudgetShare: 0.5,
  },
  growth: {
    name: 'Growth', pricePaise: 399900, yearlyPricePaise: 2129900,
    users: 30, agents: 24, whatsappNumbers: 5, contacts: 60000, broadcastsPerMonth: 1000, quotesPerMonth: 20000,
    paymentLinks: true, conversionsApi: true, catalog: true, agentNumbers: true, advancedAutomation: true,
    aiBudgetShare: 1,
  },
  scale: {
    name: 'Scale', pricePaise: 799900, yearlyPricePaise: 4269900,
    users: 60, agents: 48, whatsappNumbers: 10, contacts: 200000, broadcastsPerMonth: 5000, quotesPerMonth: 50000,
    paymentLinks: true, conversionsApi: true, catalog: true, agentNumbers: true, advancedAutomation: true, api: true,
    aiBudgetShare: 2,
  },
  infinite: {
    name: 'Infinite', pricePaise: 1499900, yearlyPricePaise: 7999900,
    whatsappNumbers: MAX_WHATSAPP_NUMBERS,
    paymentLinks: true, conversionsApi: true, catalog: true, agentNumbers: true, advancedAutomation: true, api: true,
    aiBudgetShare: 4,
  },
});
const PLAN_KEYS = Object.freeze(Object.keys(PLANS));
// How often a plan is paid for (D125): every month, or a year at once.
const BILLING_INTERVALS = Object.freeze(['monthly', 'yearly']);
// A new organization tries the Growth plan for 3 days (D48; 30 days until D125).
const TRIAL_PLAN = 'growth';
const TRIAL_DAYS = 3;
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
// What is counted but limited by no plan (Phase 3A, D80): shown next to the limits so the company
// sees all it uses on one screen. Limits for these are a pricing decision, not made yet.
// unit: count | bytes. monthly: counted from the 1st (India).
const METERS = Object.freeze({
  apiCallsPerMonth: { label: 'API calls this month', unit: 'count', monthly: true },
  webhookSendsPerMonth: { label: 'Webhook sends this month', unit: 'count', monthly: true },
  workflowRunsPerMonth: { label: 'Workflow runs this month', unit: 'count', monthly: true },
  fileBytes: { label: 'Files in Documents', unit: 'bytes' },
  customFields: { label: 'Custom fields', unit: 'count' },
  customObjects: { label: 'Custom objects', unit: 'count' },
});
// The owners and admins hear when a limit is this full (percent), once per level per period.
const ALERT_LEVELS = Object.freeze([80, 100]);

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

module.exports = { PLANS, PLAN_KEYS, BILLING_INTERVALS, MAX_WHATSAPP_NUMBERS, TRIAL_PLAN, TRIAL_DAYS, PLAN_GST_PCT, LIMITS, METERS, ALERT_LEVELS, FEATURES, INCLUDED, SUBSCRIPTION_STATUSES, planOf };
