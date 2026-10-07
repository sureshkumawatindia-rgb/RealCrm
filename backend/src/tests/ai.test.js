jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Anthropic = require('@anthropic-ai/sdk');
const Organization = require('../models/Organization');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const FaqRule = require('../models/FaqRule');
const AiUsage = require('../models/AiUsage');
const Notification = require('../models/Notification');
const queue = require('../jobs/queue');
const engine = require('../services/automation/engine');
const leadRouting = require('../services/leadRoutingService');
const ai = require('../services/aiService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// A stand-in for the Claude API client (no network, no cost in tests).
const fake = {
  calls: [],
  answers: [],
  async answer(beta, params) {
    fake.calls.push({ beta, params });
    const next = fake.answers.shift();
    if (next instanceof Error) throw next;
    return { model: params.model, stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 }, ...next };
  },
};
fake.messages = { parse: (params) => fake.answer(false, params) };
fake.beta = { messages: { parse: (params) => fake.answer(true, params) } };

const settle = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};

describe('AI assistant (Phase 10D)', () => {
  let owner;
  let agent;
  let chat;
  const customerSays = async (from, text, name = '') => (await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from, text, name })).body.data;
  beforeAll(async () => {
    ai.setClient(fake);
    engine.register(queue);
    leadRouting.attach(queue);
    ai.register(queue);
    owner = await login('ai-owner@example.com', { name: 'Asha' });
    agent = await inviteAndJoin(owner.token, 'ai-agent@example.com', { role: 'agent', modules: ['inbox'] });
    await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ name: 'Yellow Traders', city: 'Jaipur', description: 'Wholesale spices since 1998.' });
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    await api().post('/api/v1/products').set(bearer(owner.token)).send({ name: 'Jeera 25kg', sku: 'J25', unit: 'bag', pricePaise: 300000, gstRatePct: 5, moq: 10 });
    await FaqRule.create({ organizationId: owner.data.organizationId, name: 'Delivery time', keywords: ['delivery', 'kab tak'], answer: { text: 'Delivery in 3 to 5 days across Rajasthan.' } });
  });

  it('is off until an owner or admin switches it on', async () => {
    expect((await api().get('/api/v1/ai/status').set(bearer(agent.token))).body.data).toEqual({ available: false, autoReply: false });
    expect((await api().get('/api/v1/ai/settings').set(bearer(agent.token))).status).toBe(403);
    chat = await customerSays('9829011111', 'Jeera ka rate kya hai?', 'Ravi');
    await settle();
    const off = await api().post(`/api/v1/conversations/${chat.conversation?.id || chat.conversationId}/ai/suggest`).set(bearer(owner.token));
    expect(off.body).toMatchObject({ code: 'AI_UNAVAILABLE', message: expect.stringContaining('switched off') });
    const saved = await api().put('/api/v1/ai/settings').set(bearer(owner.token)).send({ enabled: true, instructions: 'Always mention free delivery above 50 bags.' });
    expect(saved.body.data).toMatchObject({ configured: true, enabled: true, autoReply: false, models: { suggest: 'claude-sonnet-5-5', autoReply: 'claude-haiku-4-5' }, month: { calls: 0, budgetUsd: 5 } });
    expect((await api().get('/api/v1/ai/status').set(bearer(agent.token))).body.data).toEqual({ available: true, autoReply: false });
  });

  it('drafts replies for an agent from the company facts, and logs the cost', async () => {
    const conversationId = chat.conversation?.id || chat.conversationId;
    fake.calls = [];
    fake.answers = [{ parsed_output: { suggestions: ['Namaste Ravi ji! Jeera 25kg ₹3,000 per bag + 5% GST.', 'Ji, ₹3,150 per bag with GST, minimum 10 bags.', 'Third', 'Fourth'], note: 'Check stock before confirming.' } }];
    const res = await api().post(`/api/v1/conversations/${conversationId}/ai/suggest`).set(bearer(agent.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ suggestions: ['Namaste Ravi ji! Jeera 25kg ₹3,000 per bag + 5% GST.', 'Ji, ₹3,150 per bag with GST, minimum 10 bags.', 'Third'], note: 'Check stock before confirming.' });
    const [{ beta, params }] = fake.calls;
    expect(beta).toBe(true);
    expect(params).toMatchObject({ model: 'claude-sonnet-5-5', betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low', format: { type: 'json_schema' } } });
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    const system = params.system[0].text;
    expect(system).toContain('- Jeera 25kg (SKU J25): ₹3,000 per bag + 5% GST (₹3,150 with GST); minimum order 10');
    expect(system).toContain('Delivery time (asked as: delivery, kab tak): Delivery in 3 to 5 days across Rajasthan.');
    expect(system).toContain('Always mention free delivery above 50 bags.');
    expect(system).toContain('Location: Jaipur');
    expect(params.messages[0].content).toMatch(/Customer: Jeera ka rate kya hai\?/);
    expect(params.thinking).toBeUndefined();
    const usage = await AiUsage.findOne({ feature: 'suggest' });
    expect(usage).toMatchObject({ outcome: 'suggested', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, costMicros: 5000 });
    expect((await api().get('/api/v1/ai/settings').set(bearer(owner.token))).body.data.month).toMatchObject({ calls: 1, suggested: 1, costUsd: 0.005 });

    // The service is busy: a friendly message, logged.
    fake.answers = [Object.assign(Object.create(Anthropic.RateLimitError.prototype), { message: '429 rate limited', status: 429 })];
    const busy = await api().post(`/api/v1/conversations/${conversationId}/ai/suggest`).set(bearer(agent.token));
    expect(busy.status).toBe(502);
    expect(busy.body).toMatchObject({ code: 'AI_FAILED', message: 'The AI service is busy. Try again in a minute.' });
    // A refusal: no suggestion.
    fake.answers = [{ parsed_output: null, stop_reason: 'refusal' }];
    expect((await api().post(`/api/v1/conversations/${conversationId}/ai/suggest`).set(bearer(agent.token))).body.code).toBe('AI_NO_ANSWER');
    expect(await AiUsage.countDocuments({ outcome: { $in: ['error', 'refused'] } })).toBe(2);
  });

  it('answers customers by itself only when sure, else passes the chat to a person', async () => {
    await api().put('/api/v1/ai/settings').set(bearer(owner.token)).send({ autoReply: true });
    fake.calls = [];
    fake.answers = [{ parsed_output: { reply: 'Ji, delivery 3 se 5 din mein ho jaati hai.', confidence: 'high', handoff: false, reason: 'Delivery time from the FAQ.' } }];
    const kiran = await customerSays('9829022222', 'Delivery kitne din mein?', 'Kiran');
    await settle();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ beta: false, params: { model: 'claude-haiku-4-5', max_tokens: 1024 } });
    expect(fake.calls[0].params.output_config.effort).toBeUndefined();
    const kiranId = kiran.conversation?.id || kiran.conversationId;
    const sent = await Message.findOne({ conversationId: kiranId, direction: 'out' });
    expect(sent).toMatchObject({ text: 'Ji, delivery 3 se 5 din mein ho jaati hai.', automation: { kind: 'ai' } });

    // Not sure: no answer, a bell note, and quiet in this chat for a day.
    fake.answers = [{ parsed_output: { reply: '', confidence: 'low', handoff: true, reason: 'Asks for a discount on 40 bags.' } }];
    await customerSays('9829022222', '40 bag lunga, kuch discount?');
    await settle();
    expect(await Message.countDocuments({ conversationId: kiranId, direction: 'out' })).toBe(1);
    expect((await Conversation.findById(kiranId)).ai).toMatchObject({ handoffReason: 'Asks for a discount on 40 bags.' });
    expect(await Notification.exists({ title: 'The AI assistant passed a chat to you', body: 'Asks for a discount on 40 bags.' })).toBeTruthy();
    fake.calls = [];
    await customerSays('9829022222', 'Hello?');
    await settle();
    expect(fake.calls).toHaveLength(0);

    // A teammate is in the chat: the assistant stays out of it.
    const ravi = chat.conversation?.id || chat.conversationId;
    await api().post(`/api/v1/conversations/${ravi}/messages`).set(bearer(owner.token)).send({ text: 'Namaste Ravi ji' });
    await customerSays('9829011111', 'Aur haldi?');
    await settle();
    expect(fake.calls).toHaveLength(0);
    expect(await AiUsage.countDocuments({ feature: 'auto_reply' })).toBe(2);
  }, 60000);

  it('tests an answer without sending, and stops at the monthly budget', async () => {
    fake.answers = [{ parsed_output: { reply: 'Jeera ₹3,000 per bag + 5% GST.', confidence: 'high', handoff: false, reason: 'Price from the products.' } }];
    const test = await api().post('/api/v1/ai/test').set(bearer(owner.token)).send({ message: 'Jeera rate?' });
    expect(test.body.data).toMatchObject({ reply: 'Jeera ₹3,000 per bag + 5% GST.', handoff: false, confidence: 'high' });
    await AiUsage.create({ organizationId: owner.data.organizationId, feature: 'suggest', outcome: 'suggested', costMicros: 5e6 });
    const chatId = chat.conversation?.id || chat.conversationId;
    // The owner replied in this chat earlier, so it is theirs now (agents see their own and unassigned chats).
    expect((await api().post(`/api/v1/conversations/${chatId}/ai/suggest`).set(bearer(owner.token))).body.message).toBe('This month\'s AI budget is used up; the assistant is back on the 1st.');
    expect((await api().post('/api/v1/ai/test').set(bearer(owner.token)).send({ message: 'x' })).body.code).toBe('AI_UNAVAILABLE');
  });

  it('is paused while the plan is not active, and stays in its company', async () => {
    await AiUsage.deleteMany({});
    await Organization.updateOne({ _id: owner.data.organizationId }, { $set: { 'subscription.status': 'trialing', 'subscription.trialEndsAt': new Date(Date.now() - 1000) } });
    expect((await api().get('/api/v1/ai/status').set(bearer(agent.token))).body.data.available).toBe(false);
    expect((await api().put('/api/v1/ai/settings').set(bearer(owner.token)).send({ enabled: true })).body.code).toBe('SUBSCRIPTION_INACTIVE');
    const stranger = await login('ai-stranger@example.com');
    const chatId = chat.conversation?.id || chat.conversationId;
    expect((await api().post(`/api/v1/conversations/${chatId}/ai/suggest`).set(bearer(stranger.token))).status).toBe(404);
  });
});
