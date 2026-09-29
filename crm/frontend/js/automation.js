/**
 * automation.js — Sales Automation module (Workflows + Sequences)
 * Workflows and sequences live on the CRM backend (getWorkflows, getSequences,
 * saveAutomation, removeAutomation in app.js). "Run Now" / "Enroll One" ask the
 * server to create the tasks (runWorkflowNow, enrollInSequence); emails,
 * notifications and status changes are not sent yet (automation engine: Phase 6).
 * Reuses shared helpers from app.js (getAgents, showToast,
 * renderSidebarUser, initSidebarToggle, requireAuth).
 */

requireAuth();
renderSidebarUser();
initSidebarToggle();

const ACTION_TYPES = [
  "Create Task",
  "Send Email (simulated)",
  "Notify Agent",
  "Update Status",
  "Add to Sequence",
];
const STEP_TYPES = ["Email", "Call", "Task", "Wait"];

let activeTab = "workflows"; // "workflows" | "sequences"

const findById = (list, id) => list.find((item) => String(item.id) === String(id));

// Deletes after confirming; kind is "workflows" or "sequences".
function confirmDeleteAutomation(kind, id, label, onDone) {
  const item = findById(kind === "workflows" ? getWorkflows() : getSequences(), id);
  if (!item || !confirm(`Delete "${item.name}"? This can't be undone.`)) return;
  removeAutomation(kind, id)
    .then(() => {
      if (onDone) onDone();
      showToast(`${label} deleted`, "success");
    })
    .catch((error) => showToast(apiErrorMessage(error, `Couldn't delete the ${label.toLowerCase()}.`), "error"))
    .finally(renderAll);
}

// "Also configured, not sent yet: Notify Agent, ..." for actions the server only simulates.
function simulatedNote(simulated) {
  return simulated && simulated.length ? ` (not sent yet: ${simulated.join(", ")})` : "";
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
function ownerNames() {
  return getAgents().map((a) => a.name);
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
      confirmDeleteAutomation("workflows", btn.dataset.id, "Workflow");
    }),
  );
}

// The server creates the tasks and counts the run (one run per click, even on a retry).
async function runWorkflow(id) {
  const wf = findById(getWorkflows(), id);
  if (!wf) return;
  let result;
  try {
    result = await runWorkflowNow(wf.id);
  } catch (error) {
    showToast(apiErrorMessage(error, "Couldn't run the workflow."), "error");
    renderAll();
    return;
  }
  const tasksCreated = result.tasks.length;
  showToast(
    (tasksCreated
      ? `"${wf.name}" ran — created ${tasksCreated} task${tasksCreated === 1 ? "" : "s"}`
      : `"${wf.name}" ran — no task-creating actions configured`) + simulatedNote(result.simulated),
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
      confirmDeleteAutomation("sequences", btn.dataset.id, "Sequence");
    }),
  );
}

// The server schedules the first Call/Task step as a task and counts the enrollment.
async function enrollSequence(id) {
  const sq = findById(getSequences(), id);
  if (!sq) return;
  let result;
  try {
    result = await enrollInSequence(sq.id);
  } catch (error) {
    showToast(apiErrorMessage(error, "Couldn't enroll."), "error");
    renderAll();
    return;
  }
  showToast(
    result.task
      ? `Enrolled — first task scheduled for Day ${result.firstTaskDay}`
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
    const wf = findById(getWorkflows(), id);
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
    const sq = findById(getSequences(), id);
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
crmReady(["workflows", "sequences", "members"], renderAll);

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
  if (id) confirmDeleteAutomation("workflows", id, "Workflow", closeWorkflowModal);
});
document.getElementById("workflowForm").addEventListener("submit", async (e) => {
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
  try {
    await saveAutomation("workflows", id || null, payload);
    showToast(id ? "Workflow updated" : "Workflow created", "success");
  } catch (error) {
    showToast(apiErrorMessage(error, "Couldn't save the workflow."), "error");
    return;
  }
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
  if (id) confirmDeleteAutomation("sequences", id, "Sequence", closeSequenceModal);
});
document.getElementById("sequenceForm").addEventListener("submit", async (e) => {
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
  try {
    await saveAutomation("sequences", id || null, payload);
    showToast(id ? "Sequence updated" : "Sequence created", "success");
  } catch (error) {
    showToast(apiErrorMessage(error, "Couldn't save the sequence."), "error");
    return;
  }
  closeSequenceModal();
  renderAll();
});
