/**
 * app.js — shared helpers for every page.
 * Sign-in, the company profile, the team, contacts, leads/deals, products, quotations, tasks,
 * calendar events, support tickets, notes, documents, campaigns and automation settings live on
 * the CRM backend (crmApi, crmLoad), and so does the team (Account Champions = members and
 * invites). Sign-in details (KEYS) and a copy of the company profile stay in localStorage.
 */

const KEYS = {
  SESSION: "crm_session",
  USER: "crm_user",
  MEMBER: "crm_member",
  COMPANY: "crm_company",
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

// Returns the whole response body ({ data, pagination, ... }), or a Blob for { blob: true }
// (file downloads); throws with status/code/errors.
async function crmRequest(path, options = {}, { retried = false, blob = false } = {}) {
  const headers = new Headers(options.headers || {});
  const session = localStorage.getItem(KEYS.SESSION);
  if (session) headers.set("Authorization", `Bearer ${session}`);
  let response;
  try {
    response = await fetch(`${CRM_API_BASE}${path}`, { credentials: "include", ...options, headers });
  } catch (error) {
    throw new Error(`CRM API is unreachable at ${CRM_API_BASE}. Start the backend and verify its port.`);
  }
  if (blob && response.ok) return response.blob();
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && !retried && !sessionEnded && !NO_REFRESH_PATHS.has(path)) {
    if (await refreshAccessToken(session)) return crmRequest(path, options, { retried: true, blob });
    endSession();
  }
  if (!response.ok) {
    const error = new Error(body.message || "Request failed.");
    error.status = response.status;
    error.code = body.code;
    error.errors = body.errors;
    throw error;
  }
  return body;
}

async function crmApi(path, options = {}) {
  return (await crmRequest(path, options)).data;
}

// Downloads a file the API only gives to signed-in members (a plain link can't send the token).
async function crmDownload(path, fileName) {
  const file = await crmRequest(path, {}, { blob: true });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
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
// Server data — contacts, leads (also shown as deals), products, quotations,
// the team, tasks, calendar events, tickets, documents, campaigns and automations. Pages call crmLoad([...]) (or crmReady) once,
// then read synchronously with the getters below; changes go through
// the async save/remove helpers, which update the in-memory copy.
// ---------------------------------------------------------------
const CRM_SOURCES = {
  contacts: "/contacts",
  leads: "/leads",
  products: "/products",
  members: "/members",
  invites: "/invites?status=pending", // owners/admins only; empty for everyone else
  quotations: "/quotations",
  tasks: "/tasks",
  events: "/events",
  tickets: "/tickets",
  documents: "/documents",
  campaigns: "/campaigns",
  workflows: "/workflows",
  sequences: "/sequences",
};
const crmCache = {};
const MAX_LOAD_PAGES = 50; // 50 pages × 100 records per resource

async function crmFetchAll(path) {
  const items = [];
  for (let page = 1; page <= MAX_LOAD_PAGES; page += 1) {
    const body = await crmRequest(`${path}${path.includes("?") ? "&" : "?"}page=${page}&limit=100`);
    items.push(...(body.data || []));
    if (!body.pagination?.hasNextPage) break;
  }
  return items;
}

// Loads each resource once per page. A module the member may not open (403) loads as empty.
async function crmLoad(names, { force = false } = {}) {
  await Promise.all(
    names
      .filter((name) => force || !crmCache[name])
      .map(async (name) => {
        try {
          crmCache[name] = await crmFetchAll(CRM_SOURCES[name]);
        } catch (error) {
          if (error.status !== 403) throw error;
          crmCache[name] = [];
        }
      }),
  );
}

// crmLoad with a loading bar and a retry banner, then runs the page's first render.
async function crmReady(names, onReady) {
  document.body.classList.add("crm-loading");
  document.getElementById("crm-load-error")?.remove();
  try {
    await crmLoad(names);
    document.body.classList.remove("crm-loading");
    onReady();
  } catch (error) {
    document.body.classList.remove("crm-loading");
    const banner = document.createElement("div");
    banner.id = "crm-load-error";
    banner.className = "crm-load-error";
    banner.setAttribute("role", "alert");
    banner.innerHTML = `<span></span><button type="button" class="btn btn-outline">Retry</button>`;
    banner.querySelector("span").textContent = `Couldn't load your CRM data: ${error.message || "unknown error"}`;
    banner.querySelector("button").addEventListener("click", () => crmReady(names, onReady));
    document.body.prepend(banner);
  }
}

function cached(name) {
  return crmCache[name] || [];
}
function cacheUpsert(name, item) {
  const list = crmCache[name] || (crmCache[name] = []);
  const index = list.findIndex((existing) => String(existing.id) === String(item.id));
  if (index === -1) list.unshift(item);
  else list[index] = item;
  return item;
}
function cacheDrop(name, id) {
  crmCache[name] = cached(name).filter((item) => String(item.id) !== String(id));
}

const jsonRequest = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const toPaise = (rupees) => (rupees === "" || rupees == null || Number.isNaN(Number(rupees)) ? null : Math.round(Number(rupees) * 100));
const toRupees = (paise) => (paise == null ? "" : paise / 100);
const dateOnly = (value) => (value ? String(value).slice(0, 10) : "");

// Pipeline stages (one pipeline for leads and deals).
const LEAD_STAGES = ["New", "Contacted", "Quote Sent", "Negotiation", "Won", "Lost"];
const OPEN_LEAD_STAGES = ["New", "Contacted", "Quote Sent", "Negotiation"];
const ROLE_LABELS = { owner: "Owner", admin: "Admin", agent: "Agent", viewer: "Viewer" };

// Asks why a lead was lost (required by the server). Returns null when cancelled.
function askLostReason(name) {
  const reason = window.prompt(`Why was "${name}" lost? (for example: price too high, bought elsewhere)`);
  return reason && reason.trim() ? reason.trim() : null;
}

// --- team -------------------------------------------------------
function getAgents() {
  return cached("members").map((member) => ({
    id: member.id,
    name: member.name || member.email,
    email: member.email,
    role: ROLE_LABELS[member.role] || member.role,
    modules: member.modules,
  }));
}
// The server builds invite links from its own address; share the sign-in page of the address
// this CRM is open on instead (the one Google already accepts for this team).
function inviteLinkHere(serverLink) {
  const token = new URL(serverLink).searchParams.get("invite");
  return new URL(`login.html?invite=${encodeURIComponent(token)}`, window.location.href).toString();
}
function memberName(id) {
  if (!id) return "";
  return getAgents().find((agent) => String(agent.id) === String(id))?.name || "";
}

// --- products ---------------------------------------------------
function toLegacyProduct(product) {
  return {
    ...product,
    price: toRupees(product.pricePaise),
    basePrice: toRupees(product.pricePaise),
    gst: product.gstRatePct,
    gstPercentage: product.gstRatePct,
    quantity: product.stockQty ?? "",
  };
}
function getProducts() {
  return cached("products").map(toLegacyProduct);
}
// Product form values (rupees, "gst", "quantity") → API fields.
function productPayload(form) {
  const payload = {};
  if ("name" in form) payload.name = form.name;
  if ("category" in form) payload.category = form.category || "";
  if ("description" in form) payload.description = form.description || "";
  if ("price" in form) payload.pricePaise = toPaise(form.price) ?? 0;
  if ("gst" in form) payload.gstRatePct = Number(form.gst) || 0;
  if ("quantity" in form) payload.stockQty = form.quantity === "" || form.quantity == null ? null : Math.max(0, Math.round(Number(form.quantity)));
  return payload;
}
async function saveProduct(id, form) {
  const product = await crmApi(id ? `/products/${id}` : "/products", jsonRequest(id ? "PATCH" : "POST", productPayload(form)));
  return toLegacyProduct(cacheUpsert("products", product));
}
async function removeProduct(id) {
  await crmApi(`/products/${id}`, { method: "DELETE" });
  cacheDrop("products", id);
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

// --- contacts (customers are contacts with lifecycle "customer") -----
function toLegacyContact(contact) {
  return { ...contact, product: contact.productIds?.[0] || "", owner: memberName(contact.ownerId) };
}
function getContacts() {
  return cached("contacts").map(toLegacyContact);
}
function getCustomers() {
  return getContacts().filter((contact) => contact.lifecycle === "customer");
}
// Distinct company names, for the "account" fields that used to have their own list.
function getAccounts() {
  const names = [...new Set(getContacts().map((contact) => (contact.company || "").trim()).filter(Boolean))];
  return names.sort((a, b) => a.localeCompare(b)).map((name) => ({ id: name, name }));
}
async function saveContact(id, form) {
  const payload = { ...form };
  if ("product" in payload) {
    payload.productIds = payload.product ? [payload.product] : [];
    delete payload.product;
  }
  const contact = await crmApi(id ? `/contacts/${id}` : "/contacts", jsonRequest(id ? "PATCH" : "POST", payload));
  return toLegacyContact(cacheUpsert("contacts", contact));
}
async function removeContact(id) {
  await crmApi(`/contacts/${id}`, { method: "DELETE" });
  cacheDrop("contacts", id);
}

// --- leads (and the same records as deals) -----------------------
function toLegacyLead(lead) {
  const contact = lead.contact || {};
  return {
    ...lead,
    name: contact.name || lead.title || "(deleted contact)",
    email: contact.email || "",
    phone: contact.phone || "",
    company: contact.company || "",
    product: lead.productId || "",
    quantity: lead.quantity ?? "",
    status: lead.stage,
    value: toRupees(lead.expectedValuePaise),
    followUp: dateOnly(lead.followUpAt),
    convertedCustomerId: lead.convertedAt ? lead.contactId : "",
    owner: memberName(lead.ownerId),
  };
}
function toLegacyDeal(lead) {
  const asLead = toLegacyLead(lead);
  return {
    ...asLead,
    name: lead.title || asLead.name,
    account: asLead.company,
    contact: asLead.name,
    value: Number(asLead.value) || 0,
    closeDate: dateOnly(lead.expectedCloseDate),
  };
}
function getLeads() {
  return cached("leads").map(toLegacyLead);
}
function getDeals() {
  return cached("leads").map(toLegacyDeal);
}
function getLeadRecord(id) {
  return cached("leads").find((lead) => String(lead.id) === String(id)) || null;
}
function cacheLead(lead) {
  cacheUpsert("leads", lead);
  // The contact may have changed (details, or lifecycle after Won).
  if (lead.contact && crmCache.contacts) {
    const existing = cached("contacts").find((contact) => String(contact.id) === String(lead.contact.id));
    if (existing) Object.assign(existing, lead.contact);
    else if (lead.convertedAt) crmLoad(["contacts"], { force: true }).catch(() => {});
  }
  return lead;
}
async function createLead(payload) {
  return cacheLead(await crmApi("/leads", jsonRequest("POST", payload)));
}
// Sends the lead's current version, so a stale edit gets a clear "reload" error.
async function updateLeadRecord(id, payload) {
  const current = getLeadRecord(id);
  const lead = await crmApi(`/leads/${id}`, jsonRequest("PATCH", { ...payload, ...(current && { version: current.version }) }));
  return cacheLead(lead);
}
async function changeLeadStage(id, stage, lostReason) {
  const current = getLeadRecord(id);
  const lead = await crmApi(`/leads/${id}/stage`, jsonRequest("POST", { stage, ...(lostReason && { lostReason }), ...(current && { version: current.version }) }));
  return cacheLead(lead);
}
async function removeLead(id) {
  await crmApi(`/leads/${id}`, { method: "DELETE" });
  cacheDrop("leads", id);
}
async function getLeadActivities(id) {
  return crmApi(`/leads/${id}/activities`);
}
async function addLeadNote(id, text) {
  return crmApi(`/leads/${id}/activities`, jsonRequest("POST", { type: "Note", text }));
}

// --- quotations -------------------------------------------------
function toLegacyQuotation(quotation) {
  return {
    ...quotation,
    quotationNumber: quotation.number,
    grandTotal: toRupees(quotation.totals?.grandTotalPaise),
  };
}
function getQuotations() {
  return cached("quotations").map(toLegacyQuotation);
}
// --- tasks and calendar events ------------------------------------
// The pages pick people and related records by name; the server stores ids.
function agentIdByName(name) {
  if (!name) return null;
  return getAgents().find((agent) => agent.name === name)?.id || null;
}
function relatedIdByName(type, name) {
  if (!type || !name) return null;
  const pools = { Customer: getCustomers, Contact: getContacts, Lead: getLeads, Deal: getDeals };
  const matches = (pools[type] ? pools[type]() : []).filter((record) => record.name === name);
  return matches.length === 1 ? matches[0].id : null;
}
function workItemPayload(form, fields) {
  const payload = {};
  fields.forEach((key) => {
    if (key in form) payload[key] = form[key];
  });
  if ("assignee" in form) payload.assigneeId = agentIdByName(form.assignee);
  if ("relatedType" in form || "relatedName" in form) {
    payload.relatedType = form.relatedType || "";
    payload.relatedName = payload.relatedType ? form.relatedName || "" : "";
    payload.relatedId = relatedIdByName(payload.relatedType, payload.relatedName);
  }
  return payload;
}
// assignee: the team member's name, or the name kept on imported items.
const toLegacyWorkItem = (item) => ({ ...item, assignee: memberName(item.assigneeId) || item.assigneeName || "" });

function getTasks() {
  return cached("tasks").map(toLegacyWorkItem);
}
async function saveTask(id, form) {
  const payload = workItemPayload(form, ["title", "description", "dueDate", "priority", "status", ...(id ? [] : ["origin"])]);
  const task = await crmApi(id ? `/tasks/${id}` : "/tasks", jsonRequest(id ? "PATCH" : "POST", payload));
  return toLegacyWorkItem(cacheUpsert("tasks", task));
}
async function removeTask(id) {
  await crmApi(`/tasks/${id}`, { method: "DELETE" });
  cacheDrop("tasks", id);
}

function getEvents() {
  return cached("events").map(toLegacyWorkItem);
}
async function saveEvent(id, form) {
  const payload = workItemPayload(form, ["title", "type", "date", "startTime", "endTime", "description"]);
  const event = await crmApi(id ? `/events/${id}` : "/events", jsonRequest(id ? "PATCH" : "POST", payload));
  return toLegacyWorkItem(cacheUpsert("events", event));
}
async function removeEvent(id) {
  await crmApi(`/events/${id}`, { method: "DELETE" });
  cacheDrop("events", id);
}

// --- support tickets and notes -------------------------------------
// customer: the linked contact's name, or the name typed on the ticket.
const toLegacyTicket = (ticket) => ({ ...toLegacyWorkItem(ticket), customer: ticket.customerName || "" });

function getTickets() {
  return cached("tickets").map(toLegacyTicket);
}
// The number is given by the server. A typed customer links to the contact with that exact
// name when there is only one; an unchanged name keeps the ticket's current link.
async function saveTicket(id, form) {
  const payload = workItemPayload(form, ["subject", "description", "category", "priority", "status", "dueDate"]);
  if ("customer" in form) {
    const current = id ? cached("tickets").find((ticket) => String(ticket.id) === String(id)) : null;
    payload.customerName = form.customer || "";
    payload.contactId =
      current?.contactId && current.customerName === payload.customerName
        ? current.contactId
        : relatedIdByName("Contact", payload.customerName);
  }
  const ticket = await crmApi(id ? `/tickets/${id}` : "/tickets", jsonRequest(id ? "PATCH" : "POST", payload));
  return toLegacyTicket(cacheUpsert("tickets", ticket));
}
async function removeTicket(id) {
  await crmApi(`/tickets/${id}`, { method: "DELETE" });
  cacheDrop("tickets", id);
}

// Notes arrive newest first, as { text, author, at } like the pages already show them.
const toLegacyNote = (note) => ({ ...note, author: note.authorName || "", at: note.createdAt });

async function getTicketNotes(ticketId) {
  return (await crmApi(`/tickets/${ticketId}/notes`)).map(toLegacyNote);
}
async function addTicketNote(ticketId, text) {
  return toLegacyNote(await crmApi(`/tickets/${ticketId}/notes`, jsonRequest("POST", { text })));
}
async function getContactNotes(contactId) {
  return (await crmApi(`/contacts/${contactId}/notes`)).map(toLegacyNote);
}
async function addContactNote(contactId, text) {
  return toLegacyNote(await crmApi(`/contacts/${contactId}/notes`, jsonRequest("POST", { text })));
}

// --- documents ------------------------------------------------------
// The file stays on the server; open it with downloadDocument.
const toLegacyDocument = (doc) => ({ ...doc, owner: memberName(doc.ownerId), fileType: doc.mimeType, fileSize: doc.sizeBytes });

function getDocuments() {
  return cached("documents").map(toLegacyDocument);
}
// "drive.google.com/x" → "https://drive.google.com/x" (the server accepts web links only).
function webAddress(value) {
  const link = String(value || "").trim();
  return !link || /^[a-z][a-z0-9+.-]*:/i.test(link) ? link : `https://${link}`;
}
// Sent as form data so a newly picked file can go along. Without a new file or a link, the
// document keeps its current file.
async function saveDocument(id, form, file) {
  const data = new FormData();
  ["name", "category", "description"].forEach((key) => {
    if (key in form) data.append(key, form[key] ?? "");
  });
  if ("tags" in form) data.append("tags", (form.tags || []).join(","));
  if ("owner" in form) data.append("ownerId", agentIdByName(form.owner) || "");
  if ("relatedType" in form) {
    const relatedName = form.relatedType ? form.relatedName || "" : "";
    data.append("relatedType", form.relatedType || "");
    data.append("relatedName", relatedName);
    data.append("relatedId", relatedIdByName(form.relatedType, relatedName) || "");
  }
  if (form.linkUrl) data.append("linkUrl", webAddress(form.linkUrl));
  if (file) data.append("file", file, file.name);
  const doc = await crmApi(id ? `/documents/${id}` : "/documents", { method: id ? "PATCH" : "POST", body: data });
  return toLegacyDocument(cacheUpsert("documents", doc));
}
async function removeDocument(id) {
  await crmApi(`/documents/${id}`, { method: "DELETE" });
  cacheDrop("documents", id);
}
async function downloadDocument(doc) {
  await crmDownload(`/documents/${doc.id}/download`, doc.fileName || doc.name);
}

// --- marketing campaigns ---------------------------------------------
// budget: rupees on the page, paise on the server.
const toLegacyCampaign = (campaign) => ({ ...campaign, budget: toRupees(campaign.budgetPaise) || 0, owner: memberName(campaign.ownerId) });

function getCampaigns() {
  return cached("campaigns").map(toLegacyCampaign);
}
async function saveCampaign(id, form) {
  const payload = {};
  ["name", "type", "status", "startDate", "endDate", "leadsGenerated", "audience", "description"].forEach((key) => {
    if (key in form) payload[key] = form[key];
  });
  if ("budget" in form) payload.budgetPaise = toPaise(form.budget) ?? 0;
  if ("owner" in form) payload.ownerId = agentIdByName(form.owner);
  const campaign = await crmApi(id ? `/campaigns/${id}` : "/campaigns", jsonRequest(id ? "PATCH" : "POST", payload));
  return toLegacyCampaign(cacheUpsert("campaigns", campaign));
}
async function removeCampaign(id) {
  await crmApi(`/campaigns/${id}`, { method: "DELETE" });
  cacheDrop("campaigns", id);
}
async function getCampaignNotes(campaignId) {
  return (await crmApi(`/campaigns/${campaignId}/notes`)).map(toLegacyNote);
}
async function addCampaignNote(campaignId, text) {
  return toLegacyNote(await crmApi(`/campaigns/${campaignId}/notes`, jsonRequest("POST", { text })));
}

// --- sales automation: workflows and sequences --------------------------
// kind: "workflows" or "sequences". Run and enroll counts are kept by the server.
const withOwnerName = (item) => ({ ...item, owner: memberName(item.ownerId) });

function getWorkflows() {
  return cached("workflows").map(withOwnerName);
}
function getSequences() {
  return cached("sequences").map(withOwnerName);
}
async function saveAutomation(kind, id, form) {
  const { owner, ...fields } = form;
  const payload = "owner" in form ? { ...fields, ownerId: agentIdByName(owner) } : fields;
  const item = await crmApi(id ? `/${kind}/${id}` : `/${kind}`, jsonRequest(id ? "PATCH" : "POST", payload));
  return withOwnerName(cacheUpsert(kind, item));
}
async function removeAutomation(kind, id) {
  await crmApi(`/${kind}/${id}`, { method: "DELETE" });
  cacheDrop(kind, id);
}
// One key per click: if the request is retried, the server answers once and runs once.
function newIdempotencyKey() {
  return window.crypto?.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
// Run Now: the server creates the workflow's tasks. Returns { workflow, tasks, simulated }.
async function runWorkflowNow(id) {
  const result = await crmApi(`/workflows/${id}/run`, { method: "POST", headers: { "Idempotency-Key": newIdempotencyKey() } });
  cacheUpsert("workflows", result.workflow);
  return result;
}
// Enroll One: the server schedules the first call/task step. Returns { sequence, task, firstTaskDay, simulated }.
async function enrollInSequence(id) {
  const result = await crmApi(`/sequences/${id}/enroll`, { method: "POST", headers: { "Idempotency-Key": newIdempotencyKey() } });
  cacheUpsert("sequences", result.sequence);
  return result;
}

// Items use the form's rupee values; the server computes every total.
async function saveLeadQuotation(leadId, items) {
  const payload = {
    items: items
      .filter((item) => Number(item.quantity) > 0)
      .map((item) => ({
        productId: item.productId || null,
        quantity: Number(item.quantity),
        unitPricePaise: toPaise(item.unitPrice) ?? 0,
        discountPaise: toPaise(item.discount) ?? 0,
        taxRatePct: Number(item.tax) || 0,
      })),
  };
  if (!payload.items.length) return null;
  const quotation = await crmApi(`/leads/${leadId}/quotations`, jsonRequest("POST", payload));
  cacheUpsert("quotations", quotation);
  return toLegacyQuotation(quotation);
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
// Sidebar: agents and viewers only see the modules they were given
// (the server enforces the same rule on every API call).
// ---------------------------------------------------------------
// Page file → module key, in sidebar order (login sends a member to the first allowed page).
const PAGE_MODULES = {
  "dashboard.html": "dashboard",
  "Inbox.html": "inbox",
  "customer-360.html": "customers",
  "customers.html": "customers",
  "leads.html": "leads",
  "accounts.html": "accounts",
  "Deals.html": "deals",
  "Marketing.html": "marketing",
  "Sales Automation.html": "automation",
  "Tasks.html": "tasks",
  "Calendar.html": "calendar",
  "Documents.html": "documents",
  "Support.html": "support",
  "Reports & Analytics.html": "reports",
  "Al Insights.html": "insights",
  "Products.html": "products",
};

// The unread WhatsApp messages next to "Inbox" in the sidebar.
function setInboxNavBadge(count) {
  const badge = document.getElementById("navInboxBadge");
  if (!badge) return;
  badge.textContent = count > 99 ? "99+" : String(count || "");
  badge.hidden = !count;
}
async function refreshInboxNavBadge() {
  const member = getCurrentMember();
  if (!document.getElementById("navInboxBadge") || !member) return;
  if (!isOrgManager() && !(member.modules || []).includes("inbox")) return;
  try {
    setInboxNavBadge((await crmApi("/conversations/summary")).unread);
  } catch {
    /* the badge is a convenience */
  }
}

function moduleForPage(fileName) {
  const lower = String(fileName).toLowerCase();
  return Object.entries(PAGE_MODULES).find(([page]) => page.toLowerCase() === lower)?.[1] || null;
}

function hideUnavailableModules() {
  const member = getCurrentMember();
  if (!member || isOrgManager()) return;
  const allowed = new Set(member.modules || []);
  document.querySelectorAll(".sidebar .nav-item[href]").forEach((link) => {
    const module = moduleForPage(decodeURIComponent(link.getAttribute("href")).replace(/^\.\//, ""));
    if (module && !allowed.has(module)) link.style.display = "none";
  });
  document.querySelectorAll(".sidebar .nav-submenu").forEach((submenu) => {
    const visible = [...submenu.querySelectorAll(".nav-item")].some((item) => item.style.display !== "none");
    if (visible) return;
    submenu.style.display = "none";
    const parent = document.querySelector(`.nav-parent[data-group="${submenu.dataset.submenu}"]`);
    if (parent) parent.style.display = "none";
  });
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

  // Inserted in order after their anchor, so Inbox ends up right below Dashboard.
  const GLOBAL_ITEMS = [
    {
      href: "customer-360.html",
      icon: "fa-address-card",
      label: "Customer 360°",
      afterHref: "dashboard.html",
    },
    {
      href: "Inbox.html",
      icon: "fa-comments",
      label: 'Inbox <span class="nav-badge" id="navInboxBadge" hidden></span>',
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
  hideUnavailableModules();
  // The Inbox page keeps its own count up to date live.
  if (moduleForPage(currentPageName()) !== "inbox") refreshInboxNavBadge();

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