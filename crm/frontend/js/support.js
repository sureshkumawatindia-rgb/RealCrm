/**
 * support.js — Support module (Ticket Kanban + Table)
 * Tickets and their replies live on the CRM backend (getTickets, saveTicket,
 * removeTicket, getTicketNotes, addTicketNote in app.js); the server gives
 * each ticket its number. Reuses shared helpers from app.js
 * (getAgents, getCustomers, showToast, renderSidebarUser,
 * initSidebarToggle, requireAuth).
 */

requireAuth();
renderSidebarUser();

const STATUSES = [
  "Open",
  "In Progress",
  "Waiting on Customer",
  "Resolved",
  "Closed",
];

// Only these statuses are shown as Kanban columns. Change this list any
// time you want a different subset visible on the board.
const VISIBLE_STATUSES = ["Open" , "Closed"];

const STATUS_DOT = {
  Open: "var(--info)",
  "In Progress": "var(--brand-darker)",
  "Waiting on Customer": "var(--warning)",
  Resolved: "var(--success)",
  Closed: "var(--text-faint)",
};
const STATUS_BADGE_CLASS = {
  Open: "badge-status-open",
  "In Progress": "badge-status-inprogress",
  "Waiting on Customer": "badge-status-waiting",
  Resolved: "badge-status-resolved",
  Closed: "badge-status-closed",
};
const PRIORITY_BADGE_CLASS = {
  Low: "badge-priority-low",
  Medium: "badge-priority-medium",
  High: "badge-priority-high",
  Urgent: "badge-priority-urgent",
};
const PRIORITY_ORDER = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
const OPEN_STATUSES = ["Open", "In Progress", "Waiting on Customer"];

let currentView = "kanban";
let draggingId = null;
let activeStageFilter = null; // set by the nav-bar-kanban-card pill buttons

function getTicket(id) {
  return getTickets().find((t) => String(t.id) === String(id));
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(crmI18n.locale(), {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
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
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  // Quotes too: the result is also used inside HTML attributes.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function assigneeNames() {
  const agents = getAgents().map((a) => a.name);
  if (agents.length) return agents;
  return [
    ...new Set(
      getTickets()
        .map((t) => t.assignee)
        .filter(Boolean),
    ),
  ];
}
function customerNames() {
  return getCustomers()
    .map((c) => c.name)
    .filter(Boolean);
}

// ---------------------------------------------------------------
// SLA (G3, D107): when the first reply and the resolution are due.
// The server works it out (ticket.sla); the chips count down here.
// ---------------------------------------------------------------
const SLA_SOON_MS = 2 * 60 * 60 * 1000;
const SLA_PRIORITIES = ["Urgent", "High", "Medium", "Low"];
let slaSettings = null; // GET /ticket-sla; null until it loads
const slaOn = () => slaSettings?.enabled !== false;

// The part that matters now: the first reply until there is one, then the resolution.
function slaFocus(t) {
  if (!t.sla || !slaOn()) return null;
  return t.sla.reply.at ? { kind: "resolve", ...t.sla.resolve } : { kind: "reply", ...t.sla.reply };
}
// Milliseconds left on it (below 0: late); null when the ticket is closed or waits on the customer.
function slaLeftMs(t) {
  const focus = slaFocus(t);
  if (!focus || !OPEN_STATUSES.includes(t.status) || focus.state === "paused") return null;
  return new Date(focus.dueAt).getTime() - Date.now();
}
// "breached": late now; "soon": due within 2 hours.
function slaMatches(t, which) {
  const left = slaLeftMs(t);
  if (left === null) return false;
  return which === "breached" ? left <= 0 : left > 0 && left <= SLA_SOON_MS;
}
function slaTime(ms) {
  const minutes = Math.max(Math.round(Math.abs(ms) / 60000), 1);
  if (minutes < 60) return crmI18n.t("sla.time.min", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? crmI18n.t("sla.time.hm", { h: hours, m: minutes % 60 }) : crmI18n.t("sla.time.h", { h: hours });
  const days = Math.floor(hours / 24);
  return hours % 24 ? crmI18n.t("sla.time.dh", { d: days, h: hours % 24 }) : crmI18n.t("sla.time.d", { d: days });
}
function formatDateTime(iso) {
  return new Date(iso).toLocaleString(crmI18n.locale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// The chip on cards and rows: time left or late, paused, met or missed.
function slaChip(t) {
  const focus = slaFocus(t);
  if (!focus) return "";
  const left = slaLeftMs(t);
  let cls;
  let text;
  if (left !== null) {
    cls = left <= 0 ? "late" : left <= SLA_SOON_MS ? "soon" : "due";
    text = crmI18n.t(`sla.chip.${focus.kind}${left <= 0 ? "Late" : "In"}`, { time: slaTime(left) });
  } else if (OPEN_STATUSES.includes(t.status)) {
    cls = "paused";
    text = crmI18n.t("sla.chip.paused");
  } else {
    const missed = t.sla.reply.state === "late" || t.sla.resolve.state === "late";
    cls = missed ? "missed" : "met";
    text = crmI18n.t(missed ? "sla.chip.missed" : "sla.chip.met");
  }
  const title = crmI18n.t("sla.dueBy", { time: formatDateTime(focus.dueAt) });
  return `<span class="sla-chip ${cls}" data-sla-ticket="${escapeHtml(t.id)}" title="${escapeHtml(title)}"><i class="fa-solid fa-stopwatch" aria-hidden="true"></i> ${escapeHtml(text)}</span>`;
}

// The ticket's window: each part's due time and how it stands.
function renderSlaBox(ticket) {
  const box = document.getElementById("slaBox");
  const sla = ticket && slaOn() ? ticket.sla : null;
  box.hidden = !sla;
  if (!sla) return;
  const open = OPEN_STATUSES.includes(ticket.status);
  const line = (label, part) => {
    let state = part.state;
    let ms = 0;
    if (open && (state === "due" || state === "breached")) {
      ms = new Date(part.dueAt).getTime() - Date.now();
      state = ms > 0 ? "due" : "breached";
    }
    const text = crmI18n.t(`sla.line.${state}`, { time: slaTime(ms), at: formatDateTime(part.at || part.dueAt), due: formatDateTime(part.dueAt) });
    return `<div class="sla-line ${state}"><span class="sla-line__label">${escapeHtml(label)}</span><span class="sla-line__value">${escapeHtml(text)}</span></div>`;
  };
  box.innerHTML = `
    <div class="sla-box__head"><i class="fa-solid fa-stopwatch" aria-hidden="true"></i> ${escapeHtml(crmI18n.t("sla.box.title"))}
      <span class="sla-box__how">· ${escapeHtml(crmI18n.t(sla.workingHours ? "sla.box.workingHours" : "sla.box.allHours"))}</span></div>
    ${line(crmI18n.t("sla.box.reply"), sla.reply)}
    ${line(crmI18n.t("sla.box.resolve"), sla.resolve)}
    ${sla.reply.at ? "" : `<div class="sla-box__hint">${escapeHtml(crmI18n.t("sla.box.firstReplyHint"))}</div>`}`;
}

// ---------------------------------------------------------------
// Filters
// ---------------------------------------------------------------
function getFilteredTickets() {
  const q = (document.getElementById("searchInput").value || "")
    .toLowerCase()
    .trim();
  const status = document.getElementById("filterStatus").value;
  const priority = document.getElementById("filterPriority").value;
  const category = document.getElementById("filterCategory").value;
  const assignee = document.getElementById("filterAssignee").value;
  const sla = document.getElementById("filterSla").value;

  return getTickets().filter((t) => {
    if (q) {
      const hay =
        `${t.subject} ${t.customer || ""} ${t.assignee || ""} #${t.number}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (status !== "all" && t.status !== status) return false;
    if (priority !== "all" && t.priority !== priority) return false;
    if (category !== "all" && t.category !== category) return false;
    if (assignee !== "all" && t.assignee !== assignee) return false;
    if (sla !== "all" && !slaMatches(t, sla)) return false;
    return true;
  });
}

// ---------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------
function renderKpis() {
  const tickets = getTickets();
  const today = todayStr();
  const open = tickets.filter((t) => OPEN_STATUSES.includes(t.status));
  const overdue = tickets.filter(
    (t) =>
      t.dueDate &&
      t.dueDate < today &&
      t.status !== "Resolved" &&
      t.status !== "Closed",
  );

  const now = new Date();
  const resolvedThisMonth = tickets.filter((t) => {
    if (t.status !== "Resolved" && t.status !== "Closed") return false;
    const when = t.resolvedAt || t.createdAt;
    if (!when) return false;
    const c = new Date(when);
    return (
      c.getMonth() === now.getMonth() && c.getFullYear() === now.getFullYear()
    );
  });

  const cards = [
    { label: crmI18n.t("sup.kpi.total"), value: tickets.length, cls: "" },
    { label: crmI18n.t("c360.openTickets"), value: open.length, cls: "info" },
    { label: crmI18n.t("dash.overdue"), value: overdue.length, cls: "warning" },
    {
      label: crmI18n.t("sup.kpi.resolved"),
      value: resolvedThisMonth.length,
      cls: "success",
    },
    // Open tickets past their SLA's first reply or resolution time (D107).
    ...(slaOn() && tickets.some((t) => t.sla)
      ? [{ label: crmI18n.t("sla.filter.breached"), value: tickets.filter((t) => slaMatches(t, "breached")).length, cls: "danger" }]
      : []),
  ];

  document.getElementById("kpiGrid").innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card ${c.cls}">
        <div class="label">${escapeHtml(c.label)}</div>
        <div class="value">${escapeHtml(String(c.value))}</div>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------
// Kanban view
// ---------------------------------------------------------------
function renderKanban() {
  const tickets = getFilteredTickets();
  const board = document.getElementById("kanbanView");
  const statusesToShow = activeStageFilter
    ? [activeStageFilter]
    : VISIBLE_STATUSES;

  board.innerHTML = statusesToShow
    .map((status) => {
      const statusTickets = tickets
        .filter((t) => t.status === status)
        .sort(
          (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
        );

      const cardsHtml = statusTickets.length
        ? statusTickets.map((t) => ticketCardHtml(t)).join("")
        : `<div class="kanban-col-empty">${escapeHtml(crmI18n.t("sup.noTickets"))}</div>`;

      return `
      <div class="kanban-col" data-status="${status}">
        <div class="kanban-col-head">
          <div class="kanban-col-head-title">
            <span class="kanban-dot" style="background:${STATUS_DOT[status]}"></span>
            <h4>${escapeHtml(crmLabel("ticketStatus", status))}</h4>
          </div>
          <span class="kanban-count">${statusTickets.length}</span>
        </div>
        <div class="kanban-col-body" data-drop-status="${status}">
          ${cardsHtml}
        </div>
      </div>`;
    })
    .join("");

  attachDragEvents();
}

function ticketCardHtml(t) {
  const overdue =
    t.dueDate &&
    t.status !== "Resolved" &&
    t.status !== "Closed" &&
    t.dueDate < todayStr();
  return `
    <div class="ticket-card ${t.priority === "Urgent" ? "is-urgent" : ""}" draggable="true" data-id="${t.id}">
      <div class="ticket-card__top">
        <span class="ticket-card__id">#${t.number}</span>
        <span class="badge ${PRIORITY_BADGE_CLASS[t.priority]}">${escapeHtml(crmLabel("priority", t.priority))}</span>
      </div>
      <div class="ticket-card__subject">${escapeHtml(t.subject)}</div>
      ${
        t.customer
          ? `<div class="ticket-card__customer"><i class="fa-solid fa-user"></i> ${escapeHtml(t.customer)}</div>`
          : ""
      }
      <div class="ticket-card__tags">
        <span class="ticket-tag">${escapeHtml(crmLabel("ticketCategory", t.category || "General"))}</span>
        ${slaChip(t)}
      </div>
      <div class="ticket-card__foot">
        <div class="ticket-card__assignee">
          <span class="ticket-card__avatar">${initials(t.assignee)}</span>
          ${escapeHtml((t.assignee || "").split(" ")[0] || crmI18n.t("dash.unassigned"))}
        </div>
        <div class="ticket-card__date ${overdue ? "overdue" : ""}">
          ${overdue ? '<i class="fa-solid fa-triangle-exclamation"></i> ' : ""}${t.dueDate ? formatDate(t.dueDate) : escapeHtml(crmI18n.t("sup.noDue"))}
        </div>
      </div>
      ${kanbanMoveButton(t.id)}
    </div>`;
}

// A ticket to another status: dropped on a column, or picked in "Move to…" on a touch screen (R2).
function moveTicket(id, newStatus) {
  const ticket = getTicket(id);
  if (!ticket || ticket.status === newStatus) return;
  saveTicket(ticket.id, { status: newStatus })
    .then(() => showToast(crmI18n.t("sup.moved", { number: ticket.number, status: crmLabel("ticketStatus", newStatus) }), "success"))
    .catch((error) => showToast(apiErrorMessage(error, crmI18n.t("sup.err.move")), "error"))
    .finally(renderAll);
}

function attachDragEvents() {
  document.querySelectorAll(".ticket-card").forEach((card) => {
    card.addEventListener("click", () => openModal(card.dataset.id));
    card.querySelector(".kanban-move")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const ticket = getTicket(card.dataset.id);
      if (!ticket) return;
      const status = await crmMoveMenu.open({
        title: crmI18n.t("sup.moveTo", { number: ticket.number }), current: ticket.status, returnFocus: event.currentTarget,
        options: STATUSES.map((s) => ({ value: s, label: crmLabel("ticketStatus", s), color: STATUS_DOT[s] })),
      });
      if (status) moveTicket(ticket.id, status);
    });
    card.addEventListener("dragstart", () => {
      draggingId = card.dataset.id;
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      draggingId = null;
    });
  });

  document.querySelectorAll(".kanban-col").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      if (!draggingId) return;
      moveTicket(draggingId, col.dataset.status);
    });
  });
}

// ---------------------------------------------------------------
// Kanban stage filter pills (nav-bar-kanban-card)
// ---------------------------------------------------------------
function initKanbanStageButtons() {
  const buttons = document.querySelectorAll(".nav-bar-kanban-card button");
  buttons.forEach((btn) => {
    const stage = btn.dataset.stage;
    if (!stage) return;
    btn.addEventListener("click", () => {
      if (activeStageFilter === stage) {
        // clicking the active pill again clears the filter
        activeStageFilter = null;
        btn.classList.remove("active");
      } else {
        buttons.forEach((b) => b.classList.remove("active"));
        activeStageFilter = stage;
        btn.classList.add("active");
      }
      if (currentView === "kanban") renderKanban();
    });
  });
}

// ---------------------------------------------------------------
// Table view
// ---------------------------------------------------------------
function renderTable() {
  const tickets = getFilteredTickets();
  const wrap = document.getElementById("ticketsTable");

  if (!tickets.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-headset"></i>
        <div>${escapeHtml(crmI18n.t("sup.empty.filtered"))}</div>
      </div>`;
    return;
  }

  const withSla = slaOn() && tickets.some((t) => t.sla);
  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>${escapeHtml(crmI18n.t("sup.subject"))}</th>
          <th>${escapeHtml(crmI18n.t("orders.customer"))}</th>
          <th>${escapeHtml(crmI18n.t("tasks.priority"))}</th>
          <th>${escapeHtml(crmI18n.t("col.status"))}</th>
          ${withSla ? `<th>${escapeHtml(crmI18n.t("sla.col"))}</th>` : ""}
          <th>${escapeHtml(crmI18n.t("sup.col.assignee"))}</th>
          <th>${escapeHtml(crmI18n.t("tasks.due-date"))}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${tickets
          .map(
            (t) => `
          <tr data-id="${t.id}">
            <td>#${t.number}</td>
            <td><strong>${escapeHtml(t.subject)}</strong></td>
            <td>${escapeHtml(t.customer || "—")}</td>
            <td><span class="badge ${PRIORITY_BADGE_CLASS[t.priority]}">${escapeHtml(crmLabel("priority", t.priority))}</span></td>
            <td><span class="badge ${STATUS_BADGE_CLASS[t.status]}">${escapeHtml(crmLabel("ticketStatus", t.status))}</span></td>
            ${withSla ? `<td>${slaChip(t) || "—"}</td>` : ""}
            <td>${escapeHtml(t.assignee || "—")}</td>
            <td>${t.dueDate ? formatDate(t.dueDate) : "—"}</td>
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-row" data-id="${t.id}" title="${escapeHtml(crmI18n.t("common.edit"))}" aria-label="${escapeHtml(crmI18n.t("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-row" data-id="${t.id}" title="${escapeHtml(crmI18n.t("common.delete"))}" aria-label="${escapeHtml(crmI18n.t("common.delete"))}"><i class="fa-solid fa-trash"></i></button>
              </div>
            </td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  wrap.querySelectorAll(".edit-row").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal(btn.dataset.id);
    }),
  );
  wrap.querySelectorAll(".delete-row").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDelete(btn.dataset.id);
    }),
  );
  wrap
    .querySelectorAll("tbody tr")
    .forEach((row) =>
      row.addEventListener("click", () => openModal(row.dataset.id)),
    );
}

// ---------------------------------------------------------------
// Right panel — Agents (workload)
// ---------------------------------------------------------------
function renderAgentsTab() {
  const tickets = getTickets();
  const agents = getAgents();
  const el = document.getElementById("agentsTabContent");

  if (!agents.length) {
    el.innerHTML = `<div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-user-group"></i><div>${escapeHtml(crmI18n.t("tasks.noAgents", { link: crmI18n.t("nav.accounts") }))}</div></div>`;
    return;
  }

  el.innerHTML = agents
    .map((a) => {
      const openCount = tickets.filter(
        (t) => t.assignee === a.name && OPEN_STATUSES.includes(t.status),
      ).length;
      return `
        <div class="team-member-row">
          <div class="avatar">${initials(a.name)}</div>
          <div class="info">
            <div class="name">${escapeHtml(a.name)}</div>
            <div class="sub">${escapeHtml(crmLabel("role", a.role || "Agent"))}</div>
          </div>
          <span class="count">${openCount}</span>
        </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Right panel — Overdue queue: past their due date, or past the SLA's
// first reply or resolution time (D107; those first, the latest on top)
// ---------------------------------------------------------------
function renderOverdueTab() {
  const today = todayStr();
  const overdue = getTickets()
    .filter((t) => OPEN_STATUSES.includes(t.status))
    .map((t) => ({ t, slaMs: slaMatches(t, "breached") ? slaLeftMs(t) : null }))
    .filter(({ t, slaMs }) => slaMs !== null || (t.dueDate && t.dueDate < today))
    .sort((a, b) => (a.slaMs ?? Infinity) - (b.slaMs ?? Infinity) || (a.t.dueDate > b.t.dueDate ? 1 : -1));

  const el = document.getElementById("overdueTabContent");
  if (!overdue.length) {
    el.innerHTML = `<div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-circle-check"></i><div>${escapeHtml(crmI18n.t("sup.nothingOverdue"))}</div></div>`;
    return;
  }

  el.innerHTML = overdue
    .map(({ t, slaMs }) => {
      const why = slaMs !== null
        ? crmI18n.t(`sla.chip.${slaFocus(t).kind}Late`, { time: slaTime(slaMs) })
        : crmI18n.t("sup.dueOn", { date: formatDate(t.dueDate) });
      return `
        <div class="overdue-row" data-id="${t.id}">
          <span class="dot"></span>
          <div class="info">
            <div class="name">#${t.number} · ${escapeHtml(t.subject)}</div>
            <div class="sub">${escapeHtml(why)}${t.assignee ? " · " + escapeHtml(t.assignee) : ""}</div>
          </div>
        </div>`;
    })
    .join("");

  el.querySelectorAll(".overdue-row").forEach((row) =>
    row.addEventListener("click", () => openModal(row.dataset.id)),
  );
}

// ---------------------------------------------------------------
// Assignee picker (button + dropdown, pulls Account Champions agents)
// ---------------------------------------------------------------
function setAssigneeValue(name, role) {
  document.getElementById("fAssignee").value = name || "";
  const avatarEl = document.getElementById("assigneeTriggerAvatar");
  const labelEl = document.getElementById("assigneeTriggerLabel");
  if (name) {
    avatarEl.textContent = initials(name);
    labelEl.textContent = role ? `${name} · ${crmLabel("role", role)}` : name;
    labelEl.classList.remove("is-placeholder");
  } else {
    avatarEl.textContent = "?";
    labelEl.textContent = crmI18n.t("cal.select-agent");
    labelEl.classList.add("is-placeholder");
  }
}
function buildAssigneeMenu() {
  const menu = document.getElementById("assigneeMenu");
  const agents = getAgents();
  const selected = document.getElementById("fAssignee").value;

  if (!agents.length) {
    const link = `<a href="accounts.html">${escapeHtml(crmI18n.t("nav.accounts"))}</a>`;
    menu.innerHTML = `<div class="assignee-picker__empty">${crmI18n.t("tasks.noAgents", { link })}</div>`;
    return;
  }

  menu.innerHTML = agents
    .map(
      (a) => `
      <div class="assignee-picker__item ${a.name === selected ? "selected" : ""}" data-name="${escapeHtml(a.name)}" data-role="${escapeHtml(a.role || "")}">
        <span class="avatar">${initials(a.name)}</span>
        <div class="info">
          <div class="name">${escapeHtml(a.name)}</div>
          <div class="role">${escapeHtml(crmLabel("role", a.role || "Agent"))}</div>
        </div>
        <i class="fa-solid fa-check check"></i>
      </div>`,
    )
    .join("");

  menu.querySelectorAll(".assignee-picker__item").forEach((item) =>
    item.addEventListener("click", () => {
      setAssigneeValue(item.dataset.name, item.dataset.role);
      closeAssigneeMenu();
    }),
  );
}
function openAssigneeMenu() {
  buildAssigneeMenu();
  document.getElementById("assigneePicker").classList.add("open");
}
function closeAssigneeMenu() {
  document.getElementById("assigneePicker").classList.remove("open");
}
function toggleAssigneeMenu() {
  const picker = document.getElementById("assigneePicker");
  picker.classList.contains("open") ? closeAssigneeMenu() : openAssigneeMenu();
}
document.getElementById("assigneeTrigger").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleAssigneeMenu();
});
document.addEventListener("click", (e) => {
  const picker = document.getElementById("assigneePicker");
  if (picker.classList.contains("open") && !picker.contains(e.target)) {
    closeAssigneeMenu();
  }
});

// ---------------------------------------------------------------
// Filter dropdown population
// ---------------------------------------------------------------
function populateFilterAssignee() {
  const sel = document.getElementById("filterAssignee");
  const current = sel.value;
  sel.innerHTML =
    `<option value="all">${escapeHtml(crmI18n.t("tasks.all-agents"))}</option>` +
    assigneeNames()
      .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
      .join("");
  sel.value = current || "all";
}
function populateCustomerOptions() {
  document.getElementById("customerOptions").innerHTML = customerNames()
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

// ---------------------------------------------------------------
// Modal — add / edit
// ---------------------------------------------------------------
function openModal(id) {
  const overlay = document.getElementById("modalOverlay");
  const form = document.getElementById("ticketForm");
  form.reset();
  closeAssigneeMenu();
  populateCustomerOptions();

  const deleteBtn = document.getElementById("deleteBtn");
  const timelineSection = document.getElementById("timelineSection");

  if (id) {
    const ticket = getTicket(id);
    if (!ticket) return;
    document.getElementById("modalTitle").textContent =
      crmI18n.t("sup.edit", { number: ticket.number });
    document.getElementById("editId").value = ticket.id;
    document.getElementById("fSubject").value = ticket.subject;
    document.getElementById("fCustomer").value = ticket.customer || "";
    document.getElementById("fCategory").value = ticket.category || "General";
    document.getElementById("fPriority").value = ticket.priority;
    document.getElementById("fStatus").value = ticket.status;
    const agent = getAgents().find((a) => a.name === ticket.assignee);
    setAssigneeValue(ticket.assignee || "", agent ? agent.role : "");
    document.getElementById("fDueDate").value = ticket.dueDate || "";
    document.getElementById("fDescription").value = ticket.description || "";
    deleteBtn.style.display = "inline-flex";
    timelineSection.style.display = "block";
    renderTimeline(null);
    loadTimeline(ticket.id);
    renderSlaBox(ticket);
  } else {
    document.getElementById("modalTitle").textContent = crmI18n.t("sup.new-ticket");
    document.getElementById("editId").value = "";
    document.getElementById("fCategory").value = "Technical";
    document.getElementById("fPriority").value = "Medium";
    document.getElementById("fStatus").value = "Open";
    setAssigneeValue("", "");
    deleteBtn.style.display = "none";
    timelineSection.style.display = "none";
    renderSlaBox(null);
  }

  overlay.classList.add("open");
}
function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
}

// Replies load from the server each time a ticket opens (newest first).
async function loadTimeline(id) {
  try {
    const notes = await getTicketNotes(id);
    if (document.getElementById("editId").value === String(id)) renderTimeline(notes);
  } catch (error) {
    document.getElementById("timelineList").innerHTML =
      `<div class="text-muted" style="font-size:12.5px">${escapeHtml(apiErrorMessage(error, crmI18n.t("sup.err.replies")))}</div>`;
  }
}

// notes: null while loading.
function renderTimeline(notes) {
  const el = document.getElementById("timelineList");
  if (!notes) {
    el.innerHTML = `<div class="text-muted" style="font-size:12.5px">${escapeHtml(crmI18n.t("sup.loadingReplies"))}</div>`;
    return;
  }
  el.innerHTML = notes.length
    ? notes
        .map(
          (n) => `
      <div class="timeline-item">
        <span class="dot"></span>
        <div class="body">
          <div class="text">${escapeHtml(n.text)}</div>
          <div class="meta">${escapeHtml(n.author || "")} · ${formatDate(n.at)}</div>
        </div>
      </div>`,
        )
        .join("")
    : `<div class="text-muted" style="font-size:12.5px">${escapeHtml(crmI18n.t("sup.noReplies"))}</div>`;
}

async function addNoteToTicket() {
  const id = document.getElementById("editId").value;
  if (!id) return;
  const input = document.getElementById("noteInput");
  const text = input.value.trim();
  if (!text) return;
  try {
    await addTicketNote(id, text);
  } catch (error) {
    showToast(apiErrorMessage(error, crmI18n.t("inbox.err.note")), "error");
    return;
  }
  input.value = "";
  showToast(crmI18n.t("c360.noteAdded"), "success");
  await loadTimeline(id);
  // The first note is the ticket's first reply (D107): its SLA changes.
  const ticket = getTicket(id);
  if (ticket?.sla && !ticket.sla.reply.at) await refreshTicket(id);
}

async function refreshTicket(id) {
  try {
    cacheUpsert("tickets", await crmApi(`/tickets/${id}`));
  } catch {
    return; // right again on the next load
  }
  if (document.getElementById("editId").value === String(id)) renderSlaBox(getTicket(id));
  renderAll();
}

function confirmDelete(id) {
  const ticket = getTicket(id);
  if (!ticket) return;
  if (confirm(crmI18n.t("sup.confirmDelete", { number: ticket.number }))) {
    removeTicket(id)
      .then(() => showToast(crmI18n.t("sup.deleted"), "success"))
      .catch((error) => showToast(apiErrorMessage(error, crmI18n.t("sup.err.delete")), "error"))
      .finally(renderAll);
  }
}

// ---------------------------------------------------------------
// Full render
// ---------------------------------------------------------------
function renderAll() {
  renderKpis();
  populateFilterAssignee();
  if (currentView === "kanban") {
    renderKanban();
  } else {
    renderTable();
  }
  renderAgentsTab();
  renderOverdueTab();
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
initSidebarToggle();
crmReady(["tickets", "contacts", "members"], () => {
  renderAll();
  loadSlaSettings(); // D107: the SLA filter and, for owners and admins, its settings
  openFromAddress((id) => {
    if (!getTickets().some((t) => t.id === id)) return false;
    openModal(id);
  });
});
initKanbanStageButtons();

// Search & filters
[
  "searchInput",
  "filterStatus",
  "filterPriority",
  "filterCategory",
  "filterAssignee",
  "filterSla",
].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener("input", () => {
    currentView === "kanban" ? renderKanban() : renderTable();
  });
  el.addEventListener("change", () => {
    currentView === "kanban" ? renderKanban() : renderTable();
  });
});
document.getElementById("filterStatus").addEventListener("change", () => {
  // Dropdown takes priority over the stage pills — clear any active pill
  // so "All Status" (and any other dropdown choice) actually takes effect.
  activeStageFilter = null;
  document
    .querySelectorAll(".nav-bar-kanban-card button")
    .forEach((b) => b.classList.remove("active"));
  currentView === "kanban" ? renderKanban() : renderTable();
});
document.getElementById("clearFiltersBtn").addEventListener("click", () => {
  document.getElementById("searchInput").value = "";
  document.getElementById("filterStatus").value = "all";
  document.getElementById("filterPriority").value = "all";
  document.getElementById("filterCategory").value = "all";
  document.getElementById("filterAssignee").value = "all";
  document.getElementById("filterSla").value = "all";
  activeStageFilter = null;
  document
    .querySelectorAll(".nav-bar-kanban-card button")
    .forEach((b) => b.classList.remove("active"));
  currentView === "kanban" ? renderKanban() : renderTable();
});

// View toggle
document.getElementById("viewKanbanBtn").addEventListener("click", () => {
  currentView = "kanban";
  document.getElementById("viewKanbanBtn").classList.add("active");
  document.getElementById("viewTableBtn").classList.remove("active");
  document.getElementById("kanbanView").style.display = "flex";
  document.getElementById("tableView").style.display = "none";
  renderKanban();
});
document.getElementById("viewTableBtn").addEventListener("click", () => {
  currentView = "table";
  document.getElementById("viewTableBtn").classList.add("active");
  document.getElementById("viewKanbanBtn").classList.remove("active");
  document.getElementById("tableView").style.display = "block";
  document.getElementById("kanbanView").style.display = "none";
  renderTable();
});

// Side panel tabs
document.querySelectorAll(".side-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".side-tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".side-tab-content")
      .forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document
      .querySelector(`[data-tab-content="${tab.dataset.tab}"]`)
      .classList.add("active");
  });
});

// Modal open/close
document
  .getElementById("addBtn")
  .addEventListener("click", () => openModal(null));
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
document.getElementById("modalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});

// Notes
document
  .getElementById("addNoteBtn")
  .addEventListener("click", addNoteToTicket);
document.getElementById("noteInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addNoteToTicket();
  }
});

// Delete from modal
document.getElementById("deleteBtn").addEventListener("click", () => {
  const id = document.getElementById("editId").value;
  if (id) {
    closeModal();
    confirmDelete(id);
  }
});

// Save (create / update)
document.getElementById("ticketForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("editId").value;
  const payload = {
    subject: document.getElementById("fSubject").value.trim(),
    customer: document.getElementById("fCustomer").value.trim(),
    category: document.getElementById("fCategory").value,
    priority: document.getElementById("fPriority").value,
    status: document.getElementById("fStatus").value,
    assignee: document.getElementById("fAssignee").value,
    dueDate: document.getElementById("fDueDate").value,
    description: document.getElementById("fDescription").value.trim(),
  };

  if (!payload.subject || !payload.customer) {
    showToast(crmI18n.t("deals.required"), "error");
    return;
  }

  try {
    const saved = await saveTicket(id || null, payload);
    showToast(id ? crmI18n.t("sup.updated") : crmI18n.t("sup.created", { number: saved.number }), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, crmI18n.t("sup.err.save")), "error");
    return;
  }
  closeModal();
  renderAll();
});

// ---------------------------------------------------------------
// SLA settings (D107): everyone sees the SLA; owners and admins set
// the hours by priority in a window
// ---------------------------------------------------------------
function showSlaFilter() {
  const filter = document.getElementById("filterSla");
  filter.hidden = !slaOn();
  if (!slaOn()) filter.value = "all";
}
async function loadSlaSettings() {
  try {
    slaSettings = await crmApi("/ticket-sla");
  } catch {
    return; // the tickets still show their SLA; the filter and the button stay hidden
  }
  showSlaFilter();
  document.getElementById("slaBtn").hidden = !isOrgManager();
  renderAll();
}

const hoursOf = (minutes) => String(Math.round((minutes / 60) * 100) / 100);
// "Mon–Sat", or the days one by one when they are not in a row.
function daysText(days) {
  const sorted = [...days].sort((a, b) => a - b);
  const name = (d) => new Date(Date.UTC(2026, 10, 1 + d)).toLocaleDateString(crmI18n.locale(), { weekday: "short", timeZone: "UTC" }); // 1 Nov 2026: a Sunday
  const inARow = sorted.length > 2 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  return inARow ? `${name(sorted[0])}–${name(sorted[sorted.length - 1])}` : sorted.map(name).join(", ");
}

function openSlaSettings() {
  if (!slaSettings) return;
  const { businessHours: hours, limits } = slaSettings;
  document.getElementById("slaEnabled").checked = slaSettings.enabled;
  document.getElementById("slaWorkingHours").checked = slaSettings.workingHoursOnly;
  const hoursText = hours.days.length
    ? crmI18n.t("sla.set.hours", { days: daysText(hours.days), start: hours.start, end: hours.end })
    : crmI18n.t("sla.set.noHours");
  document.getElementById("slaHoursNote").innerHTML = `${escapeHtml(hoursText)} <a href="Settings.html?tab=leadrules">${escapeHtml(crmI18n.t("sla.set.hoursLink"))}</a>`;
  const input = (priority, part) =>
    `<input type="number" min="0.1" max="2160" step="any" inputmode="decimal" data-priority="${priority}" data-part="${part}" value="${hoursOf(limits[priority][part])}" aria-label="${escapeHtml(`${crmLabel("priority", priority)}: ${crmI18n.t(part === "reply" ? "sla.set.reply" : "sla.set.resolve")}`)}" />`;
  document.getElementById("slaLimits").innerHTML = SLA_PRIORITIES.map((p) => `
    <tr>
      <td><span class="badge ${PRIORITY_BADGE_CLASS[p]}">${escapeHtml(crmLabel("priority", p))}</span></td>
      <td>${input(p, "reply")}</td>
      <td>${input(p, "resolve")}</td>
    </tr>`).join("");
  document.getElementById("slaOverlay").classList.add("open");
}
function closeSlaSettings() {
  document.getElementById("slaOverlay").classList.remove("open");
}

async function saveSlaSettings() {
  const limits = {};
  for (const input of document.querySelectorAll("#slaLimits input")) {
    const hours = Number(input.value);
    if (!input.value.trim() || !Number.isFinite(hours) || hours < 0.1 || hours > 2160) {
      input.focus();
      showToast(crmI18n.t("sla.set.err.range"), "error");
      return;
    }
    limits[input.dataset.priority] = { ...limits[input.dataset.priority], [input.dataset.part]: Math.round(hours * 60) };
  }
  const wrong = SLA_PRIORITIES.find((p) => limits[p].reply > limits[p].resolve);
  if (wrong) {
    showToast(crmI18n.t("sla.set.err.order", { priority: crmLabel("priority", wrong) }), "error");
    return;
  }
  const button = document.getElementById("slaSave");
  button.disabled = true;
  try {
    slaSettings = await crmApi("/ticket-sla", jsonRequest("PATCH", {
      enabled: document.getElementById("slaEnabled").checked,
      workingHoursOnly: document.getElementById("slaWorkingHours").checked,
      limits,
    }));
  } catch (error) {
    showToast(apiErrorMessage(error, crmI18n.t("sla.set.err.save")), "error");
    return;
  } finally {
    button.disabled = false;
  }
  closeSlaSettings();
  showToast(crmI18n.t("sla.set.saved"), "success");
  showSlaFilter();
  renderAll();
}

document.getElementById("slaBtn").addEventListener("click", openSlaSettings);
document.getElementById("slaClose").addEventListener("click", closeSlaSettings);
document.getElementById("slaCancel").addEventListener("click", closeSlaSettings);
document.getElementById("slaSave").addEventListener("click", saveSlaSettings);
document.getElementById("slaOverlay").addEventListener("click", (e) => {
  if (e.target.id === "slaOverlay") closeSlaSettings();
});

// The chips count down without a reload.
setInterval(() => {
  if (document.hidden) return;
  document.querySelectorAll("[data-sla-ticket]").forEach((chip) => {
    const ticket = getTicket(chip.dataset.slaTicket);
    if (ticket) chip.outerHTML = slaChip(ticket);
  });
}, 60 * 1000);
