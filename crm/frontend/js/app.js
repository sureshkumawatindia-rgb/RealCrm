/**
 * app.js — shared helpers for every page.
 * Everything is stored in localStorage. No backend anywhere.
 */

const KEYS = {
  SESSION: "crm_session",
  USER: "crm_user",
  COMPANY: "crm_company",
  CUSTOMERS: "crm_customers",
  LEADS: "crm_leads",
  ACCOUNTS: "crm_accounts",
  AGENTS: "crm_agents",
  PRODUCTS: "crm_products",
  QUOTATIONS: "crm_quotations",
  LEAD_ACTIVITIES: "crm_lead_activities",
};

const CRM_API_BASE = "http://127.0.0.1:3000/api/v1";

async function crmApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const session = localStorage.getItem(KEYS.SESSION);
  if (session) headers.set("Authorization", `Bearer ${session}`);
  let response;
  try {
    response = await fetch(`${CRM_API_BASE}${path}`, { ...options, headers });
  } catch (error) {
    throw new Error(`CRM API is unreachable at ${CRM_API_BASE}. Start the backend and verify its port.`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || "Request failed.");
  }
  return body.data;
}

// ---------------------------------------------------------------
// Auth
// ---------------------------------------------------------------
function isAuthenticated() {
  const session = localStorage.getItem(KEYS.SESSION);
  return !!session && session.split(".").length === 3;
}

function getCurrentUser() {
  const raw = localStorage.getItem(KEYS.USER);
  return raw ? JSON.parse(raw) : null;
}

function requireAuth() {
  if (!isAuthenticated()) {
    window.location.replace("login.html");
  }
}

function logout() {
  localStorage.removeItem(KEYS.SESSION);
  localStorage.removeItem(KEYS.USER);
  window.location.href = "login.html";
}

// ---------------------------------------------------------------
// Storage — company profile
// ---------------------------------------------------------------
const COMPANY_FIELDS = [
  { key: "name", label: "Company Name" },
  { key: "industry", label: "Industry" },
  { key: "email", label: "Company Email" },
  { key: "phone", label: "Phone" },
  { key: "website", label: "Website" },
  { key: "logo", label: "Logo URL" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "country", label: "Country" },
  { key: "zip", label: "Postal Code" },
  { key: "taxId", label: "Tax / GST ID" },
  { key: "employees", label: "Employees" },
  { key: "founded", label: "Founded Year" },
  { key: "description", label: "Description", full: true },
];

function getCompanyInfo() {
  const raw = localStorage.getItem(KEYS.COMPANY);
  return raw ? JSON.parse(raw) : null;
}
function saveCompanyInfo(data) {
  localStorage.setItem(KEYS.COMPANY, JSON.stringify(data));
}
function hasCompanyInfo() {
  return !!localStorage.getItem(KEYS.COMPANY);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}

function buildCompanyReviewHTML(company) {
  return COMPANY_FIELDS.map((f) => {
    const value = company[f.key] ? escapeHtml(company[f.key]) : "—";
    return `
      <div class="review-item${f.full ? " full" : ""}">
        <span class="review-label">${f.label}</span>
        <span class="review-value">${value}</span>
      </div>`;
  }).join("");
}

// Fills #company-modal-body (if present on the page) with current company info.
function renderCompanyModal() {
  const body = document.getElementById("company-modal-body");
  if (!body) return;
  const company = getCompanyInfo();
  if (!company) {
    body.innerHTML = `<p class="text-muted" style="font-size:13px;">No company details saved yet.</p>`;
    return;
  }
  body.innerHTML = `<div class="company-review-grid">${buildCompanyReviewHTML(company)}</div>`;
}

function openCompanyModal() {
  renderCompanyModal();
  const overlay = document.getElementById("company-modal-overlay");
  if (overlay) overlay.classList.add("open");
}
function closeCompanyModal() {
  const overlay = document.getElementById("company-modal-overlay");
  if (overlay) overlay.classList.remove("open");
}

// Fills #company-dashboard-panel (if present on dashboard.html) with a summary card.
function renderCompanyDashboardCard() {
  const panel = document.getElementById("company-dashboard-panel");
  if (!panel) return;
  const company = getCompanyInfo();
  if (!company) {
    panel.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-building"></i>
        <p>No company details yet.</p>
        <a href="company.html" class="btn btn-primary" style="margin-top:8px;">Add Company Details</a>
      </div>`;
    return;
  }
  panel.innerHTML = `<div class="company-review-grid">${buildCompanyReviewHTML(company)}</div>`;
}

// ---------------------------------------------------------------
// Storage — customers
// ---------------------------------------------------------------
function getCustomers() {
  const raw = localStorage.getItem(KEYS.CUSTOMERS);
  return raw ? JSON.parse(raw) : [];
}
function saveCustomers(list) {
  localStorage.setItem(KEYS.CUSTOMERS, JSON.stringify(list));
}
function addCustomer(customer) {
  const list = getCustomers();
  customer.id =
    "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  customer.createdAt = new Date().toISOString();
  list.unshift(customer);
  saveCustomers(list);
  return customer;
}
function updateCustomer(id, patch) {
  const list = getCustomers();
  const idx = list.findIndex((c) => c.id === id);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...patch };
    saveCustomers(list);
  }
}
function deleteCustomer(id) {
  saveCustomers(getCustomers().filter((c) => c.id !== id));
}

function ensureWonCustomer(record, sourceType) {
  const sourceKey = sourceType === "deal" ? "sourceDealId" : "sourceLeadId";
  const sourceCustomerId = record.convertedCustomerId;
  const linkedCustomer = getCustomers().find(
    (customer) =>
      customer.id === sourceCustomerId || customer[sourceKey] === record.id,
  );
  const customerData = {
    name: record.name || record.account || record.company || record.contact || "Unnamed Customer",
    email: record.email || "",
    phone: record.phone || "",
    company: record.company || record.account || "",
    address: record.address || "",
    notes: record.notes || "",
    product: record.product || "",
    status: "Active",
    [sourceKey]: record.id,
  };

  if (linkedCustomer) {
    updateCustomer(linkedCustomer.id, customerData);
    return linkedCustomer.id;
  }

  return addCustomer(customerData).id;
}

// ---------------------------------------------------------------
// Storage — leads
// ---------------------------------------------------------------
function getLeads() {
  const raw = localStorage.getItem(KEYS.LEADS);
  return raw ? JSON.parse(raw) : [];
}
function saveLeads(list) {
  localStorage.setItem(KEYS.LEADS, JSON.stringify(list));
}
function addLead(lead) {
  const list = getLeads();
  lead.id =
    "l_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  lead.createdAt = new Date().toISOString();
  list.unshift(lead);
  saveLeads(list);
  return lead;
}
function updateLead(id, patch) {
  const list = getLeads();
  const idx = list.findIndex((l) => l.id === id);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...patch };
    saveLeads(list);
  }
}
function deleteLead(id) {
  saveLeads(getLeads().filter((l) => l.id !== id));
}

// ---------------------------------------------------------------
// Storage — lead activity timeline
// ---------------------------------------------------------------
function getLeadActivities() {
  const raw = localStorage.getItem(KEYS.LEAD_ACTIVITIES);
  return raw ? JSON.parse(raw) : [];
}
function saveLeadActivities(list) {
  localStorage.setItem(KEYS.LEAD_ACTIVITIES, JSON.stringify(list));
}
function addLeadActivity(leadId, type, text) {
  const list = getLeadActivities();
  const activity = {
    id: "act_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    leadId,
    type,
    text,
    createdAt: new Date().toISOString(),
  };
  list.unshift(activity);
  saveLeadActivities(list);
  return activity;
}

// ---------------------------------------------------------------
// Storage — accounts
// ---------------------------------------------------------------
function getAccounts() {
  const raw = localStorage.getItem(KEYS.ACCOUNTS);
  return raw ? JSON.parse(raw) : [];
}
function saveAccounts(list) {
  localStorage.setItem(KEYS.ACCOUNTS, JSON.stringify(list));
}
function addAccount(account) {
  const list = getAccounts();
  account.id =
    "a_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  account.createdAt = new Date().toISOString();
  list.unshift(account);
  saveAccounts(list);
  return account;
}
function updateAccount(id, patch) {
  const list = getAccounts();
  const idx = list.findIndex((a) => a.id === id);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...patch };
    saveAccounts(list);
  }
}
function deleteAccount(id) {
  saveAccounts(getAccounts().filter((a) => a.id !== id));
}

// ---------------------------------------------------------------
// Storage — agents
// ---------------------------------------------------------------
function getAgents() {
  const raw = localStorage.getItem(KEYS.AGENTS);
  return raw ? JSON.parse(raw) : [];
}
function saveAgents(list) {
  localStorage.setItem(KEYS.AGENTS, JSON.stringify(list));
}
function addAgent(agent) {
  const list = getAgents();
  agent.id =
    "ag_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  agent.createdAt = new Date().toISOString();
  list.unshift(agent);
  saveAgents(list);
  return agent;
}
function updateAgentRecord(id, patch) {
  const list = getAgents();
  const idx = list.findIndex((a) => a.id === id);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...patch };
    saveAgents(list);
  }
}
function deleteAgent(id) {
  saveAgents(getAgents().filter((a) => a.id !== id));
}

// ---------------------------------------------------------------
// Storage — products
// ---------------------------------------------------------------
function getProducts() {
  const raw = localStorage.getItem(KEYS.PRODUCTS);
  return raw ? JSON.parse(raw) : [];
}
function saveProducts(list) {
  localStorage.setItem(KEYS.PRODUCTS, JSON.stringify(list));
}
function addProduct(product) {
  const list = getProducts();
  product.id =
    "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  product.createdAt = new Date().toISOString();
  list.unshift(product);
  saveProducts(list);
  return product;
}
function updateProduct(id, patch) {
  const list = getProducts();
  const idx = list.findIndex((p) => p.id === id);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...patch };
    saveProducts(list);
  }
}
function deleteProduct(id) {
  saveProducts(getProducts().filter((p) => p.id !== id));
}

function calculateProductPricing(basePrice, gstPercentage) {
  const base = Number(basePrice) || 0;
  const percentage = Number(gstPercentage) || 0;
  const gstAmount = (base * percentage) / 100;
  return {
    basePrice: base,
    gstPercentage: percentage,
    gstAmount,
    finalPrice: base + gstAmount,
  };
}

function getProductPricing(product) {
  return calculateProductPricing(
    product.basePrice ?? product.price,
    product.gstPercentage ?? product.gst,
  );
}

// ---------------------------------------------------------------
// Storage — quotations
// ---------------------------------------------------------------
function getQuotations() {
  const raw = localStorage.getItem(KEYS.QUOTATIONS);
  return raw ? JSON.parse(raw) : [];
}
function saveQuotations(list) {
  localStorage.setItem(KEYS.QUOTATIONS, JSON.stringify(list));
}
function nextQuotationNumber() {
  const year = new Date().getFullYear();
  const prefix = `QT-${year}-`;
  const highest = getQuotations().reduce((max, quotation) => {
    const match = String(quotation.quotationNumber || quotation.number || "").match(new RegExp(`^${prefix}(\\d+)$`));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(4, "0")}`;
}
function addQuotation(quotation) {
  const list = getQuotations();
  const record = {
    ...quotation,
    id: "q_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    quotationNumber: quotation.quotationNumber || quotation.number || nextQuotationNumber(),
    number: quotation.quotationNumber || quotation.number || nextQuotationNumber(),
    status: quotation.status || "Draft",
    createdAt: new Date().toISOString(),
  };
  list.unshift(record);
  saveQuotations(list);
  return record;
}
function updateQuotation(id, patch) {
  const list = getQuotations();
  const idx = list.findIndex((quotation) => quotation.id === id);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...patch, updatedAt: new Date().toISOString() };
    saveQuotations(list);
    return list[idx];
  }
  return null;
}
function deleteQuotation(id) {
  saveQuotations(getQuotations().filter((quotation) => quotation.id !== id));
}

// ---------------------------------------------------------------
// Toast
// ---------------------------------------------------------------
function showToast(message, type = "info") {
  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  stack.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ---------------------------------------------------------------
// Sidebar user info (called on dashboard/customers/leads/accounts pages)
// ---------------------------------------------------------------
function renderSidebarUser() {
  const user = getCurrentUser();
  if (!user) return;
  const nameEl = document.getElementById("sidebar-user-name");
  const emailEl = document.getElementById("sidebar-user-email");
  const imgEl = document.getElementById("sidebar-user-avatar");
  if (nameEl) nameEl.textContent = user.name || user.email;
  if (emailEl) emailEl.textContent = user.email || "";
  if (imgEl && user.picture) imgEl.src = user.picture;
}

// ---------------------------------------------------------------
// Mobile sidebar toggle
// ---------------------------------------------------------------
function initSidebarToggle() {
  const btn = document.getElementById("menu-toggle");
  const sidebar = document.querySelector(".sidebar");
  if (btn && sidebar) {
    btn.addEventListener("click", () => sidebar.classList.toggle("open"));
  }
}

// ---------------------------------------------------------------
// Nav dropdown groups (Sales, Sales Automation, Activities, Analytics)
// ---------------------------------------------------------------
function initNavGroups() {
  const parents = document.querySelectorAll(".nav-parent");
  if (!parents.length) return;

  parents.forEach((parent) => {
    parent.addEventListener("click", () => {
      const key = parent.dataset.group;
      const submenu = document.querySelector(
        `.nav-submenu[data-submenu="${key}"]`,
      );
      const isOpen = parent.classList.contains("open");

      parents.forEach((p) => {
        if (p !== parent) {
          p.classList.remove("open");
          const sm = document.querySelector(
            `.nav-submenu[data-submenu="${p.dataset.group}"]`,
          );
          sm.classList.remove("open");
          sm.style.maxHeight = null;
        }
      });

      if (isOpen) {
        parent.classList.remove("open");
        submenu.classList.remove("open");
        submenu.style.maxHeight = null;
      } else {
        parent.classList.add("open");
        submenu.classList.add("open");
        submenu.style.maxHeight = submenu.scrollHeight + "px";
      }
    });
  });

  // Auto-open whichever group contains the active page link
  const activeInSubmenu = document.querySelector(
    ".nav-submenu .nav-item.active",
  );
  if (activeInSubmenu) {
    const submenu = activeInSubmenu.closest(".nav-submenu");
    const key = submenu.dataset.submenu;
    const parent = document.querySelector(`.nav-parent[data-group="${key}"]`);
    parent.classList.add("open");
    submenu.classList.add("open");
    submenu.style.maxHeight = submenu.scrollHeight + "px";
  }
}

// ---------------------------------------------------------------
// Global sidebar item: Customer 360°
// Injected here — not hand-copied into every page — so it is
// guaranteed identical, in the same position, on every page that
// includes app.js (which is every page with a sidebar). Adding
// future global nav items should follow this same pattern instead
// of editing each page's HTML.
// ---------------------------------------------------------------
function injectGlobalNavItems() {
  const navGroup = document.querySelector(".sidebar .nav-group");
  if (!navGroup) return; // page has no sidebar (login, company setup, etc.)

  const currentPage = window.location.pathname.split("/").pop().toLowerCase();

  const GLOBAL_ITEMS = [
    {
      href: "customer-360.html",
      icon: "fa-address-card",
      label: "Customer 360°",
      afterHref: "dashboard.html",
    },
  ];

  GLOBAL_ITEMS.forEach((item) => {
    // Never insert twice, in case a page already has it hard-coded.
    if (navGroup.querySelector(`.nav-item[href="${item.href}"]`)) return;

    const anchor = navGroup.querySelector(`.nav-item[href="${item.afterHref}"]`);
    if (!anchor) return;

    const isActive = currentPage === item.href.toLowerCase();

    const link = document.createElement("a");
    link.href = item.href;
    link.className = "nav-item" + (isActive ? " active" : "");
    link.innerHTML = `<i class="fa-solid ${item.icon}"></i> ${item.label}`;

    anchor.insertAdjacentElement("afterend", link);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  injectGlobalNavItems();

  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);

  const sidebarUser = document.querySelector(".sidebar-user");
  if (sidebarUser) {
    sidebarUser.setAttribute("role", "link");
    sidebarUser.setAttribute("tabindex", "0");
    const openCompanySettings = () => {
      window.location.href = "Settings.html?tab=company";
    };
    sidebarUser.addEventListener("click", openCompanySettings);
    sidebarUser.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openCompanySettings();
      }
    });
  }
  initSidebarToggle();
  initNavGroups();

  // Company profile modal (trigger sits next to the logout button)
  const companyTrigger = document.getElementById("company-info-trigger");
  if (companyTrigger)
    companyTrigger.addEventListener("click", openCompanyModal);
  const companyModalClose = document.getElementById("company-modal-close");
  if (companyModalClose)
    companyModalClose.addEventListener("click", closeCompanyModal);
  const companyModalOverlay = document.getElementById("company-modal-overlay");
  if (companyModalOverlay) {
    companyModalOverlay.addEventListener("click", (e) => {
      if (e.target === companyModalOverlay) closeCompanyModal();
    });
  }

  // Dashboard company summary card (no-op if the panel isn't on this page)
  renderCompanyDashboardCard();
});