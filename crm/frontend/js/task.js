/**
 * task.js — Tasks module (Kanban + Table)
 * Persists to localStorage under 'crm_tasks'.
 * Reuses shared helpers from app.js (getAgents, getCustomers, getLeads,
 * getAccounts, showToast, renderSidebarUser, initSidebarToggle, requireAuth).
 */

requireAuth();
renderSidebarUser();

const TASKS_KEY = "crm_tasks";
const STATUSES = ["To Do", "In Progress", "Done"];
const STATUS_DOT = {
  "To Do": "var(--info)",
  "In Progress": "var(--brand-darker)",
  Done: "var(--success)",
};
const STATUS_BADGE_CLASS = {
  "To Do": "badge-status-todo",
  "In Progress": "badge-status-inprogress",
  Done: "badge-status-done",
};
const PRIORITY_BADGE_CLASS = {
  Low: "badge-priority-low",
  Medium: "badge-priority-medium",
  High: "badge-priority-high",
};
const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };

let currentView = "kanban";
let draggingId = null;

// ---------------------------------------------------------------
// Storage
// ---------------------------------------------------------------
function getTasks() {
  const raw = localStorage.getItem(TASKS_KEY);
  return raw ? JSON.parse(raw) : [];
}
function saveTasks(list) {
  localStorage.setItem(TASKS_KEY, JSON.stringify(list));
}
function addTask(task) {
  const list = getTasks();
  task.id =
    "tk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  task.createdAt = new Date().toISOString();
  list.unshift(task);
  saveTasks(list);
  return task;
}
function updateTaskRecord(id, patch) {
  const list = getTasks();
  const idx = list.findIndex((t) => t.id === id);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...patch };
    saveTasks(list);
  }
  return list[idx];
}
function deleteTaskRecord(id) {
  saveTasks(getTasks().filter((t) => t.id !== id));
}
function getTask(id) {
  return getTasks().find((t) => t.id === id);
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
      getTasks()
        .map((t) => t.assignee)
        .filter(Boolean),
    ),
  ];
}
// Deals aren't stored via a shared app.js helper, so read directly.
function dealNames() {
  const raw = localStorage.getItem("crm_deals");
  const list = raw ? JSON.parse(raw) : [];
  return list.map((d) => d.name).filter(Boolean);
}
function relatedOptionsForType(type) {
  switch (type) {
    case "Customer":
      return getCustomers().map((c) => c.name);
    case "Lead":
      return getLeads().map((l) => l.name);
    case "Account":
      return getAccounts().map((a) => a.name);
    case "Deal":
      return dealNames();
    default:
      return [];
  }
}

// ---------------------------------------------------------------
// Filters
// ---------------------------------------------------------------
function getFilteredTasks() {
  const q = (document.getElementById("searchInput").value || "")
    .toLowerCase()
    .trim();
  const status = document.getElementById("filterStatus").value;
  const priority = document.getElementById("filterPriority").value;
  const assignee = document.getElementById("filterAssignee").value;
  const dueBy = document.getElementById("filterDueDate").value;

  return getTasks().filter((t) => {
    if (q) {
      const hay =
        `${t.title} ${t.assignee || ""} ${t.relatedName || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (status !== "all" && t.status !== status) return false;
    if (priority !== "all" && t.priority !== priority) return false;
    if (assignee !== "all" && t.assignee !== assignee) return false;
    if (dueBy && t.dueDate && t.dueDate > dueBy) return false;
    return true;
  });
}

// ---------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------
function renderKpis() {
  const tasks = getTasks();
  const today = todayStr();
  const dueToday = tasks.filter(
    (t) => t.dueDate === today && t.status !== "Done",
  );
  const overdue = tasks.filter(
    (t) => t.dueDate && t.dueDate < today && t.status !== "Done",
  );
  const completed = tasks.filter((t) => t.status === "Done");

  const cards = [
    { label: "Total Tasks", value: tasks.length, cls: "" },
    { label: "Due Today", value: dueToday.length, cls: "info" },
    { label: "Overdue", value: overdue.length, cls: "warning" },
    { label: "Completed", value: completed.length, cls: "success" },
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
  const tasks = getFilteredTasks();
  const board = document.getElementById("kanbanView");

  board.innerHTML = STATUSES.map((status) => {
    const statusTasks = tasks
      .filter((t) => t.status === status)
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

    const cardsHtml = statusTasks.length
      ? statusTasks.map((t) => taskCardHtml(t)).join("")
      : `<div class="kanban-col-empty">No tasks</div>`;

    return `
      <div class="kanban-col" data-status="${status}">
        <div class="kanban-col-head">
          <div class="kanban-col-head-title">
            <span class="kanban-dot" style="background:${STATUS_DOT[status]}"></span>
            <h4>${status}</h4>
          </div>
          <span class="kanban-count">${statusTasks.length}</span>
        </div>
        <div class="kanban-col-body" data-drop-status="${status}">
          ${cardsHtml}
        </div>
      </div>`;
  }).join("");

  attachDragEvents();
}

function taskCardHtml(t) {
  const overdue = t.dueDate && t.status !== "Done" && t.dueDate < todayStr();
  return `
    <div class="task-card ${t.status === "Done" ? "is-done" : ""}" draggable="true" data-id="${t.id}">
      <div class="task-card__top">
        <div class="task-card__title">${escapeHtml(t.title)}</div>
        <span class="badge ${PRIORITY_BADGE_CLASS[t.priority]}">${t.priority}</span>
      </div>
      ${
        t.relatedName
          ? `<div class="task-card__related"><i class="fa-solid fa-link"></i> ${escapeHtml(t.relatedType)}: ${escapeHtml(t.relatedName)}</div>`
          : ""
      }
      <div class="task-card__foot">
        <div class="task-card__assignee">
          <span class="task-card__avatar">${initials(t.assignee)}</span>
          ${escapeHtml((t.assignee || "").split(" ")[0] || "Unassigned")}
        </div>
        <div class="task-card__date ${overdue ? "overdue" : ""}">
          ${overdue ? '<i class="fa-solid fa-triangle-exclamation"></i> ' : ""}${formatDate(t.dueDate)}
        </div>
      </div>
    </div>`;
}

function attachDragEvents() {
  document.querySelectorAll(".task-card").forEach((card) => {
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
      const task = getTask(draggingId);
      if (!task || task.status === newStatus) return;
      updateTaskRecord(draggingId, { status: newStatus });
      showToast(`Moved "${task.title}" to ${newStatus}`, "success");
      renderAll();
    });
  });
}

// ---------------------------------------------------------------
// Table view
// ---------------------------------------------------------------
function renderTable() {
  const tasks = getFilteredTasks();
  const wrap = document.getElementById("tasksTable");

  if (!tasks.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-list-check"></i>
        <div>No tasks match your filters.</div>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Task</th>
          <th>Agents</th>
          <th>Priority</th>
          <th>Status</th>
          <th>Due Date</th>
          <th>Related To</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${tasks
          .map(
            (t) => `
          <tr data-id="${t.id}">
            <td><strong>${escapeHtml(t.title)}</strong></td>
            <td>${escapeHtml(t.assignee || "—")}</td>
            <td><span class="badge ${PRIORITY_BADGE_CLASS[t.priority]}">${t.priority}</span></td>
            <td><span class="badge ${STATUS_BADGE_CLASS[t.status]}">${t.status}</span></td>
            <td>${formatDate(t.dueDate)}</td>
            <td>${t.relatedName ? `${escapeHtml(t.relatedType)}: ${escapeHtml(t.relatedName)}` : "—"}</td>
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
    labelEl.textContent = "Select assignee";
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
function populateRelatedOptions(type) {
  document.getElementById("relatedOptions").innerHTML = relatedOptionsForType(
    type,
  )
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

// ---------------------------------------------------------------
// Modal — add / edit
// ---------------------------------------------------------------
function openModal(id) {
  const overlay = document.getElementById("modalOverlay");
  const form = document.getElementById("taskForm");
  form.reset();
  closeAssigneeMenu();
  populateRelatedOptions(document.getElementById("fRelatedType").value);

  const deleteBtn = document.getElementById("deleteBtn");

  if (id) {
    const task = getTask(id);
    if (!task) return;
    document.getElementById("modalTitle").textContent = "Edit Task";
    document.getElementById("editId").value = task.id;
    document.getElementById("fTitle").value = task.title;
    document.getElementById("fDescription").value = task.description || "";
    const agent = getAgents().find((a) => a.name === task.assignee);
    setAssigneeValue(task.assignee || "", agent ? agent.role : "");
    document.getElementById("fDueDate").value = task.dueDate || "";
    document.getElementById("fPriority").value = task.priority;
    document.getElementById("fStatus").value = task.status;
    document.getElementById("fRelatedType").value = task.relatedType || "";
    populateRelatedOptions(task.relatedType || "");
    document.getElementById("fRelatedName").value = task.relatedName || "";
    deleteBtn.style.display = "inline-flex";
  } else {
    document.getElementById("modalTitle").textContent = "New Task";
    document.getElementById("editId").value = "";
    setAssigneeValue("", "");
    document.getElementById("fPriority").value = "Medium";
    document.getElementById("fStatus").value = "To Do";
    deleteBtn.style.display = "none";
  }

  overlay.classList.add("open");
}
function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
}

function confirmDelete(id) {
  const task = getTask(id);
  if (!task) return;
  if (confirm(`Delete "${task.title}"? This can't be undone.`)) {
    deleteTaskRecord(id);
    showToast("Task deleted", "success");
    renderAll();
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
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
initSidebarToggle();
renderAll();

// Search & filters
[
  "searchInput",
  "filterStatus",
  "filterPriority",
  "filterAssignee",
  "filterDueDate",
].forEach((id) => {
  document.getElementById(id).addEventListener("input", () => {
    currentView === "kanban" ? renderKanban() : renderTable();
  });
});
document.getElementById("clearFiltersBtn").addEventListener("click", () => {
  document.getElementById("searchInput").value = "";
  document.getElementById("filterStatus").value = "all";
  document.getElementById("filterPriority").value = "all";
  document.getElementById("filterAssignee").value = "all";
  document.getElementById("filterDueDate").value = "";
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

// Modal open/close
document
  .getElementById("addBtn")
  .addEventListener("click", () => openModal(null));
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
document.getElementById("modalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});

// Related type change -> refresh related record suggestions
document.getElementById("fRelatedType").addEventListener("change", (e) => {
  populateRelatedOptions(e.target.value);
  document.getElementById("fRelatedName").value = "";
  document.getElementById("fRelatedName").placeholder = e.target.value
    ? `Select a ${e.target.value.toLowerCase()}...`
    : "Select a type first";
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
document.getElementById("taskForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("editId").value;
  const payload = {
    title: document.getElementById("fTitle").value.trim(),
    description: document.getElementById("fDescription").value.trim(),
    assignee: document.getElementById("fAssignee").value,
    dueDate: document.getElementById("fDueDate").value,
    priority: document.getElementById("fPriority").value,
    status: document.getElementById("fStatus").value,
    relatedType: document.getElementById("fRelatedType").value,
    relatedName: document.getElementById("fRelatedName").value.trim(),
  };

  if (!payload.title || !payload.assignee || !payload.dueDate) {
    showToast("Please fill in all required fields", "error");
    return;
  }
  if (!payload.relatedType) payload.relatedName = "";

  if (id) {
    updateTaskRecord(id, payload);
    showToast("Task updated", "success");
  } else {
    addTask(payload);
    showToast("Task created", "success");
  }
  closeModal();
  renderAll();
});

// ---------------------------------------------------------------
// Deep link support: Dashboard's "New Task" / "+ New" quick actions
// land here with ?new=1 — auto-open the New Task modal, then clean
// the URL so refreshing the page doesn't reopen it.
// ---------------------------------------------------------------
(function handleQuickAddDeepLink() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("new") === "1") {
    openModal(null);
    window.history.replaceState({}, "", window.location.pathname);
  }
})();