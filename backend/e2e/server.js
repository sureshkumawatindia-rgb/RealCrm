// The server the end-to-end browser tests run against (Phase 2, D114): the real CRM with an
// in-memory MongoDB, the test Google sign-in ("test:<sub>:<email>:<name>") and the developer
// tools on (test WhatsApp numbers, the message simulator). NODE_ENV=test: backend/.env is never
// read and no real database, Meta or payment gateway is ever reached.
// Started by playwright.config.js; by hand: node e2e/server.js (port E2E_PORT, default 3200).
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const PORT = String(process.env.E2E_PORT || 3200);
const fromBackend = (file) => require(path.join(BACKEND, file)); // eslint-disable-line global-require, import/no-dynamic-require

(async () => {
  const { MongoMemoryReplSet } = fromBackend('node_modules/mongodb-memory-server');
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-e2e-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT,
    MONGO_URI: replSet.getUri('crm_e2e'),
    JWT_SECRET: 'e2e-jwt-secret-that-is-long-enough-1234567890',
    GOOGLE_CLIENT_ID: 'e2e-google-client-id',
    GOOGLE_CLIENT_SECRET: 'e2e-google-client-secret',
    GMAIL_TOKEN_ENCRYPTION_KEY: 'e2e-gmail-token-key',
    DATA_ENCRYPTION_KEY: '',
    PUBLIC_URL: `http://127.0.0.1:${PORT}`,
    UPLOAD_DIR: path.join(files, 'uploads'),
    DOCUMENT_DIR: path.join(files, 'documents'),
    LOGIN_WHATSAPP_CODE: 'off',
    DEV_TOOLS: 'on',
    // The browser tests click quickly and from one address: the per-minute limits stay out of the way.
    RATE_LIMIT_API_PER_MINUTE: '100000',
    RATE_LIMIT_AUTH_PER_MINUTE: '100000',
    // The platform admin page's own admin in the help test (e2e/help.spec.js, D118).
    PLATFORM_ADMIN_EMAILS: 'admin@help.test',
  });
  const idToken = require.resolve(path.join(BACKEND, 'src/integrations/google/idToken'));
  require.cache[idToken] = { id: idToken, filename: idToken, loaded: true, exports: fromBackend('src/tests/helpers/fakeGoogle') };
  fromBackend('src/server.js');
  const stop = async () => {
    await replSet.stop();
    fs.rmSync(files, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
