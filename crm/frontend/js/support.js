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
  return d.toLocaleDateString("en-IN", {
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
  return div.innerHTML;
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
    { label: "Total Tickets", value: tickets.length, cls: "" },
    { label: "Open Tickets", value: open.length, cls: "info" },
    { label: "Overdue", value: overdue.length, cls: "warning" },
    {
      label: "Resolved This Month",
      value: resolvedThisMonth.length,
      cls: "success",
    },
  ];

  document.getElementById("kpiGrid").innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card ${c.cls}">
        <div class="label">${c.label}</div>
        <div class="value">${c.value}</div>
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
        : `<div class="kanban-col-empty">No tickets</div>`;

      return `
      <div class="kanban-col" data-status="${status}">
        <div class="kanban-col-head">
          <div class="kanban-col-head-title">
            <span class="kanban-dot" style="background:${STATUS_DOT[status]}"></span>
            <h4>${status}</h4>
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
        <span class="badge ${PRIORITY_BADGE_CLASS[t.priority]}">${t.priority}</span>
      </div>
      <div class="ticket-card__subject">${escapeHtml(t.subject)}</div>
      ${
        t.customer
          ? `<div class="ticket-card__customer"><i class="fa-solid fa-user"></i> ${escapeHtml(t.customer)}</div>`
          : ""
      }
      <div class="ticket-card__tags">
        <span class="ticket-tag">${escapeHtml(t.category || "General")}</span>
      </div>
      <div class="ticket-card__foot">
        <div class="ticket-card__assignee">
          <span class="ticket-card__avatar">${initials(t.assignee)}</span>
          ${escapeHtml((t.assignee || "").split(" ")[0] || "Unassigned")}
        </div>
        <div class="ticket-card__date ${overdue ? "overdue" : ""}">
          ${overdue ? '<i class="fa-solid fa-triangle-exclamation"></i> ' : ""}${t.dueDate ? formatDate(t.dueDate) : "No due date"}
        </div>
      </div>
    </div>`;
}

function attachDragEvents() {
  document.querySelectorAll(".ticket-card").forEach((card) => {
    card.addEventListener("click", () => openModal(card.dataset.id));
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
      const newStatus = col.dataset.status;
      const ticket = getTicket(draggingId);
      if (!ticket || ticket.status === newStatus) return;
      saveTicket(ticket.id, { status: newStatus })
        .then(() => showToast(`Moved #${ticket.number} to ${newStatus}`, "success"))
        .catch((error) => showToast(apiErrorMessage(error, "Couldn't move the ticket."), "error"))
        .finally(renderAll);
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
        <div>No tickets match your filters.</div>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Subject</th>
          <th>Customer</th>
          <th>Priority</th>
          <th>Status</th>
          <th>Assignee</th>
          <th>Due Date</th>
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
            <td><span class="badge ${PRIORITY_BADGE_CLASS[t.priority]}">${t.priority}</span></td>
            <td><span class="badge ${STATUS_BADGE_CLASS[t.status]}">${t.status}</span></td>
            <td>${escapeHtml(t.assignee || "—")}</td>
            <td>${t.dueDate ? formatDate(t.dueDate) : "—"}</td>
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-row" data-id="${t.id}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-row" data-id="${t.id}"><i class="fa-solid fa-trash"></i></button>
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
    el.innerHTML = `<div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-user-group"></i><div>No agents yet. Add one from Account Champions.</div></div>`;
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
            <div class="sub">${escapeHtml(a.role || "Agent")}</div>
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
    el.innerHTML = `<div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-circle-check"></i><div>Nothing overdue. Nice work.</div></div>`;
    return;
  }

  el.innerHTML = overdue
    .map(
      (t) => `
        <div class="overdue-row" data-id="${t.id}">
          <span class="dot"></span>
          <div class="info">
            <div class="name">#${t.number} · ${escapeHtml(t.subject)}</div>
            <div class="sub">Due ${formatDate(t.dueDate)}${t.assignee ? " · " + escapeHtml(t.assignee) : ""}</div>
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
    labelEl.textContent = role ? `${name} · ${role}` : name;
    labelEl.classList.remove("is-placeholder");
  } else {
    avatarEl.textContent = "?";
    labelEl.textContent = "Select agent";
    labelEl.classList.add("is-placeholder");
  }
}
function buildAssigneeMenu() {
  const menu = document.getElementById("assigneeMenu");
  const agents = getAgents();
  const selected = document.getElementById("fAssignee").value;

  if (!agents.length) {
    menu.innerHTML = `<div class="assignee-picker__empty">No agents yet. Add one from <a href="accounts.html">Account Champions</a>.</div>`;
    return;
  }

  menu.innerHTML = agents
    .map(
      (a) => `
      <div class="assignee-picker__item ${a.name === selected ? "selected" : ""}" data-name="${escapeHtml(a.name)}" data-role="${escapeHtml(a.role || "")}">
        <span class="avatar">${initials(a.name)}</span>
        <div class="info">
          <div class="name">${escapeHtml(a.name)}</div>
          <div class="role">${escapeHtml(a.role || "Agent")}</div>
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
    `<option value="all">All Agents</option>` +
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
      `Edit Ticket #${ticket.number}`;
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
    document.getElementById("modalTitle").textContent = "New Ticket";
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
      `<div class="text-muted" style="font-size:12.5px">${escapeHtml(apiErrorMessage(error, "Couldn't load the replies."))}</div>`;
  }
}

// notes: null while loading.
function renderTimeline(notes) {
  const el = document.getElementById("timelineList");
  if (!notes) {
    el.innerHTML = `<div class="text-muted" style="font-size:12.5px">Loading replies…</div>`;
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
    : `<div class="text-muted" style="font-size:12.5px">No replies yet.</div>`;
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
    showToast(apiErrorMessage(error, "Couldn't add the note."), "error");
    return;
  }
  input.value = "";
  showToast("Note added", "success");
  await loadTimeline(id);
}

function confirmDelete(id) {
  const ticket = getTicket(id);
  if (!ticket) return;
  if (confirm(`Delete ticket #${ticket.number}? This can't be undone.`)) {
    removeTicket(id)
      .then(() => showToast("Ticket deleted", "success"))
      .catch((error) => showToast(apiErrorMessage(error, "Couldn't delete the ticket."), "error"))
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
crmReady(["tickets", "contacts", "members"], renderAll);
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
    showToast("Please fill in all required fields", "error");
    return;
  }

  try {
    const saved = await saveTicket(id || null, payload);
    showToast(id ? "Ticket updated" : `Ticket #${saved.number} created`, "success");
  } catch (error) {
    showToast(apiErrorMessage(error, "Couldn't save the ticket."), "error");
    return;
  }
  closeModal();
  renderAll();
});
