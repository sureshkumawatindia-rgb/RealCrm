const os = require('os');
const path = require('path');

// Runs before any module is loaded in a test file. config/env.js skips backend/.env in tests.
Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGO_URI: process.env.MONGO_TEST_URI,
  JWT_SECRET: 'test-jwt-secret-that-is-long-enough-123456',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GMAIL_TOKEN_ENCRYPTION_KEY: 'test-gmail-token-key',
  DATA_ENCRYPTION_KEY: '',
  PUBLIC_URL: 'http://127.0.0.1:3000',
  UPLOAD_DIR: path.join(os.tmpdir(), `crm-test-uploads-${process.pid}`),
  DOCUMENT_DIR: path.join(os.tmpdir(), `crm-test-documents-${process.pid}`),
  DOCUMENT_MAX_MB: '1',
  RATE_LIMIT_API_PER_MINUTE: '100000',
  RATE_LIMIT_AUTH_PER_MINUTE: '100000',
  RATE_LIMIT_FORM_PER_MINUTE: '30',
  // Most tests sign in with Google alone; tests/login.test.js switches the WhatsApp step on.
  LOGIN_WHATSAPP_CODE: 'off',
  // Test numbers and the simulator (developer test tools) are what most WhatsApp tests use.
  DEV_TOOLS: 'on',
});
