const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Order = require('../models/Order');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Product = require('../models/Product');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const env = require('../config/env');
const logger = require('../config/logger');
const bus = require('../realtime/bus');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { nextSequence } = require('../utils/counter');
const { financialYear, formatRupees } = require('../utils/money');
const { providerFor } = require('../integrations/whatsapp');
const accounts = require('./whatsappAccountService');
const { billingOf } = require('./organizationService');
const automationEvents = require('./automation/events');
const quotationService = require('./quotationService');
const conversationService = require('./conversationService');
const leadService = require('./leadService');
const notificationService = require('./notificationService');
const { leadOfContact } = require('./automation/context');
const planService = require('./planService');

// The WhatsApp catalog (Phase 8C, Meta Commerce). A number's WhatsApp Business Account has a
// catalog connected in Meta's Commerce Manager; the CRM checks it, then keeps it in step with the
// products marked "in the WhatsApp catalog" (the "catalog.sync" job: at once, then daily, and by
// hand). Members send one product or a list into a chat; a cart the customer sends back
// ("order" message) becomes a CRM order at Received (the "catalog.order" job), confirmed to them.
// Prices go to Meta including GST (D43); the order is priced from the products as usual.
const JOBS = { SYNC: 'catalog.sync', ORDER: 'catalog.order' };
const SYNC_EVERY_MS = 24 * 60 * 60 * 1000;
const BATCH = 1000;
const MAX_PRODUCTS_IN_MESSAGE = 30;
const ORDER_SOURCE = 'WhatsApp catalog';

const scheduleKey = (accountId) => `catalog:${accountId}`;
const retailerIdOf = (product) => String(product.sku || product._id).trim().slice(0, 100);
const withGstPaise = (product) => Math.round(((product.pricePaise || 0) * (100 + (product.gstRatePct || 0))) / 100);

const { serializeCatalog } = accounts;

const assertPlan = (organizationId) => planService.assertFeature(organizationId, 'catalog');

// --- connecting a catalog to a number (Settings → WhatsApp, owners and admins) ----------------
// PUT /whatsapp/accounts/:id/catalog { catalogId, catalogVisible?, cartEnabled? }
async function connect(req, accountId, { catalogId, catalogVisible, cartEnabled }, queue = require('../jobs/queue')) {
  await assertPlan(req.tenant.organizationId);
  const account = await accounts.findInOrg(req, accountId);
  const provider = providerFor(account);
  let catalog;
  try {
    catalog = await provider.getCatalog(accounts.credentials(account), catalogId);
  } catch (error) {
    throw httpError(400, 'CATALOG_REFUSED', `Meta did not open catalog ${catalogId}: ${error.message} Check the catalog id in Commerce Manager, that it is connected to this WhatsApp Business Account, and that your system user has access to it.`);
  }
  let statusMessage = '';
  if (catalogVisible !== undefined || cartEnabled !== undefined) {
    try {
      await provider.setCommerceSettings(accounts.credentials(account), { catalogVisible: Boolean(catalogVisible), cartEnabled: Boolean(cartEnabled) });
    } catch (error) {
      statusMessage = `The catalog is connected, but Meta did not change the shop settings: ${error.message}`;
    }
  }
  const before = account.catalog || {};
  const changed = (catalogVisible !== undefined || cartEnabled !== undefined) && !statusMessage;
  account.catalog = {
    catalogId: catalog.catalogId, name: catalog.name, productCount: catalog.productCount, status: 'connected', statusMessage, checkedAt: new Date(),
    catalogVisible: changed ? Boolean(catalogVisible) : before.catalogVisible,
    cartEnabled: changed ? Boolean(cartEnabled) : before.cartEnabled,
    // The same catalog again keeps its sync history.
    ...(before.catalogId === catalog.catalogId && { lastSyncAt: before.lastSyncAt, lastSync: before.lastSync }),
  };
  await account.save();
  // A sync at once, then every day.
  await queue.every(JOBS.SYNC, SYNC_EVERY_MS, { accountId: String(account._id) }, { uniqueKey: scheduleKey(account._id), organizationId: account.organizationId });
  await audit(req, { action: 'whatsapp.catalog.connected', entityType: 'WhatsAppAccount', entityId: account._id, changes: { catalogId: catalog.catalogId } });
  return serializeCatalog(account);
}

async function disconnect(req, accountId, queue = require('../jobs/queue')) {
  const account = await accounts.findInOrg(req, accountId);
  account.catalog = undefined;
  await account.save();
  await queue.cancel(scheduleKey(account._id));
  await audit(req, { action: 'whatsapp.catalog.disconnected', entityType: 'WhatsAppAccount', entityId: account._id });
}

// GET /catalog — the catalogs of the organization's numbers and how many products are in it.
async function status(req) {
  const organizationId = req.tenant.organizationId;
  const list = await WhatsAppAccount.find({ organizationId, 'catalog.catalogId': { $exists: true, $ne: null } }).sort({ isDefault: -1, createdAt: 1 });
  const [included, synced, failed] = await Promise.all([
    Product.countDocuments({ organizationId, 'catalog.include': true, active: true }),
    Product.countDocuments({ organizationId, 'catalog.include': true, active: true, 'catalog.status': 'synced' }),
    Product.countDocuments({ organizationId, 'catalog.include': true, active: true, 'catalog.status': 'error' }),
  ]);
  return {
    available: planService.hasFeature(await Organization.findById(organizationId), 'catalog'),
    catalogs: list.map((account) => ({ ...serializeCatalog(account), accountName: account.name || account.verifiedName || account.displayPhone || '' })),
    products: { included, synced, failed },
  };
}

// --- keeping the catalog in step with the products --------------------------------------------
function problemOf(product) {
  if (!(product.pricePaise > 0)) return 'Add a price: WhatsApp shows one for every product.';
  if (!/^https:\/\//i.test(product.images?.[0] || '')) return 'Add a "Photo link (https)" to the product: WhatsApp shows a photo it can open for every product.';
  return '';
}

function landingPage(organization) {
  const site = String(organization?.website || '').trim();
  if (/^https?:\/\//i.test(site)) return site;
  if (site) return `https://${site.replace(/^\/+/, '')}`;
  return env.publicUrl;
}

function itemData(product, organization) {
  return {
    id: retailerIdOf(product),
    title: product.name.slice(0, 100),
    description: (product.description || product.name).slice(0, 5000),
    availability: product.stockQty === 0 ? 'out of stock' : 'in stock',
    condition: 'new',
    price: `${(withGstPaise(product) / 100).toFixed(2)} INR`,
    link: landingPage(organization),
    image_link: product.images[0],
    brand: (organization?.name || 'Our shop').slice(0, 100),
  };
}

// Sends what changed since the last sync: products to show (UPDATE adds or changes them), and
// products to take away (DELETE: no longer included, inactive, deleted, or their SKU changed).
async function syncAccount(accountId) {
  const account = await WhatsAppAccount.findById(accountId);
  if (!account?.catalog?.catalogId) return { skipped: 'no catalog' };
  const organization = await Organization.findById(account.organizationId);
  if (!planService.hasFeature(organization, 'catalog')) return { skipped: 'plan' };
  const organizationId = account.organizationId;
  const [products, deleted] = await Promise.all([
    Product.find({ organizationId, $or: [{ 'catalog.include': true }, { 'catalog.retailerId': { $exists: true } }] }),
    Product.find({ organizationId, deletedAt: { $ne: null }, 'catalog.retailerId': { $exists: true } }),
  ]);
  const requests = [];
  const outcome = new Map(); // product id → { set, unset }
  const sentIds = new Map(); // retailer id → product id (to match Meta's problems)
  let failed = 0;
  for (const product of products) {
    const wanted = product.catalog?.include && product.active;
    const previous = product.catalog?.retailerId;
    if (wanted) {
      const problem = problemOf(product);
      if (problem) {
        failed += 1;
        outcome.set(String(product._id), { set: { 'catalog.status': 'error', 'catalog.error': problem } });
        continue;
      }
      const id = retailerIdOf(product);
      if (previous && previous !== id) requests.push({ method: 'DELETE', data: { id: previous } });
      requests.push({ method: 'UPDATE', data: itemData(product, organization) });
      sentIds.set(id, String(product._id));
      outcome.set(String(product._id), { set: { 'catalog.retailerId': id, 'catalog.status': 'synced', 'catalog.error': '', 'catalog.syncedAt': new Date() } });
    } else if (previous) {
      requests.push({ method: 'DELETE', data: { id: previous } });
      outcome.set(String(product._id), { set: { 'catalog.status': 'removed', 'catalog.error': '' }, unset: { 'catalog.retailerId': 1 } });
    }
  }
  for (const product of deleted) {
    requests.push({ method: 'DELETE', data: { id: product.catalog.retailerId } });
    outcome.set(String(product._id), { set: { 'catalog.status': 'removed' }, unset: { 'catalog.retailerId': 1 }, deleted: true });
  }
  const provider = providerFor(account);
  try {
    for (let i = 0; i < requests.length; i += BATCH) {
      const { problems } = await provider.catalogBatch(accounts.credentials(account), account.catalog.catalogId, requests.slice(i, i + BATCH));
      for (const problem of problems) {
        const productId = sentIds.get(problem.retailerId);
        if (!productId) continue;
        failed += 1;
        outcome.set(productId, { set: { 'catalog.status': 'error', 'catalog.error': `Meta: ${problem.message}`.slice(0, 300) } });
      }
    }
  } catch (error) {
    await WhatsAppAccount.updateOne({ _id: account._id }, { $set: { 'catalog.lastSyncAt': new Date(), 'catalog.lastSync': { sent: 0, removed: 0, failed, error: String(error.message).slice(0, 300) } } });
    if (error.statusCode && error.statusCode < 500) return { error: error.message };
    throw error; // Meta unreachable: the job tries again
  }
  for (const [productId, change] of outcome) {
    const update = { $set: change.set, ...(change.unset && { $unset: change.unset }) };
    await Product.updateOne({ _id: productId, ...(change.deleted && { deletedAt: { $ne: null } }) }, update);
  }
  const summary = {
    sent: [...outcome.values()].filter((c) => c.set['catalog.status'] === 'synced').length,
    removed: [...outcome.values()].filter((c) => c.set['catalog.status'] === 'removed').length,
    failed,
    error: '',
  };
  await WhatsAppAccount.updateOne({ _id: account._id }, { $set: { 'catalog.lastSyncAt': new Date(), 'catalog.lastSync': summary } });
  return summary;
}

// POST /catalog/sync — every catalog of the organization, now.
async function syncNow(req) {
  await assertPlan(req.tenant.organizationId);
  const list = await WhatsAppAccount.find({ organizationId: req.tenant.organizationId, 'catalog.catalogId': { $exists: true, $ne: null } });
  if (!list.length) throw httpError(409, 'NO_CATALOG', 'Connect a catalog to a WhatsApp number in Settings → WhatsApp first.');
  const results = [];
  for (const account of list) results.push({ accountId: account._id, ...(await syncAccount(account._id)) });
  await audit(req, { action: 'whatsapp.catalog.synced', entityType: 'Organization', entityId: req.tenant.organizationId });
  return { results, ...(await status(req)) };
}

// --- products in a chat -----------------------------------------------------------------------
async function chatCatalog(req, conversationId) {
  const conversation = await conversationService.findVisible(req, conversationId);
  const account = await WhatsAppAccount.findOne({ _id: conversation.whatsappAccountId, organizationId: conversation.organizationId });
  return { conversation, account, catalogId: account?.catalog?.catalogId || '' };
}

// GET /conversations/:id/catalog — the products that can be sent in this chat.
async function productsForChat(req, conversationId) {
  const { conversation, catalogId } = await chatCatalog(req, conversationId);
  let blocked = planService.featureBlock(await Organization.findById(req.tenant.organizationId), 'catalog');
  if (!blocked && !catalogId) blocked = 'This chat\'s WhatsApp number has no catalog yet (Settings → WhatsApp).';
  const products = blocked ? [] : await Product.find({ organizationId: req.tenant.organizationId, active: true, 'catalog.include': true, 'catalog.status': 'synced' })
    .sort({ category: 1, name: 1 }).limit(500);
  return {
    blocked,
    windowOpen: conversationService.serviceWindow(conversation).open,
    products: products.map((p) => ({ id: p._id, name: p.name, category: p.category || '', unit: p.unit || '', pricePaise: p.pricePaise, gstRatePct: p.gstRatePct, priceWithGstPaise: withGstPaise(p), image: p.images?.[0] || '', retailerId: p.catalog.retailerId })),
  };
}

// POST /conversations/:id/products { productIds, header?, body? }
async function sendProducts(req, conversationId, { productIds, header, body }) {
  await assertPlan(req.tenant.organizationId);
  const { catalogId } = await chatCatalog(req, conversationId);
  if (!catalogId) throw httpError(409, 'NO_CATALOG', 'This chat\'s WhatsApp number has no catalog yet (Settings → WhatsApp).');
  if (productIds.length > MAX_PRODUCTS_IN_MESSAGE) throw httpError(400, 'VALIDATION_ERROR', `WhatsApp shows at most ${MAX_PRODUCTS_IN_MESSAGE} products in one message.`);
  const found = await Product.find({ _id: { $in: productIds }, organizationId: req.tenant.organizationId, active: true, 'catalog.include': true, 'catalog.status': 'synced' });
  const byId = new Map(found.map((p) => [String(p._id), p]));
  const products = productIds.map((id) => byId.get(String(id))).filter(Boolean);
  if (products.length !== productIds.length) {
    throw httpError(400, 'VALIDATION_ERROR', 'Some products are not in the WhatsApp catalog yet (sync it first).', [{ field: 'productIds', code: 'NOT_IN_CATALOG', message: 'Pick products shown as "in the catalog".' }]);
  }
  const organization = await Organization.findById(req.tenant.organizationId);
  const message = await conversationService.sendProducts(req, conversationId, {
    catalogId,
    products: products.map((p) => ({ productId: p._id, retailerId: p.catalog.retailerId, name: p.name, section: p.category || 'Products' })),
    header: (header || `${organization.name || 'Our'} products`).slice(0, 60),
    body: body || (products.length > 1 ? 'Tap a product to see it, add what you need to the cart and send it to us.' : ''),
  });
  if (message.status === 'failed') throw httpError(502, 'WHATSAPP_REFUSED', `WhatsApp did not accept it: ${message.error?.message || 'unknown reason'}.`);
  return message;
}

// --- a cart from the catalog becomes an order ------------------------------------------------
const systemReq = (organizationId) => ({
  tenant: { organizationId },
  member: { _id: undefined, role: 'owner', modules: [], permissions: [], status: 'active' },
  user: { _id: undefined, name: ORDER_SOURCE },
  automation: { chain: [] },
  id: `catalog-order:${organizationId}`,
  ip: '',
  get: () => '',
});

async function orderFromMessage({ messageId }) {
  const message = await Message.findById(messageId);
  if (!message || message.type !== 'order' || message.direction !== 'in' || !message.order?.items?.length || message.order.orderId) return null;
  const existing = await Order.findOne({ 'catalogOrder.messageId': message._id });
  if (existing) {
    await Message.updateOne({ _id: message._id }, { $set: { 'order.orderId': existing._id } });
    return existing;
  }
  const organizationId = message.organizationId;
  const req = systemReq(organizationId);
  const [organization, contact, conversation] = await Promise.all([
    Organization.findById(organizationId),
    Contact.findOne({ _id: message.contactId, organizationId }),
    Conversation.findOne({ _id: message.conversationId, organizationId }),
  ]);
  // The cart's items, matched to the products by the id Meta knows them by.
  const warnings = [];
  const lines = [];
  for (const item of message.order.items) {
    const product = await Product.findOne({ organizationId, 'catalog.retailerId': item.retailerId })
      || (mongoose.isValidObjectId(item.retailerId) ? await Product.findOne({ organizationId, _id: item.retailerId }) : null);
    if (product) {
      lines.push({ productId: product._id, quantity: item.quantity });
      const shown = withGstPaise(product);
      if (item.itemPricePaise && Math.abs(item.itemPricePaise - shown) > 100) {
        warnings.push(`${product.name}: the catalog showed ${formatRupees(item.itemPricePaise)}, the CRM price with GST is ${formatRupees(shown)}.`);
      }
    } else {
      lines.push({ name: `Catalog item ${item.retailerId}`, unit: 'pcs', quantity: item.quantity, unitPricePaise: item.itemPricePaise || 0, gstRatePct: 0 });
      warnings.push(`"${item.retailerId}" is not a product in the CRM: added at the catalog price without GST.`);
    }
  }
  const billing = billingOf(organization);
  const billTo = quotationService.partyFromContact(contact);
  const lead = await leadOfContact(organizationId, message.contactId);
  const openLead = lead && !['Won', 'Lost'].includes(lead.stage) ? lead : null;
  const ownerId = openLead?.ownerId || conversation?.assigneeId || contact?.ownerId || undefined;
  let order;
  try {
    await mongoose.connection.transaction(async (session) => {
      const priced = await quotationService.priceFor(organization, { items: lines, billTo, roundOff: billing.roundOff }, session);
      const year = financialYear();
      const seq = await nextSequence(organizationId, `order:${year}`, { session });
      order = new Order({
        organizationId,
        number: `${billing.prefixes.order}/${year}/${String(seq).padStart(4, '0')}`,
        financialYear: year,
        source: 'catalog',
        catalogOrder: { messageId: message._id, conversationId: message.conversationId, catalogId: message.order.catalogId, text: message.order.text || '', ...(warnings.length && { warnings }) },
        leadId: openLead?._id,
        contactId: message.contactId,
        ownerId,
        billTo,
        seller: quotationService.sellerOf(organization),
        supply: priced.supply,
        items: priced.items,
        totals: priced.totals,
        notes: message.order.text ? `Customer's note: ${message.order.text}` : '',
        history: [{ stage: 'Received', from: '', byName: ORDER_SOURCE, note: 'Sent from the WhatsApp catalog' }],
      });
      await order.save({ session });
      if (openLead) await leadService.addActivity(req, openLead, 'Order', `Order ${order.number} received from the WhatsApp catalog (${formatRupees(order.totals.grandTotalPaise)})`, { session });
    });
    automationEvents.emit('order.created', { organizationId, orderId: order._id, leadId: order.leadId || null, contactId: order.contactId, key: `order.created:${order._id}` });
  } catch (error) {
    if (error.code !== 11000) throw error;
    order = await Order.findOne({ 'catalogOrder.messageId': message._id });
  }
  const linked = await Message.findByIdAndUpdate(message._id, { $set: { 'order.orderId': order._id } }, { returnDocument: 'after' });
  bus.emit('message:status', { organizationId, message: linked }); // the open chat shows "Open the order"
  // Thank the customer (they just wrote, so the window is open).
  if (conversation && conversationService.serviceWindow(conversation).open) {
    const text = `Thank you${contact?.name ? ` ${contact.name}` : ''}! We have received your order ${order.number} for ${formatRupees(order.totals.grandTotalPaise)}. We will confirm it shortly.`;
    await conversationService.sendTextAutomatically({ conversation, text, automation: { kind: 'catalog-order', ruleId: order._id } })
      .catch((error) => logger.warn(`Catalog order ${order.number}: the thank-you message failed: ${error.message}`));
  }
  // The bell: the order's owner, else the owners and admins.
  const people = ownerId ? [ownerId] : (await OrganizationMember.find({ organizationId, status: 'active', role: { $in: ['owner', 'admin'] } }).select('_id')).map((m) => m._id);
  await notificationService.notify(organizationId, people, {
    title: `New order from the WhatsApp catalog: ${order.number}`,
    body: `${contact?.name || 'A customer'} ordered ${message.order.items.length} ${message.order.items.length === 1 ? 'product' : 'products'} for ${formatRupees(order.totals.grandTotalPaise)}.${warnings.length ? ` Check: ${warnings[0]}` : ''}`,
    link: `Orders.html?id=${order._id}`,
    source: 'catalog',
  });
  return order;
}

let listener = null;
function register(queue) {
  queue.define(JOBS.SYNC, async ({ accountId }) => {
    const account = await WhatsAppAccount.findById(accountId);
    if (!account?.catalog?.catalogId) {
      await queue.cancel(scheduleKey(accountId));
      return;
    }
    await syncAccount(accountId);
  }, { maxAttempts: 3 });
  queue.define(JOBS.ORDER, orderFromMessage, { maxAttempts: 5 });
  if (listener) bus.off('message:new', listener);
  listener = ({ message }) => {
    if (message?.type !== 'order' || message.direction !== 'in') return;
    queue.enqueue(JOBS.ORDER, { messageId: String(message._id) }, { uniqueKey: `catalog-order:${message._id}`, organizationId: message.organizationId })
      .catch((error) => logger.error(`Catalog order for message ${message._id} could not be queued: ${error.message}`));
  };
  bus.on('message:new', listener);
}

module.exports = {
  JOBS, connect, disconnect, status, syncAccount, syncNow, productsForChat, sendProducts, orderFromMessage, register,
  serializeCatalog, retailerIdOf, withGstPaise, itemData,
};
