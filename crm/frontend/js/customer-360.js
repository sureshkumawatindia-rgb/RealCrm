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
  // Quotes too: the result is also used inside HTML attributes.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
  return "₹" + num.toLocaleString(crmI18n.locale());
}
function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(crmI18n.locale(), {
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
      el.innerHTML = `<div class="text-muted" style="text-align:center;padding:20px;font-size:12.5px">${escapeHtml(t("c360.noCustomers"))}</div>`;
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
  healthEl.innerHTML = `<span class="num">${score}</span><span class="lbl">${escapeHtml(t("c360.health"))}</span>`;
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
    { label: t("c360.openDeals"), value: `${openDeals.length} · ${formatCurrency(openValue)}`, cls: "success" },
    { label: t("c360.openTickets"), value: openTickets.length, cls: openTickets.length ? "warning" : "" },
    { label: t("c360.openTasks"), value: openTasks.length, cls: "info" },
    { label: t("nav.documents"), value: relatedDocuments(customer).length, cls: "" },
  ];

  document.getElementById("c360Kpis").innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card ${c.cls}">
        <div class="label">${escapeHtml(c.label)}</div>
        <div class="value">${escapeHtml(String(c.value))}</div>
      </div>`,
    )
    .join("");
}

function renderFields(customer) {
  const fields = [
    [t("col.status"), customer.status ? crmLabel("stage", customer.status) : "—"],
    [t("col.company"), customer.company || "—"],
    [t("leads.email"), customer.email || "—"],
    [t("leads.phone"), customer.phone || "—"],
    [t("c360.since"), formatDate(customer.createdAt)],
  ];
  const row = ([k, v]) => `
      <div class="c360-field">
        <span class="k">${escapeHtml(k)}</span>
        <span class="v">${escapeHtml(v)}</span>
      </div>`;
  const box = document.getElementById("c360Fields");
  box.innerHTML = fields.map(row).join("");
  // The company's own fields (D73) that this customer has filled, under the built-in ones.
  box.dataset.customerId = customer.id;
  // Under small section headings when the company made sections (D76).
  cfFilledValues("contact", customer.customFields, customer.customFieldLinks).then((filled) => {
    if (box.dataset.customerId !== String(customer.id) || !filled.length) return;
    box.insertAdjacentHTML(
      "beforeend",
      filled
        .map(({ label, text, heading }, i) => {
          const title = heading && heading !== filled[i - 1]?.heading ? `<div class="c360-field-heading">${escapeHtml(heading)}</div>` : "";
          return title + row([label, text]);
        })
        .join(""),
    );
  });
}

// ---------------------------------------------------------------
// Tab panels
// ---------------------------------------------------------------
function renderDealsTab(customer) {
  const deals = relatedDeals(customer);
  const el = document.getElementById("c360Deals");
  if (!deals.length) {
    el.innerHTML = relEmptyBlock("fa-handshake", t("c360.empty.deals"));
    return;
  }
  el.innerHTML = deals
    .map(
      (d) => `
      <div class="c360-list-item">
        <span class="c360-list-icon" style="background:var(--brand-light);color:var(--brand-darker)"><i class="fa-solid fa-handshake"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">${escapeHtml(d.name)} · ${formatCurrency(d.value)}</div>
          <div class="c360-list-meta">${escapeHtml(crmLabel("stage", d.stage))} · ${escapeHtml(t("c360.closes", { date: formatDate(d.closeDate) }))} · ${escapeHtml(d.owner || t("dash.unassigned"))}</div>
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
    el.innerHTML = relEmptyBlock("fa-list-check", t("c360.empty.tasks"));
    return;
  }
  const taskRows = tasks.map(
    (t) => `
      <div class="c360-list-item">
        <span class="c360-list-icon ${t.status === "Done" ? "success" : "info"}" style="background:${t.status === "Done" ? "var(--success-bg)" : "var(--info-bg)"};color:${t.status === "Done" ? "var(--success)" : "var(--info)"}"><i class="fa-solid fa-list-check"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">${escapeHtml(t.title)}</div>
          <div class="c360-list-meta">${escapeHtml(crmI18n.t("dash.add.task"))} · ${escapeHtml(crmLabel("taskStatus", t.status))} · ${escapeHtml(crmI18n.t("c360.due", { date: formatDate(t.dueDate) }))} · ${escapeHtml(t.assignee || crmI18n.t("dash.unassigned"))}</div>
        </div>
      </div>`,
  );
  const eventRows = events.map(
    (e) => `
      <div class="c360-list-item">
        <span class="c360-list-icon" style="background:var(--info-bg);color:var(--info)"><i class="fa-solid fa-calendar-day"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">${escapeHtml(e.title)}</div>
          <div class="c360-list-meta">${escapeHtml(crmLabel("event", e.type))} · ${formatDate(e.date)}</div>
        </div>
      </div>`,
  );
  el.innerHTML = taskRows.concat(eventRows).join("");
}

function renderTicketsTab(customer) {
  const tickets = relatedTickets(customer);
  const el = document.getElementById("c360Tickets");
  if (!tickets.length) {
    el.innerHTML = relEmptyBlock("fa-headset", t("c360.empty.tickets"));
    return;
  }
  el.innerHTML = tickets
    .map(
      (t) => `
      <div class="c360-list-item">
        <span class="c360-list-icon" style="background:var(--warning-bg);color:var(--warning)"><i class="fa-solid fa-headset"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">#${t.number} · ${escapeHtml(t.subject)}</div>
          <div class="c360-list-meta">${escapeHtml(crmLabel("ticketStatus", t.status))} · ${escapeHtml(crmI18n.t("dash.priority", { p: crmLabel("priority", t.priority) }))} · ${escapeHtml(t.assignee || crmI18n.t("dash.unassigned"))}</div>
        </div>
      </div>`,
    )
    .join("");
}

function renderDocumentsTab(customer) {
  const docs = relatedDocuments(customer);
  const el = document.getElementById("c360Documents");
  if (!docs.length) {
    el.innerHTML = relEmptyBlock("fa-file-lines", t("c360.empty.documents"));
    return;
  }
  el.innerHTML = docs
    .map(
      (d) => `
      <div class="c360-list-item">
        <span class="c360-list-icon" style="background:var(--bg);color:var(--text-muted)"><i class="fa-solid fa-file-lines"></i></span>
        <div class="c360-list-body">
          <div class="c360-list-title">${escapeHtml(d.name)}</div>
          <div class="c360-list-meta">${escapeHtml(crmLabel("docCategory", d.category))} · ${formatDate(d.createdAt)}</div>
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
    : relEmptyBlock("fa-note-sticky", t("c360.empty.notes"));
}

async function addNote(customer) {
  const input = document.getElementById("c360NoteInput");
  const text = input.value.trim();
  if (!text) return;
  try {
    customerNoteList.unshift(await addContactNote(customer.id, text));
  } catch (error) {
    showToast(apiErrorMessage(error, t("inbox.err.note")), "error");
    return;
  }
  input.value = "";
  renderNotesTab(customer);
  renderTimelineTab(customer);
  showToast(t("c360.noteAdded"), "success");
}

// ---------------------------------------------------------------
// Activity timeline — merges every related record type by date
// ---------------------------------------------------------------
function renderTimelineTab(customer) {
  const items = [];

  relatedDeals(customer).forEach((d) =>
    items.push({ date: d.createdAt, icon: "fa-handshake", cls: "brand", title: t("c360.tl.deal", { name: d.name }), meta: `${crmLabel("stage", d.stage)} · ${formatCurrency(d.value)}` }),
  );
  relatedTasks(customer).forEach((task) =>
    items.push({ date: task.createdAt, icon: "fa-list-check", cls: "info", title: t("c360.tl.task", { title: task.title }), meta: `${crmLabel("taskStatus", task.status)} · ${t("c360.due", { date: formatDate(task.dueDate) })}` }),
  );
  relatedTickets(customer).forEach((ticket) =>
    items.push({ date: ticket.createdAt, icon: "fa-headset", cls: "warning", title: t("c360.tl.ticket", { number: ticket.number, subject: ticket.subject }), meta: crmLabel("ticketStatus", ticket.status) }),
  );
  relatedDocuments(customer).forEach((d) =>
    items.push({ date: d.createdAt, icon: "fa-file-lines", cls: "", title: t("c360.tl.document", { name: d.name }), meta: crmLabel("docCategory", d.category) }),
  );
  customerNotes(customer).forEach((n) =>
    items.push({ date: n.at, icon: "fa-note-sticky", cls: "brand", title: n.text, meta: n.author || "" }),
  );

  items.sort((a, b) => (a.date > b.date ? -1 : 1));

  const el = document.getElementById("c360Timeline");
  if (!items.length) {
    el.innerHTML = relEmptyBlock("fa-clock-rotate-left", t("c360.empty.timeline"));
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
// The kind of a WhatsApp message, in the person's language (looked up when shown).
const WA_KIND_KEYS = { image: "inbox.media.image", video: "inbox.media.video", audio: "inbox.media.audio", document: "inbox.media.document", sticker: "inbox.media.sticker", location: "inbox.location", contacts: "inbox.contactCard", reaction: "c360.reaction", unsupported: "c360.message" };

function canUseInbox() {
  return isOrgManager() || (getCurrentMember()?.modules || []).includes("inbox");
}

function whatsappLine(m) {
  const time = new Date(m.at).toLocaleString(crmI18n.locale(), { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
  const label = m.type === "document" && m.media?.fileName ? m.media.fileName : m.type === "audio" && m.media?.voice ? t("inbox.voiceMessage") : WA_KIND_KEYS[m.type] && t(WA_KIND_KEYS[m.type]);
  const kind = WA_KIND_KEYS[m.type] ? `<span class="kind">${escapeHtml(label)}</span>${m.text ? "\n" : ""}` : "";
  const sender = m.automation ? t("inbox.auto.auto-reply") : memberName(m.sentByMemberId) || t("c360.team");
  const who = m.direction === "out" ? `${m.type === "template" ? `${escapeHtml(t("inbox.template"))} · ` : ""}${escapeHtml(sender)} · ` : "";
  const failed = m.status === "failed" ? ` · ${t("c360.notSent")}` : "";
  return `<div class="c360-wa-msg ${m.direction === "out" ? "out" : ""}">${kind}${escapeHtml(m.text || "")}<span class="meta">${who}${escapeHtml(time)}${failed}</span></div>`;
}

async function showWhatsAppChat(chat) {
  const list = document.getElementById("c360WaMessages");
  list.innerHTML = relEmptyBlock("fa-spinner", t("inbox.loadingMessages"));
  try {
    const page = await crmRequest(`/conversations/${chat.id}/messages?limit=30`);
    list.innerHTML = page.data.length
      ? `<div class="c360-wa-list">${page.data.map(whatsappLine).join("")}</div>`
      : relEmptyBlock("fa-comments", t("c360.wa.noMessages"));
    const box = list.querySelector(".c360-wa-list");
    if (box) box.scrollTop = box.scrollHeight;
  } catch (error) {
    list.innerHTML = relEmptyBlock("fa-triangle-exclamation", apiErrorMessage(error, t("c360.wa.loadChat")));
  }
}

async function startWhatsAppChat(customer, button) {
  button.disabled = true;
  try {
    const chat = await crmApi("/conversations", jsonRequest("POST", { contactId: customer.id }));
    window.location.href = `Inbox.html?c=${encodeURIComponent(chat.id)}`;
  } catch (error) {
    button.disabled = false;
    showToast(apiErrorMessage(error, t("c360.wa.openFailed")), "error");
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
    list.innerHTML = relEmptyBlock("fa-triangle-exclamation", apiErrorMessage(error, t("c360.wa.loadChats")));
    return;
  }
  if (!chats.length) {
    head.innerHTML = "";
    list.innerHTML = `${relEmptyBlock("fa-comments", t(customer.phone ? "c360.wa.noChat" : "c360.wa.noPhone"))}${
      customer.phone ? `<div style="text-align:center;padding:0 16px 24px"><button class="btn btn-primary" type="button" id="c360WaStart"><i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("c360.wa.message"))}</button></div>` : ""
    }`;
    const start = document.getElementById("c360WaStart");
    if (start) start.addEventListener("click", () => startWhatsAppChat(customer, start));
    return;
  }
  const label = (c) => `${c.account?.verifiedName || c.account?.name || "WhatsApp"}${c.account?.displayPhone ? ` · ${c.account.displayPhone}` : ""}`;
  const describe = (c) => `${t(`inbox.status.${c.status}`)} · ${c.assigneeId ? t("c360.wa.with", { name: memberName(c.assigneeId) || t("inbox.teammate") }) : t("inbox.inQueue")}`;
  head.innerHTML = `
    ${chats.length > 1 ? `<select id="c360WaPick" aria-label="${escapeHtml(t("wa.number"))}">${chats.map((c, i) => `<option value="${i}">${escapeHtml(label(c))}</option>`).join("")}</select>` : `<span><i class="fa-brands fa-whatsapp" style="color:var(--wa)"></i> ${escapeHtml(label(chats[0]))}</span>`}
    <span id="c360WaState">${escapeHtml(describe(chats[0]))}</span>
    <a class="btn btn-outline" id="c360WaOpen" href="Inbox.html?c=${encodeURIComponent(chats[0].id)}"><i class="fa-solid fa-comments"></i> ${escapeHtml(t("c360.wa.openInbox"))}</a>`;
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
// The company's own objects (D75): one tab each, with this customer's records
// ---------------------------------------------------------------
async function renderRecordTabs(customer) {
  let objects = [];
  let records = [];
  try {
    [objects, records] = await Promise.all([crmApi("/custom-objects"), crmApi(`/records?contactId=${encodeURIComponent(customer.id)}&limit=100`)]);
  } catch {
    return; // the other tabs work without them
  }
  const tabs = document.getElementById("c360Tabs");
  const lastPanel = [...document.querySelectorAll(".c360-panel")].pop();
  for (const o of [...objects].reverse()) {
    const mine = records.filter((r) => r.object === o.key);
    const columns = cfListColumns((await cfLoad(o.key)) || []);
    const items = mine
      .map((r) => {
        const meta = columns.map((field) => cfDisplayValue(field, r.customFields?.[field.key], r.customFieldLinks?.[field.key])).filter(Boolean).join(" · ");
        return `<a class="c360-list-item c360-record" href="records.html?object=${encodeURIComponent(o.key)}&open=${encodeURIComponent(r.id)}">
          <span class="c360-list-icon" style="background:var(--brand-light);color:var(--brand-darker)"><i class="fa-solid fa-${escapeHtml(o.icon)}"></i></span>
          <div class="c360-list-body"><div class="c360-list-title">${escapeHtml(r.name)}</div>${meta ? `<div class="c360-list-meta">${escapeHtml(meta)}</div>` : ""}</div>
        </a>`;
      })
      .join("");
    const add = `<div class="c360-record-head"><a class="btn btn-outline" href="records.html?object=${encodeURIComponent(o.key)}&new=1&contactId=${encodeURIComponent(customer.id)}"><i class="fa-solid fa-plus"></i> ${escapeHtml(t("c360.addRecord", { name: o.singular }))}</a></div>`;
    lastPanel.insertAdjacentHTML("afterend", `<div class="panel c360-panel" data-panel="obj-${escapeHtml(o.key)}">${add}${items || relEmptyBlock("fa-" + o.icon, t("c360.empty.records", { name: o.plural }))}</div>`);
    tabs.insertAdjacentHTML("beforeend", `<button class="c360-tab" data-tab="obj-${escapeHtml(o.key)}"><i class="fa-solid fa-${escapeHtml(o.icon)}"></i> ${escapeHtml(o.plural)} (${mine.length})</button>`);
  }
  // Back in the order the company set (they were added in reverse after the last panel).
  const added = [...tabs.querySelectorAll('.c360-tab[data-tab^="obj-"]')];
  added.reverse().forEach((tab) => tabs.appendChild(tab));
  added.forEach(wireTab);
}

// ---------------------------------------------------------------
// Tabs wiring
// ---------------------------------------------------------------
function wireTab(tab) {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".c360-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".c360-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`.c360-panel[data-panel="${tab.dataset.tab}"]`).classList.add("active");
  });
}
function initTabs() {
  document.querySelectorAll(".c360-tab").forEach(wireTab);
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
      showToast(apiErrorMessage(error, t("c360.err.notes")), "error");
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
    renderRecordTabs(customer);
    renderWhatsAppTab(customer);

    document.getElementById("c360AddNoteBtn").addEventListener("click", () => addNote(customer));
    document.getElementById("c360NoteInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addNote(customer);
    });
  }
});
