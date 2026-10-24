const env = require('../../config/env');
const exotel = require('./exotel');
const mock = require('./mock');

// Cloud telephony behind one interface (Phase 6, D85): connect, test, parseStatus. The test
// provider is offered only in tests and development (never in production).
const PROVIDERS = { exotel, mock };
const mockAllowed = () => env.isTest || env.devTools;

function providerFor(name) {
  if (name === 'mock' && !mockAllowed()) return null;
  if (env.isStaging && name !== 'mock') return null; // F2: no real calls from staging
  return PROVIDERS[name] || null;
}

module.exports = { providerFor, mockAllowed, mock };
