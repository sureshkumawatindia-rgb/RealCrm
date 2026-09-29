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
  RATE_LIMIT_API_PER_MINUTE: Joi.number().integer().min(1).default(300),
  RATE_LIMIT_AUTH_PER_MINUTE: Joi.number().integer().min(1).default(20),
  RATE_LIMIT_WEBHOOK_PER_MINUTE: Joi.number().integer().min(1).default(1200),
  // Enquiries per minute from one address to the public website forms.
  RATE_LIMIT_FORM_PER_MINUTE: Joi.number().integer().min(1).default(10),
  JWT_EXPIRES_IN: Joi.string().allow(''),
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
  },
  whatsapp: {
    graphUrl: value.WHATSAPP_GRAPH_URL.replace(/\/+$/, ''),
    graphVersion: value.WHATSAPP_GRAPH_VERSION,
  },
  warnings: [
    ...(value.JWT_EXPIRES_IN ? ['JWT_EXPIRES_IN is no longer used; access tokens use ACCESS_TOKEN_TTL (default 15m).'] : []),
    ...(!value.DATA_ENCRYPTION_KEY ? ['DATA_ENCRYPTION_KEY is not set; secrets are encrypted with GMAIL_TOKEN_ENCRYPTION_KEY until you add it.'] : []),
  ],
};

module.exports = env;
