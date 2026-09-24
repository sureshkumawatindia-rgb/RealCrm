/**
 * accounts.js — "Team Champions" page
 * Gamified onboarding for adding teammates (Agents / "Champions").
 * Persists to localStorage under 'crm_agents' via the shared
 * getAgents/addAgent/updateAgentRecord/deleteAgent helpers in app.js.
 *
 * NOTE: The old "Accounts" (business/company records) feature has been
 * removed from this page entirely — it duplicated the Customers page and
 * confused people. This page is now 100% about your team (Champions).
 */

requireAuth();
renderSidebarUser();

function initials(name) {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

/* ============================================================
   ADD NEW CHAMPION — multi-step wizard
   ============================================================ */

const MODULES = [
  { key: "Dashboard", icon: "fa-chart-pie" },
  { key: "Customers", icon: "fa-users" },
  { key: "Leads", icon: "fa-bullseye" },
  { key: "Accounts", icon: "fa-building" },
  { key: "Deals", icon: "fa-handshake" },
  { key: "Tasks", icon: "fa-list-check" },
  { key: "Calendar", icon: "fa-calendar-days" },
  { key: "Marketing", icon: "fa-bullhorn" },
  { key: "Sales Automation", icon: "fa-robot" },
  { key: "Support", icon: "fa-headset" },
  { key: "Reports & Analytics", icon: "fa-chart-line" },
  { key: "AI Insights", icon: "fa-brain" },
  { key: "Documents", icon: "fa-file-lines" },
  { key: "Products", icon: "fa-box" },
  { key: "Settings", icon: "fa-gear" },
];

const agentModalOverlay = document.getElementById("agentModalOverlay");
const agentForm = document.getElementById("agentForm");
const STEP_LABELS = {
  1: "Welcome",
  2: "About Them",
  3: "Role",
  4: "Access",
  5: "Powers",
};
let agentStep = 1;
const TOTAL_STEPS = 5;

// Build the module checkbox grid once
function buildModuleGrid() {
  const grid = document.getElementById("moduleGrid");
  grid.innerHTML = MODULES.map(
    (m) => `
    <label class="module-item">
      <input type="checkbox" class="module-checkbox" value="${m.key}" ${m.key === "Accounts" ? "checked" : ""} />
      <i class="fa-solid ${m.icon}"></i>
      <span>${m.key}</span>
    </label>`,
  ).join("");
}
buildModuleGrid();

document.getElementById("selectAllModules").addEventListener("click", () => {
  document
    .querySelectorAll(".module-checkbox")
    .forEach((cb) => (cb.checked = true));
});
document.getElementById("clearAllModules").addEventListener("click", () => {
  document
    .querySelectorAll(".module-checkbox")
    .forEach((cb) => (cb.checked = false));
});

// Swap a stepper dot's number for a checkmark once that step is behind us —
// this is the "tick it off like a game" moment.
function updateStepperTicks(currentStep) {
  document.querySelectorAll(".stepper-dot").forEach((dot) => {
    const dStep = Number(dot.dataset.step);
    const numEl = dot.querySelector(".stepper-num");
    dot.classList.remove("stepper-dot--active", "stepper-dot--done");
    if (dStep < currentStep) {
      dot.classList.add("stepper-dot--done");
      numEl.innerHTML = '<i class="fa-solid fa-check"></i>';
    } else {
      numEl.textContent = dStep;
      if (dStep === currentStep) dot.classList.add("stepper-dot--active");
    }
  });
}

function goToStep(step) {
  agentStep = step;

  document
    .querySelectorAll(".agent-step")
    .forEach((p) => p.classList.remove("agent-step--active"));
  document
    .querySelector(`.agent-step[data-step-panel="${step}"]`)
    .classList.add("agent-step--active");

  updateStepperTicks(step);

  document.getElementById("agentStepCurrent").textContent = step;
  document.getElementById("agentStepLabel").textContent = STEP_LABELS[step];

  document.getElementById("agentBackBtn").style.visibility =
    step === 1 ? "hidden" : "visible";

  const nextBtn = document.getElementById("agentNextBtn");
  const createBtn = document.getElementById("agentCreateBtn");
  if (step === TOTAL_STEPS) {
    nextBtn.style.display = "none";
    createBtn.style.display = "inline-flex";
    populateReview();
  } else {
    nextBtn.style.display = "inline-flex";
    createBtn.style.display = "none";
  }
}

function validateStep(step) {
  if (step === 2) {
    const name = document.getElementById("agName").value.trim();
    if (!name) {
      showToast("Give your Champion a name to continue.", "error");
      return false;
    }
  }
  if (step === 4) {
    const anyModule = document.querySelectorAll(
      ".module-checkbox:checked",
    ).length;
    if (anyModule === 0) {
      showToast(
        "Unlock at least one page for this Champion to continue.",
        "error",
      );
      return false;
    }
  }
  return true;
}

document.getElementById("agentNextBtn").addEventListener("click", () => {
  if (!validateStep(agentStep)) return;
  if (agentStep < TOTAL_STEPS) goToStep(agentStep + 1);
});
document.getElementById("agentBackBtn").addEventListener("click", () => {
  if (agentStep > 1) goToStep(agentStep - 1);
});

function populateReview() {
  const name = document.getElementById("agName").value.trim() || "—";
  const role = document.querySelector('input[name="agRole"]:checked').value;
  const modules = Array.from(
    document.querySelectorAll(".module-checkbox:checked"),
  ).map((cb) => cb.value);
  const perms = Array.from(
    document.querySelectorAll("#permissionGrid input:checked"),
  ).map((cb) => cb.value);

  document.getElementById("agentReviewBox").innerHTML = `
    <div>🎯 <strong>${name}</strong> will join as <strong>${role}</strong>.</div>
    <div style="margin-top:8px;">They can open <strong>${modules.length}</strong> page${modules.length === 1 ? "" : "s"}:</div>
    <div>${modules.map((m) => `<span class="review-tag">${m}</span>`).join("")}</div>
    <div style="margin-top:8px;">They're allowed to:</div>
    <div>${perms.map((p) => `<span class="review-tag">${p}</span>`).join("") || '<span class="review-tag">Nothing yet</span>'}</div>
  `;
}

function openAgentModal(agent = null) {
  agentForm.reset();
  document.getElementById("agentEditId").value = agent ? agent.id : "";
  document.getElementById("agentModalTitle").textContent = agent
    ? "✏️ Edit Champion"
    : "🏆 Add a New Champion";

  if (agent) {
    document.getElementById("agName").value = agent.name;
    document.getElementById("agMobile").value = agent.mobile || "";
    document.getElementById("agEmail").value = agent.email || "";
    const roleInput = document.querySelector(
      `input[name="agRole"][value="${agent.role}"]`,
    );
    if (roleInput) roleInput.checked = true;
    document.querySelectorAll(".module-checkbox").forEach((cb) => {
      cb.checked = (agent.modules || []).includes(cb.value);
    });
    document.querySelectorAll("#permissionGrid input").forEach((cb) => {
      cb.checked = (agent.permissions || []).includes(cb.value);
    });
  } else {
    document.querySelectorAll(".module-checkbox").forEach((cb) => {
      cb.checked = cb.value === "Accounts";
    });
    document.querySelectorAll("#permissionGrid input").forEach((cb) => {
      cb.checked = cb.value === "View";
    });
  }

  goToStep(1);
  agentModalOverlay.classList.add("open");
}
function closeAgentModal() {
  agentModalOverlay.classList.remove("open");
}

document
  .getElementById("addAgentBtn")
  .addEventListener("click", () => openAgentModal());
document
  .getElementById("agentModalClose")
  .addEventListener("click", closeAgentModal);
document
  .getElementById("agentCancelBtn")
  .addEventListener("click", closeAgentModal);
agentModalOverlay.addEventListener("click", (e) => {
  if (e.target === agentModalOverlay) closeAgentModal();
});

agentForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("agentEditId").value;
  const data = {
    name: document.getElementById("agName").value.trim(),
    mobile: document.getElementById("agMobile").value.trim(),
    email: document.getElementById("agEmail").value.trim(),
    role: document.querySelector('input[name="agRole"]:checked').value,
    modules: Array.from(
      document.querySelectorAll(".module-checkbox:checked"),
    ).map((cb) => cb.value),
    permissions: Array.from(
      document.querySelectorAll("#permissionGrid input:checked"),
    ).map((cb) => cb.value),
  };
  if (!data.name) {
    showToast("Give your Champion a name to continue.", "error");
    goToStep(2);
    return;
  }
  if (id) {
    updateAgentRecord(id, data);
    showToast(`✅ ${data.name} updated.`, "success");
  } else {
    addAgent(data);
    showToast(`🎉 ${data.name} joined your team!`, "success");
  }
  closeAgentModal();
  renderAgents();
});

/* ============================================================
   TEAM PROGRESS / LEVEL — the "game" layer on the main page
   ============================================================ */

const LEVELS = [
  { min: 0, emoji: "🌱", label: "Getting Started" },
  { min: 1, emoji: "🥉", label: "Bronze Team" },
  { min: 3, emoji: "🥈", label: "Silver Squad" },
  { min: 6, emoji: "🥇", label: "Gold Team — Full Power!" },
];
const THRESHOLDS = [1, 3, 6];

function currentLevel(count) {
  let level = LEVELS[0];
  LEVELS.forEach((l) => {
    if (count >= l.min) level = l;
  });
  return level;
}

function renderTeamProgress() {
  const agents = getAgents();
  const count = agents.length;
  const level = currentLevel(count);

  document.getElementById("champLevelEmoji").textContent = level.emoji;
  document.getElementById("champLevelLabel").textContent = level.label;
  document.getElementById("champCountSub").textContent =
    `${count} Champion${count === 1 ? "" : "s"} on your team`;

  const nextThreshold = THRESHOLDS.find((t) => t > count) || THRESHOLDS[THRESHOLDS.length - 1];
  const pct = Math.min(100, Math.round((count / nextThreshold) * 100));
  document.getElementById("champProgressFill").style.width = `${pct}%`;

  const hasFullPower = agents.some((a) => {
    const p = a.permissions || [];
    return (
      p.includes("Create") && p.includes("Edit") && p.includes("Delete")
    );
  });

  const milestones = [
    { done: count >= 1, label: "Add your first Champion" },
    { done: count >= 3, label: "Build a squad (3 Champions)" },
    { done: count >= 6, label: "Go for gold (6 Champions)" },
    { done: hasFullPower, label: "Trust someone with full power (Create + Edit + Delete)" },
  ];

  document.getElementById("champMilestones").innerHTML = milestones
    .map(
      (m) => `
      <div class="champ-milestone ${m.done ? "done" : ""}">
        <span class="tick"><i class="fa-solid fa-check"></i></span>
        <span>${m.label}</span>
      </div>`,
    )
    .join("");
}

/* ============================================================
   CHAMPIONS GRID
   ============================================================ */

function renderAgents() {
  const agents = getAgents();
  document.getElementById("agentCount").textContent =
    `${agents.length} champion${agents.length === 1 ? "" : "s"}`;
  const grid = document.getElementById("agentsGrid");

  if (agents.length === 0) {
    grid.innerHTML = `<div class="empty-state"><i class="fa-solid fa-user-plus"></i><p>No Champions yet. Click "Add a Champion" above to bring your first teammate onboard.</p></div>`;
  } else {
    grid.className = "agents-grid";
    grid.innerHTML = agents
      .map(
        (a) => `
      <div class="agent-card">
        <div class="agent-card__top">
          <div class="agent-card__avatar">${initials(a.name)}</div>
          <div>
            <div class="agent-card__name">${a.name}</div>
            <div class="agent-card__role">${a.role}</div>
          </div>
        </div>
        <div class="agent-card__meta">
          <div><i class="fa-solid fa-envelope" style="width:14px;color:var(--text-faint);"></i> ${a.email || "—"}</div>
          <div><i class="fa-solid fa-phone" style="width:14px;color:var(--text-faint);"></i> ${a.mobile || "—"}</div>
        </div>
        <span class="agent-card__modules">${(a.modules || []).length} page${(a.modules || []).length === 1 ? "" : "s"} unlocked</span>
        <div class="agent-card__perms">
          ${(a.permissions || []).map((p) => `<span class="badge badge-brand">${p}</span>`).join("") || '<span class="badge badge-neutral">No permissions</span>'}
        </div>
        <div class="agent-card__actions">
          <button class="icon-btn edit-agent-btn" data-id="${a.id}"><i class="fa-solid fa-pen"></i></button>
          <button class="icon-btn danger delete-agent-btn" data-id="${a.id}"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`,
      )
      .join("");

    grid.querySelectorAll(".edit-agent-btn").forEach((btn) =>
      btn.addEventListener("click", () => {
        const agent = getAgents().find((a) => a.id === btn.dataset.id);
        openAgentModal(agent);
      }),
    );
    grid.querySelectorAll(".delete-agent-btn").forEach((btn) =>
      btn.addEventListener("click", () => {
        const agent = getAgents().find((a) => a.id === btn.dataset.id);
        if (agent && confirm(`Remove ${agent.name} from your team?`)) {
          deleteAgent(btn.dataset.id);
          showToast(`${agent.name} was removed.`, "success");
          renderAgents();
        }
      }),
    );
  }

  renderTeamProgress();
}

renderAgents();