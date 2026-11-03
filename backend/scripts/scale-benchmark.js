/**
 * Speed at scale (Phase 3, D115; docs/SPEED_AT_SCALE.md): a company with 20,000 contacts, 50,000
 * leads, 10,000 chats with 2 lakh messages, 5,000 tasks, 5,000 quotations and 2,000 orders, in an
 * in-memory MongoDB on this computer, and the time each screen's API call takes (p50 / p95 over
 * 15 requests). NODE_ENV=test: backend/.env is never read and no real database is touched.
 *
 *   npm run bench:scale                      (in backend/; about two minutes)
 *   npm run bench:scale -- results.json      also writes the timings to a file
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const OUT = process.argv[2] || '';
const RUNS = 15;
const fromBackend = (file) => require(path.join(BACKEND, file)); // eslint-disable-line global-require, import/no-dynamic-require

(async () => {
  const { MongoMemoryReplSet } = fromBackend('node_modules/mongodb-memory-server');
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-scale-'));
  Object.assign(process.env, {
    NODE_ENV: 'test', MONGO_URI: replSet.getUri('crm_scale'), JWT_SECRET: 'scale-jwt-secret-that-is-long-enough-123456',
    GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GMAIL_TOKEN_ENCRYPTION_KEY: 'x', DATA_ENCRYPTION_KEY: '',
    PUBLIC_URL: 'http://127.0.0.1:3200', UPLOAD_DIR: path.join(files, 'uploads'), DOCUMENT_DIR: path.join(files, 'documents'),
    RATE_LIMIT_API_PER_MINUTE: '1000000', RATE_LIMIT_AUTH_PER_MINUTE: '1000000', LOGIN_WHATSAPP_CODE: 'off',
  });
  const idToken = require.resolve(path.join(BACKEND, 'src/integrations/google/idToken'));
  require.cache[idToken] = { id: idToken, filename: idToken, loaded: true, exports: fromBackend('src/tests/helpers/fakeGoogle') };
  const mongoose = fromBackend('node_modules/mongoose');
  await mongoose.connect(process.env.MONGO_URI);
  const request = fromBackend('node_modules/supertest');
  const app = fromBackend('src/app');
  const model = (name) => fromBackend(`src/models/${name}`);
  const [Contact, Lead, Product, Conversation, Message, Task, Quotation, Order] = ['Contact', 'Lead', 'Product', 'Conversation', 'Message', 'Task', 'Quotation', 'Order'].map(model);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const auth = await request(app).post('/api/v1/auth/google').send({ credential: 'test:scale:scale@example.com:Scale Owner' });
  const bearer = { Authorization: `Bearer ${auth.body.data.token}` };
  const organizationId = new mongoose.Types.ObjectId(auth.body.data.organizationId);
  const ownerId = new mongoose.Types.ObjectId(auth.body.data.member.id);
  const { ObjectId } = mongoose.Types;

  // --- the company's records (written straight to the database) ------------------------------
  const started = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const ago = (n) => new Date(now - n);
  const rnd = (n, seed) => Math.abs(Math.sin(seed * 9301 + 49297)) * n | 0; // the same "random" numbers every run
  const insert = async (Model, docs) => {
    for (let i = 0; i < docs.length; i += 5000) await Model.collection.insertMany(docs.slice(i, i + 5000), { ordered: false });
  };
  const CITIES = ['Jaipur', 'Surat', 'Ludhiana', 'Rajkot', 'Indore', 'Kanpur', 'Coimbatore', 'Agra', 'Nagpur', 'Delhi'];
  const SOURCES = ['WhatsApp', 'IndiaMART', 'JustDial', 'TradeIndia', 'Website', 'Manual', 'Facebook', 'Google Ads'];
  const STAGES = ['New', 'New', 'Contacted', 'Contacted', 'Quote Sent', 'Negotiation', 'Won', 'Lost'];

  const products = Array.from({ length: 50 }, (_, i) => ({ _id: new ObjectId(), organizationId, name: `Product ${i + 1}`, pricePaise: 10000 + i * 500, gstRatePct: 5, unit: 'pcs', active: true, deletedAt: null, createdAt: ago(800 * DAY), updatedAt: ago(800 * DAY) }));
  await insert(Product, products);

  const contacts = Array.from({ length: 20000 }, (_, i) => {
    const at = ago(rnd(730, i) * DAY + i * 1000);
    return {
      _id: new ObjectId(), organizationId, name: `Seed Customer ${String(i).padStart(5, '0')}`, email: `c${i}@example.com`,
      phone: `98${String(10000000 + i).slice(-8)}`, phoneE164: `+9198${String(10000000 + i).slice(-8)}`, company: `Company ${i % 3000}`,
      city: CITIES[i % 10], tags: i % 5 ? [] : ['wholesale'], lifecycle: i % 2 ? 'customer' : 'lead', status: 'Active', ownerId,
      consent: { marketing: 'unknown' }, deletedAt: null, createdAt: at, updatedAt: at,
    };
  });
  await insert(Contact, contacts);

  const leads = Array.from({ length: 50000 }, (_, i) => {
    const at = ago(rnd(730, i + 7) * DAY + i * 1000);
    const stage = STAGES[i % STAGES.length];
    const open = !['Won', 'Lost'].includes(stage);
    return {
      _id: new ObjectId(), organizationId, contactId: contacts[i % 20000]._id, title: `Enquiry ${i}`, source: SOURCES[i % SOURCES.length],
      stage, stageChangedAt: new Date(at.getTime() + rnd(20, i) * DAY), productId: i % 3 ? products[i % 50]._id : undefined,
      quantity: 10, expectedValuePaise: i % 4 ? 100000 + rnd(5000000, i) : undefined, ownerId,
      followUpAt: open && i % 3 === 0 ? new Date(now + rnd(30, i) * DAY - 15 * DAY) : undefined,
      score: open ? { points: rnd(100, i), band: ['hot', 'warm', 'cold'][i % 3], at: ago(DAY) } : undefined,
      version: 0, deletedAt: null, createdAt: at, updatedAt: at,
    };
  });
  await insert(Lead, leads);

  const accountId = new ObjectId();
  const conversations = Array.from({ length: 10000 }, (_, i) => {
    const last = ago(rnd(365, i + 3) * DAY + i * 1000);
    return {
      _id: new ObjectId(), organizationId, contactId: contacts[i]._id, whatsappAccountId: accountId, status: ['open', 'pending', 'closed', 'closed'][i % 4],
      assigneeId: i % 3 ? ownerId : null, lastMessageAt: last, lastInboundAt: last, lastMessageDirection: i % 2 ? 'in' : 'out', lastMessagePreview: `Message ${i}`,
      unreadCount: i % 7 === 0 ? 2 : 0, archivedAt: null, blockedAt: null, tags: [], createdAt: ago(400 * DAY), updatedAt: last,
    };
  });
  await insert(Conversation, conversations);

  const messages = [];
  for (let c = 0; c < conversations.length; c += 1) {
    const conv = conversations[c];
    for (let m = 0; m < 20; m += 1) {
      const out = m % 2 === 1;
      const at = new Date(conv.lastMessageAt.getTime() - (20 - m) * 3600 * 1000);
      messages.push({
        organizationId, conversationId: conv._id, contactId: conv.contactId, whatsappAccountId: accountId, direction: out ? 'out' : 'in', type: 'text',
        text: { body: `Hello ${c}-${m} rate kya hai` }, status: out ? 'read' : 'received', sentByMemberId: out ? ownerId : undefined, createdAt: at, updatedAt: at,
      });
    }
    if (messages.length >= 50000) await insert(Message, messages.splice(0));
  }
  await insert(Message, messages);

  const today = new Date(now + 330 * 60000).toISOString().slice(0, 10);
  await insert(Task, Array.from({ length: 5000 }, (_, i) => ({ organizationId, title: `Call back ${i}`, status: i % 4 ? 'To Do' : 'Done', priority: 'Medium', dueDate: i % 10 ? new Date(now + (rnd(60, i) - 30) * DAY).toISOString().slice(0, 10) : today, assigneeId: ownerId, deletedAt: null, createdAt: ago(rnd(300, i) * DAY), updatedAt: ago(DAY) })));
  await insert(Quotation, Array.from({ length: 5000 }, (_, i) => ({ organizationId, leadId: leads[i * 7]._id, contactId: leads[i * 7].contactId, number: `QT/2026-27/${i}`, type: 'Quotation', status: ['Draft', 'Sent', 'Viewed', 'Accepted', 'Rejected'][i % 5], ownerId, totals: { grandTotalPaise: 500000 + i }, sentAt: i % 5 ? ago(rnd(200, i) * DAY) : undefined, deletedAt: null, createdAt: ago(rnd(200, i) * DAY + DAY), updatedAt: ago(DAY) })));
  await insert(Order, Array.from({ length: 2000 }, (_, i) => ({ organizationId, contactId: contacts[i]._id, number: `SO/2026-27/${i}`, stage: ['Received', 'Processing', 'Dispatched', 'Delivered', 'Payment Collected'][i % 5], ownerId, totals: { grandTotalPaise: 1000000 }, payments: i % 2 ? [{ _id: new ObjectId(), amountPaise: 500000, paidAt: ago(rnd(60, i) * DAY), source: 'manual', method: 'upi' }] : [], deletedAt: null, createdAt: ago(rnd(120, i) * DAY), updatedAt: ago(DAY) })));
  console.log(`Made in ${((Date.now() - started) / 1000).toFixed(0)} s: ${await Contact.countDocuments({ organizationId })} contacts, ${await Lead.countDocuments({ organizationId })} leads, ${await Conversation.countDocuments({ organizationId })} chats, ${await Message.countDocuments({ organizationId })} messages\n`);

  // --- the timings ----------------------------------------------------------------------------
  const rows = [];
  const show = (label, p50, p95, note = '') => {
    rows.push({ label, p50, p95, note });
    console.log(`${label.padEnd(46)} p50 ${p50.toFixed(0).padStart(5)} ms  p95 ${p95.toFixed(0).padStart(5)} ms  ${note}`);
  };
  async function measure(label, url, runs = RUNS) {
    const times = [];
    let note = '';
    for (let i = 0; i < runs; i += 1) {
      const start = process.hrtime.bigint();
      const res = await request(app).get(url).set(bearer);
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
      if (res.status !== 200) throw new Error(`${url}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      note = res.body.pagination ? `${res.body.pagination.total} match` : '';
    }
    times.sort((a, b) => a - b);
    const pick = (p) => times[Math.min(times.length - 1, Math.ceil(p * times.length) - 1)];
    show(label, pick(0.5), pick(0.95), note);
  }
  // A page's copy of 5,000 records (crmFetchPages in js/app.js): one page after the other, as
  // before Phase 3, or the first and then six at once.
  async function pageLoad(label, apiPath, together) {
    const times = [];
    for (let r = 0; r < 3; r += 1) {
      const start = process.hrtime.bigint();
      const url = (page) => `${apiPath}?page=${page}&limit=100`;
      const first = await request(app).get(url(1)).set(bearer);
      const last = Math.min(first.body.pagination.totalPages, 50);
      let next = 2;
      const worker = async () => {
        while (next <= last) {
          const page = next;
          next += 1;
          await request(app).get(url(page)).set(bearer);
        }
      };
      await Promise.all(Array.from({ length: together }, worker));
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    times.sort((a, b) => a - b);
    show(label, times[1], times[2], '50 requests');
  }

  const someChat = conversations[42]._id;
  const yearAgo = new Date(now - 364 * DAY).toISOString().slice(0, 10);
  await measure('Customers list, first 100', '/api/v1/contacts?lifecycle=customer&page=1&limit=100');
  await measure('Customers search by name', '/api/v1/contacts?lifecycle=customer&q=Customer%2015501&limit=100');
  await measure('Customers search by phone', '/api/v1/contacts?q=9810015&limit=100');
  await measure('Customers: ids for "select all"', '/api/v1/contacts/ids?lifecycle=customer');
  await measure('Leads list, first 100', '/api/v1/leads?page=1&limit=100');
  await measure('Leads list, page 300 (rows 29,901+)', '/api/v1/leads?page=300&limit=100');
  await measure('Leads search', '/api/v1/leads?q=Customer%2012345&limit=100');
  await measure('Leads by stage', '/api/v1/leads?stage=Negotiation&limit=100');
  await measure('Leads by score (hot)', '/api/v1/leads?scoreBand=hot&limit=100');
  await measure('Leads summary (dashboard, deals, products)', '/api/v1/leads/summary');
  await measure('Leads: ids for "select all"', '/api/v1/leads/ids?stage=New');
  await measure('Inbox list', '/api/v1/conversations?view=all&limit=30');
  await measure('Inbox search', '/api/v1/conversations?view=all&q=Customer%2000042&limit=30');
  await measure('Inbox tab counts', '/api/v1/conversations/summary');
  await measure('Chat messages (newest 50)', `/api/v1/conversations/${someChat}/messages?limit=50`);
  await measure('Search box (all records)', '/api/v1/search?q=Customer%2019999');
  await measure('Dashboard numbers', '/api/v1/reports/dashboard');
  await measure('Report: overview (30 days)', '/api/v1/reports/overview');
  await measure('Report: trend (30 days)', '/api/v1/reports/trend');
  await measure('Report: lead sources (30 days)', '/api/v1/reports/sources');
  await measure('Report: agents (30 days)', '/api/v1/reports/agents');
  await measure('Report: quotations (30 days)', '/api/v1/reports/quotations');
  await measure('Report: payments (30 days)', '/api/v1/reports/payments');
  await measure('Report: overview (whole year)', `/api/v1/reports/overview?from=${yearAgo}&to=${today}`);
  await measure('AI Insights', '/api/v1/reports/insights', 5);
  await pageLoad('Page copy of 5,000 contacts, one by one', '/api/v1/contacts', 1);
  await pageLoad('Page copy of 5,000 contacts, 6 at once', '/api/v1/contacts', 6);

  if (OUT) fs.writeFileSync(path.resolve(OUT), JSON.stringify(rows, null, 2));
  await mongoose.disconnect();
  await replSet.stop();
  fs.rmSync(files, { recursive: true, force: true });
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
