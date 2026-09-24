/**
 * deals.js — Deals module (Kanban + Table pipeline)
 * Persists to localStorage under 'crm_deals' and 'crm_deal_tasks'.
 * Reuses shared helpers from app.js (getAgents, getAccounts, getCustomers,
 * showToast, renderSidebarUser, initSidebarToggle, requireAuth).
 */

const DEALS_KEY = "crm_deals";
const DEAL_TASKS_KEY = "crm_deal_tasks";

const STAGES = ["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"];
const DEFAULT_VISIBLE_STAGES = ["Lead", "Won"];
const STAGE_DEFAULT_PROB = {
  Lead: 10,
  Qualified: 25,
  Proposal: 50,
  Negotiation: 75,
  Won: 100,
  Lost: 0,
};
const STAGE_DOT = {
  Lead: "var(--info)",
  Qualified: "var(--brand-darker)",
  Proposal: "var(--warning)",
  Negotiation: "#7c3aed",
  Won: "var(--success)",
  Lost: "var(--danger)",
};
const STAGE_BADGE_CLASS = {
  Lead: "badge-stage-lead",
  Qualified: "badge-stage-qualified",
  Proposal: "badge-stage-proposal",
  Negotiation: "badge-stage-negotiation",
  Won: "badge-stage-won",
  Lost: "badge-stage-lost",
};

let currentView = "kanban";
let draggingId = null;
let selectedStage = null;
// ---------------------------------------------------------------
// Storage
// ---------------------------------------------------------------
function getDeals() {
  const raw = localStorage.getItem(DEALS_KEY);
  return raw ? JSON.parse(raw) : [];
}
function saveDeals(list) {
  localStorage.setItem(DEALS_KEY, JSON.stringify(list));
}
function addDeal(deal) {
  const list = getDeals();
  deal.id =
    "d_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  deal.createdAt = new Date().toISOString();
  deal.notes = [];
  list.unshift(deal);
  saveDeals(list);
  return deal;
}
function updateDeal(id, patch) {
  const list = getDeals();
  const idx = list.findIndex((d) => d.id === id);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...patch };
    saveDeals(list);
  }
  return list[idx];
}
function deleteDeal(id) {
  saveDeals(getDeals().filter((d) => d.id !== id));
}
function getDeal(id) {
  return getDeals().find((d) => d.id === id);
}

function getDealTasks() {
  const raw = localStorage.getItem(DEAL_TASKS_KEY);
  return raw ? JSON.parse(raw) : [];
}
function saveDealTasks(list) {
  localStorage.setItem(DEAL_TASKS_KEY, JSON.stringify(list));
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function formatCurrency(n) {
  const num = Number(n) || 0;
  return "₹" + num.toLocaleString("en-IN");
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
function ownerNames() {
  return getAgents().map((a) => a.name);
}
function accountNames() {
  return getAccounts()
    .map((a) => a.name)
    .filter(Boolean);
}
function contactNames() {
  return getCustomers()
    .map((c) => c.name)
    .filter(Boolean);
}

// ---------------------------------------------------------------
// Filters
// ---------------------------------------------------------------
function getFilteredDeals() {
  const q = (document.getElementById("searchInput").value || "")
    .toLowerCase()
    .trim();
  const stage = document.getElementById("filterStage").value;
  const owner = document.getElementById("filterOwner").value;
  const min = parseFloat(document.getElementById("filterMinValue").value);
  const max = parseFloat(document.getElementById("filterMaxValue").value);
  const closeBy = document.getElementById("filterCloseDate").value;

  return getDeals().filter((d) => {
    if (q) {
      const hay =
        `${d.name} ${d.account} ${d.owner} ${d.contact || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (stage !== "all" && d.stage !== stage) return false;
    if (owner !== "all" && d.owner !== owner) return false;
    if (!isNaN(min) && d.value < min) return false;
    if (!isNaN(max) && d.value > max) return false;
    if (closeBy && d.closeDate && d.closeDate > closeBy) return false;
    return true;
  });
}

// ---------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------
function renderKpis() {
  const deals = getDeals();
  const open = deals.filter((d) => d.stage !== "Won" && d.stage !== "Lost");
  const pipelineValue = open.reduce((sum, d) => sum + Number(d.value || 0), 0);

  const now = new Date();
  const wonThisMonth = deals.filter((d) => {
    if (d.stage !== "Won" || !d.closeDate) return false;
    const c = new Date(d.closeDate);
    return (
      c.getMonth() === now.getMonth() && c.getFullYear() === now.getFullYear()
    );
  });
  const wonValue = wonThisMonth.reduce(
    (sum, d) => sum + Number(d.value || 0),
    0,
  );

  const cards = [
    { label: "Total Deals", value: deals.length, cls: "" },
    {
      label: "Total Pipeline Value",
      value: formatCurrency(pipelineValue),
      cls: "info",
    },
    {
      label: "Won This Month",
      value: `${wonThisMonth.length} · ${formatCurrency(wonValue)}`,
      cls: "success",
    },
    { label: "Deals in Progress", value: open.length, cls: "warning" },
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
  const deals = getFilteredDeals();
  const board = document.getElementById("kanbanView");

  const visibleStages = selectedStage
    ? [selectedStage]
    : DEFAULT_VISIBLE_STAGES;
  board.innerHTML = visibleStages
    .map((stage) => {
      const stageDeals = deals.filter((d) => d.stage === stage);
      const total = stageDeals.reduce(
        (sum, d) => sum + Number(d.value || 0),
        0,
      );

      const cardsHtml = stageDeals.length
        ? stageDeals.map((d) => dealCardHtml(d)).join("")
        : `<div class="kanban-col-empty">No deals</div>`;

      return `
      <div class="kanban-col" data-stage="${stage}">
        <div class="kanban-col-head">
          <div class="kanban-col-head-title">
            <span class="kanban-dot" style="background:${STAGE_DOT[stage]}"></span>
            <h4>${stage}</h4>
          </div>
          <span class="kanban-count">${stageDeals.length}</span>
        </div>
        <div class="kanban-col-value">${formatCurrency(total)}</div>
        <div class="kanban-col-body" data-drop-stage="${stage}">
          ${cardsHtml}
        </div>
      </div>`;
    })
    .join("");

  attachDragEvents();
}

// ---------------------------------------------------------------
// Kanban stage filter buttons (nav-bar-kanban-card)
// ---------------------------------------------------------------
function initKanbanStageButtons() {
  const buttons = document.querySelectorAll(".nav-bar-kanban-card button");
  buttons.forEach((btn) => {
    const stage = btn.dataset.stage;
    if (!stage) return;
    btn.addEventListener("click", () => {
      selectedStage = selectedStage === stage ? null : stage;
      buttons.forEach((button) => {
        button.classList.toggle("active", button.dataset.stage === selectedStage);
      });
      if (currentView === "kanban") renderKanban();
    });
  });
}

function dealCardHtml(d) {
  const overdue =
    d.closeDate &&
    d.stage !== "Won" &&
    d.stage !== "Lost" &&
    d.closeDate < todayStr();
  return `
    <div class="deal-card" draggable="true" data-id="${d.id}">
      <div class="deal-card__name">${escapeHtml(d.name)}</div>
      <div class="deal-card__account"><i class="fa-solid fa-building"></i> ${escapeHtml(d.account)}</div>
      <div class="deal-card__value">${formatCurrency(d.value)}</div>
      <div class="deal-card__prob-track">
        <div class="deal-card__prob-fill" style="width:${d.probability}%"></div>
      </div>
      <div class="deal-card__foot">
        <div class="deal-card__owner">
          <span class="deal-card__owner-avatar">${initials(d.owner)}</span>
          ${escapeHtml((d.owner || "").split(" ")[0] || "")}
        </div>
        <div class="deal-card__date ${overdue ? "overdue" : ""}">
          ${overdue ? '<i class="fa-solid fa-triangle-exclamation"></i> ' : ""}${formatDate(d.closeDate)}
        </div>
      </div>
    </div>`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function attachDragEvents() {
  document.querySelectorAll(".deal-card").forEach((card) => {
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
      const newStage = col.dataset.stage;
      const deal = getDeal(draggingId);
      if (!deal || deal.stage === newStage) return;
      updateDeal(draggingId, {
        stage: newStage,
        probability: STAGE_DEFAULT_PROB[newStage],
      });
      if (newStage === "Won") {
        const customerId = ensureWonCustomer({ ...deal, stage: newStage }, "deal");
        updateDeal(draggingId, { convertedCustomerId: customerId });
      }
      showToast(`Moved "${deal.name}" to ${newStage}`, "success");
      renderAll();
    });
  });
}

// ---------------------------------------------------------------
// Table view
// ---------------------------------------------------------------
function renderTable() {
  const deals = getFilteredDeals();
  const wrap = document.getElementById("dealsTable");

  if (!deals.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-handshake"></i>
        <div>No deals match your filters.</div>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Deal</th>
          <th>Account</th>
          <th>Value</th>
          <th>Stage</th>
          <th>Probability</th>
          <th>Close Date</th>
          <th>Owner</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${deals
          .map(
            (d) => `
          <tr data-id="${d.id}">
            <td><strong>${escapeHtml(d.name)}</strong></td>
            <td>${escapeHtml(d.account)}</td>
            <td>${formatCurrency(d.value)}</td>
            <td><span class="badge ${STAGE_BADGE_CLASS[d.stage]}">${d.stage}</span></td>
            <td>${d.probability}%</td>
            <td>${formatDate(d.closeDate)}</td>
            <td>${escapeHtml(d.owner)}</td>
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-row" data-id="${d.id}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-row" data-id="${d.id}"><i class="fa-solid fa-trash"></i></button>
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
// Right panel — Team
// ---------------------------------------------------------------
function renderTeamTab() {
  const deals = getDeals();
  const agents = getAgents();
  const names = agents.length
    ? agents.map((a) => a.name)
    : [...new Set(deals.map((d) => d.owner))];

  const el = document.getElementById("teamTabContent");
  if (!names.length) {
    el.innerHTML = `<div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-user-group"></i><div>No agents yet.</div></div>`;
    return;
  }

  el.innerHTML = names
    .map((name) => {
      const agent = agents.find((a) => a.name === name);
      const count = deals.filter((d) => d.owner === name).length;
      const value = deals
        .filter(
          (d) => d.owner === name && d.stage !== "Won" && d.stage !== "Lost",
        )
        .reduce((sum, d) => sum + Number(d.value || 0), 0);
      return `
        <div class="team-member-row">
          <div class="avatar">${initials(name)}</div>
          <div class="info">
            <div class="name">${escapeHtml(name)}</div>
            <div class="sub">${agent ? escapeHtml(agent.role) : "Deal Owner"} · ${formatCurrency(value)} open</div>
          </div>
          <span class="count">${count}</span>
        </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Right panel — Tasks
// ---------------------------------------------------------------
function renderTasksTab() {
  const tasks = getDealTasks();
  const el = document.getElementById("tasksTabContent");

  const list = tasks.length
    ? tasks
        .map(
          (t) => `
      <div class="task-row ${t.done ? "done" : ""}">
        <input type="checkbox" data-id="${t.id}" class="task-toggle" ${t.done ? "checked" : ""} />
        <div class="task-text">
          ${escapeHtml(t.text)}
          ${t.due ? `<span class="task-due"><i class="fa-regular fa-clock"></i> ${formatDate(t.due)}</span>` : ""}
        </div>
        <button class="icon-btn danger task-delete" data-id="${t.id}"><i class="fa-solid fa-xmark"></i></button>
      </div>`,
        )
        .join("")
    : `<div class="empty-state" style="padding:20px 10px"><i class="fa-solid fa-list-check"></i><div>No tasks yet.</div></div>`;

  el.innerHTML = `
    ${list}
    <div class="task-add-row">
      <input type="text" id="newTaskInput" placeholder="Add a follow-up task..." />
      <button class="btn btn-outline" id="addTaskBtn"><i class="fa-solid fa-plus"></i></button>
    </div>`;

  el.querySelectorAll(".task-toggle").forEach((cb) =>
    cb.addEventListener("change", () => {
      const list = getDealTasks();
      const t = list.find((x) => x.id === cb.dataset.id);
      if (t) {
        t.done = cb.checked;
        saveDealTasks(list);
        renderTasksTab();
      }
    }),
  );
  el.querySelectorAll(".task-delete").forEach((btn) =>
    btn.addEventListener("click", () => {
      saveDealTasks(getDealTasks().filter((x) => x.id !== btn.dataset.id));
      renderTasksTab();
    }),
  );
  document
    .getElementById("addTaskBtn")
    .addEventListener("click", addTaskFromInput);
  document.getElementById("newTaskInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTaskFromInput();
  });
}

function addTaskFromInput() {
  const input = document.getElementById("newTaskInput");
  const text = input.value.trim();
  if (!text) return;
  const list = getDealTasks();
  list.unshift({
    id: "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text,
    done: false,
    due: null,
  });
  saveDealTasks(list);
  input.value = "";
  renderTasksTab();
}

// ---------------------------------------------------------------
// Right panel — Calendar
// ---------------------------------------------------------------
function renderCalendarTab() {
  const deals = getDeals()
    .filter((d) => d.stage !== "Won" && d.stage !== "Lost" && d.closeDate)
    .sort((a, b) => (a.closeDate > b.closeDate ? 1 : -1))
    .slice(0, 10);

  const el = document.getElementById("calendarTabContent");
  if (!deals.length) {
    el.innerHTML = `<div class="empty-state" style="padding:20px 10px"><i class="fa-solid fa-calendar-days"></i><div>No upcoming close dates.</div></div>`;
    return;
  }

  el.innerHTML = deals
    .map((d) => {
      const dt = new Date(d.closeDate);
      return `
      <div class="calendar-row">
        <div class="calendar-date-chip">
          <span class="d">${dt.getDate()}</span>
          <span class="m">${dt.toLocaleDateString("en-IN", { month: "short" })}</span>
        </div>
        <div class="info">
          <div class="name">${escapeHtml(d.name)}</div>
          <div class="sub">${escapeHtml(d.account)} · ${d.stage}</div>
        </div>
      </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Modal — add / edit
// ---------------------------------------------------------------
function populateOwnerSelect() {
  const sel = document.getElementById("fOwner");
  const owners = ownerNames();
  sel.innerHTML = owners.length
    ? owners
        .map(
          (n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`,
        )
        .join("")
    : `<option value="" disabled selected>Add an agent first (Account Champions)</option>`;
}
function populateFilterOwners() {
  const sel = document.getElementById("filterOwner");
  const current = sel.value;
  sel.innerHTML =
    `<option value="all">All Owners</option>` +
    ownerNames()
      .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
      .join("");
  sel.value = current || "all";
}
function populateDatalists() {
  document.getElementById("accountOptions").innerHTML = accountNames()
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
  document.getElementById("contactOptions").innerHTML = contactNames()
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

function openModal(id) {
  const overlay = document.getElementById("modalOverlay");
  const form = document.getElementById("dealForm");
  form.reset();
  populateOwnerSelect();
  populateDatalists();

  const deleteBtn = document.getElementById("deleteBtn");
  const timelineSection = document.getElementById("timelineSection");

  if (id) {
    const deal = getDeal(id);
    if (!deal) return;
    document.getElementById("modalTitle").textContent = "Edit Deal";
    document.getElementById("editId").value = deal.id;
    document.getElementById("fName").value = deal.name;
    document.getElementById("fAccount").value = deal.account;
    document.getElementById("fContact").value = deal.contact || "";
    document.getElementById("fValue").value = deal.value;
    document.getElementById("fCloseDate").value = deal.closeDate || "";
    document.getElementById("fStage").value = deal.stage;
    document.getElementById("fOwner").value = deal.owner;
    document.getElementById("fProbability").value = deal.probability;
    document.getElementById("fProbabilityValue").textContent =
      `${deal.probability}%`;
    deleteBtn.style.display = "inline-flex";
    timelineSection.style.display = "block";
    renderTimeline(deal);
  } else {
    document.getElementById("modalTitle").textContent = "New Deal";
    document.getElementById("editId").value = "";
    document.getElementById("fStage").value = "Lead";
    document.getElementById("fProbability").value = STAGE_DEFAULT_PROB["Lead"];
    document.getElementById("fProbabilityValue").textContent =
      `${STAGE_DEFAULT_PROB["Lead"]}%`;
    deleteBtn.style.display = "none";
    timelineSection.style.display = "none";
  }

  overlay.classList.add("open");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
}

function renderTimeline(deal) {
  const el = document.getElementById("timelineList");
  const notes = deal.notes || [];
  el.innerHTML = notes.length
    ? notes
        .slice()
        .reverse()
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
    : `<div class="text-muted" style="font-size:12.5px">No activity yet.</div>`;
}

function addNoteToDeal() {
  const id = document.getElementById("editId").value;
  if (!id) return;
  const input = document.getElementById("noteInput");
  const text = input.value.trim();
  if (!text) return;
  const deal = getDeal(id);
  const notes = deal.notes || [];
  notes.push({
    text,
    at: new Date().toISOString(),
    author: getCurrentUser()?.name || "You",
  });
  const updated = updateDeal(id, { notes });
  input.value = "";
  renderTimeline(updated);
  showToast("Note added", "success");
}

function confirmDelete(id) {
  const deal = getDeal(id);
  if (!deal) return;
  if (confirm(`Delete "${deal.name}"? This can't be undone.`)) {
    deleteDeal(id);
    showToast("Deal deleted", "success");
    renderAll();
  }
}

// ---------------------------------------------------------------
// Full render
// ---------------------------------------------------------------
function renderAll() {
  renderKpis();
  populateFilterOwners();
  if (currentView === "kanban") {
    renderKanban();
  } else {
    renderTable();
  }
  renderTeamTab();
  renderTasksTab();
  renderCalendarTab();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  requireAuth();
  renderSidebarUser();
  initSidebarToggle();

  // One-time cleanup: earlier versions of this file auto-seeded demo deals
  // into localStorage. This runs once to wipe any leftover demo data, then
  // never touches crm_deals again.
  if (!localStorage.getItem("crm_deals_demo_cleared")) {
    localStorage.removeItem(DEALS_KEY);
    localStorage.setItem("crm_deals_demo_cleared", "1");
  }

  renderAll();
  initKanbanStageButtons();

  // Search & filters
  [
    "searchInput",
    "filterStage",
    "filterOwner",
    "filterMinValue",
    "filterMaxValue",
    "filterCloseDate",
  ].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => {
      currentView === "kanban" ? renderKanban() : renderTable();
    });
  });
  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    document.getElementById("searchInput").value = "";
    document.getElementById("filterStage").value = "all";
    document.getElementById("filterOwner").value = "all";
    document.getElementById("filterMinValue").value = "";
    document.getElementById("filterMaxValue").value = "";
    document.getElementById("filterCloseDate").value = "";
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

  // Probability slider live value
  document.getElementById("fProbability").addEventListener("input", (e) => {
    document.getElementById("fProbabilityValue").textContent =
      `${e.target.value}%`;
  });
  // Stage change suggests a default probability
  document.getElementById("fStage").addEventListener("change", (e) => {
    const suggested = STAGE_DEFAULT_PROB[e.target.value];
    document.getElementById("fProbability").value = suggested;
    document.getElementById("fProbabilityValue").textContent = `${suggested}%`;
  });

  // Notes
  document
    .getElementById("addNoteBtn")
    .addEventListener("click", addNoteToDeal);
  document.getElementById("noteInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addNoteToDeal();
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
  document.getElementById("dealForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("editId").value;
    const payload = {
      name: document.getElementById("fName").value.trim(),
      account: document.getElementById("fAccount").value.trim(),
      contact: document.getElementById("fContact").value.trim(),
      value: parseFloat(document.getElementById("fValue").value) || 0,
      closeDate: document.getElementById("fCloseDate").value,
      stage: document.getElementById("fStage").value,
      owner: document.getElementById("fOwner").value,
      probability: parseInt(document.getElementById("fProbability").value, 10),
    };

    if (!payload.name || !payload.account || !payload.closeDate) {
      showToast("Please fill in all required fields", "error");
      return;
    }

    if (id) {
      const existingDeal = getDeal(id);
      updateDeal(id, payload);
      if (existingDeal?.stage !== "Won" && payload.stage === "Won") {
        const customerId = ensureWonCustomer({ ...existingDeal, ...payload }, "deal");
        updateDeal(id, { convertedCustomerId: customerId });
      }
      showToast("Deal updated", "success");
    } else {
      addDeal(payload);
      showToast("Deal created", "success");
    }
    closeModal();
    renderAll();
  });

  // Deep link support: Dashboard's "New Deal" / "+ New" quick actions land
  // here with ?new=1 — auto-open the New Deal modal, then clean the URL
  // so refreshing the page doesn't reopen it.
  const params = new URLSearchParams(window.location.search);
  if (params.get("new") === "1") {
    openModal(null);
    window.history.replaceState({}, "", window.location.pathname);
  }
});