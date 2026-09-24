/**
 * app.js — shared helpers for every page.
 * Sign-in, the company profile and the team live on the CRM backend (crmApi);
 * the other CRM records are still stored in this browser's localStorage.
 */

const KEYS = {
  SESSION: "crm_session",
  USER: "crm_user",
  MEMBER: "crm_member",
  COMPANY: "crm_company",
  CUSTOMERS: "crm_customers",
  LEADS: "crm_leads",
  ACCOUNTS: "crm_accounts",
  AGENTS: "crm_agents",
  PRODUCTS: "crm_products",
  QUOTATIONS: "crm_quotations",
  LEAD_ACTIVITIES: "crm_lead_activities",
};

// When the backend serves this page (http://127.0.0.1:3000/crm/frontend/ or a real domain) the
// API is on the same origin. VS Code Live Server (ports 5500/5501) falls back to the local backend.
const CRM_API_BASE =
  /^https?:$/.test(window.location.protocol) && !["5500", "5501"].includes(window.location.port)
    ? `${window.location.origin}/api/v1`
    : "http://127.0.0.1:3000/api/v1";

// Auth endpoints answer 401 for their own reasons; never try a token refresh for them.
const NO_REFRESH_PATHS = new Set(["/auth/google", "/auth/refresh", "/auth/logout"]);
let refreshInFlight = null;
let sessionEnded = false;

// Exchanges the httpOnly refresh cookie for a new access token. Tabs take turns (Web Locks),
// so two tabs never present the same refresh token (the server treats that as theft).
async function requestNewAccessToken(staleToken) {
  const refresh = async () => {
    const current = localStorage.getItem(KEYS.SESSION);
    if (current && current !== staleToken) return current; // another tab refreshed already
    try {
      const response = await fetch(`${CRM_API_BASE}/auth/refresh`, { method: "POST", credentials: "include" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.data?.token) return null;
      localStorage.setItem(KEYS.SESSION, body.data.token);
      return body.data.token;
    } catch {
      return null;
    }
  };
  return navigator.locks?.request ? navigator.locks.request("crm-token-refresh", refresh) : refresh();
}

function refreshAccessToken(staleToken) {
  if (!refreshInFlight) {
    refreshInFlight = requestNewAccessToken(staleToken).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function crmApi(path, options = {}, { retried = false } = {}) {
  const headers = new Headers(options.headers || {});
  const session = localStorage.getItem(KEYS.SESSION);
  if (session) headers.set("Authorization", `Bearer ${session}`);
  let response;
  try {
    response = await fetch(`${CRM_API_BASE}${path}`, { credentials: "include", ...options, headers });
  } catch (error) {
    throw new Error(`CRM API is unreachable at ${CRM_API_BASE}. Start the backend and verify its port.`);
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && !retried && !sessionEnded && !NO_REFRESH_PATHS.has(path)) {
    if (await refreshAccessToken(session)) return crmApi(path, options, { retried: true });
    endSession();
  }
  if (!response.ok) {
    const error = new Error(body.message || "Request failed.");
    error.status = response.status;
    error.code = body.code;
    error.errors = body.errors;
    throw error;
  }
  return body.data;
}

// ---------------------------------------------------------------
// Auth
// ---------------------------------------------------------------
const PUBLIC_PAGES = new Set(["", "index.html", "login.html"]);

function currentPageName() {
  return decodeURIComponent(window.location.pathname.split("/").pop()).toLowerCase();
}

function isAuthenticated() {
  const session = localStorage.getItem(KEYS.SESSION);
  return !!session && session.split(".").length === 3;
}

function getCurrentUser() {
  const raw = localStorage.getItem(KEYS.USER);
  return raw ? JSON.parse(raw) : null;
}

// { id, role, modules, permissions } in the active organization, saved at sign-in.
function getCurrentMember() {
  try {
    return JSON.parse(localStorage.getItem(KEYS.MEMBER)) || null;
  } catch {
    return null;
  }
}

function isOrgManager() {
  return ["owner", "admin"].includes(getCurrentMember()?.role);
}

function requireAuth() {
  if (!isAuthenticated()) {
    window.location.replace("login.html");
  }
}

// Shared guard: every page except login/index needs a session.
if (!PUBLIC_PAGES.has(currentPageName()) && !isAuthenticated()) {
  window.location.replace("login.html");
}

function clearSession() {
  localStorage.removeItem(KEYS.SESSION);
  localStorage.removeItem(KEYS.USER);
  localStorage.removeItem(KEYS.MEMBER);
  localStorage.removeItem(KEYS.COMPANY);
}

// The session can no longer be refreshed (expired, signed out elsewhere, removed from the team).
function endSession() {
  sessionEnded = true;
  clearSession();
  if (currentPageName() !== "login.html") window.location.replace("login.html?expired=1");
}

async function logout() {
  try {
    await fetch(`${CRM_API_BASE}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    // Offline: the refresh token expires on its own; still sign out locally.
  }
  clearSession();
  window.location.href = "login.html";
}

// ---------------------------------------------------------------
// Company profile (organization on the backend, cached in localStorage
// so the dashboard card and company modal can render synchronously)
// ---------------------------------------------------------------
const COMPANY_FIELDS = [
  { key: "name", label: "Company Name" },
  { key: "industry", label: "Industry" },
  { key: "email", label: "Company Email" },
  { key: "phone", label: "Phone" },
  { key: "website", label: "Website" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "country", label: "Country" },
  { key: "postalCode", label: "Pincode" },
  { key: "gstin", label: "GSTIN" },
  { key: "size", label: "Company Size" },
  { key: "foundedYear", label: "Founded Year" },
  { key: "description", label: "Description", full: true },
];

// Company form inputs (company.html and Settings) → organization fields.
const COMPANY_FORM_FIELDS = {
  cName: "name",
  cIndustry: "industry",
  cSize: "size",
  cFounded: "foundedYear",
  cWebsite: "website",
  cEmail: "email",
  cPhone: "phone",
  cGst: "gstin",
  cAddress: "address",
  cCity: "city",
  cState: "state",
  cCountry: "country",
  cPincode: "postalCode",
  cDescription: "description",
};

// Older versions saved gst / pincode / founded (company form) or taxId / zip / employees.
function normalizeCompany(raw) {
  if (!raw) return null;
  const company = { ...raw };
  const legacy = { gst: "gstin", taxId: "gstin", pincode: "postalCode", zip: "postalCode", founded: "foundedYear", employees: "size", logo: "logoUrl" };
  Object.entries(legacy).forEach(([oldKey, newKey]) => {
    if (company[oldKey] && !company[newKey]) company[newKey] = company[oldKey];
    delete company[oldKey];
  });
  return company;
}

function companyHasDetails(company) {
  return ["industry", "email", "phone", "website", "gstin", "address", "city", "state", "postalCode", "description"]
    .some((key) => company?.[key]);
}

function getCompanyInfo() {
  try {
    return normalizeCompany(JSON.parse(localStorage.getItem(KEYS.COMPANY)));
  } catch {
    return null;
  }
}
function saveCompanyInfo(data) {
  const company = normalizeCompany(data);
  // company.html's inline guard reads setupComplete before app.js loads.
  localStorage.setItem(KEYS.COMPANY, JSON.stringify({ ...company, setupComplete: companyHasDetails(company) }));
}
function hasCompanyInfo() {
  return companyHasDetails(getCompanyInfo());
}

// Fetches the organization and refreshes the cache. If the server profile is still empty but
// this browser has details from before, the browser copy is kept (and localOnly is reported)
// until an owner/admin saves it to the server.
async function loadCompanyProfile() {
  const organization = await crmApi("/organization");
  const cached = getCompanyInfo();
  const localOnly = !companyHasDetails(organization) && companyHasDetails(cached);
  if (!localOnly) saveCompanyInfo(organization);
  return { organization, company: localOnly ? { ...cached, id: organization.id, logoUrl: organization.logoUrl } : organization, localOnly };
}

async function saveCompanyProfile(data) {
  const organization = await crmApi("/organization", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  saveCompanyInfo(organization);
  return organization;
}

function fillCompanyForm(company) {
  Object.entries(COMPANY_FORM_FIELDS).forEach(([id, key]) => {
    const input = document.getElementById(id);
    if (input) input.value = company?.[key] ?? "";
  });
}

function readCompanyForm() {
  const data = {};
  Object.entries(COMPANY_FORM_FIELDS).forEach(([id, key]) => {
    const input = document.getElementById(id);
    if (!input) return;
    const value = input.value.trim();
    data[key] = key === "foundedYear" && value ? Number(value) : value;
  });
  return data;
}

// The first validation message from the API (e.g. "GSTIN must be 15 characters ...").
function apiErrorMessage(error, fallback) {
  return error?.errors?.[0]?.message || error?.message || fallback;
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

  // Keep the cached company profile in step with what teammates saved on the server.
  const showsCompany = document.getElementById("company-dashboard-panel") || document.getElementById("company-modal-body");
  if (showsCompany && isAuthenticated()) {
    loadCompanyProfile().then(renderCompanyDashboardCard).catch(() => {});
  }
});