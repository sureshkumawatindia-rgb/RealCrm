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

// A direct link (e.g. from the Inbox) may point at a contact that is still a lead. The customer
// and its own leads come from the server (Phase 3, D115): the page does not load every contact
// and lead, so a customer from years ago opens too.
async function findCustomer(id) {
  let contact = null;
  try {
    contact = await crmRecord("contacts", id);
  } catch (error) {
    // Phase 8 (D120): the customer's data was erased on their request.
    if (error.code === "ERASED") return { erased: true, erasedAt: error.errors?.[0]?.message || null };
  }
  if (!contact) return null;
  try {
    const body = await crmRequest(`/leads?contactId=${encodeURIComponent(id)}&limit=100`);
    (body.data || []).forEach((lead) => cacheUpsert("leads", lead));
  } catch {
    /* the deals tab shows none */
  }
  return toLegacyContact(contact);
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

  // The newest 50 customers, or the ones the search finds among all of them (on the server, D115).
  let asked = 0;
  async function draw(filter) {
    const params = new URLSearchParams({ lifecycle: "customer", limit: "50" });
    const q = (filter || "").trim();
    if (q) params.set("q", q.slice(0, 100));
    const mine = ++asked;
    let list = [];
    try {
      list = ((await crmRequest(`/contacts?${params}`)).data || []).map(toLegacyContact);
    } catch {
      list = [];
    }
    if (mine !== asked) return; // a newer search is on its way
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
  let typing = null;
  document.getElementById("pickerSearch").addEventListener("input", (e) => {
    clearTimeout(typing);
    typing = setTimeout(() => draw(e.target.value), 300);
  });
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

// How they found you, and their consent history (D79): the first touch, each enquiry's source
// and campaign, and every consent change with how it happened.
const ORIGIN_CHANNEL = (channel) => t(`rep.ch.${channel}`);
function touchLine(touch) {
  const tags = [touch.utm?.source, touch.utm?.medium].filter(Boolean).join(" / ");
  const campaign = touch.utm?.campaign || touch.ad?.formName || touch.ad?.campaignId || "";
  return [ORIGIN_CHANNEL(touch.channel), touch.source, tags, campaign].filter(Boolean).join(" · ");
}
async function renderOrigin(customer) {
  const panel = document.getElementById("c360OriginPanel");
  const box = document.getElementById("c360Origin");
  box.dataset.customerId = customer.id;
  let touches;
  let consents;
  try {
    [touches, consents] = await Promise.all([crmApi(`/contacts/${encodeURIComponent(customer.id)}/touchpoints`), crmApi(`/contacts/${encodeURIComponent(customer.id)}/consent-history`)]);
  } catch {
    panel.hidden = true;
    return;
  }
  if (box.dataset.customerId !== String(customer.id)) return;
  const row = (title, meta) => `<div class="c360-field"><span class="v">${escapeHtml(title)}</span><span class="c360-origin-meta">${escapeHtml(meta)}</span></div>`;
  const parts = [];
  if (touches.firstTouch) parts.push(`<div class="c360-field"><span class="k">${escapeHtml(t("c360.origin.first"))}</span><span class="v">${escapeHtml([ORIGIN_CHANNEL(touches.firstTouch.channel), touches.firstTouch.source, touches.firstTouch.campaign].filter(Boolean).join(" · "))}</span></div>`);
  if (touches.items.length) {
    parts.push(`<div class="c360-field-heading">${escapeHtml(t("c360.origin.touches", { n: touches.items.length }))}</div>`);
    parts.push(...touches.items.slice(0, 10).map((tp) => row(touchLine(tp), formatDate(tp.at))));
  }
  const STATE = { opted_in: t("c360.consent.in"), opted_out: t("c360.consent.out"), unknown: t("c360.consent.unknown") };
  if (consents.length) {
    parts.push(`<div class="c360-field-heading">${escapeHtml(t("c360.consent.title"))}</div>`);
    parts.push(...consents.slice(0, 10).map((e) => row(`${STATE[e.to] || e.to} · ${t(`c360.consent.by.${e.method}`)}`, [e.actorName, e.detail, formatDate(e.at)].filter(Boolean).join(" · "))));
  }
  panel.hidden = !parts.length;
  box.innerHTML = parts.join("");
}

// Phase 8 (D120): a copy of the customer's data, or erasing it, on their request (owners and
// admins; js/customer-privacy.js). After the erasure the page says so.
function renderPrivacy(customer) {
  const panel = document.getElementById("c360PrivacyPanel");
  if (!isOrgManager() || typeof crmCustomerPrivacy === "undefined") return;
  panel.hidden = false;
  document.getElementById("c360DataBtn").onclick = () => crmCustomerPrivacy.download({ id: customer.id, name: customer.name });
  document.getElementById("c360EraseBtn").onclick = () => crmCustomerPrivacy.erase({ id: customer.id, name: customer.name }, { onErased: showErased });
}
function showErased(result) {
  document.getElementById("pickerView").style.display = "none";
  // The profile stays in the page (hidden): something still loading for it finds its places.
  const view = document.getElementById("profileView");
  view.style.display = "none";
  let note = document.getElementById("c360Erased");
  if (!note) {
    note = document.createElement("div");
    note.id = "c360Erased";
    view.after(note);
  }
  note.innerHTML = crmCustomerPrivacy.erasedHtml(result || {});
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
// The customer's delivery projects (D92), under their deals: status and progress, each a link.
async function renderCustomerProjects(customer) {
  const el = document.getElementById("c360Deals");
  const summary = await crmApi(`/projects/summary?contactId=${encodeURIComponent(customer.id)}`).catch(() => null);
  if (!summary || !summary.count) return;
  el.querySelector(".c360-projects")?.remove();
  const box = document.createElement("div");
  box.className = "c360-projects";
  box.innerHTML = `<h4 class="c360-projects-title">${escapeHtml(t("nav.projects"))}</h4>${summary.items.length
    ? summary.items.map((p) => `<a class="c360-list-item c360-record c360-project" href="projects.html?id=${encodeURIComponent(p.id)}">
        <span class="c360-list-icon" style="background:var(--info-bg);color:var(--info)"><i class="fa-solid fa-briefcase"></i></span>
        <span class="c360-list-body"><span class="c360-list-title">${escapeHtml(p.name)}</span>
        <span class="c360-list-meta">${escapeHtml([p.number, crmI18n.t(`proj.status.${p.status}`), t("proj.percentDone", { n: p.progress }), p.overdue ? t("proj.late") : ""].filter(Boolean).join(" · "))}</span></span>
      </a>`).join("")
    : `<p class="c360-list-meta">${escapeHtml(t("proj.hasProjects", { n: summary.count }))}</p>`}`;
  if (el.querySelector(".empty-state")) el.innerHTML = "";
  el.appendChild(box);
}

function renderDealsTab(customer) {
  const deals = relatedDeals(customer);
  const el = document.getElementById("c360Deals");
  renderCustomerProjects(customer);
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

// Documents, with "New Google Doc / Sheet" when the member connected Google with Drive (D90).
function renderDocumentsTab(customer) {
  const docs = relatedDocuments(customer);
  const el = document.getElementById("c360Documents");
  el.innerHTML = `<div class="c360-hist-bar"><span></span>${googleFileButtonsHtml()}</div>
    ${docs.length ? docs.map(documentRowHtml).join("") : relEmptyBlock("fa-file-lines", t("c360.empty.documents"))}`;
  wireGoogleFileButtons(el, { name: customer.name, relatedType: "Customer", relatedId: customer.id, onMade: () => renderDocumentsTab(customer) });
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
// Customer history (D85): from GET /contacts/:id/timeline — WhatsApp, calls, deals and their
// moves, quotations, orders and payments, tickets, tasks, meetings, notes, enquiries and consent,
// newest first, by filter, with "Load more". The viewer's own Gmail emails with this customer are
// added (read-only) when they connected Gmail. Log a call by hand, or Call through the company's
// calling provider (the member's phone rings first).
// ---------------------------------------------------------------
const HIST_FILTERS = [["", "c360.hist.f.all"], ["talk", "c360.hist.f.talk"], ["sales", "c360.hist.f.sales"], ["service", "c360.hist.f.service"], ["work", "c360.hist.f.work"], ["notes", "c360.hist.f.notes"]];
const HIST_ICONS = {
  sms: ["fa-solid fa-comment-sms", "info"], whatsapp: ["fa-brands fa-whatsapp", "success"], call: ["fa-solid fa-phone", "info"], email: ["fa-solid fa-envelope", "info"], note: ["fa-solid fa-note-sticky", "brand"],
  lead: ["fa-solid fa-handshake", "brand"], stage: ["fa-solid fa-arrow-right", "brand"], quotation: ["fa-solid fa-file-invoice", "warning"], order: ["fa-solid fa-box", "warning"],
  payment: ["fa-solid fa-indian-rupee-sign", "success"], ticket: ["fa-solid fa-headset", "warning"], task: ["fa-solid fa-list-check", "info"], event: ["fa-solid fa-calendar", "info"],
  enquiry: ["fa-solid fa-inbox", ""], consent: ["fa-solid fa-shield-halved", ""], document: ["fa-solid fa-file-lines", ""],
};
// G8 (D112): Instagram and Messenger messages come as source "whatsapp" with their channel.
const SOCIAL_HIST = {
  instagram: { icon: ["fa-brands fa-instagram", "brand"], in: "c360.hist.igIn", out: "c360.hist.igOut" },
  messenger: { icon: ["fa-brands fa-facebook-messenger", "info"], in: "c360.hist.fbIn", out: "c360.hist.fbOut" },
};
const HIST_LABELS = {
  note: "c360.hist.s.note", lead: "c360.hist.s.lead", stage: "c360.hist.s.stage", quotation: "c360.hist.s.quotation", order: "c360.hist.s.order", payment: "c360.hist.s.payment",
  ticket: "c360.hist.s.ticket", task: "c360.hist.s.task", event: "c360.hist.s.event", enquiry: "c360.hist.s.enquiry", consent: "c360.hist.s.consent", document: "c360.hist.s.document",
};
const CALL_OUTCOMES = ["connected", "interested", "callback", "not_interested", "no_answer", "busy", "wrong_number", "switched_off"];
const HIST_COLORS = { brand: ["var(--brand-light)", "var(--brand-darker)"], info: ["var(--info-bg)", "var(--info)"], warning: ["var(--warning-bg)", "var(--warning)"], success: ["var(--success-bg, var(--bg))", "var(--success)"], "": ["var(--bg)", "var(--text-muted)"] };
// seq: a newer reset (another filter, a saved call) wins over a page still on its way.
const hist = { customer: null, kind: "", items: [], next: null, calling: false, loading: false, seq: 0 };

const minutesText = (sec) => (sec >= 60 ? t("call.minutes", { n: Math.round(sec / 60) }) : sec ? t("call.seconds", { n: sec }) : "");

function historyItemHtml(it) {
  const social = it.source === "whatsapp" ? SOCIAL_HIST[it.channel] : null;
  const [icon, cls] = social?.icon || HIST_ICONS[it.source] || ["fa-solid fa-circle", ""];
  const [bg, fg] = HIST_COLORS[cls] || HIST_COLORS[""];
  const extra = it.source === "call"
    ? [it.outcome ? t(`call.outcome.${it.outcome}`) : t(`call.status.${it.status}`), minutesText(it.durationSec)].filter(Boolean).join(" · ")
    : it.source === "sms" && it.direction === "out" ? t(`sms.status.${it.status}`) : "";
  // A translated label for the kind, then the record's own name (the server's `title` is English).
  // A WhatsApp call (G7, D111) says so.
  const label = it.source === "call" ? t(it.provider === "whatsapp" ? (it.direction === "in" ? "call.waIn" : "call.waOut") : it.direction === "in" ? "call.in" : "call.out")
    : social ? t(it.direction === "in" ? social.in : social.out)
    : it.source === "whatsapp" ? t(it.direction === "in" ? "c360.hist.waIn" : "c360.hist.waOut")
    : it.source === "sms" ? t(it.direction === "in" ? "c360.hist.smsIn" : "c360.hist.smsOut")
    : it.source === "email" ? t(it.direction === "in" ? "c360.hist.emailIn" : "c360.hist.emailOut")
      : it.source === "consent" && it.channel === "sms" ? t("c360.hist.smsConsent")
      : HIST_LABELS[it.source] ? t(HIST_LABELS[it.source]) : "";
  const title = !label ? it.title : it.name ? `${label}: ${it.name}` : label;
  const when = new Date(it.at).toLocaleString(crmI18n.locale(), { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  const detail = it.source === "task" ? [it.status, it.due ? t("c360.hist.due", { date: it.due }) : ""].filter(Boolean).join(" · ") : it.detail;
  const meta = [extra, detail && !["call", "whatsapp", "note", "sms"].includes(it.source) ? detail : "", it.actorName, when].filter(Boolean).join(" · ");
  const body = ["call", "whatsapp", "note", "email", "sms"].includes(it.source) && it.detail ? `<div class="c360-hist-text">${escapeHtml(it.detail)}</div>` : "";
  const action = it.source === "call" && !it.outcome && it.id ? `<button type="button" class="link-btn" data-hist="outcome" data-id="${escapeHtml(it.id)}">${escapeHtml(t("call.addOutcome"))}</button>` : "";
  return `<div class="c360-list-item">
      <span class="c360-list-icon" style="background:${bg};color:${fg}"><i class="${icon}"></i></span>
      <div class="c360-list-body">
        <div class="c360-list-title">${escapeHtml(title)}</div>
        ${body}
        <div class="c360-list-meta">${escapeHtml(meta)} ${action}</div>
      </div>
    </div>`;
}

function renderHistoryList() {
  const list = document.getElementById("c360HistList");
  const items = hist.items;
  list.innerHTML = items.length ? items.map(historyItemHtml).join("") : relEmptyBlock("fa-clock-rotate-left", t("c360.empty.timeline"));
  document.getElementById("c360HistMore").hidden = !hist.next;
}

async function loadHistory({ reset = false } = {}) {
  if (!reset && hist.loading) return;
  const seq = reset ? ++hist.seq : hist.seq;
  hist.loading = true;
  const params = new URLSearchParams({ limit: "30" });
  if (hist.kind) params.set("kinds", hist.kind);
  if (!reset && hist.next) params.set("before", hist.next);
  try {
    const page = await crmApi(`/contacts/${encodeURIComponent(hist.customer.id)}/timeline?${params}`);
    if (seq !== hist.seq) return;
    hist.items = reset ? page.items : [...hist.items, ...page.items];
    hist.next = page.next;
    renderHistoryList();
  } catch (error) {
    if (seq === hist.seq) document.getElementById("c360HistList").innerHTML = relEmptyBlock("fa-triangle-exclamation", apiErrorMessage(error, t("c360.hist.loadFailed")));
  } finally {
    if (seq === hist.seq) hist.loading = false;
  }
}

function callFormHtml(customer) {
  const leads = relatedDeals(customer).filter((d) => !["Won", "Lost"].includes(d.stage));
  return `<form class="c360-call-form" id="c360CallForm" hidden autocomplete="off">
    <div class="c360-call-outcomes" role="radiogroup" aria-label="${escapeHtml(t("call.outcome"))}">
      ${CALL_OUTCOMES.map((o, i) => `<label class="chip-radio"><input type="radio" name="outcome" value="${o}" ${i === 0 ? "checked" : ""} /> ${escapeHtml(t(`call.outcome.${o}`))}</label>`).join("")}
    </div>
    <div class="c360-call-row">
      <select name="direction" aria-label="${escapeHtml(t("call.direction"))}"><option value="out">${escapeHtml(t("call.out"))}</option><option value="in">${escapeHtml(t("call.in"))}</option></select>
      <input type="number" name="minutes" min="0" max="600" placeholder="${escapeHtml(t("call.minutesPh"))}" aria-label="${escapeHtml(t("call.minutesPh"))}" />
      ${leads.length ? `<select name="leadId" aria-label="${escapeHtml(t("call.lead"))}"><option value="">${escapeHtml(t("call.noLead"))}</option>${leads.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join("")}</select>` : ""}
    </div>
    <input type="text" name="notes" maxlength="2000" placeholder="${escapeHtml(t("call.notesPh"))}" aria-label="${escapeHtml(t("call.notesPh"))}" />
    <div class="pl-buttons"><button class="btn btn-primary" type="submit">${escapeHtml(t("call.save"))}</button><button class="btn btn-outline" type="button" data-hist="cancel">${escapeHtml(t("common.cancel"))}</button></div>
  </form>`;
}

function renderTimelineTab(customer) {
  const el = document.getElementById("c360Timeline");
  if (!hist.customer || hist.customer.id !== customer.id || !document.getElementById("c360HistList")) {
    hist.customer = customer;
    hist.kind = "";
    el.innerHTML = `
      <div class="c360-hist-bar">
        <div class="c360-hist-filters">${HIST_FILTERS.map(([kind, key]) => `<button type="button" class="chip${kind === "" ? " active" : ""}" data-kind="${kind}">${escapeHtml(t(key))}</button>`).join("")}</div>
        <div class="pl-buttons">
          <button type="button" class="btn btn-outline" data-hist="log"><i class="fa-solid fa-phone"></i> ${escapeHtml(t("call.log"))}</button>
          <button type="button" class="btn btn-primary" data-hist="dial" hidden><i class="fa-solid fa-phone-volume"></i> ${escapeHtml(t("call.dial"))}</button>
          <button type="button" class="btn btn-outline" data-hist="sms" hidden><i class="fa-solid fa-comment-sms"></i> ${escapeHtml(t("sms.send"))}</button>
        </div>
      </div>
      ${callFormHtml(customer)}
      <form class="c360-call-form" id="c360SmsForm" hidden autocomplete="off"></form>
      <div id="c360HistList"></div>
      <button type="button" class="btn btn-outline c360-hist-more" id="c360HistMore" hidden>${escapeHtml(t("c360.hist.more"))}</button>`;
    el.onclick = (event) => onHistoryClick(event, customer);
    el.querySelector("#c360CallForm").addEventListener("submit", (event) => saveCall(event, customer));
    crmApi("/telephony").then((tel) => {
      hist.calling = tel.connected;
      el.querySelector('[data-hist="dial"]').hidden = !tel.connected || !(customer.phone || customer.phoneE164);
    }).catch(() => {});
    // SMS (D88): when the company has an SMS account with templates, and the customer a number.
    crmApi("/sms/connection").then((conn) => {
      hist.sms = conn;
      el.querySelector('[data-hist="sms"]').hidden = !conn.connected || !conn.templates.length || !(customer.phone || customer.phoneE164);
    }).catch(() => {});
    el.querySelector("#c360SmsForm").addEventListener("submit", (event) => sendSms(event, customer));
    el.querySelector("#c360SmsForm").addEventListener("input", (event) => { if (event.target.dataset.blank !== undefined) renderSmsPreview(); });
    el.querySelector("#c360SmsForm").addEventListener("change", (event) => { if (event.target.name === "template") renderSmsForm(customer, event.target.value); });
  }
  loadHistory({ reset: true });
}

async function onHistoryClick(event, customer) {
  const chip = event.target.closest("[data-kind]");
  if (chip) {
    hist.kind = chip.dataset.kind;
    document.querySelectorAll(".c360-hist-filters .chip").forEach((c) => c.classList.toggle("active", c === chip));
    hist.next = null;
    loadHistory({ reset: true });
    return;
  }
  if (event.target.id === "c360HistMore") return loadHistory();
  const button = event.target.closest("[data-hist]");
  if (!button) return undefined;
  const form = document.getElementById("c360CallForm");
  if (button.dataset.hist === "log") {
    form.hidden = !form.hidden;
    return undefined;
  }
  if (button.dataset.hist === "cancel") {
    form.hidden = true;
    return undefined;
  }
  if (button.dataset.hist === "sms") {
    const smsForm = document.getElementById("c360SmsForm");
    if (smsForm.hidden) renderSmsForm(customer);
    smsForm.hidden = !smsForm.hidden;
    return undefined;
  }
  if (button.dataset.hist === "sms-cancel") {
    document.getElementById("c360SmsForm").hidden = true;
    return undefined;
  }
  if (button.dataset.hist === "sms-optout") {
    const optedOut = !customer.smsOptOut;
    if (optedOut && !confirm(t("sms.optOutConfirm"))) return undefined;
    try {
      const result = await crmApi(`/contacts/${encodeURIComponent(customer.id)}/sms-consent`, jsonRequest("POST", { optedOut }));
      customer.smsOptOut = result.smsOptOut;
      renderSmsForm(customer, document.querySelector('#c360SmsForm [name="template"]')?.value);
    } catch (error) {
      showToast(apiErrorMessage(error, t("sms.failed")), "error");
    }
    return undefined;
  }
  if (button.dataset.hist === "dial") {
    button.disabled = true;
    try {
      await crmApi("/calls/dial", jsonRequest("POST", { contactId: customer.id }));
      showToast(t("call.ringing"), "success");
      setTimeout(() => loadHistory({ reset: true }), 1500);
    } catch (error) {
      showToast(apiErrorMessage(error, t("call.dialFailed")), "error");
      loadHistory({ reset: true });
    } finally {
      button.disabled = false;
    }
    return undefined;
  }
  if (button.dataset.hist === "outcome") {
    const outcome = await crmMoveMenu.open({ title: t("call.outcome"), current: "", options: CALL_OUTCOMES.map((o) => ({ value: o, label: t(`call.outcome.${o}`) })) });
    if (!outcome) return undefined;
    try {
      await crmApi(`/calls/${button.dataset.id}`, jsonRequest("PATCH", { outcome }));
      loadHistory({ reset: true });
    } catch (error) {
      showToast(apiErrorMessage(error, t("call.saveFailed")), "error");
    }
  }
  return undefined;
}

// SMS (D88): a DLT template, its blanks (the customer's name and company filled in), a preview.
function smsTemplateOf(key) {
  return (hist.sms?.templates || []).find((x) => x.key === key) || hist.sms?.templates?.[0];
}
function renderSmsForm(customer, key) {
  const form = document.getElementById("c360SmsForm");
  const template = smsTemplateOf(key);
  if (!template) return;
  const guess = (name) => (/name/i.test(name) ? customer.name || "" : /company|firm/i.test(name) ? customer.company || "" : "");
  const optedOut = Boolean(customer.smsOptOut);
  form.innerHTML = `
    <select name="template" aria-label="${escapeHtml(t("sms.template"))}">${hist.sms.templates.map((x) => `<option value="${escapeHtml(x.key)}" ${x.key === template.key ? "selected" : ""}>${escapeHtml(x.name)}</option>`).join("")}</select>
    ${template.variables.map((name) => `<input type="text" data-blank="${escapeHtml(name)}" maxlength="100" value="${escapeHtml(guess(name))}" placeholder="${escapeHtml(name)}" aria-label="${escapeHtml(name)}" />`).join("")}
    <p class="c360-hist-text c360-sms-preview" id="c360SmsPreview"></p>
    <p class="c360-list-meta">${escapeHtml(t(optedOut ? "sms.optedOut" : "sms.allowed"))} <button type="button" class="link-btn" data-hist="sms-optout">${escapeHtml(t(optedOut ? "sms.allow" : "sms.optOut"))}</button></p>
    <div class="pl-buttons"><button class="btn btn-primary" type="submit" ${optedOut ? "disabled" : ""}>${escapeHtml(t("sms.sendNow"))}</button><button class="btn btn-outline" type="button" data-hist="sms-cancel">${escapeHtml(t("common.cancel"))}</button></div>`;
  renderSmsPreview();
}
function renderSmsPreview() {
  const form = document.getElementById("c360SmsForm");
  const template = smsTemplateOf(form.querySelector('[name="template"]')?.value);
  if (!template) return;
  const values = Object.fromEntries([...form.querySelectorAll("[data-blank]")].map((i) => [i.dataset.blank, i.value]));
  document.getElementById("c360SmsPreview").textContent = template.text.replace(/##([A-Za-z0-9_]{1,30})##/g, (m, name) => values[name] || `[${name}]`);
}
async function sendSms(event, customer) {
  event.preventDefault();
  const form = event.target;
  const values = Object.fromEntries([...form.querySelectorAll("[data-blank]")].map((i) => [i.dataset.blank, i.value.trim()]));
  const body = { contactId: customer.id, template: form.querySelector('[name="template"]').value, values };
  // One key per SMS being sent (a changed form is a new SMS), as for calls.
  const signature = JSON.stringify(body);
  if (form.dataset.signature !== signature) Object.assign(form.dataset, { signature, key: newIdempotencyKey() });
  const button = form.querySelector("[type=submit]");
  button.disabled = true;
  try {
    await crmApi("/sms", { ...jsonRequest("POST", body), headers: { "Content-Type": "application/json", "Idempotency-Key": form.dataset.key } });
    delete form.dataset.signature;
    delete form.dataset.key;
    form.hidden = true;
    showToast(t("sms.sent"), "success");
    loadHistory({ reset: true });
  } catch (error) {
    showToast(apiErrorMessage(error, t("sms.failed")), "error");
  } finally {
    button.disabled = false;
  }
}

async function saveCall(event, customer) {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const minutes = Number(data.get("minutes") || 0);
  const body = {
    contactId: customer.id,
    outcome: data.get("outcome"),
    direction: data.get("direction") || "out",
    durationSec: Math.round(minutes * 60),
    notes: String(data.get("notes") || "").trim(),
    ...(data.get("leadId") && { leadId: data.get("leadId") }),
  };
  const button = form.querySelector("[type=submit]");
  button.disabled = true;
  // One key per call being logged: trying again after a lost answer does not log it twice (a
  // changed form is a new call, since the server refuses a key reused with another body).
  const signature = JSON.stringify(body);
  if (form.dataset.signature !== signature) Object.assign(form.dataset, { signature, key: newIdempotencyKey() });
  try {
    await crmApi("/calls", { ...jsonRequest("POST", body), headers: { "Content-Type": "application/json", "Idempotency-Key": form.dataset.key } });
    delete form.dataset.signature;
    delete form.dataset.key;
    form.reset();
    form.hidden = true;
    showToast(t("call.logged"), "success");
    loadHistory({ reset: true });
  } catch (error) {
    showToast(apiErrorMessage(error, t("call.saveFailed")), "error");
  } finally {
    button.disabled = false;
  }
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
crmReady(["products", "members", "tasks", "events", "tickets", "documents"], async () => {
  const customerId = getCustomerIdFromUrl();
  const customer = customerId ? await findCustomer(customerId) : null;

  if (customer?.erased) {
    showErased(customer);
  } else if (!customer) {
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
    renderOrigin(customer);
    renderPrivacy(customer);
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
