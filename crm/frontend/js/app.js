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
  PREFS: "crm_prefs", // this browser's page preferences (e.g. inbox sound), never business data
};

// When the backend serves this page (http://127.0.0.1:3000/crm/frontend/ or a real domain) the
// API is on the same origin. VS Code Live Server (ports 5500/5501) falls back to the local backend.
const CRM_API_BASE =
  /^https?:$/.test(window.location.protocol) && !["5500", "5501"].includes(window.location.port)
    ? `${window.location.origin}/api/v1`
    : "http://127.0.0.1:3000/api/v1";

// Auth endpoints answer 401 for their own reasons; never try a token refresh for them.
const NO_REFRESH_PATHS = new Set(["/auth/google", "/auth/refresh", "/auth/logout", "/auth/login/code", "/auth/login/verify", "/auth/qr"]);
let refreshInFlight = null;
let sessionEnded = false;
// Set while a member is sent away from a page they cannot open: its script asks for nothing.
let leavingPage = false;

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
  if (leavingPage) return new Promise(() => {}); // the browser is already on its way elsewhere
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
  // A wrong sign-in code (OTP_…) is a 401 too, but not an ended session.
  if (response.status === 401 && !retried && !sessionEnded && !NO_REFRESH_PATHS.has(path) && !/^OTP_/.test(body.code || "")) {
    if (await refreshAccessToken(session)) return crmRequest(path, options, { retried: true, blob });
    endSession();
  }
  if (!response.ok) {
    const error = new Error(body.message || "Request failed.");
    error.status = response.status;
    error.code = body.code;
    error.errors = body.errors;
    if (UPGRADE_CODES.has(body.code)) crmPlan.nudge(error.message);
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
const PUBLIC_PAGES = new Set(["", "index.html", "login.html", "privacy.html", "terms.html"]);

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

// Small per-browser preferences (storage can be blocked or full: then the default is used).
function getPreference(name, fallback) {
  try {
    const prefs = JSON.parse(localStorage.getItem(KEYS.PREFS)) || {};
    return name in prefs ? prefs[name] : fallback;
  } catch {
    return fallback;
  }
}
function setPreference(name, value) {
  try {
    const prefs = JSON.parse(localStorage.getItem(KEYS.PREFS)) || {};
    prefs[name] = value;
    localStorage.setItem(KEYS.PREFS, JSON.stringify(prefs));
  } catch {
    /* the preference just isn't remembered */
  }
}

function requireAuth() {
  if (!isAuthenticated()) {
    window.location.replace("login.html");
  }
}

// Shared guard: every page except login/index needs a session.
if (!PUBLIC_PAGES.has(currentPageName()) && !isAuthenticated()) {
  // A phone that scanned a computer's QR code before signing in comes back to it afterwards.
  if (currentPageName() === "link-device.html" && window.location.hash.length > 1) {
    sessionStorage.setItem("crm_pending_link", window.location.hash.slice(1));
  }
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
  // Quotes too: the result is also used inside HTML attributes.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
        // Pending invites are for owners and admins: nobody else needs to ask.
        if (name === "invites" && !isOrgManager()) {
          crmCache[name] = [];
          return;
        }
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
  if ("hsnSac" in form) payload.hsnSac = String(form.hsnSac || "").trim();
  if ("unit" in form) payload.unit = String(form.unit || "").trim() || "pcs";
  if ("quantity" in form) payload.stockQty = form.quantity === "" || form.quantity == null ? null : Math.max(0, Math.round(Number(form.quantity)));
  // The WhatsApp catalog (Phase 8C): item code, one photo link, shown or not.
  if ("sku" in form) payload.sku = String(form.sku || "").trim();
  if ("image" in form) payload.images = String(form.image || "").trim() ? [String(form.image).trim()] : [];
  if ("inCatalog" in form) payload.inCatalog = Boolean(form.inCatalog);
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

// --- sales automation ---------------------------------------------------
// Workflows and sequences are loaded with crmReady(["workflows", "sequences"]); the Sales
// Automation page (js/automation.js) builds, runs and enrolls through the API itself.
// One key per click: if the request is retried, the server answers once and runs once.
function newIdempotencyKey() {
  return window.crypto?.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

// ---------------------------------------------------------------
// The bell (Phase 6, D31): this member's notifications, e.g. from an automation's "notify"
// step. Checked every minute and when the tab is shown again; the Inbox page also passes on
// the ones its live connection receives (crmBell.push).
// ---------------------------------------------------------------
const crmBell = (() => {
  let items = [];
  let unread = 0;
  const byId = (id) => document.getElementById(id);
  const ago = (iso) => {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
    return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  };

  function render() {
    const count = byId("crmBellCount");
    if (!count) return;
    count.textContent = unread > 99 ? "99+" : String(unread);
    count.hidden = !unread;
    byId("crmBellBtn").setAttribute("aria-label", unread ? `Notifications: ${unread} unread` : "Notifications");
    byId("crmBellReadAll").hidden = !unread;
    byId("crmBellList").innerHTML = items.length
      ? items
          .map((n) => `<button type="button" class="crm-bell__item${n.readAt ? "" : " unread"}" data-id="${escapeHtml(n.id)}">
              <span class="title">${escapeHtml(n.title)}</span>
              ${n.body ? `<span class="body">${escapeHtml(n.body)}</span>` : ""}
              <span class="time">${escapeHtml(ago(n.createdAt))}</span></button>`)
          .join("")
      : '<p class="crm-bell__empty">Nothing new. Automations that notify you show up here.</p>';
  }

  async function refresh() {
    try {
      const data = await crmApi("/notifications?limit=15");
      items = data.items;
      unread = data.unread;
      render();
    } catch {
      /* the bell is a convenience */
    }
  }

  function push(notification) {
    if (!notification || items.some((n) => String(n.id) === String(notification.id))) return;
    items = [notification, ...items].slice(0, 15);
    if (!notification.readAt) unread += 1;
    render();
  }

  const setOpen = (open) => {
    byId("crmBellPanel").hidden = !open;
    byId("crmBellBtn").setAttribute("aria-expanded", String(open));
  };

  async function openItem(id) {
    const notification = items.find((n) => String(n.id) === String(id));
    if (!notification) return;
    if (!notification.readAt) {
      notification.readAt = new Date().toISOString();
      unread = Math.max(unread - 1, 0);
      render();
      try {
        await crmApi(`/notifications/${id}/read`, { method: "POST" });
      } catch {
        /* shown as read here; the next check corrects it */
      }
    }
    if (notification.link) window.location.href = notification.link;
  }

  function mount() {
    const topbar = document.querySelector(".topbar");
    if (!topbar || !isAuthenticated() || byId("crmBell")) return;
    const bell = document.createElement("div");
    bell.className = "crm-bell";
    bell.id = "crmBell";
    bell.innerHTML = `
      <button class="icon-btn crm-bell__btn" id="crmBellBtn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Notifications">
        <i class="fa-regular fa-bell"></i><span class="crm-bell__count" id="crmBellCount" hidden></span>
      </button>
      <div class="crm-bell__panel" id="crmBellPanel" hidden>
        <div class="crm-bell__head"><strong>Notifications</strong><button type="button" class="crm-bell__readall" id="crmBellReadAll" hidden>Mark all read</button></div>
        <div class="crm-bell__list" id="crmBellList"></div>
      </div>`;
    // Next to the page's own buttons on the right, if it has any (never inside the page title).
    const last = topbar.lastElementChild;
    const right = topbar.children.length > 1 && !/^H\d$/.test(last.tagName) ? last : topbar;
    right.appendChild(bell);

    byId("crmBellBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      const open = byId("crmBellPanel").hidden;
      setOpen(open);
      if (open) refresh();
    });
    byId("crmBellList").addEventListener("click", (event) => {
      const item = event.target.closest("[data-id]");
      if (item) openItem(item.dataset.id);
    });
    byId("crmBellReadAll").addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await crmApi("/notifications/read-all", { method: "POST" });
        items = items.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() }));
        unread = 0;
        render();
      } catch (error) {
        showToast(apiErrorMessage(error, "Couldn't mark them read."), "error");
      }
    });
    document.addEventListener("click", (event) => {
      if (!byId("crmBellPanel").hidden && !bell.contains(event.target)) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !byId("crmBellPanel").hidden) setOpen(false);
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
    render();
    refresh();
    setInterval(() => {
      if (!document.hidden) refresh();
    }, 60 * 1000);
  }

  return { mount, push, refresh };
})();

// ---------------------------------------------------------------
// Toast
// ---------------------------------------------------------------
function showToast(message, type = "info") {
  if (crmPlan.isShowing(message)) return; // the upgrade prompt already says it
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
// Plan & usage (Phase 10): a banner under the top bar while the trial ends soon or the plan is
// not active, and a prompt with "See plans" when the plan stops something (the server checks
// every limit; this only explains it).
// ---------------------------------------------------------------
const UPGRADE_CODES = new Set(["PLAN_LIMIT", "SUBSCRIPTION_INACTIVE", "QUOTA_REACHED"]);
const crmPlan = (() => {
  const PLANS_LINK = "Settings.html?tab=plan";
  let nudgeEl = null;
  let nudgeMessage = "";
  let pending = null; // this page's answer (never kept in the browser: it is business data)

  function forget() {
    pending = null;
  }
  // The organization's plan and subscription (GET /billing/subscription), asked once a page.
  function state({ fresh = false } = {}) {
    if (fresh || !pending) {
      const asked = crmApi("/billing/subscription");
      pending = asked;
      asked.catch(() => {
        if (pending === asked) pending = null;
      });
    }
    return pending;
  }

  const day = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const onPlanPage = () => /settings\.html$/i.test(currentPageName()) && new URLSearchParams(window.location.search).get("tab") === "plan";

  function bannerOf({ plan, subscription: s, deletion }) {
    // An owner asked to delete the company (Phase 10F): nothing matters more.
    if (deletion?.scheduledFor) {
      return {
        locked: true,
        link: "Settings.html?tab=data",
        action: "Keep or download",
        text: `This company will be deleted on ${day(deletion.scheduledFor)} with all its data. Download what you need before then.`,
      };
    }
    if (s.locked) {
      const why = s.wasTrial && s.trialEndsAt
        ? `Your free trial ended on ${day(s.trialEndsAt)}.`
        : s.status === "halted" ? "The payment for your plan did not go through." : "Your plan has ended.";
      return { locked: true, text: `${why} Your data is safe and chats keep working; choose a plan to add contacts, quotations, broadcasts and teammates again.` };
    }
    if (s.status === "past_due") return { text: "The last payment for your plan did not go through. It will be tried again; check your card or UPI mandate to keep your plan." };
    if (s.status === "trialing" && s.daysLeft !== null && s.daysLeft <= 7) {
      return { dismissible: true, text: `Your free ${plan.name} trial ends on ${day(s.trialEndsAt)} (${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"} left). Choose a plan to keep everything running.` };
    }
    if (s.status === "cancelled" && s.currentPeriodEnd) return { dismissible: true, text: `Your ${plan.name} plan is cancelled and ends on ${day(s.currentPeriodEnd)}.` };
    return null;
  }

  async function mountBanner() {
    const topbar = document.querySelector(".main > .topbar");
    if (!topbar || !isAuthenticated() || PUBLIC_PAGES.has(currentPageName())) return;
    let banner;
    try {
      banner = bannerOf(await state());
    } catch {
      return; // the banner is a convenience
    }
    document.getElementById("planBanner")?.remove();
    const today = new Date().toDateString();
    if (!banner || (banner.dismissible && getPreference("planBannerHiddenOn", "") === today)) return;
    const el = document.createElement("div");
    el.id = "planBanner";
    el.className = `plan-banner${banner.locked ? " locked" : ""}`;
    el.setAttribute("role", "status");
    el.innerHTML = `<i class="fa-solid ${banner.locked ? "fa-lock" : "fa-gem"}"></i>
      <span class="plan-banner-text">${escapeHtml(banner.text)}${isOrgManager() || banner.link ? "" : " Ask an owner or admin to choose a plan."}</span>
      ${banner.link && isOrgManager() ? `<a class="btn btn-primary" href="${banner.link}">${escapeHtml(banner.action)}</a>` : ""}
      ${!banner.link && isOrgManager() && !onPlanPage() ? `<a class="btn btn-primary" href="${PLANS_LINK}">Choose a plan</a>` : ""}
      ${banner.dismissible ? '<button class="plan-banner-close" type="button" aria-label="Hide until tomorrow">&times;</button>' : ""}`;
    // Full-height pages (the inbox) leave room for it.
    const room = (px) => document.documentElement.style.setProperty("--plan-banner-h", `${px}px`);
    el.querySelector(".plan-banner-close")?.addEventListener("click", () => {
      setPreference("planBannerHiddenOn", today);
      el.remove();
      room(0);
    });
    topbar.insertAdjacentElement("afterend", el);
    room(el.offsetHeight);
  }

  // The prompt when the server says the plan stops something.
  function nudge(message) {
    forget(); // the usage just mattered: read it fresh next time
    nudgeEl?.remove();
    nudgeMessage = message;
    const manager = isOrgManager();
    nudgeEl = document.createElement("div");
    nudgeEl.className = "upgrade-nudge";
    nudgeEl.setAttribute("role", "alert");
    nudgeEl.innerHTML = `<i class="fa-solid fa-gem"></i>
      <div class="upgrade-nudge-body"><strong>${manager ? "Upgrade to do more" : "Your company's plan stops this"}</strong>${escapeHtml(message)}${manager ? "" : " Ask an owner or admin."}
        <div class="upgrade-nudge-actions">${manager && !onPlanPage() ? `<a class="btn btn-primary" href="${PLANS_LINK}">See plans</a>` : ""}<button class="btn btn-outline" type="button">Close</button></div>
      </div>`;
    const el = nudgeEl;
    const close = () => {
      el.remove();
      if (nudgeEl === el) nudgeMessage = "";
    };
    el.querySelector("button").addEventListener("click", close);
    document.body.appendChild(el);
    setTimeout(close, 12000);
  }

  const isShowing = (message) => Boolean(nudgeMessage) && message === nudgeMessage && Boolean(nudgeEl?.isConnected);

  return { state, forget, mountBanner, nudge, isShowing };
})();

// Private numbers (D61): the popup that says plainly what making a number private — or showing
// it to the team again — does, before an owner confirms. Used by the Inbox and Settings →
// WhatsApp. open() resolves to { note } when confirmed, null when cancelled.
const crmPrivacyDialog = (() => {
  const POINTS = {
    hide: [
      ["fa-user-lock", "Only owners will see this chat.", "Admins and agents won't see it in the Inbox, Customers, Leads or reports."],
      ["fa-bell-slash", "New messages stay private too.", "No automation, bot or auto-reply runs for this number, and no lead is created from it."],
      ["fa-box-archive", "Nothing is deleted.", "The chat stays here for you, and in the WhatsApp Business app on your phone."],
      ["fa-rotate-left", "You can undo it any time.", "Settings → WhatsApp → Private numbers → Show to team."],
    ],
    show: [
      ["fa-users", "Your team will see this chat again.", "Admins and agents who see all chats will find it in the Inbox, Customers and Leads."],
      ["fa-bolt", "New messages run your automations again.", "Assignment rules, auto-replies and the bot treat it like any customer."],
      ["fa-clock-rotate-left", "Earlier messages stay as they are.", "Nothing that happened while it was private is sent or started now."],
    ],
  };

  function open({ mode = "hide", name = "", phone = "" } = {}) {
    return new Promise((resolve) => {
      const hide = mode === "hide";
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay open privacy-dialog";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.innerHTML = `
        <div class="modal">
          <div class="modal-head">
            <h3><i class="fa-solid ${hide ? "fa-lock" : "fa-lock-open"}"></i> ${hide ? "Make this number private?" : "Show this number to the team?"}</h3>
            <button class="icon-btn" type="button" data-cancel aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="modal-body">
            <p class="privacy-who"><strong>${escapeHtml(name || formatPhoneE164(phone))}</strong>${name && phone ? ` <span>${escapeHtml(formatPhoneE164(phone))}</span>` : ""}</p>
            <ul class="privacy-points">
              ${POINTS[hide ? "hide" : "show"].map(([icon, title, text]) => `<li><i class="fa-solid ${icon}"></i><span><strong>${escapeHtml(title)}</strong> ${escapeHtml(text)}</span></li>`).join("")}
            </ul>
            ${hide ? '<div class="field"><label for="privacyNote">Label (optional, only you see it)</label><input type="text" id="privacyNote" maxlength="60" placeholder="e.g. Family" /></div>' : ""}
            <div class="privacy-actions">
              <button class="btn btn-outline" type="button" data-cancel>Cancel</button>
              <button class="btn btn-primary" type="button" data-confirm><i class="fa-solid ${hide ? "fa-lock" : "fa-lock-open"}"></i> ${hide ? "Make private" : "Show to team"}</button>
            </div>
          </div>
        </div>`;
      const close = (result) => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(result);
      };
      const onKey = (event) => {
        if (event.key === "Escape") close(null);
      };
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest("[data-cancel]")) close(null);
        if (event.target.closest("[data-confirm]")) close({ note: overlay.querySelector("#privacyNote")?.value.trim() || "" });
      });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(overlay);
      (overlay.querySelector("#privacyNote") || overlay.querySelector("[data-confirm]")).focus();
    });
  }

  return { open };
})();

const isOrgOwner = () => getCurrentMember()?.role === "owner";

// "+919829070001" → "+91 98290 70001" (how numbers are read in India); others unchanged.
function formatPhoneE164(phone) {
  const match = /^\+91(\d{5})(\d{5})$/.exec(String(phone || ""));
  return match ? `+91 ${match[1]} ${match[2]}` : String(phone || "");
}

// "Connect WhatsApp" on the dashboard (D60): for owners and admins whose company has no WhatsApp
// number yet, once the platform offers it (e.g. after "Skip for now"). × hides it for the day.
async function mountWhatsAppReminder() {
  const topbar = document.querySelector(".main > .topbar");
  if (!topbar || currentPageName() !== "dashboard.html" || !isAuthenticated() || !isOrgManager()) return;
  // The dashboard's "Get your CRM ready" list has this step, unless it was hidden.
  if (!getPreference("setupChecklistHidden", false)) return;
  const today = new Date().toDateString();
  if (getPreference("whatsappBannerHiddenOn", "") === today) return;
  let status;
  try {
    status = await crmApi("/whatsapp/connect");
  } catch {
    return; // a reminder only
  }
  if (!status.available || status.connected) return;
  const el = document.createElement("div");
  el.id = "whatsappBanner";
  el.className = "plan-banner whatsapp-banner";
  el.setAttribute("role", "status");
  el.innerHTML = `<i class="fa-brands fa-whatsapp"></i>
    <span class="plan-banner-text">Connect your WhatsApp Business number to bring your chats into the Inbox. The app keeps working on your phone.</span>
    <a class="btn btn-primary" href="connect-whatsapp.html?add=1">Connect WhatsApp</a>
    <button class="plan-banner-close" type="button" aria-label="Hide until tomorrow">&times;</button>`;
  el.querySelector(".plan-banner-close").addEventListener("click", () => {
    setPreference("whatsappBannerHiddenOn", today);
    el.remove();
  });
  (document.getElementById("planBanner") || topbar).insertAdjacentElement("afterend", el);
}

// ---------------------------------------------------------------
// Search the whole CRM (top bar; Ctrl+K or "/" anywhere): customers, leads, chats, quotations,
// orders, products, tasks and tickets in one list (GET /search; the server keeps each module's
// own rules). ↑ ↓ move, Enter opens, Esc closes.
// ---------------------------------------------------------------
const crmSearch = (() => {
  const ICONS = {
    customers: "fa-solid fa-user",
    leads: "fa-solid fa-bullseye",
    chats: "fa-brands fa-whatsapp",
    quotations: "fa-solid fa-file-invoice",
    orders: "fa-solid fa-truck-fast",
    products: "fa-solid fa-box-open",
    tasks: "fa-solid fa-list-check",
    tickets: "fa-solid fa-headset",
  };
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  let overlay;
  let input;
  let results;
  let opener = null;
  let timer = null;
  let asked = 0;

  // The words typed, marked in a result (the text is escaped first).
  function mark(text, q) {
    const safe = escapeHtml(text || "");
    const words = q.trim().split(/\s+/).filter((word) => word.length > 1).map((word) => escapeHtml(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return words.length ? safe.replace(new RegExp(`(${words.join("|")})`, "gi"), "<mark>$1</mark>") : safe;
  }

  function show(html) {
    results.innerHTML = html;
    const items = results.querySelectorAll(".search-item");
    items.forEach((item, index) => item.addEventListener("mouseenter", () => setActive(index)));
    setActive(items.length ? 0 : -1);
  }
  function message(icon, text) {
    show(`<div class="search-message"><i class="${icon}"></i><p>${text}</p></div>`);
  }
  function setActive(index) {
    const items = [...results.querySelectorAll(".search-item")];
    items.forEach((item, i) => {
      item.classList.toggle("active", i === index);
      item.setAttribute("aria-selected", String(i === index));
    });
    const active = items[index];
    input.setAttribute("aria-activedescendant", active ? active.id : "");
    active?.scrollIntoView({ block: "nearest" });
  }
  function move(step) {
    const items = [...results.querySelectorAll(".search-item")];
    if (!items.length) return;
    const current = items.findIndex((item) => item.classList.contains("active"));
    setActive((current + step + items.length) % items.length);
  }

  function render(data, q) {
    if (!data.groups.length) {
      message("fa-regular fa-face-meh", `Nothing found for “${escapeHtml(q)}”. Try a name, phone number, or a quotation or order number.`);
      return;
    }
    let n = 0;
    show(
      data.groups
        .map(
          (group) => `
        <section class="search-group" aria-label="${escapeHtml(group.label)}">
          <div class="search-group-head">
            <span>${escapeHtml(group.label)}</span>
            ${group.total > group.items.length ? `<a href="${escapeHtml(group.allUrl)}">Show all ${group.total}</a>` : ""}
          </div>
          ${group.items
            .map(
              (item) => `
            <a class="search-item" id="crmSearchItem${n++}" role="option" href="${escapeHtml(item.url)}">
              <span class="search-item-icon search-${escapeHtml(item.type)}"><i class="${ICONS[item.type] || "fa-solid fa-circle"}"></i></span>
              <span class="search-item-text">
                <strong>${mark(item.title, q)}</strong>
                ${item.subtitle ? `<span>${mark(item.subtitle, q)}</span>` : ""}
              </span>
              <i class="fa-solid fa-arrow-turn-down search-item-go" aria-hidden="true"></i>
            </a>`,
            )
            .join("")}
        </section>`,
        )
        .join(""),
    );
  }

  async function run() {
    const q = input.value.trim();
    const ticket = ++asked;
    if (q.length < 2) {
      message("fa-solid fa-magnifying-glass", "Type a name, phone number, company, quotation or order number…");
      return;
    }
    results.setAttribute("aria-busy", "true");
    if (!results.querySelector(".search-item")) message("fa-solid fa-spinner fa-spin", "Searching…");
    try {
      const data = await crmApi(`/search?q=${encodeURIComponent(q)}&limit=5`);
      if (ticket === asked) render(data, q);
    } catch (error) {
      if (ticket === asked) message("fa-solid fa-triangle-exclamation", escapeHtml(apiErrorMessage(error, "Couldn't search right now. Try again.")));
    } finally {
      if (ticket === asked) results.removeAttribute("aria-busy");
    }
  }

  function build() {
    overlay = document.createElement("div");
    overlay.className = "search-overlay";
    overlay.id = "crmSearch";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search the CRM">
        <div class="search-field">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
          <input type="search" id="crmSearchInput" placeholder="Search customers, leads, chats, orders…" autocomplete="off" spellcheck="false"
            role="combobox" aria-expanded="true" aria-controls="crmSearchResults" aria-autocomplete="list" />
          <button type="button" class="search-esc" aria-label="Close search">Esc</button>
        </div>
        <div class="search-results" id="crmSearchResults" role="listbox" aria-label="Results"></div>
        <div class="search-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    input = overlay.querySelector("#crmSearchInput");
    results = overlay.querySelector("#crmSearchResults");
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close();
    });
    overlay.querySelector(".search-esc").addEventListener("click", close);
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(run, 250);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        move(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        clearTimeout(timer);
        const active = results.querySelector(".search-item.active");
        if (active) window.location.href = active.getAttribute("href");
        else run();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
  }

  function open() {
    if (!overlay) build();
    if (!overlay.hidden) return input.focus();
    opener = document.activeElement;
    overlay.hidden = false;
    document.body.classList.add("search-open");
    input.select();
    input.focus();
    if (!input.value.trim()) run();
  }
  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove("search-open");
    opener?.focus?.();
  }

  // The box in the top bar, next to the bell; the keyboard shortcuts on every page.
  function mount() {
    const topbar = document.querySelector(".main > .topbar");
    if (!topbar || !isAuthenticated() || document.getElementById("crmSearchBtn")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "topbar-search";
    button.id = "crmSearchBtn";
    button.setAttribute("aria-label", `Search the CRM (${isMac ? "⌘" : "Ctrl"}+K)`);
    button.innerHTML = `<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><span>Search…</span><kbd>${isMac ? "⌘" : "Ctrl"} K</kbd>`;
    button.addEventListener("click", open);
    const bell = document.getElementById("crmBell");
    if (bell) bell.before(button);
    else topbar.appendChild(button);

    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
        return;
      }
      const typing = event.target.closest?.("input, textarea, select, [contenteditable='true']");
      if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !document.querySelector(".modal-overlay.open")) {
        event.preventDefault();
        open();
      }
    });
  }

  return { mount, open, close };
})();

// A link from the search (or elsewhere) can open one record: "?open=<id>" on Leads, Deals,
// Products, Tasks and Support. Pages call this once their data has loaded; the address is
// cleaned so a refresh does not open it again.
function openFromAddress(openRecord) {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("open");
  if (!id) return;
  params.delete("open");
  const rest = params.toString();
  history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
  if (openRecord(id) === false) showToast("That record is no longer here. It may have been deleted.", "error");
}

// The first steps after sign-in for owners and admins (D64): Connect WhatsApp (its page decides)
// → Invite your team (once, for a company with nobody else yet) → company details → dashboard.
// after: the step just finished ("team").
async function onboardingNextPage({ after = "" } = {}) {
  if (!isOrgManager()) return "dashboard.html";
  if (after !== "team") {
    try {
      if ((await crmApi("/organization/onboarding")).teamStep) return "invite-team.html";
    } catch {
      /* a first step is never in the way of the CRM */
    }
  }
  try {
    const { company } = await loadCompanyProfile();
    return companyHasDetails(company) ? "dashboard.html" : "company.html";
  } catch {
    return "dashboard.html";
  }
}

// A customer's number the company hides from agents (D65) shows in forms as +91 98••• ••210: it can
// be seen, not edited (the server ignores it if sent back). The same field is typable again for a
// new customer.
document.addEventListener("focusin", (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement)) return;
  const masked = field.value.includes("•");
  if (masked && !field.readOnly) {
    field.readOnly = true;
    field.dataset.maskedNumber = "1";
    field.title = "Hidden by your company's settings";
  } else if (!masked && field.dataset.maskedNumber) {
    field.readOnly = false;
    delete field.dataset.maskedNumber;
    field.removeAttribute("title");
  }
});

// "Show all" in the search opens a list page with "?q=<words>": they go into its search box.
function fillSearchFromAddress() {
  const q = new URLSearchParams(window.location.search).get("q");
  const box = document.querySelector("#searchInput, #qSearch, #oSearch, #inboxSearch");
  if (!q || !box) return;
  box.value = q;
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------------------------------------------------------------
// Installable app and web push (Phase 10E): every page links the manifest and registers the
// service worker (sw.js: offline notice, push notifications). Browsers allow both only on
// https or this computer (127.0.0.1 / localhost).
// ---------------------------------------------------------------
(function installableApp() {
  const head = document.head;
  if (!head || !/^https?:$/.test(window.location.protocol)) return;
  const add = (tag, attributes) => {
    if (head.querySelector(`${tag}[rel="${attributes.rel}"]${attributes.name ? `,${tag}[name="${attributes.name}"]` : ""}`)) return;
    const el = document.createElement(tag);
    Object.entries(attributes).forEach(([key, value]) => el.setAttribute(key, value));
    head.appendChild(el);
  };
  add("link", { rel: "manifest", href: "manifest.webmanifest" });
  add("link", { rel: "icon", type: "image/png", href: "img/icons/icon-192.png" });
  add("link", { rel: "apple-touch-icon", href: "img/icons/icon-192.png" });
  add("meta", { rel: "theme-color", name: "theme-color", content: "#ffde59" });
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* the app works without it */
    });
  }
})();

const crmPush = (() => {
  const supported = () => window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const keyBytes = (base64url) => {
    const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "="));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  const sameKey = (buffer, bytes) => Boolean(buffer) && new Uint8Array(buffer).every((b, i) => b === bytes[i]) && buffer.byteLength === bytes.length;

  // This browser's push subscription, or null.
  async function current() {
    if (!supported()) return null;
    const registration = await navigator.serviceWorker.getRegistration();
    return registration ? registration.pushManager.getSubscription() : null;
  }

  async function enable() {
    if (!supported()) throw new Error("This browser cannot show notifications from the CRM here (it needs https, or the installed app).");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings, then try again.");
    const registration = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    const { publicKey } = await crmApi("/push/key");
    const key = keyBytes(publicKey);
    let subscription = await registration.pushManager.getSubscription();
    // Made with another server key (e.g. the keys were changed): start again.
    if (subscription && !sameKey(subscription.options?.applicationServerKey, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription = subscription || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    return crmApi("/push/subscriptions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subscription.toJSON()) });
  }

  async function disable() {
    const subscription = await current();
    if (!subscription) return { devices: 0 };
    const result = await crmApi("/push/subscriptions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
    await subscription.unsubscribe();
    return result;
  }

  return { supported, current, enable, disable };
})();

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
// Mobile sidebar: on phones and tablets the menu slides in over the page.
// Page scripts call this too, so it only wires things up once.
// ---------------------------------------------------------------
function initSidebarToggle() {
  const sidebar = document.querySelector(".sidebar");
  const topbar = document.querySelector(".topbar");
  if (!sidebar || sidebar.dataset.toggleReady) return;
  sidebar.dataset.toggleReady = "1";

  let btn = document.getElementById("menu-toggle");
  if (!btn && topbar) {
    // A few pages have no menu button in their top bar: add one next to the title.
    btn = document.createElement("button");
    btn.id = "menu-toggle";
    btn.className = "icon-btn";
    btn.type = "button";
    btn.style.display = "none";
    btn.innerHTML = '<i class="fa-solid fa-bars"></i>';
    const first = topbar.firstElementChild;
    const title = topbar.querySelector(":scope > h2");
    if (first && first.tagName === "DIV") {
      first.prepend(btn);
    } else if (title) {
      const wrap = document.createElement("div");
      wrap.className = "topbar-title";
      title.replaceWith(wrap);
      wrap.append(btn, title);
    } else {
      topbar.prepend(btn);
    }
  }
  if (!btn) return;
  btn.setAttribute("aria-label", "Menu");
  btn.setAttribute("aria-expanded", "false");

  const backdrop = document.createElement("div");
  backdrop.className = "sidebar-backdrop";
  document.body.appendChild(backdrop);

  const setOpen = (open) => {
    sidebar.classList.toggle("open", open);
    backdrop.classList.toggle("show", open);
    document.body.classList.toggle("nav-open", open);
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", () => setOpen(!sidebar.classList.contains("open")));
  backdrop.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sidebar.classList.contains("open")) setOpen(false);
  });
  // Choosing a page closes the menu (the page changes anyway; "#" links stay on this one).
  sidebar.addEventListener("click", (event) => {
    if (event.target.closest("a.nav-item")) setOpen(false);
  });
  // Turning a tablet sideways to a wide screen: the menu is part of the page again.
  window.matchMedia("(min-width: 861px)").addEventListener("change", (event) => {
    if (event.matches) setOpen(false);
  });
}

// ---------------------------------------------------------------
// Phones: list tables turn into cards (style.css "m-cards"). Each cell gets its
// column's name to show as a label; empty cells ("—") are left out of the card.
// Pages draw their tables at any time, so new ones are labelled as they appear.
// ---------------------------------------------------------------
function labelTableCells() {
  document.querySelectorAll(".main table:not([data-keep-table])").forEach((table) => {
    const heads = table.querySelectorAll(":scope > thead > tr:last-child > th");
    if (!heads.length) return;
    const labels = [];
    heads.forEach((th) => {
      for (let i = 0; i < (th.colSpan || 1); i += 1) labels.push(th.textContent.trim());
    });
    // The card's title: the first named column (not a "#" rank or a tick box).
    const titleColumn = Math.max(0, labels.findIndex((label) => label && label !== "#"));
    table.classList.add("m-cards");
    table.querySelectorAll(":scope > tbody > tr, :scope > tfoot > tr").forEach((row) => {
      let column = 0;
      for (const cell of row.children) {
        if (!cell.hasAttribute("data-label")) cell.setAttribute("data-label", cell.colSpan > 1 ? "" : labels[column] || "");
        cell.toggleAttribute("data-title", column === titleColumn && cell.colSpan === 1);
        cell.toggleAttribute("data-rank", cell.getAttribute("data-label") === "#");
        column += cell.colSpan || 1;
        const text = cell.textContent.trim();
        const blank = (text === "" || text === "—" || text === "-") && !cell.querySelector("img, input, select, button, a, i, svg");
        cell.toggleAttribute("data-empty", blank);
      }
    });
  });
}
// A button that is only an icon gets a name from its icon: read out by screen readers and
// shown as a tooltip on hover ("Edit", "Delete", …). Buttons that have a name keep it.
const ICON_NAMES = {
  "fa-pen": "Edit",
  "fa-pen-to-square": "Edit",
  "fa-trash": "Delete",
  "fa-trash-can": "Delete",
  "fa-xmark": "Remove",
  "fa-plus": "Add",
  "fa-chevron-left": "Previous",
  "fa-chevron-right": "Next",
  "fa-eye": "View",
  "fa-download": "Download",
  "fa-copy": "Copy",
};
function nameIconButtons(root = document) {
  root.querySelectorAll("button:not([aria-label]):not([title])").forEach((button) => {
    if (button.textContent.trim() || button.children.length !== 1) return;
    const icon = [...button.firstElementChild.classList].find((name) => ICON_NAMES[name]);
    if (!icon) return;
    button.setAttribute("aria-label", ICON_NAMES[icon]);
    button.title = ICON_NAMES[icon];
  });
}

function initTableCards() {
  const main = document.querySelector(".main");
  nameIconButtons();
  if (!main) return;
  const run = () => {
    labelTableCells();
    nameIconButtons(main);
  };
  run();
  // One call per batch of changes; it only sets attributes, which this observer ignores.
  new MutationObserver(run).observe(main, { childList: true, subtree: true });
}

// ---------------------------------------------------------------
// Tab bars and stage chips scroll sideways when there is no room (style.css); the side with more
// tabs fades (data-scroll: left | right | both), so it is clear there is more to swipe to.
// ---------------------------------------------------------------
const TAB_BARS = ".nav-bar-kanban-card, .mk-tabs, .report-tabs, .automation-tabs, .settings-tabs, .o-tabs, .c360-tabs";
function watchTabBars() {
  const update = (bar) => {
    const max = bar.scrollWidth - bar.clientWidth;
    const left = bar.scrollLeft > 2;
    const right = bar.scrollLeft < max - 2;
    const state = max <= 2 ? "" : left && right ? "both" : left ? "left" : right ? "right" : "";
    if (state) bar.dataset.scroll = state;
    else delete bar.dataset.scroll;
  };
  // Tabs that appear later (a page shows the ones the member may open) change the room too.
  const sizes = typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => entries.forEach((entry) => {
        const bar = entry.target.matches(TAB_BARS) ? entry.target : entry.target.parentElement;
        if (bar) update(bar);
      }))
    : null;
  document.querySelectorAll(TAB_BARS).forEach((bar) => {
    update(bar);
    bar.addEventListener("scroll", () => update(bar), { passive: true });
    if (sizes) [bar, ...bar.children].forEach((element) => sizes.observe(element));
    // Pages that draw their tabs later (Orders' stages with counts).
    new MutationObserver(() => {
      if (sizes) [...bar.children].forEach((element) => sizes.observe(element));
      update(bar);
    }).observe(bar, { childList: true });
  });
}

// ---------------------------------------------------------------
// Popups: Escape closes the one on top through its own × button (so the page's close
// logic runs), and every × has a name for screen readers.
// ---------------------------------------------------------------
const POPUP_CLOSE = '.modal-head .icon-btn[id$="Close"], .modal-head .icon-btn[id$="close"]';
function initPopupKeys() {
  document.querySelectorAll(POPUP_CLOSE).forEach((button) => {
    if (!button.getAttribute("aria-label")) button.setAttribute("aria-label", button.title || "Close");
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.body.classList.contains("search-open")) return; // the search closes first
      const open = [...document.querySelectorAll(".modal-overlay.open")];
      if (!open.length) return;
      const zIndex = (el) => Number(getComputedStyle(el).zIndex) || 0;
      const top = open.reduce((best, el) => (zIndex(el) >= zIndex(best) ? el : best));
      const close = top.querySelector(POPUP_CLOSE);
      if (!close) return; // a popup without a × handles Escape itself
      event.stopPropagation();
      close.click();
    },
    true,
  );
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
// Page file → module key (or keys: any one opens the page), in sidebar order (login sends a
// member to the first allowed page).
const PAGE_MODULES = {
  "dashboard.html": "dashboard",
  "Inbox.html": "inbox",
  "customer-360.html": "customers",
  "customers.html": "customers",
  "leads.html": "leads",
  "accounts.html": "accounts",
  "Deals.html": "deals",
  "Quotations.html": ["leads", "deals"],
  "Orders.html": ["leads", "deals"],
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

// Owners and admins open every page; others only the pages of their modules (and pages
// without a module, such as Settings or My performance).
function canOpenPage(fileName, member = getCurrentMember()) {
  if (!member || ["owner", "admin"].includes(member.role)) return true;
  const module = moduleForPage(fileName);
  return !module || [].concat(module).some((key) => (member.modules || []).includes(key));
}
// Where a member starts: the first page in sidebar order they may open.
function firstAllowedPage(member = getCurrentMember()) {
  const first = Object.keys(PAGE_MODULES).find((page) => canOpenPage(page, member));
  return first ? encodeURI(first) : "Settings.html";
}
const PAGE_NAMES = { "al insights.html": "AI Insights", "customer-360.html": "Customer 360°" };
function pageName(fileName) {
  const name = PAGE_NAMES[String(fileName).toLowerCase()] || String(fileName).replace(/\.html$/i, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// A member who opens a page they have no access to (an old bookmark or link) goes to their
// first page before this page's own script asks the server for anything; that page says why.
const thisPageFile = () => decodeURIComponent(window.location.pathname.split("/").pop());
function leaveIfNoAccess() {
  if (!isAuthenticated() || canOpenPage(thisPageFile())) return false;
  leavingPage = true;
  document.documentElement.style.visibility = "hidden";
  window.location.replace(`${firstAllowedPage()}?noaccess=${encodeURIComponent(thisPageFile())}`);
  return true;
}
leaveIfNoAccess();
function explainNoAccess() {
  const params = new URLSearchParams(window.location.search);
  const blocked = params.get("noaccess");
  if (!blocked) return;
  showToast(`You don't have access to ${pageName(blocked)}. Ask your company's owner or admin to give it to you.`, "error");
  params.delete("noaccess");
  const rest = params.toString();
  history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
}

function hideUnavailableModules() {
  const member = getCurrentMember();
  if (!member) return;
  document.querySelectorAll(".sidebar .nav-item[href]").forEach((link) => {
    const page = decodeURIComponent(link.getAttribute("href")).replace(/^\.\//, "");
    link.style.display = canOpenPage(page, member) ? "" : "none";
  });
  document.querySelectorAll(".sidebar .nav-submenu").forEach((submenu) => {
    const visible = [...submenu.querySelectorAll(".nav-item")].some((item) => item.style.display !== "none");
    submenu.style.display = visible ? "" : "none";
    const parent = document.querySelector(`.nav-parent[data-group="${submenu.dataset.submenu}"]`);
    if (parent) parent.style.display = visible ? "" : "none";
  });
}

// The top of the sidebar shows the company's own name and logo (Settings → Your Profile) with
// "YELLOW CRM" under it; a company without a name yet keeps the YELLOW CRM brand.
function renderSidebarBrand(company = getCompanyInfo()) {
  const brand = document.querySelector(".sidebar-brand");
  const img = brand?.querySelector(".mark img");
  const label = brand?.querySelector(":scope > span:last-child");
  if (!brand || !label) return;
  if (img) {
    img.dataset.defaultSrc ||= img.getAttribute("src");
    img.src = company?.logoUrl || img.dataset.defaultSrc;
    img.alt = company?.name ? `${company.name} logo` : "logo";
  }
  if (!company?.name) return;
  const name = document.createElement("strong");
  name.textContent = company.name;
  const product = document.createElement("small");
  product.textContent = "YELLOW CRM";
  label.className = "sidebar-brand__name";
  label.title = company.name;
  label.replaceChildren(name, product);
}

// The saved membership comes from sign-in; an owner may have changed the role or the modules
// since. Each page checks it again and updates the sidebar (and leaves a page no longer open
// to this member).
async function syncMembership() {
  try {
    const me = await crmApi("/auth/me");
    if (!me?.member) return;
    const cached = getCompanyInfo() || {};
    const { name = "", logoUrl = "" } = me.organization || {};
    if (cached.name !== name || (cached.logoUrl || "") !== logoUrl) {
      saveCompanyInfo({ ...cached, name, logoUrl });
      renderSidebarBrand();
    }
    const before = localStorage.getItem(KEYS.MEMBER);
    const after = JSON.stringify({ ...me.member, organizationId: me.organization?.id ?? getCurrentMember()?.organizationId });
    if (before === after) return;
    localStorage.setItem(KEYS.MEMBER, after);
    if (leaveIfNoAccess()) return;
    hideUnavailableModules();
  } catch {
    /* the saved membership stays; the server checks every request anyway */
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
    {
      href: "Quotations.html",
      icon: "fa-file-invoice",
      label: "Quotations",
      afterHref: "Deals.html",
    },
    {
      href: "Orders.html",
      icon: "fa-truck-fast",
      label: "Orders",
      afterHref: "Quotations.html",
    },
    // The team's work (D61): everyone sees their own; owners and admins see the team live.
    // Both go right after Reports & Analytics, in this order.
    {
      href: "my-performance.html",
      icon: "fa-user-check",
      label: "My performance",
      afterHref: "Reports & Analytics.html",
    },
    {
      href: "team-live.html",
      icon: "fa-signal",
      label: "Team live",
      afterHref: "Reports & Analytics.html",
      managersOnly: true,
    },
  ];
  // Pages write the same link as "Deals.html" or "./Deals.html".
  const findLink = (href) => [...navGroup.querySelectorAll(".nav-item[href]")].find((link) => link.getAttribute("href").replace(/^\.\//, "") === href);

  GLOBAL_ITEMS.forEach((item) => {
    // Never insert twice, in case a page already has it hard-coded.
    if (findLink(item.href)) return;
    if (item.managersOnly && !isOrgManager()) return;

    const anchor = findLink(item.afterHref);
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
  renderSidebarBrand();
  if (isAuthenticated() && document.querySelector(".sidebar")) syncMembership();
  explainNoAccess();
  crmBell.mount();
  crmSearch.mount();
  fillSearchFromAddress();
  crmPlan.mountBanner();
  mountWhatsAppReminder();
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
  initPopupKeys(); // before the icon names: a popup's × is "Close", not "Remove"
  initTableCards();
  watchTabBars();

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