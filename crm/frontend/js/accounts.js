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
const PERMISSION_LABELS = { View: "acct.perm.view", Create: "acct.perm.create", Edit: "acct.perm.edit", Delete: "acct.perm.delete", ViewAll: "acct.perm.viewAll" }; // the keys of their texts

function accessFromWizard(modules, perms) {
  const role = perms.includes("Create") || perms.includes("Edit") ? "agent" : "viewer";
  const permissions = [];
  if (role === "agent" && perms.includes("Delete")) modules.forEach((m) => permissions.push(`${m}:delete`));
  if (perms.includes("ViewAll")) modules.forEach((m) => permissions.push(`${m}:view_all`));
  return { role, modules, permissions };
}

function wizardPermissions(person) {
  if (isManagerRole(person.role)) return Object.keys(PERMISSION_LABELS);
  const perms = ["View"]; // i18n-ok: permission values (PERMISSION_LABELS has their texts)
  if (person.role === "agent") perms.push("Create", "Edit"); // i18n-ok: permission values
  const grants = person.permissions || [];
  if (grants.some((p) => p.endsWith(":delete"))) perms.push("Delete"); // i18n-ok: permission values
  if (grants.some((p) => p.endsWith(":view_all"))) perms.push("ViewAll");
  return perms;
}

/* ============================================================
   ADD NEW CHAMPION — multi-step wizard
   ============================================================ */

// key: the server's module name; label: the key of what the page shows (the menu's names).
const MODULES = [
  { key: "dashboard", label: "nav.dashboard", icon: "fa-chart-pie" },
  { key: "inbox", label: "nav.inbox", icon: "fa-comments" },
  { key: "customers", label: "nav.customers", icon: "fa-users" },
  { key: "leads", label: "nav.leads", icon: "fa-bullseye" },
  { key: "accounts", label: "nav.accounts", icon: "fa-building" },
  { key: "deals", label: "nav.deals", icon: "fa-handshake" },
  { key: "tasks", label: "nav.tasks", icon: "fa-list-check" },
  { key: "projects", label: "nav.projects", icon: "fa-briefcase" },
  { key: "calendar", label: "nav.calendar", icon: "fa-calendar-days" },
  { key: "marketing", label: "nav.marketing", icon: "fa-bullhorn" },
  { key: "automation", label: "nav.automation", icon: "fa-robot" },
  { key: "support", label: "nav.support", icon: "fa-headset" },
  { key: "reports", label: "nav.reports", icon: "fa-chart-line" },
  { key: "insights", label: "nav.aiInsights", icon: "fa-brain" },
  { key: "documents", label: "nav.documents", icon: "fa-file-lines" },
  { key: "products", label: "nav.products", icon: "fa-box" },
  { key: "settings", label: "nav.settings", icon: "fa-gear" },
];
const MODULE_LABEL = Object.fromEntries(MODULES.map((m) => [m.key, m.label]));
// A new agent starts with the everyday sales and service pages.
const DEFAULT_AGENT_MODULES = ["dashboard", "inbox", "customers", "leads", "deals", "tasks", "calendar", "support", "documents", "products", "projects"];

const agentModalOverlay = document.getElementById("agentModalOverlay");
const agentForm = document.getElementById("agentForm");
const STEP_LABELS = {
  1: "acct.step.welcome", // the keys of their texts
  2: "acct.step.about",
  3: "acct.step.role",
  4: "acct.step.access",
  5: "acct.step.powers",
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
      <span>${escapeHtml(t(m.label))}</span>
    </label>`,
  ).join("");
}
crmI18n.ready.then(buildModuleGrid); // its labels are texts

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
  document.getElementById("agentStepLabel").textContent = t(STEP_LABELS[step]);

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
      showToast(t("acct.give-your-champion-a-name-to"), "error");
      return false;
    }
    const email = document.getElementById("agEmail").value.trim();
    if (!editing && !EMAIL_PATTERN.test(email)) {
      showToast(t("acct.add-the-email-of-their-google"), "error");
      return false;
    }
  }
  if (step === 4) {
    const anyModule = document.querySelectorAll(
      ".module-checkbox:checked",
    ).length;
    if (anyModule === 0) {
      showToast(
        t("acct.unlock-at-least-one-page-for"),
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
    <div>🎯 ${t("acct.review.joinAs", { name: `<strong>${escapeHtml(name)}</strong>`, title: `<strong>${escapeHtml(title)}</strong>`, role: escapeHtml(ROLE_LABELS[role]) })}</div>
    <div style="margin-top:8px;">${t(modules.length === 1 ? "acct.review.pages.one" : "acct.review.pages.many", { n: `<strong>${modules.length}</strong>` })}</div>
    <div>${modules.map((m) => `<span class="review-tag">${escapeHtml(MODULE_LABEL[m] ? t(MODULE_LABEL[m]) : m)}</span>`).join("")}</div>
    <div style="margin-top:8px;">${escapeHtml(t("acct.review.allowed"))}</div>
    <div>${perms.map((p) => `<span class="review-tag">${escapeHtml(PERMISSION_LABELS[p] ? t(PERMISSION_LABELS[p]) : p)}</span>`).join("") || `<span class="review-tag">${escapeHtml(t("acct.review.nothing"))}</span>`}</div>
    ${role === "viewer" ? `<div style="margin-top:8px;">${escapeHtml(t("acct.review.viewerOnly", { viewer: ROLE_LABELS.viewer }))}</div>` : ""}
  `;
}

// person: a member or invite from teamPeople(), or null for a new invite.
function openAgentModal(person = null) {
  editing = person;
  agentForm.reset();
  document.getElementById("agentEditId").value = person ? person.id : "";
  document.getElementById("agentModalTitle").textContent = person
    ? t("acct.edit-champion")
    : t("acct.add-a-new-champion");
  document.getElementById("agentCreateBtn").innerHTML = person
    ? `<i class="fa-solid fa-check"></i> ${escapeHtml(t("acct.saveChanges"))}`
    : `<i class="fa-solid fa-paper-plane"></i> ${escapeHtml(t("acct.createInvite"))}`;

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
      cb.checked = ["View", "Create", "Edit"].includes(cb.value); // i18n-ok: permission values
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
  const companyName = getCompanyInfo()?.name || t("invite.our-company");
  document.getElementById("inviteLinkEmail").textContent = email;
  document.getElementById("inviteLinkText").textContent = link;
  document.getElementById("whatsappInviteLink").href =
    `https://wa.me/?text=${encodeURIComponent(t("acct.join-on-yellow-crm", { companyName, link }))}`;
  document.getElementById("inviteLinkBox").hidden = false;
}

document.getElementById("copyInviteBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById("inviteLinkText").textContent);
    showToast(t("acct.invite-link-copied"), "success");
  } catch {
    showToast(t("wa.link.copyFailed"), "error");
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
    showToast(t("acct.give-your-champion-a-name-to"), "error");
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
      showToast(t("acct.updated", { name }), "success");
    } else {
      // A new invite, or a pending one sent again with the new access (its old link stops working).
      const email = editing ? editing.email : document.getElementById("agEmail").value.trim();
      const result = await sendInvite(email, body);
      showInviteLink(email, result.link);
      showToast(editing ? t("acct.invite-for-updated-share-the-new", { name }) : t("acct.is-invited-share-the-link-or", { name }), "success");
    }
  } catch (error) {
    showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
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

const LEVELS = [ // label: the key of its text
  { min: 0, emoji: "🌱", label: "acct.level.start" },
  { min: 1, emoji: "🥉", label: "acct.level.bronze" },
  { min: 3, emoji: "🥈", label: "acct.level.silver" },
  { min: 6, emoji: "🥇", label: "acct.level.gold" },
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
  document.getElementById("champLevelLabel").textContent = t(level.label);
  document.getElementById("champCountSub").textContent =
    t(count === 1 ? "acct.champions.one" : "acct.champions.many", { n: count });

  const nextThreshold = THRESHOLDS.find((t) => t > count) || THRESHOLDS[THRESHOLDS.length - 1];
  const pct = Math.min(100, Math.round((count / nextThreshold) * 100));
  document.getElementById("champProgressFill").style.width = `${pct}%`;

  const hasFullPower = people.some((p) => wizardPermissions(p).includes("Delete"));

  const milestones = [
    { done: count >= 1, label: t("acct.add-your-first-champion") },
    { done: count >= 3, label: t("acct.build-a-squad-3-champions") },
    { done: count >= 6, label: t("acct.go-for-gold-6-champions") },
    { done: hasFullPower, label: t("acct.trust-someone-with-full-power-create") },
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
  if (String(person.id) === String(getCurrentMember()?.id) && person.kind === "member") badges.push(`<span class="badge badge-neutral">${escapeHtml(t("set2.you"))}</span>`);
  if (person.kind === "invite") {
    badges.push(person.status === "expired"
      ? `<span class="badge badge-danger">${escapeHtml(t("acct.inviteExpired"))}</span>`
      : `<span class="badge badge-warning">${escapeHtml(t("acct.invited"))}</span>`);
  }
  if (person.status === "disabled") badges.push(`<span class="badge badge-danger">${escapeHtml(t("set2.disabled"))}</span>`);
  return badges.join(" ");
}

function cardActions(person) {
  if (!canManage(person)) return "";
  const id = escapeHtml(person.id);
  if (person.kind === "invite") {
    return `
      <button class="icon-btn edit-agent-btn" data-kind="invite" data-id="${id}" title="${escapeHtml(t("acct.changeAccess"))}"><i class="fa-solid fa-pen"></i></button>
      <button class="icon-btn resend-invite-btn" data-id="${id}" title="${escapeHtml(t("acct.newInviteLink"))}"><i class="fa-solid fa-link"></i></button>
      <button class="icon-btn danger delete-agent-btn" data-kind="invite" data-id="${id}" title="${escapeHtml(t("set2.cancelInvite"))}"><i class="fa-solid fa-xmark"></i></button>`;
  }
  return `
      <button class="icon-btn edit-agent-btn" data-kind="member" data-id="${id}" title="${escapeHtml(t("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
      <button class="icon-btn danger delete-agent-btn" data-kind="member" data-id="${id}" title="${escapeHtml(t("set2.removeFromTeam"))}"><i class="fa-solid fa-trash"></i></button>`;
}

function agentCardHtml(p) {
  const modules = p.modules || [];
  const pages = isManagerRole(p.role)
    ? t("acct.all-pages")
    : t(modules.length === 1 ? "acct.pages.one" : "acct.pages.many", { n: modules.length });
  const perms = wizardPermissions(p);
  return `
      <div class="agent-card">
        <div class="agent-card__top">
          <div class="agent-card__avatar">${escapeHtml(initials(p.name))}</div>
          <div style="min-width:0">
            <div class="agent-card__name">${escapeHtml(p.name)} ${statusBadges(p)}</div>
            <div class="agent-card__role">${escapeHtml(p.title || t("acct.team-member"))} · ${escapeHtml(ROLE_LABELS[p.role] || p.role)}</div>
          </div>
        </div>
        <div class="agent-card__meta">
          <div><i class="fa-solid fa-envelope" style="width:14px;color:var(--text-faint);"></i> ${escapeHtml(p.email || "—")}</div>
          <div><i class="fa-solid fa-phone" style="width:14px;color:var(--text-faint);"></i> ${escapeHtml(p.mobile || "—")}</div>
        </div>
        <span class="agent-card__modules">${pages}</span>
        <div class="agent-card__perms">
          ${perms.map((key) => `<span class="badge badge-brand">${escapeHtml(t(PERMISSION_LABELS[key]))}</span>`).join("")}
        </div>
        <div class="agent-card__actions">${cardActions(p)}</div>
      </div>`;
}

function renderAgents() {
  const people = teamPeople();
  const invited = people.filter((p) => p.kind === "invite").length;
  document.getElementById("agentCount").textContent =
    t(people.length - invited === 1 ? "acct.members.one" : "acct.members.many", { n: people.length - invited }) + (invited ? t("acct.invitedCount", { n: invited }) : "");
  document.getElementById("addAgentBtn").style.display = isOrgManager() ? "" : "none";
  const grid = document.getElementById("agentsGrid");

  if (people.length === 0) {
    grid.innerHTML = `<div class="empty-state"><i class="fa-solid fa-user-plus"></i><p>${escapeHtml(t("acct.no-champions-yet-click-add-agent"))}</p></div>`;
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
      showToast(t("acct.new-invite-link-created-the-old"), "success");
    } else if (remove) {
      const person = findPerson(remove.dataset.kind, remove.dataset.id);
      if (!person) return;
      if (person.kind === "invite") {
        if (!confirm(t("acct.cancel-the-invite-for-the-link", { name: person.name }))) return;
        await crmApi(`/invites/${person.id}`, { method: "DELETE" });
        showToast(t("acct.invite-cancelled"), "success");
      } else {
        if (!confirm(t("acct.remove-from-your-team-they-will", { name: person.name }))) return;
        await crmApi(`/members/${person.id}`, { method: "DELETE" });
        showToast(t("acct.was-removed", { name: person.name }), "success");
      }
    } else {
      return;
    }
  } catch (error) {
    showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
  }
  await reloadTeam();
});

crmReady(["members", "invites"], renderAgents);
