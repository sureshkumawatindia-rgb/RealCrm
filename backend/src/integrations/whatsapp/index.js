const metaCloud = require('./metaCloud');
const mock = require('./mock');

// The provider for a connected number: the real Cloud API, or the local mock.
function providerFor(account) {
  return account.provider === 'mock' ? mock : metaCloud;
}

module.exports = { providerFor };
