jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Conversation = require('../models/Conversation');
const FaqRule = require('../models/FaqRule');
const LeadActivity = require('../models/LeadActivity');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const queue = require('../jobs/queue');
const mock = require('../integrations/whatsapp/mock');
const engine = require('../services/automation/engine');
const sequenceEngine = require('../services/automation/sequences');
const leadRouting = require('../services/leadRoutingService');
const { matchesAny } = require('../services/automation/bot');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};
const ALWAYS_OPEN = { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' };

beforeAll(() => {
  leadRouting.attach(queue);
  engine.register(queue);
  sequenceEngine.register(queue);
});
afterAll(() => queue.stop());

describe('Keyword matching', () => {
  it('matches whole words or phrases in any script, capitals ignored', () => {
    expect(matchesAny(['rate'], 'Cumin ka RATE kya hai?')).toBe(true);
    expect(matchesAny(['rate'], 'Is this accurate?')).toBe(false);
    expect(matchesAny(['price list'], 'send the price   list please')).toBe(true);
    expect(matchesAny(['दाम'], 'जीरे का दाम क्या है?')).toBe(true);
    expect(matchesAny(['दाम'], 'दामाद')).toBe(false);
    expect(matchesAny(['baat karni hai'], 'mujhe aapse baat karni hai')).toBe(true);
    expect(matchesAny([], 'anything')).toBe(false);
  });
});

describe('WhatsApp FAQ bot', () => {
  let owner;
  let sent = [];
  let wamids = 0;
  let priceRule;
  const auth = () => bearer(owner.token);
  const inbound = async (from, text, extra = {}) => {
    const res = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(auth()).send({ from, name: extra.name || 'Buyer', text, ...extra });
    if (res.status !== 201) throw new Error(`inbound: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const botMessages = (conversationId) => Message.find({ conversationId, direction: 'out', 'automation.kind': 'bot' }).sort({ createdAt: 1 });
  const saveSettings = (body) => api().put('/api/v1/bot/settings').set(auth()).send(body);
  const createRule = async (body) => {
    const res = await api().post('/api/v1/faq-rules').set(auth()).send(body);
    if (res.status !== 201) throw new Error(`rule: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  };

  beforeAll(async () => {
    owner = await login('bot-owner@example.com', { name: 'Asha' });
    await api().patch('/api/v1/organization').set(auth()).send({ name: 'Yellow Traders' });
    await api().put('/api/v1/organization/business-hours').set(auth()).send(ALWAYS_OPEN);
    await api().post('/api/v1/whatsapp/accounts').set(auth()).send({ provider: 'mock' });
  });
  beforeEach(() => {
    sent = [];
    jest.spyOn(mock, 'sendMessage').mockImplementation(async (credentials, body) => {
      sent.push(body);
      wamids += 1;
      return { providerMessageId: `wamid.BOT${wamids}` };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('is off until turned on, and only owners and admins set it up', async () => {
    const settings = await api().get('/api/v1/bot/settings').set(auth());
    expect(settings.body.data).toMatchObject({ enabled: false, greeting: { enabled: true }, away: { enabled: true }, repeatAfterHours: 24 });
    expect(settings.body.data.handoff.keywords).toContain('agent');
    const agent = await inviteAndJoin(owner.token, 'bot-agent@example.com', { role: 'agent', modules: ['inbox', 'automation'] });
    expect((await api().get('/api/v1/faq-rules').set(bearer(agent.token))).status).toBe(403);
    expect((await api().put('/api/v1/bot/settings').set(bearer(agent.token)).send({ enabled: true })).status).toBe(403);
    expect((await api().get('/api/v1/bot/status').set(bearer(agent.token))).body.data).toEqual({ enabled: false });

    const chat = await inbound('98290 50001', 'Hello');
    await settle();
    expect(await botMessages(chat.conversationId)).toHaveLength(0);
  });

  it('checks answers against WhatsApp\'s limits and the organization\'s own answers', async () => {
    const statuses = [
      await api().post('/api/v1/faq-rules').set(auth()).send({ name: 'x', answer: { text: 'Hi', options: [{ title: 'This title is too long!', action: 'handoff' }] } }),
      await api().post('/api/v1/faq-rules').set(auth()).send({ name: 'x', answer: { text: 'Hi', options: Array.from({ length: 11 }, (_, i) => ({ title: `Option ${i}`, action: 'handoff' })) } }),
      await api().post('/api/v1/faq-rules').set(auth()).send({ name: 'x', answer: { text: 'Hi', options: [{ title: 'Same', action: 'handoff' }, { title: 'same', action: 'handoff' }] } }),
      await api().post('/api/v1/faq-rules').set(auth()).send({ name: 'x', answer: { text: '' } }),
      await api().post('/api/v1/faq-rules').set(auth()).send({ name: 'x', answer: { text: 'Hi', footer: 'f'.repeat(61) } }),
    ].map((res) => res.status);
    expect(statuses).toEqual([400, 400, 400, 400, 400]);
    const stranger = await login('bot-stranger@example.com');
    const theirs = (await api().post('/api/v1/faq-rules').set(bearer(stranger.token)).send({ name: 'Theirs', answer: { text: 'x' } })).body.data;
    const foreign = await api().post('/api/v1/faq-rules').set(auth()).send({ name: 'x', answer: { text: 'Hi', options: [{ title: 'Go', action: 'rule', ruleId: theirs.id }] } });
    expect(foreign.body.errors[0].code).toBe('INVALID_RULE');
    expect((await api().patch(`/api/v1/faq-rules/${theirs.id}`).set(auth()).send({ active: false })).status).toBe(404);
  });

  it('greets with buttons, answers a keyword, and follows a tapped button', async () => {
    priceRule = await createRule({
      name: 'Price list', priority: 10, keywords: ['price', 'rate', 'दाम'],
      answer: { text: 'Namaste {{contact.name}}! {{org.name}} rates: Cumin ₹250/kg, Fennel ₹180/kg.' },
    });
    const greeting = await saveSettings({
      enabled: true,
      greeting: { enabled: true, answer: { text: 'Welcome to {{org.name}}, {{contact.name}}! What do you need?', footer: 'Reply any time', options: [{ title: 'Price list', action: 'rule', ruleId: priceRule.id }, { title: 'Talk to a person', action: 'handoff' }] } },
    });
    expect(greeting.status).toBe(200);
    expect((await api().get('/api/v1/bot/status').set(auth())).body.data).toEqual({ enabled: true });

    const chat = await inbound('98290 50011', 'Hi', { name: 'Meena' });
    await settle();
    const [welcome] = sent;
    expect(welcome).toMatchObject({
      to: '919829050011', type: 'interactive',
      interactive: {
        type: 'button', body: { text: 'Welcome to Yellow Traders, Meena! What do you need?' }, footer: { text: 'Reply any time' },
        action: { buttons: [{ type: 'reply', reply: { id: `bot:rule:${priceRule.id}`, title: 'Price list' } }, { type: 'reply', reply: { id: 'bot:handoff', title: 'Talk to a person' } }] },
      },
    });
    const [stored] = await botMessages(chat.conversationId);
    expect(stored).toMatchObject({ type: 'interactive', status: 'sent', text: 'Welcome to Yellow Traders, Meena! What do you need?', interactive: { kind: 'button' } });
    expect((await api().get(`/api/v1/conversations/${chat.conversationId}/messages`).set(auth())).body.data.at(-1)).toMatchObject({ automation: { kind: 'bot' }, interactive: { kind: 'button', options: [{ title: 'Price list' }, { title: 'Talk to a person' }] } });

    // Greeted once a day: "hello again" gets nothing; a price question gets the answer.
    await inbound('98290 50011', 'hello again', { name: 'Meena' });
    await settle();
    await inbound('98290 50011', 'जीरे का दाम क्या है?', { name: 'Meena' });
    await settle();
    expect(sent.slice(1)).toEqual([{ to: '919829050011', type: 'text', text: { body: 'Namaste Meena! Yellow Traders rates: Cumin ₹250/kg, Fennel ₹180/kg.', preview_url: false } }]);

    // The customer taps "Price list" on the greeting.
    await inbound('98290 50011', 'Price list', { name: 'Meena', type: 'interactive', replyId: `bot:rule:${priceRule.id}` });
    await settle();
    expect(sent).toHaveLength(3);
    expect(sent[2].text.body).toMatch(/^Namaste Meena!/);
    expect((await FaqRule.findById(priceRule.id)).stats.answered).toBe(2);
  });

  it('shows 4 or more options as a list', async () => {
    const rules = [];
    for (const name of ['Cumin', 'Fennel', 'Coriander', 'Chilli']) rules.push(await createRule({ name, answer: { text: `${name}: in stock.` } }));
    const menu = await createRule({
      name: 'Products', keywords: ['products', 'catalogue'],
      answer: { text: 'Which product?', listButton: 'See products', options: rules.map((r) => ({ title: r.name, description: `About ${r.name}`, action: 'rule', ruleId: r.id })) },
    });
    await inbound('98290 50021', 'Show me your catalogue');
    await settle();
    expect(sent[0].interactive).toMatchObject({
      type: 'list', body: { text: 'Which product?' },
      action: { button: 'See products', sections: [{ title: 'See products', rows: [{ id: `bot:rule:${rules[0].id}`, title: 'Cumin', description: 'About Cumin' }, {}, {}, {}] }] },
    });
    // A removed answer drops out of the menu.
    await api().delete(`/api/v1/faq-rules/${rules[3].id}`).set(auth());
    await inbound('98290 50021', 'products please');
    await settle();
    expect(sent[1].interactive).toMatchObject({ type: 'button', action: { buttons: [{}, {}, {}] } });
    expect(menu.id).toBeTruthy();
  });

  it('hands the chat to a person on request and stays quiet until it is closed or switched on again', async () => {
    const chat = await inbound('98290 50031', 'Mujhe aapse baat karni hai', { name: 'Kiran' });
    await settle();
    expect(sent).toEqual([{ to: '919829050031', type: 'text', text: { body: 'Sure! Someone from our team will reply here soon.', preview_url: false } }]);
    let conversation = await Conversation.findById(chat.conversationId);
    expect(conversation.bot).toMatchObject({ handoffReason: 'The customer asked for a person.' });
    expect(conversation.bot.handedOffAt).toBeTruthy();
    expect(await Notification.exists({ title: 'Kiran wants to talk to a person', link: `Inbox.html?c=${chat.conversationId}` })).toBeTruthy();
    expect((await api().get(`/api/v1/conversations/${chat.conversationId}`).set(auth())).body.data.bot.handedOffAt).toBeTruthy();

    await inbound('98290 50031', 'price?', { name: 'Kiran' });
    await settle();
    expect(sent).toHaveLength(1); // waiting for a person

    // Closing the chat lets the bot answer the next message; a teammate can also switch it.
    await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(auth()).send({ status: 'closed' });
    conversation = await Conversation.findById(chat.conversationId);
    expect(conversation.bot.handedOffAt).toBeFalsy();
    const off = await api().post(`/api/v1/conversations/${chat.conversationId}/bot`).set(auth()).send({ active: false });
    expect(off.body.data.bot).toMatchObject({ handoffReason: 'Paused by Asha' });
    await inbound('98290 50031', 'price?', { name: 'Kiran' });
    await settle();
    expect(sent).toHaveLength(1);
    await api().post(`/api/v1/conversations/${chat.conversationId}/bot`).set(auth()).send({ active: true });
    await inbound('98290 50031', 'price?', { name: 'Kiran' });
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1].text.body).toMatch(/rates/);

    // The "Talk to a person" button does the same.
    const other = await inbound('98290 50032', 'Hi');
    await settle();
    await inbound('98290 50032', 'Talk to a person', { type: 'interactive', replyId: 'bot:handoff' });
    await settle();
    expect((await Conversation.findById(other.conversationId)).bot.handoffReason).toBe('The customer tapped the button to talk to a person.');
  });

  it('never answers once an agent has the chat (D33)', async () => {
    const agent = await inviteAndJoin(owner.token, 'bot-inbox@example.com', { role: 'agent', modules: ['inbox'] });
    const agentId = await memberId(owner.token, 'bot-inbox@example.com');
    const chat = await inbound('98290 50041', 'Hi');
    await settle();
    expect(sent).toHaveLength(1); // greeted
    // The agent replies: their first reply takes the chat.
    await api().post(`/api/v1/conversations/${chat.conversationId}/messages`).set(bearer(agent.token)).send({ text: 'Namaste! Main Sonu.' });
    expect(String((await Conversation.findById(chat.conversationId)).assigneeId)).toBe(agentId);
    await inbound('98290 50041', 'What is the price?');
    await settle();
    expect(sent.map((s) => s.text?.body || s.interactive?.body?.text)).toEqual([expect.stringMatching(/^Welcome/), 'Namaste! Main Sonu.']);
  });

  it('sends the away message outside working hours, once a day', async () => {
    // Open only on another weekday: closed now.
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
    const otherDay = (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(today) + 3) % 7;
    const closed = await api().put('/api/v1/organization/business-hours').set(auth()).send({ days: [otherDay], start: '10:00', end: '19:00' });
    expect(closed.status).toBe(200);
    try {
      await saveSettings({ away: { enabled: true, answer: { text: 'We are closed, {{contact.name}}. Back at 10 am!', options: [{ title: 'Talk to a person', action: 'handoff' }] } } });
      const chat = await inbound('98290 50051', 'Hello?', { name: 'Night Owl' });
      await settle();
      await inbound('98290 50051', 'Anyone there?', { name: 'Night Owl' });
      await settle();
      expect(sent).toHaveLength(1);
      expect(sent[0].interactive).toMatchObject({ type: 'button', body: { text: 'We are closed, Night Owl. Back at 10 am!' } });
      const conversation = await Conversation.findById(chat.conversationId);
      expect(conversation.bot.awayAt).toBeTruthy();
      expect(conversation.bot.greetedAt).toBeFalsy();
      // FAQ answers still work at night.
      await inbound('98290 50051', 'rate?', { name: 'Night Owl' });
      await settle();
      expect(sent[1].text.body).toMatch(/rates/);
    } finally {
      await api().put('/api/v1/organization/business-hours').set(auth()).send(ALWAYS_OPEN);
    }
  });

  it('leaves WhatsApp enquiries to the bot\'s greeting instead of an auto-reply rule', async () => {
    const templates = Object.fromEntries((await api().post('/api/v1/templates/sync').set(auth()).send({})).body.data.map((t) => [t.name, t]));
    const rule = await api().post('/api/v1/auto-reply-rules').set(auth()).send({
      name: 'Everyone', sources: [], templateId: templates.order_update.id, variables: { body: { 1: 'contact.name', 2: 'text:your enquiry' } },
    });
    expect(rule.status).toBe(201);
    const chat = await inbound('98290 50061', 'Hi there', { name: 'New Person' });
    await settle();
    expect(sent.map((s) => s.type)).toEqual(['interactive']); // the bot's greeting only
    const lead = await require('../models/Lead').findOne({ contactId: chat.contactId });
    expect((await LeadActivity.find({ leadId: lead._id, type: 'Auto-reply' })).map((a) => a.text)).toEqual(['No auto-reply: the WhatsApp bot greets customers who write on WhatsApp.']);
    await api().delete(`/api/v1/auto-reply-rules/${rule.body.data.id}`).set(auth());
  });

  it('stays out of chats when switched off', async () => {
    await saveSettings({ enabled: false });
    const chat = await inbound('98290 50071', 'price?');
    await settle();
    expect(await botMessages(chat.conversationId)).toHaveLength(0);
  });
});
