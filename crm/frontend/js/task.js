/**
 * task.js — Tasks module (Kanban + Table)
 * Tasks live on the CRM backend (getTasks / saveTask / removeTask in app.js).
 * Reuses shared helpers from app.js (getAgents, getCustomers, getLeads,
 * getAccounts, showToast, renderSidebarUser, initSidebarToggle, requireAuth).
 */

requireAuth();
renderSidebarUser();

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
// What a task is linked to: the server keeps the English type, the page shows the word.
const RELATED_KEYS = { Customer: "orders.customer", Lead: "dash.add.lead", Account: "deals.col.account", Deal: "dash.add.deal" };
const relatedLabel = (type) => (RELATED_KEYS[type] ? crmI18n.t(RELATED_KEYS[type]) : type);

let currentView = "kanban";
let draggingId = null;

function getTask(id) {
  return getTasks().find((t) => String(t.id) === String(id));
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
      getTasks()
        .map((t) => t.assignee)
        .filter(Boolean),
    ),
  ];
}
function dealNames() {
  return getDeals().map((d) => d.name).filter(Boolean);
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
    { label: crmI18n.t("tasks.kpi.total"), value: tasks.length, cls: "" },
    { label: crmI18n.t("tasks.kpi.dueToday"), value: dueToday.length, cls: "info" },
    { label: crmI18n.t("dash.overdue"), value: overdue.length, cls: "warning" },
    { label: crmI18n.t("tasks.kpi.completed"), value: completed.length, cls: "success" },
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
  const tasks = getFilteredTasks();
  const board = document.getElementById("kanbanView");

  board.innerHTML = STATUSES.map((status) => {
    const statusTasks = tasks
      .filter((t) => t.status === status)
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

    const cardsHtml = statusTasks.length
      ? statusTasks.map((t) => taskCardHtml(t)).join("")
      : `<div class="kanban-col-empty">${escapeHtml(crmI18n.t("tasks.noTasks"))}</div>`;

    return `
      <div class="kanban-col" data-status="${status}">
        <div class="kanban-col-head">
          <div class="kanban-col-head-title">
            <span class="kanban-dot" style="background:${STATUS_DOT[status]}"></span>
            <h4>${escapeHtml(crmLabel("taskStatus", status))}</h4>
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
        <span class="badge ${PRIORITY_BADGE_CLASS[t.priority]}">${escapeHtml(crmLabel("priority", t.priority))}</span>
      </div>
      ${
        t.relatedName
          ? `<div class="task-card__related"><i class="fa-solid fa-link"></i> ${escapeHtml(relatedLabel(t.relatedType))}: ${escapeHtml(t.relatedName)}</div>`
          : ""
      }
      <div class="task-card__foot">
        <div class="task-card__assignee">
          <span class="task-card__avatar">${initials(t.assignee)}</span>
          ${escapeHtml((t.assignee || "").split(" ")[0] || crmI18n.t("dash.unassigned"))}
        </div>
        <div class="task-card__date ${overdue ? "overdue" : ""}">
          ${overdue ? '<i class="fa-solid fa-triangle-exclamation"></i> ' : ""}${formatDate(t.dueDate)}
        </div>
      </div>
      ${kanbanMoveButton(t.id)}
    </div>`;
}

// A task to another status: dropped on a column, or picked in "Move to…" on a touch screen (R2).
function moveTask(id, newStatus) {
  const task = getTask(id);
  if (!task || task.status === newStatus) return;
  saveTask(task.id, { status: newStatus })
    .then(() => showToast(crmI18n.t("deals.moved", { name: task.title, stage: crmLabel("taskStatus", newStatus) }), "success"))
    .catch((error) => showToast(apiErrorMessage(error, crmI18n.t("tasks.err.move")), "error"))
    .finally(renderAll);
}

function attachDragEvents() {
  document.querySelectorAll(".task-card").forEach((card) => {
    card.addEventListener("click", () => openModal(card.dataset.id));
    card.querySelector(".kanban-move")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const task = getTask(card.dataset.id);
      if (!task) return;
      const status = await crmMoveMenu.open({
        title: crmI18n.t("deals.moveTo", { name: task.title }), current: task.status, returnFocus: event.currentTarget,
        options: STATUSES.map((s) => ({ value: s, label: crmLabel("taskStatus", s), color: STATUS_DOT[s] })),
      });
      if (status) moveTask(task.id, status);
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
      moveTask(draggingId, col.dataset.status);
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
        <div>${escapeHtml(crmI18n.t("tasks.empty.filtered"))}</div>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>${escapeHtml(crmI18n.t("dash.add.task"))}</th>
          <th>${escapeHtml(crmI18n.t("tasks.agents"))}</th>
          <th>${escapeHtml(crmI18n.t("tasks.priority"))}</th>
          <th>${escapeHtml(crmI18n.t("col.status"))}</th>
          <th>${escapeHtml(crmI18n.t("tasks.due-date"))}</th>
          <th>${escapeHtml(crmI18n.t("tasks.related-to"))}</th>
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
            <td><span class="badge ${PRIORITY_BADGE_CLASS[t.priority]}">${escapeHtml(crmLabel("priority", t.priority))}</span></td>
            <td><span class="badge ${STATUS_BADGE_CLASS[t.status]}">${escapeHtml(crmLabel("taskStatus", t.status))}</span></td>
            <td>${formatDate(t.dueDate)}</td>
            <td>${t.relatedName ? `${escapeHtml(relatedLabel(t.relatedType))}: ${escapeHtml(t.relatedName)}` : "—"}</td>
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
    labelEl.textContent = crmI18n.t("tasks.select-assignee");
    labelEl.classList.add("is-placeholder");
  }
}

function buildAssigneeMenu() {
  const menu = document.getElementById("assigneeMenu");
  const agents = getAgents();
  const selected = document.getElementById("fAssignee").value;

  if (!agents.length) {
    const link = `<a href="accounts.html">${escapeHtml(t("nav.accounts"))}</a>`;
    menu.innerHTML = `<div class="assignee-picker__empty">${t("tasks.noAgents", { link })}</div>`;
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

function populateFilterAssignee() {
  const sel = document.getElementById("filterAssignee");
  const current = sel.value;
  sel.innerHTML =
    `<option value="all">${escapeHtml(t("tasks.all-agents"))}</option>` +
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
    document.getElementById("modalTitle").textContent = t("tasks.edit");
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
    document.getElementById("modalTitle").textContent = t("tasks.new-task");
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
  if (confirm(t("deals.confirmDelete", { name: task.title }))) {
    removeTask(id).catch((error) => showToast(apiErrorMessage(error, t("deals.err.deleteTask")), "error")).finally(renderAll);
    showToast(t("tasks.deleted"), "success");
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
crmReady(["tasks", "leads", "contacts", "members"], () => {
  renderAll();
  handleQuickAddDeepLink();
  openFromAddress((id) => {
    if (!getTasks().some((t) => t.id === id)) return false;
    openModal(id);
  });
});

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
  document.getElementById("fRelatedName").placeholder = t(e.target.value ? `tasks.select.${e.target.value}` : "tasks.select-a-type-first");
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
document.getElementById("taskForm").addEventListener("submit", async (e) => {
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
    showToast(t("deals.required"), "error");
    return;
  }
  if (!payload.relatedType) payload.relatedName = "";

  try {
    await saveTask(id || null, payload);
    showToast(t(id ? "tasks.updated" : "tasks.created"), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, t("tasks.err.save")), "error");
    return;
  }
  closeModal();
  renderAll();
});

// ---------------------------------------------------------------
// Deep link support: Dashboard's "New Task" / "+ New" quick actions
// land here with ?new=1 — auto-open the New Task modal, then clean
// the URL so refreshing the page doesn't reopen it.
// ---------------------------------------------------------------
// Runs after the team and records are loaded (the modal lists them).
function handleQuickAddDeepLink() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("new") === "1") {
    openModal(null);
    window.history.replaceState({}, "", window.location.pathname);
  }
}