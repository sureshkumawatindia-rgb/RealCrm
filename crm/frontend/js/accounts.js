/**
 * accounts.js — "Account Champions" page
 * Your team on the CRM backend: members (GET/PATCH/DELETE /members) and pending invites
 * (/invites). The wizard invites a new teammate — they join when they open the invite link or
 * simply sign in with Google using that email — or changes a teammate's access.
 * Owners and admins manage agents and viewers here; everyone else sees the team read-only.
 * Owners and admins themselves are managed in Settings → Team & Access.
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
   TEAM DATA — members and pending invites from the server
   ============================================================ */

// kind: "member" or "invite". Invites show the name typed in the wizard, else the email.
function teamPeople() {
  const members = cached("members").map((m) => ({ ...m, kind: "member", name: m.name || m.email }));
  const invites = cached("invites").map((i) => ({ ...i, kind: "invite", name: i.displayName || i.email }));
  return [...members, ...invites];
}
function findPerson(kind, id) {
  return teamPeople().find((p) => p.kind === kind && String(p.id) === String(id));
}
const isManagerRole = (role) => role === "owner" || role === "admin";

// Owners/admins change agents and viewers here (never themselves); owners, admins and admin
// invites are managed in Settings → Team & Access.
function canManage(person) {
  if (!isOrgManager() || isManagerRole(person.role)) return false;
  return person.kind === "invite" || String(person.id) !== String(getCurrentMember()?.id);
}

async function reloadTeam() {
  await crmLoad(["members", "invites"], { force: true });
  renderAgents();
}

/* ============================================================
   ACCESS — wizard permissions ↔ server roles and grants
   ============================================================ */

// Agents always create and edit on their pages, so Create/Edit make an agent and View alone a
// viewer. Delete and "See all records" become per-page grants ("leads:delete", "leads:view_all").
const PERMISSION_LABELS = { View: "View", Create: "Create", Edit: "Edit", Delete: "Delete", ViewAll: "See all records" };

function accessFromWizard(modules, perms) {
  const role = perms.includes("Create") || perms.includes("Edit") ? "agent" : "viewer";
  const permissions = [];
  if (role === "agent" && perms.includes("Delete")) modules.forEach((m) => permissions.push(`${m}:delete`));
  if (perms.includes("ViewAll")) modules.forEach((m) => permissions.push(`${m}:view_all`));
  return { role, modules, permissions };
}

function wizardPermissions(person) {
  if (isManagerRole(person.role)) return Object.keys(PERMISSION_LABELS);
  const perms = ["View"];
  if (person.role === "agent") perms.push("Create", "Edit");
  const grants = person.permissions || [];
  if (grants.some((p) => p.endsWith(":delete"))) perms.push("Delete");
  if (grants.some((p) => p.endsWith(":view_all"))) perms.push("ViewAll");
  return perms;
}

/* ============================================================
   ADD NEW CHAMPION — multi-step wizard
   ============================================================ */

// key: the server's module name; label: what the page shows.
const MODULES = [
  { key: "dashboard", label: "Dashboard", icon: "fa-chart-pie" },
  { key: "customers", label: "Customers", icon: "fa-users" },
  { key: "leads", label: "Leads", icon: "fa-bullseye" },
  { key: "accounts", label: "Accounts", icon: "fa-building" },
  { key: "deals", label: "Deals", icon: "fa-handshake" },
  { key: "tasks", label: "Tasks", icon: "fa-list-check" },
  { key: "calendar", label: "Calendar", icon: "fa-calendar-days" },
  { key: "marketing", label: "Marketing", icon: "fa-bullhorn" },
  { key: "automation", label: "Sales Automation", icon: "fa-robot" },
  { key: "support", label: "Support", icon: "fa-headset" },
  { key: "reports", label: "Reports & Analytics", icon: "fa-chart-line" },
  { key: "insights", label: "AI Insights", icon: "fa-brain" },
  { key: "documents", label: "Documents", icon: "fa-file-lines" },
  { key: "products", label: "Products", icon: "fa-box" },
  { key: "settings", label: "Settings", icon: "fa-gear" },
];
const MODULE_LABEL = Object.fromEntries(MODULES.map((m) => [m.key, m.label]));
// A new agent starts with the everyday sales and service pages.
const DEFAULT_AGENT_MODULES = ["dashboard", "customers", "leads", "deals", "tasks", "calendar", "support", "documents", "products"];

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
let editing = null; // the member or invite being changed, null for a new invite

// Build the module checkbox grid once
function buildModuleGrid() {
  const grid = document.getElementById("moduleGrid");
  grid.innerHTML = MODULES.map(
    (m) => `
    <label class="module-item">
      <input type="checkbox" class="module-checkbox" value="${m.key}" />
      <i class="fa-solid ${m.icon}"></i>
      <span>${escapeHtml(m.label)}</span>
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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateStep(step) {
  if (step === 2) {
    const name = document.getElementById("agName").value.trim();
    if (!name) {
      showToast("Give your Champion a name to continue.", "error");
      return false;
    }
    const email = document.getElementById("agEmail").value.trim();
    if (!editing && !EMAIL_PATTERN.test(email)) {
      showToast("Add the email of their Google account — that is how they sign in.", "error");
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

function checkedValues(selector) {
  return Array.from(document.querySelectorAll(selector)).map((cb) => cb.value);
}

function populateReview() {
  const name = document.getElementById("agName").value.trim() || "—";
  const title = document.querySelector('input[name="agRole"]:checked').value;
  const modules = checkedValues(".module-checkbox:checked");
  const perms = checkedValues("#permissionGrid input:checked");
  const { role } = accessFromWizard(modules, perms);

  document.getElementById("agentReviewBox").innerHTML = `
    <div>🎯 <strong>${escapeHtml(name)}</strong> will join as <strong>${escapeHtml(title)}</strong> (${escapeHtml(ROLE_LABELS[role])}).</div>
    <div style="margin-top:8px;">They can open <strong>${modules.length}</strong> page${modules.length === 1 ? "" : "s"}:</div>
    <div>${modules.map((m) => `<span class="review-tag">${escapeHtml(MODULE_LABEL[m] || m)}</span>`).join("")}</div>
    <div style="margin-top:8px;">They're allowed to:</div>
    <div>${perms.map((p) => `<span class="review-tag">${escapeHtml(PERMISSION_LABELS[p] || p)}</span>`).join("") || '<span class="review-tag">Nothing yet</span>'}</div>
    ${role === "viewer" ? '<div style="margin-top:8px;">Without Create or Edit they can only look (Viewer).</div>' : ""}
  `;
}

// person: a member or invite from teamPeople(), or null for a new invite.
function openAgentModal(person = null) {
  editing = person;
  agentForm.reset();
  document.getElementById("agentEditId").value = person ? person.id : "";
  document.getElementById("agentModalTitle").textContent = person
    ? "✏️ Edit Champion"
    : "🏆 Add a New Champion";
  document.getElementById("agentCreateBtn").innerHTML = person
    ? '<i class="fa-solid fa-check"></i> Save Changes'
    : '<i class="fa-solid fa-paper-plane"></i> Create Invite';

  const emailInput = document.getElementById("agEmail");
  emailInput.disabled = Boolean(person);
  if (person) {
    document.getElementById("agName").value = person.kind === "invite" ? person.displayName || "" : person.name || "";
    document.getElementById("agMobile").value = person.mobile || "";
    emailInput.value = person.email || "";
    const roleInput = document.querySelector(`input[name="agRole"][value="${CSS.escape(person.title || "")}"]`);
    if (roleInput) roleInput.checked = true;
    document.querySelectorAll(".module-checkbox").forEach((cb) => {
      cb.checked = (person.modules || []).includes(cb.value);
    });
    const perms = wizardPermissions(person);
    document.querySelectorAll("#permissionGrid input").forEach((cb) => {
      cb.checked = perms.includes(cb.value);
    });
  } else {
    document.querySelectorAll(".module-checkbox").forEach((cb) => {
      cb.checked = DEFAULT_AGENT_MODULES.includes(cb.value);
    });
    document.querySelectorAll("#permissionGrid input").forEach((cb) => {
      cb.checked = ["View", "Create", "Edit"].includes(cb.value);
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

/* ============================================================
   INVITE LINK — shown after an invite is created or renewed
   ============================================================ */

function showInviteLink(email, serverLink) {
  const link = inviteLinkHere(serverLink);
  const companyName = getCompanyInfo()?.name || "our company";
  document.getElementById("inviteLinkEmail").textContent = email;
  document.getElementById("inviteLinkText").textContent = link;
  document.getElementById("whatsappInviteLink").href =
    `https://wa.me/?text=${encodeURIComponent(`Join ${companyName} on YELLOW CRM: ${link}`)}`;
  document.getElementById("inviteLinkBox").hidden = false;
}

document.getElementById("copyInviteBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById("inviteLinkText").textContent);
    showToast("Invite link copied.", "success");
  } catch {
    showToast("Copy failed — select the link and copy it by hand.", "error");
  }
});
document.getElementById("inviteLinkClose").addEventListener("click", () => {
  document.getElementById("inviteLinkBox").hidden = true;
});

async function sendInvite(email, body) {
  return crmApi("/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() },
    body: JSON.stringify({ email, ...body }),
  });
}

agentForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("agName").value.trim();
  if (!name) {
    showToast("Give your Champion a name to continue.", "error");
    goToStep(2);
    return;
  }
  const modules = checkedValues(".module-checkbox:checked");
  const body = {
    ...accessFromWizard(modules, checkedValues("#permissionGrid input:checked")),
    displayName: name,
    mobile: document.getElementById("agMobile").value.trim(),
    title: document.querySelector('input[name="agRole"]:checked').value,
  };

  const createBtn = document.getElementById("agentCreateBtn");
  createBtn.disabled = true;
  try {
    if (editing?.kind === "member") {
      await crmApi(`/members/${editing.id}`, jsonRequest("PATCH", body));
      showToast(`✅ ${name} updated.`, "success");
    } else {
      // A new invite, or a pending one sent again with the new access (its old link stops working).
      const email = editing ? editing.email : document.getElementById("agEmail").value.trim();
      const result = await sendInvite(email, body);
      showInviteLink(email, result.link);
      showToast(editing ? `✅ Invite for ${name} updated — share the new link.` : `🎉 ${name} is invited! Share the link, or ask them to sign in with Google.`, "success");
    }
  } catch (error) {
    showToast(apiErrorMessage(error, "That didn't work. Please try again."), "error");
    return;
  } finally {
    createBtn.disabled = false;
  }
  closeAgentModal();
  await reloadTeam();
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
  // The team-level progress card is not on accounts.html any more.
  if (!document.getElementById("champLevelEmoji")) return;
  const people = teamPeople();
  const count = people.length;
  const level = currentLevel(count);

  document.getElementById("champLevelEmoji").textContent = level.emoji;
  document.getElementById("champLevelLabel").textContent = level.label;
  document.getElementById("champCountSub").textContent =
    `${count} Champion${count === 1 ? "" : "s"} on your team`;

  const nextThreshold = THRESHOLDS.find((t) => t > count) || THRESHOLDS[THRESHOLDS.length - 1];
  const pct = Math.min(100, Math.round((count / nextThreshold) * 100));
  document.getElementById("champProgressFill").style.width = `${pct}%`;

  const hasFullPower = people.some((p) => wizardPermissions(p).includes("Delete"));

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

function statusBadges(person) {
  const badges = [];
  if (String(person.id) === String(getCurrentMember()?.id) && person.kind === "member") badges.push('<span class="badge badge-neutral">You</span>');
  if (person.kind === "invite") {
    badges.push(person.status === "expired"
      ? '<span class="badge badge-danger">Invite expired</span>'
      : '<span class="badge badge-warning">Invited</span>');
  }
  if (person.status === "disabled") badges.push('<span class="badge badge-danger">Disabled</span>');
  return badges.join(" ");
}

function cardActions(person) {
  if (!canManage(person)) return "";
  const id = escapeHtml(person.id);
  if (person.kind === "invite") {
    return `
      <button class="icon-btn edit-agent-btn" data-kind="invite" data-id="${id}" title="Change access"><i class="fa-solid fa-pen"></i></button>
      <button class="icon-btn resend-invite-btn" data-id="${id}" title="New invite link"><i class="fa-solid fa-link"></i></button>
      <button class="icon-btn danger delete-agent-btn" data-kind="invite" data-id="${id}" title="Cancel invite"><i class="fa-solid fa-xmark"></i></button>`;
  }
  return `
      <button class="icon-btn edit-agent-btn" data-kind="member" data-id="${id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
      <button class="icon-btn danger delete-agent-btn" data-kind="member" data-id="${id}" title="Remove from team"><i class="fa-solid fa-trash"></i></button>`;
}

function agentCardHtml(p) {
  const modules = p.modules || [];
  const pages = isManagerRole(p.role)
    ? "All pages"
    : `${modules.length} page${modules.length === 1 ? "" : "s"} unlocked`;
  const perms = wizardPermissions(p);
  return `
      <div class="agent-card">
        <div class="agent-card__top">
          <div class="agent-card__avatar">${escapeHtml(initials(p.name))}</div>
          <div style="min-width:0">
            <div class="agent-card__name">${escapeHtml(p.name)} ${statusBadges(p)}</div>
            <div class="agent-card__role">${escapeHtml(p.title || "Team member")} · ${escapeHtml(ROLE_LABELS[p.role] || p.role)}</div>
          </div>
        </div>
        <div class="agent-card__meta">
          <div><i class="fa-solid fa-envelope" style="width:14px;color:var(--text-faint);"></i> ${escapeHtml(p.email || "—")}</div>
          <div><i class="fa-solid fa-phone" style="width:14px;color:var(--text-faint);"></i> ${escapeHtml(p.mobile || "—")}</div>
        </div>
        <span class="agent-card__modules">${pages}</span>
        <div class="agent-card__perms">
          ${perms.map((key) => `<span class="badge badge-brand">${escapeHtml(PERMISSION_LABELS[key])}</span>`).join("")}
        </div>
        <div class="agent-card__actions">${cardActions(p)}</div>
      </div>`;
}

function renderAgents() {
  const people = teamPeople();
  const invited = people.filter((p) => p.kind === "invite").length;
  document.getElementById("agentCount").textContent =
    `${people.length - invited} member${people.length - invited === 1 ? "" : "s"}${invited ? ` · ${invited} invited` : ""}`;
  document.getElementById("addAgentBtn").style.display = isOrgManager() ? "" : "none";
  const grid = document.getElementById("agentsGrid");

  if (people.length === 0) {
    grid.innerHTML = `<div class="empty-state"><i class="fa-solid fa-user-plus"></i><p>No Champions yet. Click "Add Agent" above to bring your first teammate onboard.</p></div>`;
  } else {
    grid.className = "agents-grid";
    grid.innerHTML = people.map(agentCardHtml).join("");
  }
  renderTeamProgress();
}

document.getElementById("agentsGrid").addEventListener("click", async (e) => {
  const edit = e.target.closest(".edit-agent-btn");
  const remove = e.target.closest(".delete-agent-btn");
  const resend = e.target.closest(".resend-invite-btn");
  if (edit) {
    const person = findPerson(edit.dataset.kind, edit.dataset.id);
    if (person) openAgentModal(person);
    return;
  }
  try {
    if (resend) {
      const person = findPerson("invite", resend.dataset.id);
      const result = await crmApi(`/invites/${resend.dataset.id}/resend`, { method: "POST" });
      showInviteLink(person?.email || "", result.link);
      showToast("New invite link created. The old link no longer works.", "success");
    } else if (remove) {
      const person = findPerson(remove.dataset.kind, remove.dataset.id);
      if (!person) return;
      if (person.kind === "invite") {
        if (!confirm(`Cancel the invite for ${person.name}? The link will stop working.`)) return;
        await crmApi(`/invites/${person.id}`, { method: "DELETE" });
        showToast("Invite cancelled.", "success");
      } else {
        if (!confirm(`Remove ${person.name} from your team? They will lose access right away.`)) return;
        await crmApi(`/members/${person.id}`, { method: "DELETE" });
        showToast(`${person.name} was removed.`, "success");
      }
    } else {
      return;
    }
  } catch (error) {
    showToast(apiErrorMessage(error, "That didn't work. Please try again."), "error");
  }
  await reloadTeam();
});

crmReady(["members", "invites"], renderAgents);
