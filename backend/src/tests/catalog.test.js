jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const Job = require('../models/Job');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Order = require('../models/Order');
const Organization = require('../models/Organization');
const Product = require('../models/Product');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const queue = require('../jobs/queue');
const catalog = require('../services/catalogService');
const inbound = require('../services/whatsappInboundService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 8C: the WhatsApp catalog through the Cloud API code (Meta faked at fetch): connect a
// catalog, sync the products marked for it (prices with GST, photo and price required, removals),
// send one product or a list in a chat, and a cart sent back becomes an order.
const APP_SECRET = 'p8c-app-secret-0123456789';
const PHONE_NUMBER_ID = '5550008888';
const WABA_ID = '4440008888';
const CATALOG_ID = '901234567890';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sign = (raw) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const settle = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};

describe('WhatsApp catalog', () => {
  const graph = []; // what the CRM sent to Meta
  let sends = 0;
  let owner;
  let agent;
  let account;
  let products;
  const as = (user) => bearer(user.token);
  const post = (user, path, body) => api().post(`/api/v1${path}`).set(as(user)).send(body);
  const get = (user, path) => api().get(`/api/v1${path}`).set(as(user));

  beforeAll(async () => {
    catalog.register(queue);
    jest.spyOn(global, 'fetch').mockImplementation(async (target, options = {}) => {
      const url = String(target);
      const method = options.method || 'GET';
      const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : null;
      graph.push({ url, method, body });
      if (url.includes(`/${CATALOG_ID}?fields=`)) return json({ id: CATALOG_ID, name: 'Yellow Traders catalog', product_count: 3 });
      if (url.includes('/99999999999?fields=')) return json({ error: { message: 'Unsupported get request. Object with ID does not exist', code: 100 } }, 400);
      if (url.endsWith(`/${CATALOG_ID}/items_batch`)) {
        const refused = body.requests.find((r) => r.data.id === 'JEERA-BAD');
        return json({ handles: ['h1'], validation_status: refused ? [{ retailer_id: 'JEERA-BAD', errors: [{ message: 'Invalid image_link' }] }] : [] });
      }
      if (url.includes('/whatsapp_commerce_settings')) return json({ success: true });
      if (url.endsWith(`/${PHONE_NUMBER_ID}/messages`) && method === 'POST') {
        sends += 1;
        return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.P8C${sends}` }] });
      }
      if (url.includes('/message_templates')) return json({ data: [] });
      return json({ display_phone_number: '+91 90000 88888', verified_name: 'Yellow Traders', quality_rating: 'GREEN' });
    });
    owner = await login('catalog-owner@example.com', { name: 'Asha' });
    agent = await inviteAndJoin(owner.token, 'catalog-agent@example.com', { role: 'agent', modules: ['inbox', 'products'] });
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', website: 'yellowtraders.example' });
    account = (await post(owner, '/whatsapp/accounts', { name: 'Sales', phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: 'EAAG-p8c-token-1', appSecret: APP_SECRET })).body.data;
    const make = (body) => post(owner, '/products', body).then((r) => r.body.data);
    products = {
      jeera: await make({ name: 'Jeera 25kg', sku: 'JEERA-25', category: 'Spices', description: 'Rajasthan cumin, machine clean', pricePaise: 300000, gstRatePct: 5, images: ['https://cdn.example.com/jeera.jpg'], inCatalog: true }),
      haldi: await make({ name: 'Haldi 10kg', category: 'Spices', pricePaise: 150000, gstRatePct: 5, images: ['https://cdn.example.com/haldi.jpg'], stockQty: 0, inCatalog: true }),
      noPhoto: await make({ name: 'Dhaniya 10kg', category: 'Spices', pricePaise: 90000, gstRatePct: 5, inCatalog: true }),
      bad: await make({ name: 'Bad photo', sku: 'JEERA-BAD', pricePaise: 1000, gstRatePct: 5, images: ['https://cdn.example.com/x.jpg'], inCatalog: true }),
      notIn: await make({ name: 'Packing charges', pricePaise: 5000, gstRatePct: 18 }),
    };
  });
  afterAll(async () => {
    await queue.stop();
    jest.restoreAllMocks();
  });

  it('connects a catalog checked with Meta, and syncs the marked products', async () => {
    expect(products.jeera).toMatchObject({ inCatalog: true, catalog: { status: 'pending' } });
    expect(products.notIn).toMatchObject({ inCatalog: false, catalog: { status: '' } });
    const refused = await api().put(`/api/v1/whatsapp/accounts/${account.id}/catalog`).set(as(owner)).send({ catalogId: '99999999999' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('CATALOG_REFUSED');
    expect((await api().put(`/api/v1/whatsapp/accounts/${account.id}/catalog`).set(as(agent)).send({ catalogId: CATALOG_ID })).status).toBe(403);

    const connected = await api().put(`/api/v1/whatsapp/accounts/${account.id}/catalog`).set(as(owner)).send({ catalogId: CATALOG_ID, catalogVisible: true, cartEnabled: true });
    expect(connected.status).toBe(200);
    expect(connected.body.data).toMatchObject({ catalogId: CATALOG_ID, name: 'Yellow Traders catalog', status: 'connected', catalogVisible: true, cartEnabled: true });
    expect(graph.find((g) => g.url.includes('/whatsapp_commerce_settings'))).toMatchObject({ method: 'POST', url: expect.stringContaining(`/${PHONE_NUMBER_ID}/whatsapp_commerce_settings?is_catalog_visible=true&is_cart_enabled=true`) });
    expect((await get(owner, '/whatsapp/accounts')).body.data[0].catalog).toMatchObject({ catalogId: CATALOG_ID });

    await settle(); // the first sync runs at once
    const batch = graph.find((g) => g.url.endsWith('/items_batch'));
    expect(batch.body.item_type).toBe('PRODUCT_ITEM');
    const sent = Object.fromEntries(batch.body.requests.map((r) => [r.data.id, r]));
    expect(sent['JEERA-25']).toEqual({
      method: 'UPDATE',
      data: {
        id: 'JEERA-25', title: 'Jeera 25kg', description: 'Rajasthan cumin, machine clean', availability: 'in stock', condition: 'new',
        price: '3150.00 INR', link: 'https://yellowtraders.example', image_link: 'https://cdn.example.com/jeera.jpg', brand: 'Yellow Traders',
      },
    });
    expect(sent[products.haldi.id].data).toMatchObject({ availability: 'out of stock', price: '1575.00 INR', description: 'Haldi 10kg' });
    expect(Object.keys(sent)).not.toContain(products.noPhoto.id); // no photo: not sent
    expect(Object.keys(sent)).not.toContain(products.notIn.id);
    const list = Object.fromEntries((await get(owner, '/products')).body.data.map((p) => [p.name, p.catalog]));
    expect(list['Jeera 25kg']).toMatchObject({ status: 'synced', retailerId: 'JEERA-25' });
    expect(list['Dhaniya 10kg']).toMatchObject({ status: 'error', error: expect.stringContaining('photo') });
    expect(list['Bad photo']).toMatchObject({ status: 'error', error: 'Meta: Invalid image_link' });
    const state = (await get(agent, '/products/whatsapp-catalog')).body.data;
    expect(state).toMatchObject({ available: true, products: { included: 4, synced: 2, failed: 2 }, catalogs: [{ catalogId: CATALOG_ID, accountName: 'Sales', lastSync: { sent: 2, failed: 2 } }] });

    // Taken out of the catalog, or the SKU changed: Meta is told at the next sync.
    await api().patch(`/api/v1/products/${products.haldi.id}`).set(as(owner)).send({ inCatalog: false });
    await api().patch(`/api/v1/products/${products.jeera.id}`).set(as(owner)).send({ sku: 'JEERA-25KG' });
    expect((await get(owner, `/products/${products.jeera.id}`)).body.data.catalog.status).toBe('pending');
    graph.length = 0;
    expect((await post(agent, '/products/whatsapp-catalog/sync', {})).status).toBe(403);
    const synced = await post(owner, '/products/whatsapp-catalog/sync', {});
    expect(synced.status).toBe(200);
    const requests = graph.find((g) => g.url.endsWith('/items_batch')).body.requests;
    expect(requests).toEqual(expect.arrayContaining([
      { method: 'DELETE', data: { id: products.haldi.id } },
      { method: 'DELETE', data: { id: 'JEERA-25' } },
      expect.objectContaining({ method: 'UPDATE', data: expect.objectContaining({ id: 'JEERA-25KG' }) }),
    ]));
    expect((await Product.findById(products.haldi.id)).catalog).toMatchObject({ status: 'removed', retailerId: undefined });
    expect((await Product.findById(products.jeera.id)).catalog.retailerId).toBe('JEERA-25KG');
  });

  it('sends one product or a list in a chat, inside the 24-hour window', async () => {
    const chat = (await post(owner, '/dev/simulate/whatsapp-inbound', { from: '98290 81111', name: 'Ravi Traders', text: 'Catalogue bhejiye' }));
    expect(chat.status).toBe(201);
    const { conversationId } = chat.body.data;
    const offer = (await get(agent, `/conversations/${conversationId}/catalog`)).body.data;
    expect(offer).toMatchObject({ blocked: '', windowOpen: true });
    expect(offer.products.map((p) => [p.name, p.retailerId, p.priceWithGstPaise])).toEqual([['Jeera 25kg', 'JEERA-25KG', 315000]]);

    graph.length = 0;
    const one = await post(agent, `/conversations/${conversationId}/products`, { productIds: [products.jeera.id], body: 'Fresh stock' });
    expect(one.status).toBe(201);
    expect(one.body.data).toMatchObject({ type: 'interactive', interactive: { kind: 'product', products: [{ retailerId: 'JEERA-25KG', name: 'Jeera 25kg' }] } });
    expect(graph.find((g) => g.url.endsWith('/messages')).body).toMatchObject({
      type: 'interactive', interactive: { type: 'product', body: { text: 'Fresh stock' }, action: { catalog_id: CATALOG_ID, product_retailer_id: 'JEERA-25KG' } },
    });
    // A list needs synced products; the bad one is refused.
    expect((await post(agent, `/conversations/${conversationId}/products`, { productIds: [products.jeera.id, products.bad.id] })).body.code).toBe('VALIDATION_ERROR');
    await Product.updateOne({ _id: products.bad.id }, { $set: { 'catalog.status': 'synced', 'catalog.retailerId': 'JEERA-BAD', category: 'Offers' } });
    graph.length = 0;
    expect((await post(agent, `/conversations/${conversationId}/products`, { productIds: [products.jeera.id, products.bad.id], header: 'Diwali offers' })).status).toBe(201);
    expect(graph.find((g) => g.url.endsWith('/messages')).body.interactive).toMatchObject({
      type: 'product_list', header: { type: 'text', text: 'Diwali offers' },
      action: { catalog_id: CATALOG_ID, sections: [{ title: 'Spices', product_items: [{ product_retailer_id: 'JEERA-25KG' }] }, { title: 'Offers', product_items: [{ product_retailer_id: 'JEERA-BAD' }] }] },
    });
  });

  it('turns a cart sent from the catalog into an order, once', async () => {
    const waId = '919829081112';
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: WABA_ID,
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_NUMBER_ID }, contacts: [{ profile: { name: 'Kiran Stores' }, wa_id: waId }],
            messages: [{
              from: waId, id: 'wamid.P8CORDER1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'order',
              order: { catalog_id: CATALOG_ID, text: 'Jaldi bhejna', product_items: [{ product_retailer_id: 'JEERA-25KG', quantity: 2, item_price: 3150, currency: 'INR' }, { product_retailer_id: 'UNKNOWN-9', quantity: 1, item_price: 499, currency: 'INR' }] },
            }],
          },
        }],
      }],
    });
    const hook = () => api().post(account.webhookPath).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw);
    expect((await hook()).status).toBe(200);
    await inbound.idle();
    await settle();
    const message = await Message.findOne({ providerMessageId: 'wamid.P8CORDER1' });
    expect(message).toMatchObject({ type: 'order', text: 'Jaldi bhejna', order: { catalogId: CATALOG_ID, items: [{ retailerId: 'JEERA-25KG', quantity: 2, itemPricePaise: 315000 }, { retailerId: 'UNKNOWN-9', quantity: 1, itemPricePaise: 49900 }] } });
    const order = await Order.findById(message.order.orderId);
    // 2 × ₹3,000 + 5% (CGST + SGST, the customer's state unknown) = ₹6,300 + ₹499 (unknown, no GST) = ₹6,799.
    expect(order).toMatchObject({ source: 'catalog', stage: 'Received', totals: { grandTotalPaise: 679900 }, billTo: { name: 'Kiran Stores' } });
    expect(order.items.map((i) => [i.name, i.quantity])).toEqual([['Jeera 25kg', 2], ['Catalog item UNKNOWN-9', 1]]);
    expect(order.catalogOrder.warnings).toEqual(['"UNKNOWN-9" is not a product in the CRM: added at the catalog price without GST.']);
    expect(order.notes).toBe('Customer\'s note: Jaldi bhejna');
    const thanks = await Message.findOne({ conversationId: message.conversationId, 'automation.kind': 'catalog-order' });
    expect(thanks.text).toBe(`Thank you Kiran Stores! We have received your order ${order.number} for ₹6,799.00. We will confirm it shortly.`);
    expect(await Notification.findOne({ title: `New order from the WhatsApp catalog: ${order.number}` })).toBeTruthy();
    const listed = (await get(owner, `/orders/${order.id}`)).body.data;
    expect(listed).toMatchObject({ source: 'catalog', catalogOrder: { text: 'Jaldi bhejna', warnings: [expect.any(String)] } });
    const inChat = (await get(owner, `/conversations/${message.conversationId}/messages`)).body.data.find((m) => m.type === 'order');
    expect(inChat.order).toMatchObject({ orderId: String(order._id), items: [{ retailerId: 'JEERA-25KG' }, { retailerId: 'UNKNOWN-9' }] });

    // Meta sends the webhook again; the job runs again: still one order.
    expect((await hook()).status).toBe(200);
    await inbound.idle();
    await catalog.orderFromMessage({ messageId: message._id });
    await settle();
    expect(await Order.countDocuments({ 'catalogOrder.messageId': message._id })).toBe(1);
  });

  it('needs a plan with the catalog, and stays in its company', async () => {
    const stranger = await login('catalog-stranger@example.com');
    expect((await api().put(`/api/v1/whatsapp/accounts/${account.id}/catalog`).set(as(stranger)).send({ catalogId: CATALOG_ID })).status).toBe(404);
    expect((await get(stranger, '/products/whatsapp-catalog')).body.data).toMatchObject({ catalogs: [], products: { included: 0 } });
    const org = await Organization.findOne({ name: 'Yellow Traders' });
    await Organization.updateOne({ _id: org._id }, { $set: { plan: 'pro' } });
    const refused = await post(owner, '/products/whatsapp-catalog/sync', {});
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('PLAN_LIMIT');
    await Organization.updateOne({ _id: org._id }, { $set: { plan: 'growth' } });
    expect((await api().delete(`/api/v1/whatsapp/accounts/${account.id}/catalog`).set(as(owner))).status).toBe(200);
    expect((await WhatsAppAccount.findById(account.id)).catalog?.catalogId).toBeUndefined();
    expect(await Job.exists({ liveKey: `catalog:${account.id}`, status: 'queued' })).toBeNull(); // no more daily syncs
  });
});
