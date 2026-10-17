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

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>${escapeHtml(crmI18n.t("sup.subject"))}</th>
          <th>${escapeHtml(crmI18n.t("orders.customer"))}</th>
          <th>${escapeHtml(crmI18n.t("tasks.priority"))}</th>
          <th>${escapeHtml(crmI18n.t("col.status"))}</th>
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
// Right panel — Overdue queue
// ---------------------------------------------------------------
function renderOverdueTab() {
  const today = todayStr();
  const overdue = getTickets()
    .filter(
      (t) =>
        t.dueDate &&
        t.dueDate < today &&
        t.status !== "Resolved" &&
        t.status !== "Closed",
    )
    .sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));

  const el = document.getElementById("overdueTabContent");
  if (!overdue.length) {
    el.innerHTML = `<div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-circle-check"></i><div>${escapeHtml(crmI18n.t("sup.nothingOverdue"))}</div></div>`;
    return;
  }

  el.innerHTML = overdue
    .map(
      (t) => `
        <div class="overdue-row" data-id="${t.id}">
          <span class="dot"></span>
          <div class="info">
            <div class="name">#${t.number} · ${escapeHtml(t.subject)}</div>
            <div class="sub">${escapeHtml(crmI18n.t("sup.dueOn", { date: formatDate(t.dueDate) }))}${t.assignee ? " · " + escapeHtml(t.assignee) : ""}</div>
          </div>
        </div>`,
    )
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
  } else {
    document.getElementById("modalTitle").textContent = crmI18n.t("sup.new-ticket");
    document.getElementById("editId").value = "";
    document.getElementById("fCategory").value = "Technical";
    document.getElementById("fPriority").value = "Medium";
    document.getElementById("fStatus").value = "Open";
    setAssigneeValue("", "");
    deleteBtn.style.display = "none";
    timelineSection.style.display = "none";
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
