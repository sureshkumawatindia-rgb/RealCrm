// The optional AI assistant (Phase 10D) on the Claude API, as data.
// Models (checked 2026-10-07 in Anthropic's model list): a Sonnet-class model drafts reply
// suggestions for agents, a Haiku-class model answers customers by itself (cheap and quick).
// Both can be changed with AI_SUGGEST_MODEL / AI_AUTOREPLY_MODEL.
const AI_MODELS = Object.freeze({
  suggest: 'claude-sonnet-5-5',
  autoReply: 'claude-haiku-4-5',
});

// US dollars per million tokens (Anthropic's list prices, 2026-09-25): input, output, cache
// read; a 5-minute cache write is 1.25 × input. Used only to estimate each company's spend.
const AI_PRICES = Object.freeze({
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
});
const CACHE_WRITE_FACTOR = 1.25;

const AI_FEATURES = Object.freeze(['suggest', 'auto_reply', 'test']);
const AI_OUTCOMES = Object.freeze(['suggested', 'sent', 'handoff', 'refused', 'error', 'skipped']);

module.exports = { AI_MODELS, AI_PRICES, CACHE_WRITE_FACTOR, AI_FEATURES, AI_OUTCOMES };
