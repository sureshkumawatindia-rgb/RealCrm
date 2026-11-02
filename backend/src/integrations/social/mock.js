const crypto = require('crypto');

// Stand-in for Meta's Pages, Messenger and Instagram (G8; development and tests only — the
// server refuses test Pages in production). Nothing leaves this computer.
const sent = []; // what the CRM sent: { pageId, channel, recipientId, text, humanAgent, replyToMid, messageId }
const profiles = new Map(); // customer id → { name, username } (the simulator tells it)
const hex = (n) => crypto.randomBytes(n).toString('hex');

module.exports = {
  available: () => true,
  async exchangeCode() {
    return `mock-user-${hex(6)}`;
  },
  // A new test Page with an Instagram account each time.
  async pages() {
    const id = `${Date.now()}${crypto.randomInt(1000, 9999)}`;
    return [{ id: `9${id}`, name: 'Test Page (mock)', accessToken: `mock-page-${hex(8)}`, instagram: { id: `17${id}`, username: 'test_shop', name: 'Test Shop (mock)' } }];
  },
  async subscribePage() {},
  async unsubscribePage() {},
  async sendText({ pageId }, { channel, recipientId, text, humanAgent = false, replyToMid = '' }) {
    const messageId = `m_MOCK${hex(12)}`;
    sent.push({ pageId, channel, recipientId, text, humanAgent, replyToMid, messageId });
    return { messageId };
  },
  async profile(credentials, { userId }) {
    return profiles.get(String(userId)) || { name: '', username: '' };
  },
  setProfile(userId, profile) {
    profiles.set(String(userId), { name: profile.name || '', username: profile.username || '' });
  },
  sent: () => [...sent],
};
