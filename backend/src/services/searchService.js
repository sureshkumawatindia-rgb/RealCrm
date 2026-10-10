const logger = require('../config/logger');
const { can } = require('../constants/permissions');
const contactService = require('./contactService');
const leadService = require('./leadService');
const conversationService = require('./conversationService');
const quotationService = require('./quotationService');
const orderService = require('./orderService');
const productService = require('./productService');
const taskService = require('./taskService');
const ticketService = require('./ticketService');

// One search box for the whole CRM (top bar, Ctrl+K). Each group searches through its own
// module's list, so a member finds exactly what that page would show them: their own records
// when they only see assigned ones, no private numbers unless they are an owner (D61), and
// no group at all for a module they may not open.

const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const join = (...parts) => parts.filter(Boolean).join(' · ');

const GROUPS = [
  {
    type: 'customers',
    label: 'Customers',
    modules: ['customers'],
    page: () => 'customers.html',
    // Like the Customers page: people who buy. Leads' contacts are found under Leads, WhatsApp
    // contacts under their chats.
    search: (req, query) => contactService.list(req, { ...query, lifecycle: 'customer' }),
    item: (contact) => ({
      id: contact.id,
      title: contact.name,
      subtitle: join(contact.company, contact.phone || contact.phoneE164, contact.email),
      url: `customer-360.html?id=${contact.id}`,
    }),
  },
  {
    type: 'leads',
    label: 'Leads',
    modules: leadService.MODULES,
    // The Deals page shows the same leads, for members who have Deals but not Leads.
    page: (req) => (can(req.member, 'leads', 'view') ? 'leads.html' : 'Deals.html'),
    search: (req, query) => leadService.list(req, query),
    item: (lead, req) => ({
      id: lead.id,
      title: lead.contact?.name || lead.title,
      subtitle: join(lead.stage, lead.title !== lead.contact?.name && lead.title, lead.contact?.company, lead.contact?.phone),
      url: `${GROUP_PAGE.leads(req)}?open=${lead.id}`,
    }),
  },
  {
    type: 'chats',
    label: 'WhatsApp chats',
    modules: ['inbox'],
    page: () => 'Inbox.html',
    search: (req, query) => conversationService.list(req, { ...query, status: 'any' }),
    item: (chat) => ({
      id: chat.id,
      title: chat.contact.name || chat.contact.phone || 'WhatsApp chat',
      subtitle: join(chat.contact.name && chat.contact.phone, chat.lastMessagePreview),
      url: `Inbox.html?c=${chat.id}`,
    }),
  },
  {
    type: 'quotations',
    label: 'Quotations',
    modules: ['leads', 'deals'],
    page: () => 'Quotations.html',
    search: (req, query) => quotationService.list(req, query),
    item: (quotation) => ({
      id: quotation.id,
      title: quotation.number,
      subtitle: join(quotation.billTo?.name, rupees(quotation.totals?.grandTotalPaise), quotation.status),
      url: `Quotations.html?id=${quotation.id}`,
    }),
  },
  {
    type: 'orders',
    label: 'Orders',
    modules: ['leads', 'deals'],
    page: () => 'Orders.html',
    search: (req, query) => orderService.list(req, query),
    item: (order) => ({
      id: order.id,
      title: order.number,
      subtitle: join(order.billTo?.name, rupees(order.totals?.grandTotalPaise), order.stage),
      url: `Orders.html?id=${order.id}`,
    }),
  },
  {
    type: 'products',
    label: 'Products',
    modules: ['products'],
    page: () => 'Products.html',
    search: (req, query) => productService.list(req, query),
    item: (product) => ({
      id: product.id,
      title: product.name,
      subtitle: join(product.sku, rupees(product.pricePaise), product.category),
      url: `Products.html?open=${product.id}`,
    }),
  },
  {
    type: 'tasks',
    label: 'Tasks',
    modules: ['tasks'],
    page: () => 'Tasks.html',
    search: (req, query) => taskService.list(req, query),
    item: (task) => ({
      id: task.id,
      title: task.title,
      subtitle: join(task.status, task.dueDate && `due ${task.dueDate}`, task.assigneeName, task.relatedName),
      url: `Tasks.html?open=${task.id}`,
    }),
  },
  {
    type: 'tickets',
    label: 'Support tickets',
    modules: ['support'],
    page: () => 'Support.html',
    search: (req, query) => ticketService.list(req, query),
    item: (ticket) => ({
      id: ticket.id,
      title: ticket.subject,
      subtitle: join(ticket.number && `#${ticket.number}`, ticket.status, ticket.customerName),
      url: `Support.html?open=${ticket.id}`,
    }),
  },
];

const GROUP_PAGE = Object.fromEntries(GROUPS.map((group) => [group.type, group.page]));

// A phone number typed with spaces, dashes or +91 is searched as its digits.
function searchText(q) {
  const term = String(q).trim();
  const digits = term.replace(/\D/g, '');
  return /^[+\d\s().-]+$/.test(term) && digits.length >= 5 ? digits : term;
}

async function search(req, { q, limit = 5 }) {
  const query = { q: searchText(q), page: 1, limit };
  const allowed = GROUPS.filter((group) => group.modules.some((module) => can(req.member, module, 'view')));
  const groups = await Promise.all(
    allowed.map(async (group) => {
      try {
        const { items, pagination } = await group.search(req, { ...query });
        return {
          type: group.type,
          label: group.label,
          total: pagination?.total ?? items.length,
          // The module's own page with the same search, for "Show all".
          allUrl: `${group.page(req)}?q=${encodeURIComponent(String(q).trim())}`,
          items: items.map((record) => ({ type: group.type, ...group.item(record, req) })),
        };
      } catch (error) {
        // One module failing never hides the others' results.
        logger.warn(`Search in ${group.type} failed: ${error.message}`);
        return { type: group.type, label: group.label, total: 0, items: [] };
      }
    }),
  );
  return { q: String(q).trim(), groups: groups.filter((group) => group.items.length) };
}

module.exports = { search, searchText, GROUPS };
