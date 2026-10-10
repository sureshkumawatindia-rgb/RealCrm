jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// The top bar's search: one box for customers, leads, chats, quotations, orders, products,
// tasks and tickets, each group following its own module's rules.
const search = async (token, q) => api().get('/api/v1/search').query({ q }).set(bearer(token));
const groupsOf = async (token, q) => {
  const res = await search(token, q);
  expect(res.status).toBe(200);
  return Object.fromEntries(res.body.data.groups.map((group) => [group.type, group]));
};
const post = async (token, path, body, status = 201) => {
  const res = await api().post(`/api/v1${path}`).set(bearer(token)).send(body);
  if (res.status !== status) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};

describe('Global search', () => {
  let owner;
  let admin;
  let agent;
  let lead;
  let order;
  beforeAll(async () => {
    owner = await login('search-owner@example.com', { name: 'Owner' });
    admin = await inviteAndJoin(owner.token, 'search-admin@example.com', { role: 'admin' });
    agent = await inviteAndJoin(owner.token, 'search-agent@example.com', { role: 'agent', modules: ['leads', 'customers', 'inbox'] });

    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    await post(owner.token, '/dev/simulate/whatsapp-inbound', { from: '98765 11122', name: 'Ramesh Spices', text: 'Jeera ka rate?' });
    await post(owner.token, '/contacts', { name: 'Ramesh Traders', phone: '+91 98765 22233', lifecycle: 'customer' });
    const product = await post(owner.token, '/products', { name: 'Jeera 25kg', sku: 'JEERA-25', pricePaise: 300000, gstRatePct: 5 });
    lead = (await api().get('/api/v1/leads').query({ q: 'Ramesh' }).set(bearer(owner.token))).body.data[0];
    const quotation = await post(owner.token, '/quotations', { leadId: lead.id, items: [{ productId: product.id, name: product.name, quantity: 10, unitPricePaise: 300000, taxRatePct: 5 }] });
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(bearer(owner.token)).send({ status: 'Accepted' });
    order = await post(owner.token, '/orders', { quotationId: quotation.id });
    await post(owner.token, '/tasks', { title: 'Call Ramesh about the jeera order' });
    await post(owner.token, '/tickets', { subject: 'Ramesh got a damaged packet' });
    await post(owner.token, '/leads', { contact: { name: 'Harish Owner-Lead', phone: '+919811100001' } });
    await post(agent.token, '/leads', { contact: { name: 'Aakash Agent-Lead', phone: '+919811100002' } });
    await post(owner.token, '/dev/simulate/whatsapp-inbound', { from: '98290 70001', name: 'Mummy', text: 'Khana kha liya?' });
  });

  it('finds a customer everywhere they appear, with a link to each record', async () => {
    const groups = await groupsOf(owner.token, 'Ramesh');
    expect(Object.keys(groups)).toEqual(['customers', 'leads', 'chats', 'quotations', 'orders', 'tasks', 'tickets']);
    expect(groups.customers.items.map((item) => item.title)).toEqual(['Ramesh Traders']); // a lead's contact is under Leads
    expect(groups.customers.items[0].url).toMatch(/^customer-360\.html\?id=[0-9a-f]{24}$/);
    expect(groups.leads.items[0].url).toBe(`leads.html?open=${lead.id}`);
    expect(groups.chats.items[0]).toMatchObject({ title: 'Ramesh Spices', subtitle: expect.stringContaining('Jeera ka rate?') });
    expect(groups.chats.items[0].url).toMatch(/^Inbox\.html\?c=[0-9a-f]{24}$/);
    expect(groups.quotations.items[0].subtitle).toContain('₹31,500');
    expect(groups.orders.items[0]).toMatchObject({ title: order.number, url: `Orders.html?id=${order.id}` });
    expect(groups.tasks.items[0].url).toMatch(/^Tasks\.html\?open=/);
    expect(groups.tickets.items[0].url).toMatch(/^Support\.html\?open=/);
    expect(groups.customers.total).toBe(1);
    expect(groups.leads.allUrl).toBe('leads.html?q=Ramesh');
    expect(groups.chats.allUrl).toBe('Inbox.html?q=Ramesh');
  });

  it('finds a phone number typed with spaces or +91, documents by number, products by code', async () => {
    for (const q of ['98765 22233', '+91 98765-22233']) {
      expect((await groupsOf(owner.token, q)).customers.items[0].title).toBe('Ramesh Traders');
    }
    expect((await groupsOf(owner.token, '98765 11122')).chats.items[0].title).toBe('Ramesh Spices');
    expect((await groupsOf(owner.token, order.number)).orders.items[0].id).toBe(order.id);
    expect((await groupsOf(owner.token, 'jeera-25')).products.items[0]).toMatchObject({ title: 'Jeera 25kg', subtitle: expect.stringContaining('₹3,000') });
  });

  it("shows a member only the modules they have, and only the records they may see", async () => {
    const own = await groupsOf(agent.token, 'Agent-Lead');
    expect(own.leads.items.map((item) => item.title)).toEqual(['Aakash Agent-Lead']);
    expect(await groupsOf(agent.token, 'Owner-Lead')).toEqual({});
    // No Products, Tasks or Support module: those groups are never searched.
    expect(Object.keys(await groupsOf(owner.token, 'Jeera'))).toContain('products');
    expect(Object.keys(await groupsOf(agent.token, 'Jeera'))).not.toContain('products');
    expect(Object.keys(await groupsOf(agent.token, 'Ramesh'))).not.toContain('tickets');
  });

  it('leaves private numbers to the owner (D61)', async () => {
    const chats = await api().get('/api/v1/conversations?status=any&view=all').set(bearer(owner.token));
    const family = chats.body.data.find((chat) => chat.contact.name === 'Mummy');
    await post(owner.token, `/conversations/${family.id}/private`, {});
    expect((await groupsOf(owner.token, 'Mummy')).chats.items).toHaveLength(1);
    expect(await groupsOf(admin.token, 'Mummy')).toEqual({});
  });

  it('needs a signed-in member and at least 2 characters', async () => {
    expect((await search(owner.token, 'R')).status).toBe(400);
    expect((await api().get('/api/v1/search').query({ q: 'Ramesh' })).status).toBe(401);
  });
});
