/**
 * automation.js — Sales Automation module (Workflows + Sequences)
 * Persists to localStorage under 'crm_workflows' and 'crm_sequences'.
 * "Run Now" / "Enroll" actually create real rows in 'crm_tasks' so the
 * automation has a visible, tangible effect elsewhere in the CRM.
 * Reuses shared helpers from app.js (getAgents, showToast,
 * renderSidebarUser, initSidebarToggle, requireAuth, getCurrentUser).
 */

requireAuth();
renderSidebarUser();
initSidebarToggle();

const WORKFLOWS_KEY = "crm_workflows";
const SEQUENCES_KEY = "crm_sequences";
const TASKS_KEY = "crm_tasks";

const ACTION_TYPES = [
  "Create Task",
  "Send Email (simulated)",
  "Notify Agent",
  "Update Status",
  "Add to Sequence",
];
const STEP_TYPES = ["Email", "Call", "Task", "Wait"];

let activeTab = "workflows"; // "workflows" | "sequences"

// ---------------------------------------------------------------
// Storage
// ---------------------------------------------------------------
function getWorkflows() {
  const raw = localStorage.getItem(WORKFLOWS_KEY);
  return raw ? JSON.parse(raw) : [];
}
function saveWorkflows(list) {
  localStorage.setItem(WORKFLOWS_KEY, JSON.stringify(list));
}
function getSequences() {
  const raw = localStorage.getItem(SEQUENCES_KEY);
  return raw ? JSON.parse(raw) : [];
}
function saveSequences(list) {
  localStorage.setItem(SEQUENCES_KEY, JSON.stringify(list));
}
function getTasksList() {
  const raw = localStorage.getItem(TASKS_KEY);
  return raw ? JSON.parse(raw) : [];
}
function saveTasksList(list) {
  localStorage.setItem(TASKS_KEY, JSON.stringify(list));
}
function pushTask(task) {
  const list = getTasksList();
  task.id =
    "tk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  task.createdAt = new Date().toISOString();
  list.unshift(task);
  saveTasksList(list);
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
function ownerNames() {
  return getAgents().map((a) => a.name);
}
function addDays(iso, days) {
  const d = iso ? new Date(iso) : new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function statusPillClass(status) {
  return "status-pill status-" + (status || "draft").toLowerCase();
}

// ---------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------
function renderKpis() {
  const workflows = getWorkflows();
  const sequences = getSequences();
  const activeWorkflows = workflows.filter((w) => w.status === "Active");
  const activeSequences = sequences.filter((s) => s.status === "Active");
  const totalRuns = workflows.reduce((s, w) => s + (w.runsCount || 0), 0);
  const totalEnrolled = sequences.reduce(
    (s, sq) => s + (sq.enrolledCount || 0),
    0,
  );

  const cards = [
    {
      label: "Active Workflows",
      value: activeWorkflows.length,
      cls: "success",
    },
    { label: "Active Sequences", value: activeSequences.length, cls: "info" },
    { label: "Actions Automated", value: totalRuns, cls: "warning" },
    { label: "Contacts Enrolled", value: totalEnrolled, cls: "" },
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
// Workflows grid
// ---------------------------------------------------------------
function getFilteredWorkflows() {
  const q = (document.getElementById("searchInput").value || "")
    .toLowerCase()
    .trim();
  return getWorkflows().filter((w) => {
    if (!q) return true;
    return `${w.name} ${w.trigger} ${w.owner || ""}`.toLowerCase().includes(q);
  });
}

function renderWorkflows() {
  const workflows = getFilteredWorkflows();
  const grid = document.getElementById("workflowsGrid");

  if (!workflows.length) {
    grid.innerHTML = `<div class="empty-state"><i class="fa-solid fa-diagram-project"></i><p>No workflows yet. Automate your first follow-up.</p></div>`;
    return;
  }

  grid.innerHTML = workflows
    .map((w) => {
      const actions = w.actions || [];
      return `
      <div class="auto-card" data-id="${w.id}">
        <div class="auto-card__top">
          <div class="auto-card__icon"><i class="fa-solid fa-bolt"></i></div>
          <div class="auto-card__title-wrap">
            <div class="auto-card__name">${escapeHtml(w.name)}</div>
            <div class="auto-card__owner">${escapeHtml(w.owner || "Unassigned")}</div>
          </div>
          <span class="${statusPillClass(w.status)}">${w.status}</span>
        </div>
        <div class="auto-card__trigger">
          <i class="fa-solid fa-bolt-lightning"></i>
          <span>When <strong>${escapeHtml(w.trigger)}</strong></span>
        </div>
        <div class="auto-card__chain">
          ${
            actions.length
              ? actions
                  .map(
                    (a) =>
                      `<span class="chain-chip">${escapeHtml(a.type)}</span>`,
                  )
                  .join("")
              : `<span class="chain-chip">No actions configured</span>`
          }
        </div>
        <div class="auto-card__stats">
          <div class="auto-card__stat">
            <span class="num">${actions.length}</span>
            <span class="lbl">Actions</span>
          </div>
          <div class="auto-card__stat">
            <span class="num">${w.runsCount || 0}</span>
            <span class="lbl">Times Run</span>
          </div>
        </div>
        <div class="auto-card__foot">
          <button class="btn btn-outline run-workflow-btn" data-id="${w.id}" ${w.status !== "Active" ? "disabled" : ""}>
            <i class="fa-solid fa-play"></i> Run Now
          </button>
          <div class="auto-card__actions">
            <button class="icon-btn edit-workflow-btn" data-id="${w.id}"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn danger delete-workflow-btn" data-id="${w.id}"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      </div>`;
    })
    .join("");

  grid.querySelectorAll(".run-workflow-btn").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      runWorkflow(btn.dataset.id);
    }),
  );
  grid.querySelectorAll(".edit-workflow-btn").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openWorkflowModal(btn.dataset.id);
    }),
  );
  grid.querySelectorAll(".delete-workflow-btn").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wf = getWorkflows().find((w) => w.id === btn.dataset.id);
      if (wf && confirm(`Delete "${wf.name}"? This can't be undone.`)) {
        saveWorkflows(getWorkflows().filter((w) => w.id !== btn.dataset.id));
        showToast("Workflow deleted", "success");
        renderAll();
      }
    }),
  );
}

function runWorkflow(id) {
  const list = getWorkflows();
  const wf = list.find((w) => w.id === id);
  if (!wf) return;

  let tasksCreated = 0;
  (wf.actions || []).forEach((a) => {
    if (a.type === "Create Task") {
      pushTask({
        title: a.detail || `${wf.name} — follow up`,
        description: `Auto-created by workflow "${wf.name}"`,
        assignee: wf.owner || "",
        dueDate: addDays(todayStr(), 2),
        priority: "Medium",
        status: "To Do",
        relatedType: "",
        relatedName: "",
      });
      tasksCreated++;
    }
  });

  wf.runsCount = (wf.runsCount || 0) + 1;
  saveWorkflows(list);

  showToast(
    tasksCreated
      ? `"${wf.name}" ran — created ${tasksCreated} task${tasksCreated === 1 ? "" : "s"}`
      : `"${wf.name}" ran — no task-creating actions configured`,
    "success",
  );
  renderAll();
}

// ---------------------------------------------------------------
// Sequences grid
// ---------------------------------------------------------------
function getFilteredSequences() {
  const q = (document.getElementById("searchInput").value || "")
    .toLowerCase()
    .trim();
  return getSequences().filter((s) => {
    if (!q) return true;
    return `${s.name} ${s.targetType} ${s.owner || ""}`
      .toLowerCase()
      .includes(q);
  });
}

function renderSequences() {
  const sequences = getFilteredSequences();
  const grid = document.getElementById("sequencesGrid");

  if (!sequences.length) {
    grid.innerHTML = `<div class="empty-state"><i class="fa-solid fa-layer-group"></i><p>No sequences yet. Build a multi-step follow-up cadence.</p></div>`;
    return;
  }

  grid.innerHTML = sequences
    .map((s) => {
      const steps = s.steps || [];
      return `
      <div class="auto-card" data-id="${s.id}">
        <div class="auto-card__top">
          <div class="auto-card__icon"><i class="fa-solid fa-layer-group"></i></div>
          <div class="auto-card__title-wrap">
            <div class="auto-card__name">${escapeHtml(s.name)}</div>
            <div class="auto-card__owner">${escapeHtml(s.owner || "Unassigned")} · ${escapeHtml(s.targetType)}</div>
          </div>
          <span class="${statusPillClass(s.status)}">${s.status}</span>
        </div>
        <div class="auto-card__chain">
          ${
            steps.length
              ? steps
                  .map(
                    (st) =>
                      `<span class="chain-chip step">Day ${st.day} · ${escapeHtml(st.type)}</span>`,
                  )
                  .join("")
              : `<span class="chain-chip step">No steps configured</span>`
          }
        </div>
        <div class="auto-card__stats">
          <div class="auto-card__stat">
            <span class="num">${steps.length}</span>
            <span class="lbl">Touchpoints</span>
          </div>
          <div class="auto-card__stat">
            <span class="num">${s.enrolledCount || 0}</span>
            <span class="lbl">Enrolled</span>
          </div>
        </div>
        <div class="auto-card__foot">
          <button class="btn btn-outline enroll-sequence-btn" data-id="${s.id}" ${s.status !== "Active" ? "disabled" : ""}>
            <i class="fa-solid fa-user-plus"></i> Enroll One
          </button>
          <div class="auto-card__actions">
            <button class="icon-btn edit-sequence-btn" data-id="${s.id}"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn danger delete-sequence-btn" data-id="${s.id}"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      </div>`;
    })
    .join("");

  grid.querySelectorAll(".enroll-sequence-btn").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      enrollSequence(btn.dataset.id);
    }),
  );
  grid.querySelectorAll(".edit-sequence-btn").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSequenceModal(btn.dataset.id);
    }),
  );
  grid.querySelectorAll(".delete-sequence-btn").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const sq = getSequences().find((s) => s.id === btn.dataset.id);
      if (sq && confirm(`Delete "${sq.name}"? This can't be undone.`)) {
        saveSequences(getSequences().filter((s) => s.id !== btn.dataset.id));
        showToast("Sequence deleted", "success");
        renderAll();
      }
    }),
  );
}

function enrollSequence(id) {
  const list = getSequences();
  const sq = list.find((s) => s.id === id);
  if (!sq) return;

  const steps = (sq.steps || []).slice().sort((a, b) => a.day - b.day);
  const firstTaskStep = steps.find(
    (st) => st.type === "Task" || st.type === "Call",
  );
  if (firstTaskStep) {
    pushTask({
      title:
        firstTaskStep.note ||
        `${sq.name} — Day ${firstTaskStep.day} touchpoint`,
      description: `Auto-created by sequence "${sq.name}"`,
      assignee: sq.owner || "",
      dueDate: addDays(todayStr(), firstTaskStep.day),
      priority: "Medium",
      status: "To Do",
      relatedType: "",
      relatedName: "",
    });
  }

  sq.enrolledCount = (sq.enrolledCount || 0) + 1;
  saveSequences(list);

  showToast(
    firstTaskStep
      ? `Enrolled — first task scheduled for Day ${firstTaskStep.day}`
      : `Enrolled in "${sq.name}"`,
    "success",
  );
  renderAll();
}

// ---------------------------------------------------------------
// Workflow modal — dynamic actions list
// ---------------------------------------------------------------
let wfActionRows = [];

function populateOwnerSelects() {
  const owners = ownerNames();
  const optionsHtml = owners.length
    ? owners
        .map(
          (n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`,
        )
        .join("")
    : `<option value="" disabled selected>Add an agent first (Account Champions)</option>`;
  document.getElementById("wfOwner").innerHTML = optionsHtml;
  document.getElementById("sqOwner").innerHTML = optionsHtml;
}

function renderWfActionsList() {
  const el = document.getElementById("wfActionsList");
  if (!wfActionRows.length) {
    el.innerHTML = `<div class="dynamic-list-empty">No actions yet — add one above.</div>`;
    return;
  }
  el.innerHTML = wfActionRows
    .map(
      (row, i) => `
      <div class="dynamic-row" data-idx="${i}">
        <span class="step-index">${i + 1}</span>
        <select class="type-select action-type-input">
          ${ACTION_TYPES.map((t) => `<option value="${t}" ${t === row.type ? "selected" : ""}>${t}</option>`).join("")}
        </select>
        <input type="text" class="detail-input action-detail-input" placeholder="Detail (e.g. task title, email subject...)" value="${escapeHtml(row.detail || "")}" />
        <button type="button" class="remove-row" data-idx="${i}"><i class="fa-solid fa-xmark"></i></button>
      </div>`,
    )
    .join("");

  el.querySelectorAll(".action-type-input").forEach((sel, i) =>
    sel.addEventListener("change", () => (wfActionRows[i].type = sel.value)),
  );
  el.querySelectorAll(".action-detail-input").forEach((inp, i) =>
    inp.addEventListener("input", () => (wfActionRows[i].detail = inp.value)),
  );
  el.querySelectorAll(".remove-row").forEach((btn) =>
    btn.addEventListener("click", () => {
      wfActionRows.splice(Number(btn.dataset.idx), 1);
      renderWfActionsList();
    }),
  );
}

function openWorkflowModal(id) {
  const overlay = document.getElementById("workflowModalOverlay");
  const form = document.getElementById("workflowForm");
  form.reset();
  populateOwnerSelects();

  const deleteBtn = document.getElementById("wfDeleteBtn");

  if (id) {
    const wf = getWorkflows().find((w) => w.id === id);
    if (!wf) return;
    document.getElementById("workflowModalTitle").textContent = "Edit Workflow";
    document.getElementById("wfEditId").value = wf.id;
    document.getElementById("wfName").value = wf.name;
    document.getElementById("wfStatus").value = wf.status;
    document.getElementById("wfOwner").value = wf.owner || "";
    document.getElementById("wfTrigger").value = wf.trigger;
    wfActionRows = (wf.actions || []).map((a) => ({ ...a }));
    deleteBtn.style.display = "inline-flex";
  } else {
    document.getElementById("workflowModalTitle").textContent = "New Workflow";
    document.getElementById("wfEditId").value = "";
    document.getElementById("wfStatus").value = "Active";
    wfActionRows = [{ type: "Create Task", detail: "" }];
    deleteBtn.style.display = "none";
  }

  renderWfActionsList();
  overlay.classList.add("open");
}
function closeWorkflowModal() {
  document.getElementById("workflowModalOverlay").classList.remove("open");
}

// ---------------------------------------------------------------
// Sequence modal — dynamic steps list
// ---------------------------------------------------------------
let sqStepRows = [];

function renderSqStepsList() {
  const el = document.getElementById("sqStepsList");
  if (!sqStepRows.length) {
    el.innerHTML = `<div class="dynamic-list-empty">No steps yet — add one above.</div>`;
    return;
  }
  el.innerHTML = sqStepRows
    .map(
      (row, i) => `
      <div class="dynamic-row" data-idx="${i}">
        <span class="step-index">${i + 1}</span>
        <input type="number" min="0" class="day-input step-day-input" value="${row.day ?? 0}" title="Day offset" />
        <select class="type-select step-type-input">
          ${STEP_TYPES.map((t) => `<option value="${t}" ${t === row.type ? "selected" : ""}>${t}</option>`).join("")}
        </select>
        <input type="text" class="detail-input step-note-input" placeholder="Note (e.g. call script, email subject...)" value="${escapeHtml(row.note || "")}" />
        <button type="button" class="remove-row" data-idx="${i}"><i class="fa-solid fa-xmark"></i></button>
      </div>`,
    )
    .join("");

  el.querySelectorAll(".step-day-input").forEach((inp, i) =>
    inp.addEventListener(
      "input",
      () => (sqStepRows[i].day = parseInt(inp.value, 10) || 0),
    ),
  );
  el.querySelectorAll(".step-type-input").forEach((sel, i) =>
    sel.addEventListener("change", () => (sqStepRows[i].type = sel.value)),
  );
  el.querySelectorAll(".step-note-input").forEach((inp, i) =>
    inp.addEventListener("input", () => (sqStepRows[i].note = inp.value)),
  );
  el.querySelectorAll(".remove-row").forEach((btn) =>
    btn.addEventListener("click", () => {
      sqStepRows.splice(Number(btn.dataset.idx), 1);
      renderSqStepsList();
    }),
  );
}

function openSequenceModal(id) {
  const overlay = document.getElementById("sequenceModalOverlay");
  const form = document.getElementById("sequenceForm");
  form.reset();
  populateOwnerSelects();

  const deleteBtn = document.getElementById("sqDeleteBtn");

  if (id) {
    const sq = getSequences().find((s) => s.id === id);
    if (!sq) return;
    document.getElementById("sequenceModalTitle").textContent = "Edit Sequence";
    document.getElementById("sqEditId").value = sq.id;
    document.getElementById("sqName").value = sq.name;
    document.getElementById("sqTarget").value = sq.targetType;
    document.getElementById("sqStatus").value = sq.status;
    document.getElementById("sqOwner").value = sq.owner || "";
    sqStepRows = (sq.steps || []).map((s) => ({ ...s }));
    deleteBtn.style.display = "inline-flex";
  } else {
    document.getElementById("sequenceModalTitle").textContent = "New Sequence";
    document.getElementById("sqEditId").value = "";
    document.getElementById("sqStatus").value = "Active";
    sqStepRows = [{ day: 0, type: "Email", note: "" }];
    deleteBtn.style.display = "none";
  }

  renderSqStepsList();
  overlay.classList.add("open");
}
function closeSequenceModal() {
  document.getElementById("sequenceModalOverlay").classList.remove("open");
}

// ---------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------
function setTab(tab) {
  activeTab = tab;
  const isWf = tab === "workflows";
  document.getElementById("tabWorkflowsBtn").classList.toggle("active", isWf);
  document.getElementById("tabSequencesBtn").classList.toggle("active", !isWf);
  document.getElementById("workflowsPanel").style.display = isWf
    ? "block"
    : "none";
  document.getElementById("sequencesPanel").style.display = isWf
    ? "none"
    : "block";
  document.getElementById("addBtnLabel").textContent = isWf
    ? "New Workflow"
    : "New Sequence";
  document.getElementById("searchInput").placeholder = isWf
    ? "Search workflows..."
    : "Search sequences...";
  renderAll();
}

// ---------------------------------------------------------------
// Full render
// ---------------------------------------------------------------
function renderAll() {
  renderKpis();
  if (activeTab === "workflows") {
    renderWorkflows();
  } else {
    renderSequences();
  }
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
renderAll();

document
  .getElementById("tabWorkflowsBtn")
  .addEventListener("click", () => setTab("workflows"));
document
  .getElementById("tabSequencesBtn")
  .addEventListener("click", () => setTab("sequences"));
document.getElementById("searchInput").addEventListener("input", renderAll);

document.getElementById("addBtn").addEventListener("click", () => {
  if (activeTab === "workflows") {
    openWorkflowModal(null);
  } else {
    openSequenceModal(null);
  }
});

// Workflow modal wiring
document
  .getElementById("workflowModalClose")
  .addEventListener("click", closeWorkflowModal);
document
  .getElementById("wfCancelBtn")
  .addEventListener("click", closeWorkflowModal);
document
  .getElementById("workflowModalOverlay")
  .addEventListener("click", (e) => {
    if (e.target.id === "workflowModalOverlay") closeWorkflowModal();
  });
document.getElementById("wfAddActionBtn").addEventListener("click", () => {
  wfActionRows.push({ type: "Create Task", detail: "" });
  renderWfActionsList();
});
document.getElementById("wfDeleteBtn").addEventListener("click", () => {
  const id = document.getElementById("wfEditId").value;
  const wf = getWorkflows().find((w) => w.id === id);
  if (id && wf && confirm(`Delete "${wf.name}"? This can't be undone.`)) {
    saveWorkflows(getWorkflows().filter((w) => w.id !== id));
    closeWorkflowModal();
    showToast("Workflow deleted", "success");
    renderAll();
  }
});
document.getElementById("workflowForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("wfEditId").value;
  const payload = {
    name: document.getElementById("wfName").value.trim(),
    status: document.getElementById("wfStatus").value,
    owner: document.getElementById("wfOwner").value,
    trigger: document.getElementById("wfTrigger").value,
    actions: wfActionRows.filter((a) => a.type),
  };
  if (!payload.name) {
    showToast("Workflow name is required.", "error");
    return;
  }
  const list = getWorkflows();
  if (id) {
    const idx = list.findIndex((w) => w.id === id);
    if (idx !== -1) list[idx] = { ...list[idx], ...payload };
    showToast("Workflow updated", "success");
  } else {
    payload.id =
      "wf_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    payload.runsCount = 0;
    payload.createdAt = new Date().toISOString();
    list.unshift(payload);
    showToast("Workflow created", "success");
  }
  saveWorkflows(list);
  closeWorkflowModal();
  renderAll();
});

// Sequence modal wiring
document
  .getElementById("sequenceModalClose")
  .addEventListener("click", closeSequenceModal);
document
  .getElementById("sqCancelBtn")
  .addEventListener("click", closeSequenceModal);
document
  .getElementById("sequenceModalOverlay")
  .addEventListener("click", (e) => {
    if (e.target.id === "sequenceModalOverlay") closeSequenceModal();
  });
document.getElementById("sqAddStepBtn").addEventListener("click", () => {
  const lastDay = sqStepRows.length
    ? sqStepRows[sqStepRows.length - 1].day
    : -2;
  sqStepRows.push({ day: lastDay + 2, type: "Email", note: "" });
  renderSqStepsList();
});
document.getElementById("sqDeleteBtn").addEventListener("click", () => {
  const id = document.getElementById("sqEditId").value;
  const sq = getSequences().find((s) => s.id === id);
  if (id && sq && confirm(`Delete "${sq.name}"? This can't be undone.`)) {
    saveSequences(getSequences().filter((s) => s.id !== id));
    closeSequenceModal();
    showToast("Sequence deleted", "success");
    renderAll();
  }
});
document.getElementById("sequenceForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("sqEditId").value;
  const payload = {
    name: document.getElementById("sqName").value.trim(),
    targetType: document.getElementById("sqTarget").value,
    status: document.getElementById("sqStatus").value,
    owner: document.getElementById("sqOwner").value,
    steps: sqStepRows.filter((s) => s.type),
  };
  if (!payload.name) {
    showToast("Sequence name is required.", "error");
    return;
  }
  const list = getSequences();
  if (id) {
    const idx = list.findIndex((s) => s.id === id);
    if (idx !== -1) list[idx] = { ...list[idx], ...payload };
    showToast("Sequence updated", "success");
  } else {
    payload.id =
      "sq_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    payload.enrolledCount = 0;
    payload.createdAt = new Date().toISOString();
    list.unshift(payload);
    showToast("Sequence created", "success");
  }
  saveSequences(list);
  closeSequenceModal();
  renderAll();
});
