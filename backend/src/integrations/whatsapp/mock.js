const crypto = require('crypto');

// Stand-in for the Cloud API while there is no Meta account (development and tests only; the
// server refuses mock numbers in production). Nothing leaves this computer.
module.exports = {
  async getPhoneNumber() {
    return { displayPhone: '+91 90000 00000', verifiedName: 'Test Business (mock)', qualityRating: 'GREEN' };
  },

  async sendMessage() {
    return { providerMessageId: `wamid.MOCK${crypto.randomBytes(12).toString('hex')}` };
  },
};
