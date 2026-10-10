jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const http = require('http');
const { io: connect } = require('socket.io-client');
const app = require('../app');
const Contact = require('../models/Contact');
const AuditLog = require('../models/AuditLog');
const notificationService = require('../services/notificationService');
const { attachRealtime } = require('../realtime/socket');
const { maskPhone, maskPhonesIn } = require('../utils/phoneMask');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// "Hide customer phone numbers from agents" (D65, on by default): agents and viewers get every
// customer number masked — in every answer and live event — while owners and admins see them,
// numbers still work for searching, and messages still go to the real number.
const NUMBERS = ['9876543210', '9988776655', '9811122233'];
// A number written with or without spaces, dashes or dots between its digits.
const patternOf = (digits) => new RegExp(digits.split('').join('[\\s.-]?'));
// The search repeats the words the member typed (q, allUrl): their own input, not a leak.
const leaks = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, (key, item) => (key === 'q' || key === 'allUrl' ? undefined : item));
  return NUMBERS.filter((digits) => patternOf(digits).test(text));
};
const post = async (token, path, body, status = 201) => {
  const res = await api().post(`/api/v1${path}`).set(bearer(token)).send(body);
  if (res.status !== status) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const get = (token, path) => api().get(`/api/v1${path}`).set(bearer(token));

describe('maskPhone', () => {
  it('keeps the country code, the first two and the last three digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91 98••• ••210');
    expect(maskPhone('98765 43210')).toBe('98••• ••210');
    expect(maskPhone('+91 98765-43210')).toBe('+91 98••• ••210');
    expect(maskPhone('2026')).toBe('2026'); // not a number
    expect(maskPhone(maskPhone('+919876543210'))).toBe('+91 98••• ••210');
  });
  it('masks phone fields, names that are a number and +numbers in text, nothing else', () => {
    expect(maskPhonesIn({
      phone: '+919876543210', name: '+919988776655', company: 'Ramesh Spices', note: 'Call +91 98111 22233 today',
      lrNumber: '123456789012', amountPaise: 9876543210, nested: [{ phoneE164: '+919811122233' }],
    })).toEqual({
      phone: '+91 98••• ••210', name: '+91 99••• ••655', company: 'Ramesh Spices', note: 'Call +91 98••• ••233 today',
      lrNumber: '123456789012', amountPaise: 9876543210, nested: [{ phoneE164: '+91 98••• ••233' }],
    });
  });
});

describe('Customer numbers hidden from agents', () => {
  let owner;
  let admin;
  let agent;
  let viewer;
  let named;
  let unnamed;
  let customer;
  let quotation;
  let order;
  let server;
  let io;
  let url;
  const sockets = [];

  beforeAll(async () => {
    owner = await login('mask-owner@example.com', { name: 'Owner' });
    admin = await inviteAndJoin(owner.token, 'mask-admin@example.com', { role: 'admin' });
    agent = await inviteAndJoin(owner.token, 'mask-agent@example.com', {
      role: 'agent',
      modules: ['inbox', 'customers', 'leads', 'deals', 'tasks', 'support', 'products'],
      permissions: ['inbox:view_all', 'customers:view_all', 'leads:view_all', 'deals:view_all', 'tasks:view_all', 'support:view_all'],
    });
    viewer = await inviteAndJoin(owner.token, 'mask-viewer@example.com', {
      role: 'viewer', modules: ['customers', 'leads', 'deals', 'reports'], permissions: ['customers:view_all', 'leads:view_all', 'deals:view_all'],
    });

    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    named = await post(owner.token, '/dev/simulate/whatsapp-inbound', { from: '+91 98765 43210', name: 'Ramesh Spices', text: 'Jeera ka rate? Mera dusra number +91 98111 22233 hai' });
    unnamed = await post(owner.token, '/dev/simulate/whatsapp-inbound', { from: '99887 76655', name: '', text: 'Hi' });
    customer = await post(owner.token, '/contacts', { name: 'Mohit Traders', phone: '98111 22233', lifecycle: 'customer' });

    const lead = (await get(owner.token, '/leads?q=Ramesh')).body.data[0];
    const product = await post(owner.token, '/products', { name: 'Jeera 25kg', pricePaise: 300000, gstRatePct: 5 });
    quotation = await post(owner.token, '/quotations', { leadId: lead.id, items: [{ productId: product.id, name: product.name, quantity: 10, unitPricePaise: 300000, taxRatePct: 5 }] });
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(bearer(owner.token)).send({ status: 'Accepted' });
    order = await post(owner.token, '/orders', { quotationId: quotation.id });
    await post(owner.token, '/tasks', { title: 'Call back', relatedType: 'Contact', relatedId: unnamed.contactId, relatedName: '+919988776655' });
    await post(owner.token, '/tickets', { subject: 'Damaged packet', customerName: '+91 99887 76655' });
    const agentMember = (await get(agent.token, '/auth/me')).body.data.member;
    const me = await get(owner.token, '/auth/me');
    await notificationService.notify(me.body.data.organization.id, [agentMember.id], { title: 'New lead from +91 99887 76655', body: 'Reply to +919876543210 soon' });

    server = http.createServer(app);
    io = attachRealtime(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    sockets.forEach((socket) => socket.close());
    if (!io) return;
    io.detach();
    await new Promise((resolve) => io.close(resolve));
  });

  const agentPaths = () => [
    '/contacts?limit=100', `/contacts/${named.contactId}`, `/contacts/${unnamed.contactId}`, `/contacts/${customer.id}`,
    '/leads?limit=100', `/leads?contactId=${named.contactId}`,
    '/conversations?view=all&status=any', `/conversations/${named.conversationId}`, `/conversations/${named.conversationId}/messages`,
    `/conversations?contactId=${named.contactId}&status=any`,
    '/quotations', `/quotations/${quotation.id}`, '/orders', `/orders/${order.id}`,
    '/tasks', '/tickets', '/notifications',
    '/search?q=Ramesh', '/search?q=98765%2043210', '/search?q=99887', '/search?q=Mohit',
    '/reports/me',
  ];

  it('owners and admins see the real numbers', async () => {
    for (const someone of [owner, admin]) {
      const res = await get(someone.token, '/contacts?limit=100');
      expect(leaks(res.body)).toEqual(expect.arrayContaining(['9876543210', '9988776655', '9811122233']));
    }
  });

  it('no answer an agent or viewer gets contains a full customer number', async () => {
    for (const path of agentPaths()) {
      const res = await get(agent.token, path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      expect({ path, leaks: leaks(res.body) }).toEqual({ path, leaks: [] });
    }
    for (const path of ['/contacts?limit=100', `/contacts/${named.contactId}`, '/leads?limit=100', '/quotations', `/orders/${order.id}`, '/search?q=Ramesh']) {
      const res = await get(viewer.token, path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      expect({ path, leaks: leaks(res.body) }).toEqual({ path, leaks: [] });
    }
    const contact = (await get(agent.token, `/contacts/${named.contactId}`)).body.data;
    expect(contact.phoneE164).toBe('+91 98••• ••210');
    expect((await get(agent.token, `/contacts/${unnamed.contactId}`)).body.data.name).toMatch(/•/); // its name is the number
    // The customer's own words in a chat are masked too when they write a +number.
    const messages = (await get(agent.token, `/conversations/${named.conversationId}/messages`)).body.data;
    expect(JSON.stringify(messages)).toContain('+91 98••• ••233');
  });

  it('still finds a customer by number, masked in the result', async () => {
    const res = await get(agent.token, '/search?q=98111%2022233');
    const customers = res.body.data.groups.find((group) => group.type === 'customers');
    expect(customers.items[0].title).toBe('Mohit Traders');
    expect(customers.items[0].subtitle).toContain('98••• ••233');
  });

  it('a masked number saved back from a form never replaces the real one', async () => {
    const contact = (await get(agent.token, `/contacts/${customer.id}`)).body.data;
    const res = await api().patch(`/api/v1/contacts/${customer.id}`).set(bearer(agent.token)).send({ phone: contact.phone, city: 'Jaipur' });
    expect(res.status).toBe(200);
    const stored = await Contact.findById(customer.id);
    expect(stored.phoneE164).toBe('+919811122233');
    expect(stored.city).toBe('Jaipur');
  });

  it('masks live events for agents only', async () => {
    const open = (token) => new Promise((resolve, reject) => {
      const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
      sockets.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
    const next = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
    const [agentSocket, ownerSocket] = await Promise.all([open(agent.token), open(owner.token)]);
    const toAgent = next(agentSocket, 'message:new');
    const toOwner = next(ownerSocket, 'message:new');
    await post(owner.token, '/dev/simulate/whatsapp-inbound', { from: '+91 98765 43210', name: 'Ramesh Spices', text: 'Order confirm karo' });
    expect(leaks(await toAgent)).toEqual([]);
    expect(leaks(await toOwner)).toContain('9876543210');
  });

  it('only owners and admins switch it, it is audited, and agents then see the numbers', async () => {
    expect((await get(agent.token, '/organization/settings')).body.data).toEqual({ hidePhonesFromAgents: true });
    expect((await api().patch('/api/v1/organization/settings').set(bearer(agent.token)).send({ hidePhonesFromAgents: false })).status).toBe(403);
    expect((await api().patch('/api/v1/organization/settings').set(bearer(viewer.token)).send({ hidePhonesFromAgents: false })).status).toBe(403);

    const off = await api().patch('/api/v1/organization/settings').set(bearer(admin.token)).send({ hidePhonesFromAgents: false });
    expect(off.body.data).toEqual({ hidePhonesFromAgents: false });
    expect(await AuditLog.findOne({ action: 'organization.settings_updated', 'changes.hidePhonesFromAgents': false })).toBeTruthy();
    expect(leaks((await get(agent.token, '/contacts?limit=100')).body)).toEqual(expect.arrayContaining(['9876543210']));

    await api().patch('/api/v1/organization/settings').set(bearer(owner.token)).send({ hidePhonesFromAgents: true });
    expect(leaks((await get(agent.token, '/contacts?limit=100')).body)).toEqual([]);
  });

  it('keeps private numbers (D61) away from agents, numbers or not', async () => {
    await post(owner.token, `/conversations/${unnamed.conversationId}/private`, {});
    const res = await get(agent.token, '/search?q=99887');
    expect(res.body.data.groups.map((group) => group.type)).not.toContain('chats');
    expect((await get(agent.token, `/conversations/${unnamed.conversationId}`)).status).toBe(404);
  });
});
