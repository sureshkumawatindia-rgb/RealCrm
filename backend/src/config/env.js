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
  // agreem360's own website (D149): the names whose root address opens it (agreem360.html); any
  // other name (the CRM's, crm.agreem360.com) opens the CRM's home page.
  SITE_HOSTS: Joi.string().allow('').default('agreem360.com,www.agreem360.com'),
  GOOGLE_REDIRECT_URI: Joi.string().uri({ scheme: ['http', 'https'] }),
  // Microsoft 365 (Phase 4B, D83): an app registered in Microsoft Entra ID. Without a client id the
  // Microsoft connection is off, or the mock when DEV_TOOLS=on (never in production).
  MICROSOFT_CLIENT_ID: Joi.string().allow('').default(''),
  MICROSOFT_CLIENT_SECRET: Joi.string().allow('').default(''),
  MICROSOFT_TENANT: Joi.string().pattern(/^[A-Za-z0-9.-]+$/).default('common'),
  MICROSOFT_REDIRECT_URI: Joi.string().uri({ scheme: ['http', 'https'] }),
  FRONTEND_URL: Joi.string().uri({ scheme: ['http', 'https'] }),
  GMAIL_TOKEN_ENCRYPTION_KEY: Joi.string().allow('').default(''),
  DATA_ENCRYPTION_KEY: Joi.string().allow('').default('')
    .when('NODE_ENV', { is: 'production', then: Joi.string().min(32).required().disallow('') }),
  UPLOAD_DIR: Joi.string().default('uploads'),
  DOCUMENT_DIR: Joi.string().default('storage/documents'),
  // Where files live (F5): disk = UPLOAD_DIR and DOCUMENT_DIR on this server; r2 = Cloudflare R2
  // (S3 protocol), so more than one server can run. With r2, files not found there are still read
  // from the disk folders until the copy (scripts/files-to-r2.js) is done.
  STORAGE_DRIVER: Joi.string().valid('disk', 'r2').default('disk'),
  STORAGE_DISK_FALLBACK: Joi.boolean().truthy('on').falsy('off').default(true),
  R2_ACCOUNT_ID: Joi.string().pattern(/^[A-Za-z0-9]{8,64}$/).allow('').default(''),
  R2_ACCESS_KEY_ID: Joi.string().allow('').default('')
    .when('STORAGE_DRIVER', { is: 'r2', then: Joi.string().required().disallow('') }),
  R2_SECRET_ACCESS_KEY: Joi.string().allow('').default('')
    .when('STORAGE_DRIVER', { is: 'r2', then: Joi.string().required().disallow('') }),
  R2_BUCKET: Joi.string().pattern(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).allow('').default('')
    .when('STORAGE_DRIVER', { is: 'r2', then: Joi.string().required().disallow('') }),
  // The weekly backup copy (F4a): its own bucket; empty = no weekly copy.
  R2_BACKUP_BUCKET: Joi.string().pattern(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).allow('').default(''),
  BACKUP_KEEP_WEEKS: Joi.number().integer().min(1).max(104).default(8),
  // Another S3-compatible address instead of <account>.r2.cloudflarestorage.com (tests).
  R2_ENDPOINT: Joi.string().uri({ scheme: ['http', 'https'] }).allow('').default(''),
  DOCUMENT_MAX_MB: Joi.number().integer().min(1).max(100).default(10),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  // WhatsApp Cloud API (Meta Graph API). Keep the version current (developers.facebook.com/docs/graph-api/changelog).
  WHATSAPP_GRAPH_URL: Joi.string().uri({ scheme: ['http', 'https'] }).default('https://graph.facebook.com'),
  WHATSAPP_GRAPH_VERSION: Joi.string().pattern(/^v\d+\.\d+$/).default('v26.0'),
  // "Connect WhatsApp" (Embedded Signup + WhatsApp Business app coexistence, D60): the
  // platform's own Meta app as a Tech Provider. Without all of them the button says the
  // connection is still being set up (docs/WHATSAPP_SETUP.md).
  META_APP_ID: Joi.string().pattern(/^\d*$/).allow('').default(''),
  META_APP_SECRET: Joi.string().allow('').default(''),
  META_ES_CONFIG_ID: Joi.string().pattern(/^\d*$/).allow('').default(''),
  // G8 (D112): the Facebook Login for Business configuration that connects Pages for Instagram
  // and Messenger (with META_APP_ID and META_APP_SECRET; docs/INSTAGRAM_MESSENGER_SETUP.md).
  META_SOCIAL_CONFIG_ID: Joi.string().pattern(/^\d*$/).allow('').default(''),
  META_WEBHOOK_VERIFY_TOKEN: Joi.string().allow('').default(''),
  // Developer test tools (test numbers, the message simulator): never in production, and in
  // development and staging only when switched on.
  DEV_TOOLS: Joi.boolean().truthy('on').falsy('off').default(false),
  // Which copy of the CRM this is (F2): production, or staging (production settings, made-up
  // data, and the test stand-ins instead of real WhatsApp, SMS, calls, Google and Microsoft).
  APP_ENV: Joi.string().valid('production', 'staging', 'development', 'test'),
  // The live inbox across servers (F6, realtime/relay.js): on by default in production.
  REALTIME_RELAY: Joi.boolean().truthy('on').falsy('off').default(process.env.NODE_ENV === 'production'),
  // Error reports to Sentry (F3). Without a DSN nothing is sent.
  SENTRY_DSN: Joi.string().uri({ scheme: ['http', 'https'] }).allow('').default(''),
  SENTRY_ENVIRONMENT: Joi.string().pattern(/^[A-Za-z0-9_.-]{1,64}$/).allow('').default(''),
  // IndiaMART CRM Pull API v2 (changed only for tests).
  INDIAMART_PULL_URL: Joi.string().uri({ scheme: ['http', 'https'] }).default('https://mapi.indiamart.com/wservce/crm/crmListing/v2/'),
  RATE_LIMIT_API_PER_MINUTE: Joi.number().integer().min(1).default(300),
  RATE_LIMIT_AUTH_PER_MINUTE: Joi.number().integer().min(1).default(20),
  RATE_LIMIT_WEBHOOK_PER_MINUTE: Joi.number().integer().min(1).default(1200),
  // Enquiries per minute from one address to the public website forms.
  RATE_LIMIT_FORM_PER_MINUTE: Joi.number().integer().min(1).default(10),
  // Company checks per minute from one address on the login page (D66).
  RATE_LIMIT_WORKSPACE_PER_MINUTE: Joi.number().integer().min(1).default(30),
  // Public API requests per minute per API key (Phase 10C).
  RATE_LIMIT_PUBLIC_API_PER_MINUTE: Joi.number().integer().min(1).default(120),
  JWT_EXPIRES_IN: Joi.string().allow(''),
  // Behind a reverse proxy or hosting platform (Phase 10F, docs/DEPLOYMENT.md): how many proxies
  // to trust for the client's address and https (Express "trust proxy"); 0 = none (this computer).
  TRUST_PROXY: Joi.number().integer().min(0).max(5).default(0),
  // How many days a company asked to be deleted keeps working before its data is removed.
  ORG_DELETION_GRACE_DAYS: Joi.number().integer().min(1).max(60).default(7),
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
  BILLING_INVOICE_PREFIX: Joi.string().pattern(/^[A-Z0-9-]{1,8}$/).default('AC'), // AgreemCRM (D125; YC before)
  // The platform's own emails (D104, docs/EMAIL_SETUP.md): invites, trial and payment notes, plan
  // invoices, deletion warnings and new-login alerts, sent through Resend. Without both keys
  // nothing is emailed (the bell and the links keep working); EMAIL_FROM is "Name <address>" or
  // an address on a domain verified in Resend.
  RESEND_API_KEY: Joi.string().allow('').default(''),
  EMAIL_FROM: Joi.string().trim().pattern(/^(?:[^<>]+<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/).allow('').default('')
    .messages({ 'string.pattern.base': 'EMAIL_FROM must be an email address, or "Name <address>"' }),
  // The platform's admins (D104): the Google sign-in emails, comma-separated, that may open the
  // platform admin page — and only after 2-step login with the authenticator app.
  PLATFORM_ADMIN_EMAILS: Joi.string().allow('').default(''),
  // The optional AI assistant (Phase 10D) on the platform's own Claude API key. Without a key the
  // assistant is not offered. Each company may spend up to AI_MONTHLY_BUDGET_USD a month.
  ANTHROPIC_API_KEY: Joi.string().allow('').default(''),
  // Phone sign-in with a WhatsApp code (Phase 10E) from the platform's own number and approved
  // AUTHENTICATION template. mock = development: nothing is sent, the code is in the server log
  // (never on screen, D60).
  OTP_PROVIDER: Joi.string().valid('whatsapp', 'mock', 'off').default(process.env.NODE_ENV === 'production' ? 'off' : 'mock'),
  // The WhatsApp code after Google (D58; whenever OTP_PROVIDER can send codes). Since D60:
  // optional (default) = only people who switch on 2-step verification in Settings → Your
  // Profile; required = everyone; off = Google alone for all.
  LOGIN_WHATSAPP_CODE: Joi.string().valid('required', 'optional', 'off').default('optional'),
  // 2-step login with an authenticator app (F7): owners and admins must turn it on within
  // TOTP_GRACE_DAYS of first being asked; off = optional for everyone.
  TOTP_REQUIRED_FOR_MANAGERS: Joi.boolean().truthy('on').falsy('off').default(true),
  TOTP_GRACE_DAYS: Joi.number().integer().min(0).max(90).default(7),
  WHATSAPP_OTP_PHONE_NUMBER_ID: Joi.string().allow('').default(''),
  WHATSAPP_OTP_ACCESS_TOKEN: Joi.string().allow('').default(''),
  WHATSAPP_OTP_TEMPLATE: Joi.string().allow('').default(''),
  WHATSAPP_OTP_LANGUAGE: Joi.string().default('en'),
  // The SMS backup for login codes (2026-10-08): MSG91's OTP API with a DLT-approved template.
  // mock = development (the code comes back in the answer), off = no "Get the code by SMS".
  SMS_PROVIDER: Joi.string().valid('msg91', 'mock', 'off').default(process.env.NODE_ENV === 'production' ? 'off' : 'mock'),
  MSG91_AUTH_KEY: Joi.string().allow('').default(''),
  MSG91_OTP_TEMPLATE_ID: Joi.string().allow('').default(''),
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
if (!error && value.STORAGE_DRIVER === 'r2' && !value.R2_ACCOUNT_ID && !value.R2_ENDPOINT) {
  const message = 'Invalid environment configuration (backend/.env):\n- R2_ACCOUNT_ID is required when STORAGE_DRIVER is r2';
  if (value.NODE_ENV === 'test') throw new Error(message);
  console.error(message);
  process.exit(1);
}
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
const appEnv = value.APP_ENV || (isProduction ? 'production' : value.NODE_ENV);

const env = {
  port: value.PORT,
  nodeEnv: value.NODE_ENV,
  isProduction,
  isTest: value.NODE_ENV === 'test',
  appEnv,
  isStaging: appEnv === 'staging',
  // The deployed commit (Render sets RENDER_GIT_COMMIT): on /health and in error reports.
  release: String(process.env.RENDER_GIT_COMMIT || process.env.APP_VERSION || '').slice(0, 12),
  realtimeRelay: value.REALTIME_RELAY,
  sentry: {
    dsn: value.SENTRY_DSN,
    environment: value.SENTRY_ENVIRONMENT || appEnv,
  },
  mongoUri: value.MONGO_URI,
  googleClientId: value.GOOGLE_CLIENT_ID,
  googleClientSecret: value.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: value.GOOGLE_REDIRECT_URI || `${publicUrl}/api/v1/gmail/oauth/callback`,
  frontendUrl,
  gmailTokenEncryptionKey: value.GMAIL_TOKEN_ENCRYPTION_KEY,
  dataEncryptionKey: value.DATA_ENCRYPTION_KEY,
  publicUrl,
  siteHosts: value.SITE_HOSTS.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean),
  uploadDir: value.UPLOAD_DIR,
  documentDir: value.DOCUMENT_DIR,
  storage: {
    driver: value.STORAGE_DRIVER,
    diskFallback: value.STORAGE_DISK_FALLBACK,
    r2: {
      accountId: value.R2_ACCOUNT_ID,
      accessKeyId: value.R2_ACCESS_KEY_ID,
      secretAccessKey: value.R2_SECRET_ACCESS_KEY,
      bucket: value.R2_BUCKET,
      backupBucket: value.R2_BACKUP_BUCKET,
      endpoint: value.R2_ENDPOINT.replace(/\/+$/, ''),
    },
    backupKeepWeeks: value.BACKUP_KEEP_WEEKS,
  },
  documentMaxBytes: value.DOCUMENT_MAX_MB * 1024 * 1024,
  trustProxy: value.TRUST_PROXY,
  orgDeletionGraceDays: value.ORG_DELETION_GRACE_DAYS,
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
    workspacePerMinute: value.RATE_LIMIT_WORKSPACE_PER_MINUTE,
  },
  leadSources: {
    indiamartUrl: value.INDIAMART_PULL_URL,
  },
  whatsapp: {
    graphUrl: value.WHATSAPP_GRAPH_URL.replace(/\/+$/, ''),
    graphVersion: value.WHATSAPP_GRAPH_VERSION,
  },
  meta: {
    appId: value.META_APP_ID,
    appSecret: value.META_APP_SECRET,
    esConfigId: value.META_ES_CONFIG_ID,
    socialConfigId: value.META_SOCIAL_CONFIG_ID,
    webhookVerifyToken: value.META_WEBHOOK_VERIFY_TOKEN,
  },
  // Read each time, so it can never be on in production (staging runs with production settings
  // and may switch it on: its data is made up).
  get devTools() {
    return (!this.isProduction || this.isStaging) && value.DEV_TOOLS;
  },
  login: {
    whatsappCode: value.LOGIN_WHATSAPP_CODE,
    totpRequiredForManagers: value.TOTP_REQUIRED_FOR_MANAGERS,
    totpGraceDays: value.TOTP_GRACE_DAYS,
  },
  otp: {
    provider: value.NODE_ENV === 'production' && value.OTP_PROVIDER === 'mock' ? 'off' : value.OTP_PROVIDER,
    phoneNumberId: value.WHATSAPP_OTP_PHONE_NUMBER_ID,
    accessToken: value.WHATSAPP_OTP_ACCESS_TOKEN,
    template: value.WHATSAPP_OTP_TEMPLATE,
    language: value.WHATSAPP_OTP_LANGUAGE,
  },
  sms: {
    provider: value.NODE_ENV === 'production' && value.SMS_PROVIDER === 'mock' ? 'off' : value.SMS_PROVIDER,
    msg91AuthKey: value.MSG91_AUTH_KEY,
    msg91TemplateId: value.MSG91_OTP_TEMPLATE_ID,
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
  microsoft: {
    clientId: value.MICROSOFT_CLIENT_ID,
    clientSecret: value.MICROSOFT_CLIENT_SECRET,
    tenant: value.MICROSOFT_TENANT,
    redirectUri: value.MICROSOFT_REDIRECT_URI || `${publicUrl}/api/v1/integrations/microsoft/callback`,
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
  email: {
    resendApiKey: value.RESEND_API_KEY,
    from: value.EMAIL_FROM,
  },
  platformAdminEmails: value.PLATFORM_ADMIN_EMAILS.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean),
  warnings: [
    ...(value.BILLING_PROVIDER === 'razorpay' && !(value.RAZORPAY_BILLING_KEY_ID && value.RAZORPAY_BILLING_KEY_SECRET && value.RAZORPAY_BILLING_WEBHOOK_SECRET)
      ? ['BILLING_PROVIDER is razorpay but a RAZORPAY_BILLING_* key is missing; plans cannot be bought until they are set.'] : []),
    ...(value.JWT_EXPIRES_IN ? ['JWT_EXPIRES_IN is no longer used; access tokens use ACCESS_TOKEN_TTL (default 15m).'] : []),
    ...(!value.DATA_ENCRYPTION_KEY ? ['DATA_ENCRYPTION_KEY is not set; secrets are encrypted with GMAIL_TOKEN_ENCRYPTION_KEY until you add it.'] : []),
    ...(Boolean(value.RESEND_API_KEY) !== Boolean(value.EMAIL_FROM) ? ['RESEND_API_KEY and EMAIL_FROM go together; no email is sent until both are set.'] : []),
  ],
};

module.exports = env;
