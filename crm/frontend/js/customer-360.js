/**
 * customer-360.js — Customer 360° Profile
 *
 * Read-only aggregation across every module's localStorage data for one
 * customer, plus a small notes feature stored under 'crm_customer_notes'.
 * Nothing here writes to crm_customers, crm_deals, crm_tasks, crm_tickets,
 * or crm_documents — those stay owned by their existing pages.
 *
 * Matching is best-effort by name, since the existing schema links records
 * to people by free-text name/relatedName rather than a customer id:
 *   - tasks / calendar events / documents: relatedType === "Customer" &&
 *     relatedName === customer.name
 *   - tickets: ticket.customer === customer.name
 *   - deals: deal.contact === customer.name (contact is free text)
 *
 * Reuses shared helpers from app.js (getCustomers, showToast,
 * renderSidebarUser, initSidebarToggle, requireAuth, getCurrentUser).
 */

requireAuth();
renderSidebarUser();
initSidebarToggle();

const CUSTOMER_NOTES_KEY = "crm_customer_notes";

// ---------------------------------------------------------------
// Direct reads for modules without a shared app.js helper
// ---------------------------------------------------------------
function readDeals() {
  const raw = localStorage.getItem("crm_deals");
  return raw ? JSON.parse(raw) : [];
}
function readTasks() {
  const raw = localStorage.getItem("crm_tasks");
  return raw ? JSON.parse(raw) : [];
}
function readEvents() {
  const raw = localStorage.getItem("crm_calendar_events");
  return raw ? JSON.parse(raw) : [];
}
function readTickets() {
  const raw = localStorage.getItem("crm_tickets");
  return raw ? JSON.parse(raw) : [];
}
function readDocuments() {
  const raw = localStorage.getItem("crm_documents");
  return raw ? JSON.parse(raw) : [];
}
function readCustomerNotes() {
  const raw = localStorage.getItem(CUSTOMER_NOTES_KEY);
  return raw ? JSON.parse(raw) : {};
}
function saveCustomerNotes(map) {
  localStorage.setItem(CUSTOMER_NOTES_KEY, JSON.stringify(map));
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
function initials(name) {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}
function formatCurrency(n) {
  const num = Number(n) || 0;
  return "₹" + num.toLocaleString("en-IN");
}
function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
function relEmptyBlock(icon, text) {
  return `<div class="empty-state" style="padding:34px 16px"><i class="fa-solid ${icon}"></i><p>${escapeHtml(text)}</p></div>`;
}

// ---------------------------------------------------------------
// Load the target customer (from ?id= in the URL)
// ---------------------------------------------------------------
function getCustomerIdFromUrl() {
  return new URLSearchParams(window.location.search).get("id");
}

function findCustomer(id) {
  return getCustomers().find((c) => c.id === id) || null;
}

// ---------------------------------------------------------------
// Related-record lookups (best-effort match by name)
// ---------------------------------------------------------------
function relatedDeals(customer) {
  return readDeals().filter(
    (d) => d.contact && d.contact.trim().toLowerCase() === customer.name.trim().toLowerCase(),
  );
}
function relatedTasks(customer) {
  return readTasks().filter(
    (t) => t.relatedType === "Customer" && t.relatedName === customer.name,
  );
}
function relatedEvents(customer) {
  return readEvents().filter(
    (e) => e.relatedType === "Customer" && e.relatedName === customer.name,
  );
}
function relatedTickets(customer) {
  return readTickets().filter((t) => t.customer === customer.name);
}
function relatedDocuments(customer) {
  return readDocuments().filter(
    (d) => d.relatedType === "Customer" && d.relatedName === customer.name,
  );
}
function customerNotes(customer) {
  const map = readCustomerNotes();
  return map[customer.id] || [];
}

// ---------------------------------------------------------------
// Health score — simple heuristic from what's actually on record.
// Not a model call; same "computed from local data" pattern as AI Insights.
// ---------------------------------------------------------------
function computeHealth(customer) {
  let score = 70;
  const deals = relatedDeals(customer);
  const tickets = relatedTickets(customer);
  const tasks = relatedTasks(customer);
  const today = new Date().toISOString().slice(0, 10);

  deals.forEach((d) => {
    if (d.stage === "Won") score += 6;
    if (d.stage === "Lost") score -= 8;
  });
  tickets.forEach((t) => {
    if (t.priority === "Urgent" && t.status !== "Resolved" && t.status !== "Closed") score -= 10;
    if (t.status === "Resolved" || t.status === "Closed") score += 2;
  });
  tasks.forEach((t) => {
    if (t.dueDate && t.dueDate < today && t.status !== "Done") score -= 3;
  });
  if (customer.status === "Inactive") score -= 15;

  return Math.max(5, Math.min(98, Math.round(score)));
}
function healthClass(score) {
  if (score >= 70) return "good";
  if (score >= 45) return "mid";
  return "low";
}

// ---------------------------------------------------------------
// Picker view (no ?id= supplied yet)
// ---------------------------------------------------------------
function renderPicker() {
  document.getElementById("pickerView").style.display = "block";
  document.getElementById("profileView").style.display = "none";

  function draw(filter) {
    const q = (filter || "").toLowerCase().trim();
    const list = getCustomers().filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        (c.company || "").toLowerCase().includes(q) ||
        (c.email || "").toLowerCase().includes(q),
    );
    const el = document.getElementById("pickerList");
    if (!list.length) {
      el.innerHTML = `<div class="text-muted" style="text-align:center;padding:20px;font-size:12.5px">No customers found.</div>`;
      return;
    }
    el.innerHTML = list
      .map(
        (c) => `
        <div class="c360-picker-row" data-id="${c.id}">
          <span class="deal-card__owner-avatar" style="width:32px;height:32px;font-size:11px">${initials(c.name)}</span>
          <div>
            <div style="font-weight:700;font-size:13px">${escapeHtml(c.name)}</div>
            <div class="text-muted" style="font-size:11.5px">${escapeHtml(c.company || c.email || "")}</div>
          </div>
        </div>`,
      )
      .join("");
    el.querySelectorAll(".c360-picker-row").forEach((row) =>
      row.addEventListener("click", () => {
        window.location.href = `customer-360.html?id=${encodeURIComponent(row.dataset.id)}`;
      }),
    );
  }

  draw("");
  document.getElementById("pickerSearch").addEventListener("input", (e) => draw(e.target.value));
}

// ---------------------------------------------------------------
// Profile view — header, KPIs, fields
// ---------------------------------------------------------------
function renderHeader(customer) {
  document.getElementById("c360Avatar").textContent = initials(customer.name);
  document.getElementById("c360Name").textContent = customer.name;
  document.getElementById("c360Company").innerHTML = customer.company
    ? `<i class="fa-solid fa-building"></i> ${escapeHtml(customer.company)}`
    : "";
  document.getElementById("c360Email").innerHTML = customer.email
    ? `<i class="fa-solid fa-envelope"></i> ${escapeHtml(customer.email)}`
    : "";
  document.getElementById("c360Phone").innerHTML = customer.phone
    ? `<i class="fa-solid fa-phone"></i> ${escapeHtml(customer.phone)}`
    : "";

  const score = computeHealth(customer);
  const healthEl = document.getElementById("c360Health");
  healthEl.className = "c360-health " + healthClass(score);
  healthEl.innerHTML = `<span class="num">${score}</span><span class="lbl">Health</span>`;
}

function renderKpis(customer) {
  const deals = relatedDeals(customer);
  const openDeals = deals.filter((d) => d.stage !== "Won" && d.stage !== "Lost");
  const openValue = openDeals.reduce((s, d) => s + Number(d.value || 0), 0);
  const tickets = relatedTickets(customer);
  const openTickets = tickets.filter(
    (t) => t.status !== "Resolved" && t.status !== "Closed",
  );
  const tasks = relatedTasks(customer);
  const openTasks = tasks.filter((t) => t.status !== "Done");

  const cards = [
    { label: "Open Deals", value: `${openDeals.length} · ${formatCurrency(openValue)}`, cls: "success" },
    { label: "Open Tickets", value: openTickets.length, cls: openTickets.length ? "warning" : "" },
    { label: "Open Tasks", value: openTasks.length, cls: "info" },
    { label: "Documents", value: relatedDocuments(customer).length, cls: "" },
  ];

  document.getElementById("c360Kpis").innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card ${c.cls}">
        <div class="label">${c.label}</div>
        <div class="value">${c.value}</div>
      </div>`,
    )
    .join("");
}

function renderFields(customer) {
  const fields = [
    ["Status", customer.status || "—"],
    ["Company", customer.company || "—"],
    ["Email", customer.email || "—"],
    ["Phone", customer.phone || "—"],
    ["Customer Since", formatDate(customer.createdAt)],
  ];
  document.getElementById("c360Fields").innerHTML = fields
    .map(
      ([k, v]) => `
      <div class="c360-field">
        <span class="k">${k}</span>
        <span class="v">${escapeHtml(v)}</span>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------
// Tab panels
// ---------------------------------------------------------------
function renderDealsTab(customer) {
  const deals = relatedDeals(customer);
  const el = document.getElementById("c360Deals");
  if (!deals.length) {
    el.innerHTML = relEmptyBlock("fa-handshake", "No deals linked to this customer yet.");
    return;
  }
  el.innerHTML = deals
    .map(
      (d) => `
      <div class="c360-list-item">
        <span class="c360-list-icon" style="background:var(--brand-light);color:var(--brand-darker)"><i class="fa-solid fa-handshake"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">${escapeHtml(d.name)} · ${formatCurrency(d.value)}</div>
          <div class="c360-list-meta">${escapeHtml(d.stage)} · closes ${formatDate(d.closeDate)} · ${escapeHtml(d.owner || "Unassigned")}</div>
        </div>
      </div>`,
    )
    .join("");
}

function renderTasksTab(customer) {
  const tasks = relatedTasks(customer);
  const events = relatedEvents(customer);
  const el = document.getElementById("c360Tasks");
  if (!tasks.length && !events.length) {
    el.innerHTML = relEmptyBlock("fa-list-check", "No tasks or events linked to this customer yet.");
    return;
  }
  const taskRows = tasks.map(
    (t) => `
      <div class="c360-list-item">
        <span class="c360-list-icon ${t.status === "Done" ? "success" : "info"}" style="background:${t.status === "Done" ? "var(--success-bg)" : "var(--info-bg)"};color:${t.status === "Done" ? "var(--success)" : "var(--info)"}"><i class="fa-solid fa-list-check"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">${escapeHtml(t.title)}</div>
          <div class="c360-list-meta">Task · ${escapeHtml(t.status)} · due ${formatDate(t.dueDate)} · ${escapeHtml(t.assignee || "Unassigned")}</div>
        </div>
      </div>`,
  );
  const eventRows = events.map(
    (e) => `
      <div class="c360-list-item">
        <span class="c360-list-icon" style="background:var(--info-bg);color:var(--info)"><i class="fa-solid fa-calendar-day"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">${escapeHtml(e.title)}</div>
          <div class="c360-list-meta">${escapeHtml(e.type)} · ${formatDate(e.date)}</div>
        </div>
      </div>`,
  );
  el.innerHTML = taskRows.concat(eventRows).join("");
}

function renderTicketsTab(customer) {
  const tickets = relatedTickets(customer);
  const el = document.getElementById("c360Tickets");
  if (!tickets.length) {
    el.innerHTML = relEmptyBlock("fa-headset", "No support tickets from this customer yet.");
    return;
  }
  el.innerHTML = tickets
    .map(
      (t) => `
      <div class="c360-list-item">
        <span class="c360-list-icon" style="background:var(--warning-bg);color:var(--warning)"><i class="fa-solid fa-headset"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">#${t.number} · ${escapeHtml(t.subject)}</div>
          <div class="c360-list-meta">${escapeHtml(t.status)} · ${escapeHtml(t.priority)} priority · ${escapeHtml(t.assignee || "Unassigned")}</div>
        </div>
      </div>`,
    )
    .join("");
}

function renderDocumentsTab(customer) {
  const docs = relatedDocuments(customer);
  const el = document.getElementById("c360Documents");
  if (!docs.length) {
    el.innerHTML = relEmptyBlock("fa-file-lines", "No documents linked to this customer yet.");
    return;
  }
  el.innerHTML = docs
    .map(
      (d) => `
      <div class="c360-list-item">
        <span class="c360-list-icon" style="background:var(--bg);color:var(--text-muted)"><i class="fa-solid fa-file-lines"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">${escapeHtml(d.name)}</div>
          <div class="c360-list-meta">${escapeHtml(d.category)} · ${formatDate(d.createdAt)}</div>
        </div>
      </div>`,
    )
    .join("");
}

function renderNotesTab(customer) {
  const notes = customerNotes(customer);
  const el = document.getElementById("c360NotesList");
  el.innerHTML = notes.length
    ? notes
        .slice()
        .reverse()
        .map(
          (n) => `
      <div class="c360-list-item">
        <span class="c360-list-icon" style="background:var(--brand-light);color:var(--brand-darker)"><i class="fa-solid fa-note-sticky"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">${escapeHtml(n.text)}</div>
          <div class="c360-list-meta">${escapeHtml(n.author || "")} · ${formatDate(n.at)}</div>
        </div>
      </div>`,
        )
        .join("")
    : relEmptyBlock("fa-note-sticky", "No notes yet — add the first one below.");
}

function addNote(customer) {
  const input = document.getElementById("c360NoteInput");
  const text = input.value.trim();
  if (!text) return;
  const map = readCustomerNotes();
  const list = map[customer.id] || [];
  list.push({ text, at: new Date().toISOString(), author: getCurrentUser()?.name || "You" });
  map[customer.id] = list;
  saveCustomerNotes(map);
  input.value = "";
  renderNotesTab(customer);
  showToast("Note added", "success");
}

// ---------------------------------------------------------------
// Activity timeline — merges every related record type by date
// ---------------------------------------------------------------
function renderTimelineTab(customer) {
  const items = [];

  relatedDeals(customer).forEach((d) =>
    items.push({ date: d.createdAt, icon: "fa-handshake", cls: "brand", title: `Deal: ${d.name}`, meta: `${d.stage} · ${formatCurrency(d.value)}` }),
  );
  relatedTasks(customer).forEach((t) =>
    items.push({ date: t.createdAt, icon: "fa-list-check", cls: "info", title: `Task: ${t.title}`, meta: `${t.status} · due ${formatDate(t.dueDate)}` }),
  );
  relatedTickets(customer).forEach((t) =>
    items.push({ date: t.createdAt, icon: "fa-headset", cls: "warning", title: `Ticket #${t.number}: ${t.subject}`, meta: t.status }),
  );
  relatedDocuments(customer).forEach((d) =>
    items.push({ date: d.createdAt, icon: "fa-file-lines", cls: "", title: `Document: ${d.name}`, meta: d.category }),
  );
  customerNotes(customer).forEach((n) =>
    items.push({ date: n.at, icon: "fa-note-sticky", cls: "brand", title: n.text, meta: n.author || "" }),
  );

  items.sort((a, b) => (a.date > b.date ? -1 : 1));

  const el = document.getElementById("c360Timeline");
  if (!items.length) {
    el.innerHTML = relEmptyBlock("fa-clock-rotate-left", "No activity recorded for this customer yet.");
    return;
  }
  const colorMap = {
    brand: ["var(--brand-light)", "var(--brand-darker)"],
    info: ["var(--info-bg)", "var(--info)"],
    warning: ["var(--warning-bg)", "var(--warning)"],
    "": ["var(--bg)", "var(--text-muted)"],
  };
  el.innerHTML = items
    .map((it) => {
      const [bg, fg] = colorMap[it.cls] || colorMap[""];
      return `
      <div class="c360-list-item">
        <span class="c360-list-icon" style="background:${bg};color:${fg}"><i class="fa-solid ${it.icon}"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">${escapeHtml(it.title)}</div>
          <div class="c360-list-meta">${escapeHtml(it.meta)} · ${formatDate(it.date)}</div>
        </div>
      </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Tabs wiring
// ---------------------------------------------------------------
function initTabs() {
  document.querySelectorAll(".c360-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".c360-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".c360-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`.c360-panel[data-panel="${tab.dataset.tab}"]`).classList.add("active");
    });
  });
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
const customerId = getCustomerIdFromUrl();
const customer = customerId ? findCustomer(customerId) : null;

if (!customer) {
  renderPicker();
} else {
  document.getElementById("pickerView").style.display = "none";
  document.getElementById("profileView").style.display = "block";

  renderHeader(customer);
  renderKpis(customer);
  renderFields(customer);
  renderTimelineTab(customer);
  renderDealsTab(customer);
  renderTasksTab(customer);
  renderTicketsTab(customer);
  renderDocumentsTab(customer);
  renderNotesTab(customer);
  initTabs();

  document.getElementById("c360AddNoteBtn").addEventListener("click", () => addNote(customer));
  document.getElementById("c360NoteInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addNote(customer);
  });
}