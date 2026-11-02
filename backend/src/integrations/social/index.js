const meta = require('./meta');
const mock = require('./mock');

// The provider for a connected Page (G8): Meta's Graph API, or the local stand-in.
function providerFor(account) {
  return account?.provider === 'mock' ? mock : meta;
}

module.exports = { providerFor, meta, mock };
