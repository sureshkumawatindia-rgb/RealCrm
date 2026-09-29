/**
 * customer-360.js — Customer 360° Profile
 *
 * Read-only aggregation of everything about one customer (all on the CRM
 * backend), plus the customer's notes (getContactNotes / addContactNote).
 * Nothing else is changed here — records stay owned by their own pages.
 *
 * Matching is best-effort by name where records store only a name:
 *   - tasks / calendar events / documents: relatedType === "Customer" &&
 *     relatedName === customer.name
 *   - tickets: linked contact id, else ticket.customer === customer.name
 *   - deals: deal.contact === customer.name
 *
 * Reuses shared helpers from app.js (getCustomers, getTickets, showToast,
 * renderSidebarUser, initSidebarToggle, requireAuth).
 */

requireAuth();
renderSidebarUser();
initSidebarToggle();

// This customer's notes, newest first (loaded once the customer is known).
let customerNoteList = [];

// ---------------------------------------------------------------
// Direct reads for modules without a shared app.js helper
// ---------------------------------------------------------------
function readDeals() {
  return getDeals();
}
function readTasks() {
  return getTasks();
}
function readEvents() {
  return getEvents();
}
function readTickets() {
  return getTickets();
}
function readDocuments() {
  return getDocuments();
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

// A direct link (e.g. from the Inbox) may point at a contact that is still a lead.
function findCustomer(id) {
  return getContacts().find((c) => c.id === id) || null;
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
  return readTickets().filter((t) =>
    t.contactId ? String(t.contactId) === String(customer.id) : t.customer === customer.name,
  );
}
function relatedDocuments(customer) {
  return readDocuments().filter(
    (d) =>
      d.relatedType === "Customer" &&
      (d.relatedId ? String(d.relatedId) === String(customer.id) : d.relatedName === customer.name),
  );
}
function customerNotes() {
  return customerNoteList;
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

async function addNote(customer) {
  const input = document.getElementById("c360NoteInput");
  const text = input.value.trim();
  if (!text) return;
  try {
    customerNoteList.unshift(await addContactNote(customer.id, text));
  } catch (error) {
    showToast(apiErrorMessage(error, "Couldn't add the note."), "error");
    return;
  }
  input.value = "";
  renderNotesTab(customer);
  renderTimelineTab(customer);
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
// WhatsApp — the customer's chat (latest messages, read-only) and a
// way to start one. Only for members who can open the Inbox.
// ---------------------------------------------------------------
const WA_KIND = { image: "Photo", video: "Video", audio: "Audio", document: "Document", sticker: "Sticker", location: "Location", contacts: "Contact card", reaction: "Reaction", unsupported: "Message" };

function canUseInbox() {
  return isOrgManager() || (getCurrentMember()?.modules || []).includes("inbox");
}

function whatsappLine(m) {
  const time = new Date(m.at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
  const label = m.type === "document" && m.media?.fileName ? m.media.fileName : m.type === "audio" && m.media?.voice ? "Voice message" : WA_KIND[m.type];
  const kind = WA_KIND[m.type] ? `<span class="kind">${escapeHtml(label)}</span>${m.text ? "\n" : ""}` : "";
  const who = m.direction === "out" ? `${m.type === "template" ? "Template · " : ""}${escapeHtml(memberName(m.sentByMemberId) || "Team")} · ` : "";
  const failed = m.status === "failed" ? " · not sent" : "";
  return `<div class="c360-wa-msg ${m.direction === "out" ? "out" : ""}">${kind}${escapeHtml(m.text || "")}<span class="meta">${who}${escapeHtml(time)}${failed}</span></div>`;
}

async function showWhatsAppChat(chat) {
  const list = document.getElementById("c360WaMessages");
  list.innerHTML = relEmptyBlock("fa-spinner", "Loading messages…");
  try {
    const page = await crmRequest(`/conversations/${chat.id}/messages?limit=30`);
    list.innerHTML = page.data.length
      ? `<div class="c360-wa-list">${page.data.map(whatsappLine).join("")}</div>`
      : relEmptyBlock("fa-comments", "No messages in this chat yet. Open it in the Inbox to send a template.");
    const box = list.querySelector(".c360-wa-list");
    if (box) box.scrollTop = box.scrollHeight;
  } catch (error) {
    list.innerHTML = relEmptyBlock("fa-triangle-exclamation", apiErrorMessage(error, "Couldn't load the chat."));
  }
}

async function startWhatsAppChat(customer, button) {
  button.disabled = true;
  try {
    const chat = await crmApi("/conversations", jsonRequest("POST", { contactId: customer.id }));
    window.location.href = `Inbox.html?c=${encodeURIComponent(chat.id)}`;
  } catch (error) {
    button.disabled = false;
    showToast(apiErrorMessage(error, "Couldn't open a WhatsApp chat."), "error");
  }
}

async function renderWhatsAppTab(customer) {
  if (!canUseInbox()) return;
  document.getElementById("c360WhatsAppTab").hidden = false;
  const head = document.getElementById("c360WaHead");
  const list = document.getElementById("c360WaMessages");
  let chats = [];
  try {
    chats = await crmApi(`/conversations?contactId=${encodeURIComponent(customer.id)}&status=any&limit=10`);
  } catch (error) {
    list.innerHTML = relEmptyBlock("fa-triangle-exclamation", apiErrorMessage(error, "Couldn't load WhatsApp chats."));
    return;
  }
  if (!chats.length) {
    head.innerHTML = "";
    list.innerHTML = `${relEmptyBlock("fa-comments", customer.phone ? "No WhatsApp chat with this customer yet." : "Add a mobile number to this customer to chat on WhatsApp.")}${
      customer.phone ? '<div style="text-align:center;padding:0 16px 24px"><button class="btn btn-primary" type="button" id="c360WaStart"><i class="fa-brands fa-whatsapp"></i> Message on WhatsApp</button></div>' : ""
    }`;
    const start = document.getElementById("c360WaStart");
    if (start) start.addEventListener("click", () => startWhatsAppChat(customer, start));
    return;
  }
  const label = (c) => `${c.account?.verifiedName || c.account?.name || "WhatsApp"}${c.account?.displayPhone ? ` · ${c.account.displayPhone}` : ""}`;
  const describe = (c) => `${c.status} · ${c.assigneeId ? `with ${memberName(c.assigneeId) || "a teammate"}` : "in the queue"}`;
  head.innerHTML = `
    ${chats.length > 1 ? `<select id="c360WaPick" aria-label="WhatsApp number">${chats.map((c, i) => `<option value="${i}">${escapeHtml(label(c))}</option>`).join("")}</select>` : `<span><i class="fa-brands fa-whatsapp" style="color:#25d366"></i> ${escapeHtml(label(chats[0]))}</span>`}
    <span id="c360WaState">${escapeHtml(describe(chats[0]))}</span>
    <a class="btn btn-outline" id="c360WaOpen" href="Inbox.html?c=${encodeURIComponent(chats[0].id)}"><i class="fa-solid fa-comments"></i> Open in Inbox</a>`;
  const pick = document.getElementById("c360WaPick");
  if (pick) {
    pick.addEventListener("change", () => {
      const chat = chats[Number(pick.value)];
      document.getElementById("c360WaState").textContent = describe(chat);
      document.getElementById("c360WaOpen").href = `Inbox.html?c=${encodeURIComponent(chat.id)}`;
      showWhatsAppChat(chat);
    });
  }
  showWhatsAppChat(chats[0]);
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
crmReady(["leads", "contacts", "products", "members", "tasks", "events", "tickets", "documents"], async () => {
  const customerId = getCustomerIdFromUrl();
  const customer = customerId ? findCustomer(customerId) : null;

  if (!customer) {
    renderPicker();
  } else {
    try {
      customerNoteList = await getContactNotes(customer.id);
    } catch (error) {
      customerNoteList = [];
      showToast(apiErrorMessage(error, "Couldn't load this customer's notes."), "error");
    }
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
    renderWhatsAppTab(customer);

    document.getElementById("c360AddNoteBtn").addEventListener("click", () => addNote(customer));
    document.getElementById("c360NoteInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addNote(customer);
    });
  }
});
