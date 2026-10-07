const Joi = require('joi');

// Tests set their own environment and must never pick up the real backend/.env.
if (process.env.NODE_ENV !== 'test') require('dotenv').config({ quiet: true });

const DEV_ORIGINS = [
  'http://127.0.0.1:3000', 'http://localhost:3000',
  'http://127.0.0.1:5500', 'http://localhost:5500',
  'http://127.0.0.1:5501', 'http://localhost:5501',
];

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  MONGO_URI: Joi.string().pattern(/^mongodb(\+srv)?:\/\//).required()
    .messages({ 'string.pattern.base': 'MONGO_URI must start with mongodb:// or mongodb+srv://' }),
  JWT_SECRET: Joi.string().min(16).required()
    .when('NODE_ENV', { is: 'production', then: Joi.string().min(32) }),
  ACCESS_TOKEN_TTL: Joi.string().pattern(/^\d+[smhd]$/).default('15m'),
  REFRESH_TOKEN_TTL_DAYS: Joi.number().integer().min(1).max(365).default(30),
  GOOGLE_CLIENT_ID: Joi.string().required(),
  GOOGLE_CLIENT_SECRET: Joi.string().allow('').default(''),
  PUBLIC_URL: Joi.string().uri({ scheme: ['http', 'https'] }).default('http://127.0.0.1:3000'),
  GOOGLE_REDIRECT_URI: Joi.string().uri({ scheme: ['http', 'https'] }),
  FRONTEND_URL: Joi.string().uri({ scheme: ['http', 'https'] }),
  GMAIL_TOKEN_ENCRYPTION_KEY: Joi.string().allow('').default(''),
  DATA_ENCRYPTION_KEY: Joi.string().allow('').default('')
    .when('NODE_ENV', { is: 'production', then: Joi.string().min(32).required().disallow('') }),
  UPLOAD_DIR: Joi.string().default('uploads'),
  DOCUMENT_DIR: Joi.string().default('storage/documents'),
  DOCUMENT_MAX_MB: Joi.number().integer().min(1).max(100).default(10),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  // WhatsApp Cloud API (Meta Graph API). Keep the version current (developers.facebook.com/docs/graph-api/changelog).
  WHATSAPP_GRAPH_URL: Joi.string().uri({ scheme: ['http', 'https'] }).default('https://graph.facebook.com'),
  WHATSAPP_GRAPH_VERSION: Joi.string().pattern(/^v\d+\.\d+$/).default('v26.0'),
  // IndiaMART CRM Pull API v2 (changed only for tests).
  INDIAMART_PULL_URL: Joi.string().uri({ scheme: ['http', 'https'] }).default('https://mapi.indiamart.com/wservce/crm/crmListing/v2/'),
  RATE_LIMIT_API_PER_MINUTE: Joi.number().integer().min(1).default(300),
  RATE_LIMIT_AUTH_PER_MINUTE: Joi.number().integer().min(1).default(20),
  RATE_LIMIT_WEBHOOK_PER_MINUTE: Joi.number().integer().min(1).default(1200),
  // Enquiries per minute from one address to the public website forms.
  RATE_LIMIT_FORM_PER_MINUTE: Joi.number().integer().min(1).default(10),
  // Public API requests per minute per API key (Phase 10C).
  RATE_LIMIT_PUBLIC_API_PER_MINUTE: Joi.number().integer().min(1).default(120),
  JWT_EXPIRES_IN: Joi.string().allow(''),
  // SaaS billing (Phase 10): the plans are paid to the platform's own Razorpay account
  // (Subscriptions), not to a company's gateway. mock = a test checkout page on this server
  // (never in production); off = the Choose buttons say to contact support.
  BILLING_PROVIDER: Joi.string().valid('razorpay', 'mock', 'off')
    .default(process.env.NODE_ENV === 'production' ? 'off' : 'mock'),
  RAZORPAY_BILLING_KEY_ID: Joi.string().allow('').default(''),
  RAZORPAY_BILLING_KEY_SECRET: Joi.string().allow('').default(''),
  RAZORPAY_BILLING_WEBHOOK_SECRET: Joi.string().allow('').default(''),
  // Who issues the GST invoices for the plans (the platform's business).
  BILLING_SELLER_NAME: Joi.string().allow('').default(''),
  BILLING_SELLER_GSTIN: Joi.string().allow('').default(''),
  BILLING_SELLER_ADDRESS: Joi.string().allow('').default(''),
  BILLING_SELLER_EMAIL: Joi.string().allow('').default(''),
  BILLING_SAC: Joi.string().pattern(/^\d{4,8}$/).default('998315'),
  BILLING_INVOICE_PREFIX: Joi.string().pattern(/^[A-Z0-9-]{1,8}$/).default('YC'),
  // The optional AI assistant (Phase 10D) on the platform's own Claude API key. Without a key the
  // assistant is not offered. Each company may spend up to AI_MONTHLY_BUDGET_USD a month.
  ANTHROPIC_API_KEY: Joi.string().allow('').default(''),
  // Web push (Phase 10E): VAPID keys (base64url; made once and kept in the database when empty)
  // and who sends (mailto: or https: address).
  VAPID_PUBLIC_KEY: Joi.string().allow('').default(''),
  VAPID_PRIVATE_KEY: Joi.string().allow('').default(''),
  VAPID_SUBJECT: Joi.string().pattern(/^(mailto:|https:\/\/)/).allow('').default(''),
  AI_SUGGEST_MODEL: Joi.string().allow('').default(''),
  AI_AUTOREPLY_MODEL: Joi.string().allow('').default(''),
  AI_MONTHLY_BUDGET_USD: Joi.number().min(0).default(5),
  // default = on a safety refusal the Claude API retries on another model by itself (Sonnet 5.5).
  AI_REFUSAL_FALLBACK: Joi.string().valid('default', 'off').default('default'),
}).unknown(true);

const { error, value } = schema.validate(process.env, { abortEarly: false });
if (error) {
  // Only key names and rules are reported, never the values.
  const problems = error.details.map((detail) => `- ${detail.message.replace(/"/g, '')}`).join('\n');
  const message = `Invalid environment configuration (backend/.env):\n${problems}`;
  if (value.NODE_ENV === 'test') throw new Error(message);
  console.error(message);
  process.exit(1);
}

const publicUrl = value.PUBLIC_URL.replace(/\/+$/, '');
const frontendUrl = value.FRONTEND_URL || `${publicUrl}/crm/frontend`;
const configuredOrigins = value.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
const isProduction = value.NODE_ENV === 'production';

const env = {
  port: value.PORT,
  nodeEnv: value.NODE_ENV,
  isProduction,
  isTest: value.NODE_ENV === 'test',
  mongoUri: value.MONGO_URI,
  googleClientId: value.GOOGLE_CLIENT_ID,
  googleClientSecret: value.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: value.GOOGLE_REDIRECT_URI || `${publicUrl}/api/v1/gmail/oauth/callback`,
  frontendUrl,
  gmailTokenEncryptionKey: value.GMAIL_TOKEN_ENCRYPTION_KEY,
  dataEncryptionKey: value.DATA_ENCRYPTION_KEY,
  publicUrl,
  uploadDir: value.UPLOAD_DIR,
  documentDir: value.DOCUMENT_DIR,
  documentMaxBytes: value.DOCUMENT_MAX_MB * 1024 * 1024,
  jwtSecret: value.JWT_SECRET,
  accessTokenTtl: value.ACCESS_TOKEN_TTL,
  refreshTokenTtlDays: value.REFRESH_TOKEN_TTL_DAYS,
  corsOrigins: [...new Set([
    ...configuredOrigins,
    new URL(publicUrl).origin,
    new URL(frontendUrl).origin,
    ...(isProduction ? [] : DEV_ORIGINS),
  ])],
  rateLimit: {
    apiPerMinute: value.RATE_LIMIT_API_PER_MINUTE,
    authPerMinute: value.RATE_LIMIT_AUTH_PER_MINUTE,
    webhookPerMinute: value.RATE_LIMIT_WEBHOOK_PER_MINUTE,
    formPerMinute: value.RATE_LIMIT_FORM_PER_MINUTE,
    publicApiPerMinute: value.RATE_LIMIT_PUBLIC_API_PER_MINUTE,
  },
  leadSources: {
    indiamartUrl: value.INDIAMART_PULL_URL,
  },
  whatsapp: {
    graphUrl: value.WHATSAPP_GRAPH_URL.replace(/\/+$/, ''),
    graphVersion: value.WHATSAPP_GRAPH_VERSION,
  },
  push: {
    publicKey: value.VAPID_PUBLIC_KEY,
    privateKey: value.VAPID_PRIVATE_KEY,
    subject: value.VAPID_SUBJECT,
  },
  ai: {
    apiKey: value.ANTHROPIC_API_KEY,
    suggestModel: value.AI_SUGGEST_MODEL,
    autoReplyModel: value.AI_AUTOREPLY_MODEL,
    monthlyBudgetUsd: value.AI_MONTHLY_BUDGET_USD,
    refusalFallback: value.AI_REFUSAL_FALLBACK,
  },
  billing: {
    provider: value.NODE_ENV === 'production' && value.BILLING_PROVIDER === 'mock' ? 'off' : value.BILLING_PROVIDER,
    razorpay: {
      keyId: value.RAZORPAY_BILLING_KEY_ID,
      keySecret: value.RAZORPAY_BILLING_KEY_SECRET,
      webhookSecret: value.RAZORPAY_BILLING_WEBHOOK_SECRET,
    },
    seller: {
      name: value.BILLING_SELLER_NAME,
      gstin: value.BILLING_SELLER_GSTIN.trim().toUpperCase(),
      address: value.BILLING_SELLER_ADDRESS,
      email: value.BILLING_SELLER_EMAIL,
    },
    sac: value.BILLING_SAC,
    invoicePrefix: value.BILLING_INVOICE_PREFIX,
  },
  warnings: [
    ...(value.BILLING_PROVIDER === 'razorpay' && !(value.RAZORPAY_BILLING_KEY_ID && value.RAZORPAY_BILLING_KEY_SECRET && value.RAZORPAY_BILLING_WEBHOOK_SECRET)
      ? ['BILLING_PROVIDER is razorpay but a RAZORPAY_BILLING_* key is missing; plans cannot be bought until they are set.'] : []),
    ...(value.JWT_EXPIRES_IN ? ['JWT_EXPIRES_IN is no longer used; access tokens use ACCESS_TOKEN_TTL (default 15m).'] : []),
    ...(!value.DATA_ENCRYPTION_KEY ? ['DATA_ENCRYPTION_KEY is not set; secrets are encrypted with GMAIL_TOKEN_ENCRYPTION_KEY until you add it.'] : []),
  ],
};

module.exports = env;
