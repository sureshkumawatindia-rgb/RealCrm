/**
 * settings.js — Settings module
 * - Your Profile: edits 'crm_user' (the object app.js's getCurrentUser reads), uploads the
 *   company logo, connects Gmail and switches between companies.
 * - Company Profile: the organization on the backend (loadCompanyProfile/saveCompanyProfile).
 * - Team & Access: members and invites on the backend; owners/admins manage them.
 * - Data & Privacy: download the server data (owners/admins), move the old browser data to the
 *   server, and export/import/reset the old 'crm_*' keys left in localStorage.
 * Reuses shared helpers from app.js (crmApi, getCompanyInfo, fillCompanyForm, readCompanyForm,
 * getCurrentMember, isOrgManager, showToast, renderSidebarUser, initSidebarToggle, requireAuth).
 */

requireAuth();
renderSidebarUser();
initSidebarToggle();

const USER_KEY = "crm_user";
const SESSION_KEY = "crm_session";
const LOGO_MAX_SIZE = 2 * 1024 * 1024;
const LOGO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
]);
let selectedLogo = null;
let organization = null;

// Keys not touched by Export / Import / Reset — session token stays put
// so importing a backup or resetting data never logs the user out.
const PROTECTED_KEYS = new Set([SESSION_KEY, "crm_member"]);

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

// ---------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------
// Phones (R2): Settings opens as a list of its sections (Settings.html styles); a section the
// person picks opens on its own, and "All settings" or the phone's back button returns to the
// list. The section is in the address (?tab=), like links from other pages.
const settingsPhone = window.matchMedia("(max-width: 600px)");
function setSettingsView(view) {
  document.getElementById("settingsPage").dataset.settingsView = view;
}

function initTabs() {
  setSettingsView(new URLSearchParams(window.location.search).get("tab") ? "panel" : "menu");
  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.insertAdjacentHTML("beforeend", '<i class="fa-solid fa-chevron-right settings-tab-go" aria-hidden="true"></i>');
    tab.addEventListener("click", (event) => {
      document
        .querySelectorAll(".settings-tab")
        .forEach((t) => t.classList.remove("active"));
      document
        .querySelectorAll(".settings-panel")
        .forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document
        .querySelector(`[data-settings-panel="${tab.dataset.panel}"]`)
        .classList.add("active");
      // Picked by the person from the phone's list (not opened by the page itself).
      if (event.isTrusted && settingsPhone.matches) {
        setSettingsView("panel");
        window.history.pushState({ settingsPanel: tab.dataset.panel }, "", `?tab=${tab.dataset.panel}`);
        window.scrollTo(0, 0);
      }
    });
  });
  document.getElementById("settingsBack").addEventListener("click", () => {
    if (window.history.state?.settingsPanel) {
      window.history.back();
      return;
    }
    setSettingsView("menu");
    window.history.replaceState(null, "", window.location.pathname);
    window.scrollTo(0, 0);
  });
  window.addEventListener("popstate", (event) => {
    const panel = event.state?.settingsPanel;
    if (panel) document.querySelector(`.settings-tab[data-panel="${panel}"]`)?.click();
    setSettingsView(panel ? "panel" : "menu");
  });
}

// Owners/admins only: someone else who follows a link to this tab sees their profile instead.
function leaveManagerTab(panel) {
  if (document.querySelector(`[data-settings-panel="${panel}"]`)?.classList.contains("active")) {
    document.querySelector('.settings-tab[data-panel="profile"]')?.click();
  }
}

function activateRequestedTab() {
  const tabName = new URLSearchParams(window.location.search).get("tab");
  if (!tabName) return;
  const tab = document.querySelector(`.settings-tab[data-panel="${tabName}"]`);
  if (tab) tab.click();
}

// ---------------------------------------------------------------
// Your Profile
// ---------------------------------------------------------------
function saveCurrentUser(data) {
  localStorage.setItem(USER_KEY, JSON.stringify(data));
}

function renderProfilePreview(user) {
  document.getElementById("profileNamePreview").textContent =
    user?.name || t("set2.unnamed-user");
  document.getElementById("profileEmailPreview").textContent =
    user?.email || "";
  // The Google photo, else the name's initials (also when the photo does not load).
  const img = document.getElementById("profileAvatarPreview");
  const letters = document.getElementById("profileAvatarInitials");
  letters.textContent = initials(user?.name || user?.email || "");
  const showLetters = () => {
    img.hidden = true;
    letters.hidden = false;
  };
  if (user?.picture) {
    img.onerror = showLetters;
    img.onload = () => {
      img.hidden = false;
      letters.hidden = true;
    };
    img.src = user.picture;
  } else {
    showLetters();
  }
}

function setLogoUploadError(message = "") {
  const error = document.getElementById("logoUploadError");
  error.textContent = message;
  error.hidden = !message;
}

function renderLogoUpload(source) {
  const zone = document.getElementById("logoUploadZone");
  if (!source) {
    zone.innerHTML = `
      <div class="logo-upload-content">
        <i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i>
        <strong>${escapeHtml(t("set.upload-your-logo"))}</strong>
        <span>${escapeHtml(t("set2.drag-drop-your-logo-here-or"))} <span class="logo-browse">${escapeHtml(t("set2.browse"))}</span></span>
        <span>${escapeHtml(t("set2.png-jpg-jpeg-svg-webp-max"))}</span>
      </div>`;
    return;
  }
  zone.innerHTML = `
    <div class="logo-preview">
      <img alt="${escapeHtml(t("set2.logoPreview"))}" />
      <div class="logo-preview-actions">
        <button class="logo-action" type="button" data-logo-action="change">${escapeHtml(t("set2.change-logo"))}</button>
        <button class="logo-action" type="button" data-logo-action="remove">${escapeHtml(t("set2.remove-logo"))}</button>
      </div>
    </div>`;
  const preview = zone.querySelector("img");
  preview.src = source;
  preview.addEventListener("error", () => {
    // Sirf ek retry karo (OneDrive/slow-disk se transient load fail ho sakta hai),
    // turant placeholder pe reset mat karo warna successful save bhi "failed" dikhega.
    if (preview.dataset.retried) return;
    preview.dataset.retried = "true";
    setTimeout(() => {
      preview.src = `${source}${source.includes("?") ? "&" : "?"}retry=${Date.now()}`;
    }, 500);
  });
}

function readLogoFile(file) {
  if (!file) return;
  const extension = file.name.toLowerCase().split(".").pop();
  const allowedExtensions = new Set(["png", "jpg", "jpeg", "svg", "webp"]);
  if (!LOGO_TYPES.has(file.type) || !allowedExtensions.has(extension)) {
    setLogoUploadError(t("set2.invalid-file-type-choose-a-png"));
    return;
  }
  if (file.size > LOGO_MAX_SIZE) {
    setLogoUploadError(t("set2.file-size-must-be-less-than"));
    return;
  }
  setLogoUploadError();
  selectedLogo = file;
  const reader = new FileReader();
  reader.onload = () => renderLogoUpload(reader.result);
  reader.onerror = () => {
    selectedLogo = null;
    setLogoUploadError(t("set2.logo-upload-failed-please-try-again"));
    renderLogoUpload("");
  };
  reader.readAsDataURL(file);
}

function initLogoUpload(user) {
  const input = document.getElementById("uLogo");
  const zone = document.getElementById("logoUploadZone");
  selectedLogo = null;
  renderLogoUpload(user?.logoUrl || "");
  zone.addEventListener("click", (event) => {
    const action = event.target.closest("[data-logo-action]")?.dataset.logoAction;
    if (action === "remove") {
      removeLogo();
      return;
    }
    input.click();
  });
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => {
    readLogoFile(input.files[0]);
    input.value = "";
  });
  ["dragenter", "dragover"].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove("is-dragover");
    });
  });
  zone.addEventListener("drop", (event) => readLogoFile(event.dataTransfer.files[0]));
}

async function loadProfileForm() {
  const user = getCurrentUser() || {};
  document.getElementById("uName").value = user.name || "";
  document.getElementById("uEmail").value = user.email || "";
  document.getElementById("uPicture").value = user.picture || "";
  try {
    organization = await crmApi("/organization");
    renderLogoUpload(organization.logoUrl || "");
  } catch (error) {
    setLogoUploadError(error.message || t("set2.couldn-t-load-company-profile"));
    renderLogoUpload("");
  }
  renderProfilePreview(user);
  initLogoUpload({ ...user, logoUrl: organization?.logoUrl || "" });
}

async function removeLogo() {
  try {
    organization = await crmApi("/organization/logo", { method: "DELETE" });
    selectedLogo = null;
    document.getElementById("uLogo").value = "";
    renderLogoUpload("");
    showToast(t("set2.logo-removed"), "success");
  } catch (error) {
    showToast(error.message || t("set2.logo-removal-failed"), "error");
  }
}

async function uploadSelectedLogo() {
  const formData = new FormData();
  formData.append("logo", selectedLogo);
  organization = await crmApi("/organization/logo", { method: "POST", body: formData });
  selectedLogo = null;
  renderLogoUpload(organization.logoUrl);
}

document.getElementById("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("uName").value.trim();
  const email = document.getElementById("uEmail").value.trim();
  if (!name || !email) {
    showToast(t("customers.nameEmailRequired"), "error");
    return;
  }
  const existing = getCurrentUser() || {};
  const updated = {
    ...existing,
    name,
    email,
    picture: document.getElementById("uPicture").value.trim(),
  };
  try {
    if (selectedLogo) await uploadSelectedLogo();
    saveCurrentUser(updated);
    renderSidebarUser();
    renderProfilePreview(updated);
    showToast(selectedLogo ? t("set2.profile-updated") : t("set2.profile-updated"), "success");
  } catch (error) {
    showToast(error.message || t("set2.logo-upload-failed-please-try-again"), "error");
  }
});

// ---------------------------------------------------------------
// Company Profile (the organization on the backend)
// ---------------------------------------------------------------
function setCompanyNote(message) {
  const note = document.getElementById("companyFormNote");
  note.textContent = message;
  note.hidden = !message;
}

async function loadCompanyForm() {
  const savedLabel = document.getElementById("companyLastSaved");
  savedLabel.textContent = t("bulkbar.loading");
  try {
    const { company, localOnly } = await loadCompanyProfile();
    fillCompanyForm(company);
    renderWorkspaceCode(company?.slug);
    savedLabel.textContent = localOnly ? t("set2.only-in-this-browser") : companyHasDetails(company) ? t("proj.settingsSaved") : t("set2.not-set-up-yet");
    if (localOnly) setCompanyNote(t("set2.these-details-are-only-saved-in"));
  } catch (error) {
    fillCompanyForm(getCompanyInfo());
    renderWorkspaceCode(getCompanyInfo()?.slug);
    savedLabel.textContent = "";
    setCompanyNote(apiErrorMessage(error, t("set2.couldn-t-load-the-company-profile")));
  }
  if (!isOrgManager()) {
    document.querySelectorAll("#companyForm input, #companyForm select, #companyForm textarea, #companyForm button")
      .forEach((input) => { input.disabled = true; });
    setCompanyNote(t("set2.only-an-owner-or-admin-can"));
  }
}

document.getElementById("companyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = readCompanyForm();
  if (!data.name) {
    showToast(t("set2.company-name-is-required"), "error");
    return;
  }
  const typeBefore = getCompanyInfo()?.crmType || "business";
  try {
    const organization = await saveCompanyProfile(data);
    if (organization.crmType !== typeBefore) { // the menu, the words and the set-up all change
      window.location.href = "Settings.html?tab=company";
      return;
    }
    renderWorkspaceCode(organization.slug); // a code made from the name follows a new name
    document.getElementById("companyLastSaved").textContent = t("proj.settingsSaved");
    setCompanyNote("");
    renderCompanyDashboardCard(); // no-op unless this ran on dashboard.html
    showToast(t("set2.company-profile-saved"), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, t("set2.couldn-t-save-the-company-profile")), "error");
  }
});

// ---------------------------------------------------------------
// Company → Login: the workspace code typed on the login page (D66). Everyone sees it and can
// copy the login link (login.html?company=…); owners and admins can change it.
// ---------------------------------------------------------------
const loginLinkFor = (code) => `${new URL("login.html", window.location.href).href}?company=${encodeURIComponent(code)}`;

function renderWorkspaceCode(code) {
  document.getElementById("workspaceCode").textContent = code || "—";
  document.getElementById("loginLinkText").textContent = code ? loginLinkFor(code) : "";
  document.getElementById("copyLoginLinkBtn").disabled = !code;
  document.getElementById("editWorkspaceCodeBtn").hidden = !code || !isOrgManager();
}

function closeWorkspaceCodeForm() {
  document.getElementById("workspaceCodeForm").hidden = true;
  document.getElementById("editWorkspaceCodeBtn").focus();
}

document.getElementById("copyLoginLinkBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById("loginLinkText").textContent);
    showToast(t("set2.login-link-copied"), "success");
  } catch {
    showToast(t("wa.link.copyFailed"), "error");
  }
});

document.getElementById("editWorkspaceCodeBtn").addEventListener("click", () => {
  const input = document.getElementById("workspaceCodeInput");
  input.value = document.getElementById("workspaceCode").textContent;
  document.getElementById("workspaceCodeForm").hidden = false;
  input.focus();
  input.select();
});
document.getElementById("cancelWorkspaceCodeBtn").addEventListener("click", closeWorkspaceCodeForm);

// Spaces become hyphens and letters small as it is typed, like the code will be.
document.getElementById("workspaceCodeInput").addEventListener("input", (event) => {
  const tidy = event.target.value.toLowerCase().replace(/[\s_]+/g, "-");
  if (tidy !== event.target.value) event.target.value = tidy;
});

document.getElementById("workspaceCodeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const slug = document.getElementById("workspaceCodeInput").value.trim().replace(/^-+|-+$/g, "");
  if (slug === document.getElementById("workspaceCode").textContent) return closeWorkspaceCodeForm();
  const button = document.getElementById("saveWorkspaceCodeBtn");
  button.disabled = true;
  try {
    const organization = await saveCompanyProfile({ slug });
    renderWorkspaceCode(organization.slug);
    closeWorkspaceCodeForm();
    showToast(t("set2.workspace-code-saved-tell-your-team"), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, t("set2.couldn-t-save-the-workspace-code")), "error");
    document.getElementById("workspaceCodeInput").focus();
  } finally {
    button.disabled = false;
  }
  return undefined;
});

// ---------------------------------------------------------------
// Team & Access — members and invites (owners/admins manage them)
// ---------------------------------------------------------------

// Refreshes the saved membership (role may have changed) and returns /auth/me.
async function refreshMembership() {
  const me = await crmApi("/auth/me");
  localStorage.setItem("crm_member", JSON.stringify({ ...me.member, organizationId: me.organization.id }));
  return me;
}

function roleOptions(current) {
  const assignable = getCurrentMember()?.role === "owner" ? ["owner", "admin", "agent", "viewer"] : ["agent", "viewer"];
  return assignable
    .map((role) => `<option value="${role}"${role === current ? " selected" : ""}>${ROLE_LABELS[role]}</option>`)
    .join("");
}

function renderMembers(members) {
  const me = getCurrentMember();
  const el = document.getElementById("teamMemberList");
  document.getElementById("teamCount").textContent = t(members.length === 1 ? "set2.members.one" : "set2.members.many", { n: members.length });

  el.innerHTML = members
    .map((m) => {
      const isSelf = String(m.id) === String(me?.id);
      const editable = isOrgManager() && !isSelf && (me.role === "owner" || !["owner", "admin"].includes(m.role));
      const access = ["owner", "admin"].includes(m.role)
        ? t("set2.all-modules")
        : t(m.modules.length === 1 ? "set2.modules.one" : "set2.modules.many", { n: m.modules.length });
      return `
      <div class="settings-summary-row">
        <div style="display:flex; align-items:center; gap:12px; min-width:0;">
          <div class="team-avatar" style="width:38px;height:38px;flex-shrink:0;border-radius:50%;background:var(--brand-light,#eef2ff);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12.5px;color:var(--brand-darker,#4338ca);">${escapeHtml(initials(m.name || m.email))}</div>
          <div class="info" style="min-width:0;">
            <div class="name">${escapeHtml(m.name || m.email)}${isSelf ? ` <span class="badge badge-neutral">${escapeHtml(t("set2.you"))}</span>` : ""}${m.status === "disabled" ? ` <span class="badge badge-danger">${escapeHtml(t("set2.disabled"))}</span>` : ""}</div>
            <div class="sub">${escapeHtml(m.email)} · ${access}</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          ${editable
            ? `<select data-member-role="${escapeHtml(m.id)}" aria-label="${escapeHtml(t("set.role"))}">${roleOptions(m.role)}</select>
               ${m.totpEnabled ? `<button class="icon-btn" type="button" data-reset-totp="${escapeHtml(m.id)}" data-member-name="${escapeHtml(m.name || m.email)}" title="${escapeHtml(t("set2.resetTotp"))}"><i class="fa-solid fa-shield-halved"></i></button>` : ""}
               <button class="icon-btn danger" type="button" data-remove-member="${escapeHtml(m.id)}" data-member-name="${escapeHtml(m.name || m.email)}" title="${escapeHtml(t("set2.removeFromTeam"))}"><i class="fa-solid fa-user-minus"></i></button>`
            : `<span class="badge badge-brand">${ROLE_LABELS[m.role] || escapeHtml(m.role)}</span>`}
        </div>
      </div>`;
    })
    .join("");
}

async function loadTeam() {
  const el = document.getElementById("teamMemberList");
  el.innerHTML = `<p class="settings-hint">${escapeHtml(t("set2.loading-team"))}</p>`;
  try {
    renderMembers(await crmApi("/members?limit=100"));
  } catch (error) {
    el.innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, t("set2.couldn-t-load-the-team")))}</p>`;
  }
  document.getElementById("inviteSection").hidden = !isOrgManager();
  if (isOrgManager()) loadInvites();
  loadPhonePrivacy();
}

// "Hide customer phone numbers from agents" (D65): owners and admins switch it; agents and
// viewers see a line saying it is on.
async function loadPhonePrivacy() {
  const section = document.getElementById("phonePrivacySection");
  try {
    const { hidePhonesFromAgents } = await crmApi("/organization/settings");
    document.getElementById("hidePhonesToggle").checked = hidePhonesFromAgents;
    document.getElementById("hidePhonesRow").hidden = !isOrgManager();
    document.getElementById("hidePhonesInfo").hidden = isOrgManager() || !hidePhonesFromAgents;
    section.hidden = !isOrgManager() && !hidePhonesFromAgents;
  } catch {
    section.hidden = true;
  }
}
document.getElementById("hidePhonesToggle").addEventListener("change", async (event) => {
  const toggle = event.target;
  toggle.disabled = true;
  try {
    const { hidePhonesFromAgents } = await crmApi("/organization/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidePhonesFromAgents: toggle.checked }),
    });
    toggle.checked = hidePhonesFromAgents;
    showToast(hidePhonesFromAgents ? t("set2.agents-now-see-customers-numbers-masked") : t("set2.agents-now-see-customers-full-numbers"), "success");
  } catch (error) {
    toggle.checked = !toggle.checked;
    showToast(apiErrorMessage(error, t("wa.receipts.failed")), "error");
  } finally {
    toggle.disabled = false;
  }
});

document.getElementById("teamMemberList").addEventListener("change", async (e) => {
  const select = e.target.closest("[data-member-role]");
  if (!select) return;
  try {
    await crmApi(`/members/${select.dataset.memberRole}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: select.value }),
    });
    showToast(t("set2.role-changed-to", { v: ROLE_LABELS[select.value] }), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, t("set2.couldn-t-change-the-role")), "error");
  }
  loadTeam();
});

document.getElementById("teamMemberList").addEventListener("click", async (e) => {
  // A teammate lost the phone with their authenticator app (F7).
  const reset = e.target.closest("[data-reset-totp]");
  if (reset) {
    if (!confirm(t("set2.turn-off-2-step-login-for", { memberName: reset.dataset.memberName }))) return;
    try {
      await crmApi(`/members/${reset.dataset.resetTotp}/totp-reset`, { method: "POST" });
      showToast(t("set2.2-step-login-turned-off-they"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("set2.couldn-t-turn-it-off")), "error");
    }
    loadTeam();
    return;
  }
  const button = e.target.closest("[data-remove-member]");
  if (!button) return;
  if (!confirm(t("set2.remove-from-the-team-they-will", { memberName: button.dataset.memberName }))) return;
  try {
    await crmApi(`/members/${button.dataset.removeMember}`, { method: "DELETE" });
    showToast(t("set2.member-removed"), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, t("set2.couldn-t-remove-the-member")), "error");
  }
  loadTeam();
});

function showInviteLink(email, serverLink) {
  const link = inviteLinkHere(serverLink);
  const companyName = getCompanyInfo()?.name || t("set2.our-company");
  document.getElementById("inviteLinkEmail").textContent = email;
  document.getElementById("inviteLinkText").textContent = link;
  document.getElementById("whatsappInviteLink").href =
    `https://wa.me/?text=${encodeURIComponent(t("set2.join-on-yellow-crm", { companyName, link }))}`;
  document.getElementById("inviteLinkBox").hidden = false;
}

document.getElementById("copyInviteBtn").addEventListener("click", async () => {
  const link = document.getElementById("inviteLinkText").textContent;
  try {
    await navigator.clipboard.writeText(link);
    showToast(t("set2.invite-link-copied"), "success");
  } catch {
    showToast(t("wa.link.copyFailed"), "error");
  }
});

function renderInvites(invites) {
  const el = document.getElementById("pendingInviteList");
  if (!invites.length) {
    el.innerHTML = `<p class="settings-hint" style="margin:0">${escapeHtml(t("set2.no-pending-invites"))}</p>`;
    return;
  }
  el.innerHTML = invites
    .map((invite) => {
      const expired = invite.status === "expired";
      const when = new Date(invite.expiresAt).toLocaleDateString();
      return `
      <div class="settings-summary-row">
        <div class="info" style="min-width:0;">
          <div class="name">${escapeHtml(invite.email)}</div>
          <div class="sub">${ROLE_LABELS[invite.role] || escapeHtml(invite.role)} · ${expired ? escapeHtml(t("set2.expired")) : escapeHtml(t("set2.linkValidUntil", { when }))}</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-outline" type="button" data-resend-invite="${escapeHtml(invite.id)}" data-invite-email="${escapeHtml(invite.email)}">
            <i class="fa-solid fa-link"></i> ${escapeHtml(t("set2.new-link"))}
          </button>
          <button class="icon-btn danger" type="button" data-revoke-invite="${escapeHtml(invite.id)}" title="${escapeHtml(t("set2.cancelInvite"))}"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>`;
    })
    .join("");
}

async function loadInvites() {
  const el = document.getElementById("pendingInviteList");
  try {
    renderInvites(await crmApi("/invites?status=pending&limit=100"));
  } catch (error) {
    el.innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, t("set2.couldn-t-load-invites")))}</p>`;
  }
}

document.getElementById("pendingInviteList").addEventListener("click", async (e) => {
  const resend = e.target.closest("[data-resend-invite]");
  const revoke = e.target.closest("[data-revoke-invite]");
  try {
    if (resend) {
      const result = await crmApi(`/invites/${resend.dataset.resendInvite}/resend`, { method: "POST" });
      showInviteLink(resend.dataset.inviteEmail, result.link);
      showToast(result.emailed ? t("set2.new-invite-link-emailed-to-them") : t("set2.new-invite-link-created-the-old"), "success");
    } else if (revoke) {
      if (!confirm(t("set2.cancel-this-invite-the-link-will"))) return;
      await crmApi(`/invites/${revoke.dataset.revokeInvite}`, { method: "DELETE" });
      showToast(t("set2.invite-cancelled"), "success");
    } else {
      return;
    }
  } catch (error) {
    showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
  }
  loadInvites();
});

document.getElementById("inviteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("inviteEmail").value.trim();
  const role = document.getElementById("inviteRole").value;
  const button = document.getElementById("inviteSubmitBtn");
  button.disabled = true;
  try {
    const result = await crmApi("/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ email, role }),
    });
    showInviteLink(email, result.link);
    document.getElementById("inviteForm").reset();
    // D104: emailed too when the platform sends emails.
    showToast(result.emailed ? t("set2.invite-emailed-to-you-can-also", { email }) : t("set2.invite-created-share-the-link-with"), "success");
    loadInvites();
  } catch (error) {
    showToast(apiErrorMessage(error, t("set2.couldn-t-create-the-invite")), "error");
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------
// Your Companies — switch between organizations
// ---------------------------------------------------------------
function renderCompanySwitcher(me) {
  const section = document.getElementById("companySwitchSection");
  if (me.memberships.length < 2) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  document.getElementById("companySwitchList").innerHTML = me.memberships
    .map((m) => {
      const active = String(m.organizationId) === String(me.organization.id);
      return `
      <div class="settings-summary-row">
        <div class="info">
          <div class="name">${escapeHtml(m.organizationName)}</div>
          <div class="sub">${ROLE_LABELS[m.role] || escapeHtml(m.role)}</div>
        </div>
        ${active
          ? `<span class="badge badge-success">${escapeHtml(t("set2.current"))}</span>`
          : `<button class="btn btn-outline" type="button" data-switch-org="${escapeHtml(m.organizationId)}">${escapeHtml(t("set2.switch"))}</button>`}
      </div>`;
    })
    .join("");
}

document.getElementById("companySwitchList").addEventListener("click", async (e) => {
  const button = e.target.closest("[data-switch-org]");
  if (!button) return;
  try {
    const result = await crmApi("/auth/switch-organization", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: button.dataset.switchOrg }),
    });
    localStorage.setItem("crm_session", result.token);
    localStorage.setItem("crm_member", JSON.stringify({ ...result.member, organizationId: result.organizationId }));
    localStorage.removeItem("crm_company");
    window.location.href = "dashboard.html";
  } catch (error) {
    showToast(apiErrorMessage(error, t("set2.couldn-t-switch-company")), "error");
  }
});

async function loadMembershipSections() {
  try {
    renderCompanySwitcher(await refreshMembership());
  } catch {
    // Keep the saved membership; the team list below reports API problems.
  }
  loadCompanyForm();
  loadTeam();
}

// ---------------------------------------------------------------
// Data & Privacy
// ---------------------------------------------------------------
function crmKeys() {
  return Object.keys(localStorage).filter((k) => k.startsWith("crm_"));
}
function safeParseCount(raw) {
  try {
    const val = JSON.parse(raw);
    return Array.isArray(val) ? val.length : null;
  } catch {
    return null;
  }
}

const STORAGE_LABELS = {
  // The texts' keys (D116), looked up when the list is drawn.
  crm_customers: "nav.customers",
  crm_leads: "nav.leads",
  crm_accounts: "set2.store.accounts",
  crm_agents: "set2.store.agents",
  crm_products: "nav.products",
  crm_deals: "nav.deals",
  crm_deal_tasks: "set2.store.dealTasks",
  crm_tasks: "nav.tasks",
  crm_calendar_events: "set2.store.events",
  crm_campaigns: "set2.store.campaigns",
  crm_workflows: "set2.store.workflows",
  crm_sequences: "set2.store.sequences",
};

function renderStorageSummary() {
  const el = document.getElementById("storageSummaryList");
  const rows = Object.keys(STORAGE_LABELS)
    .map((key) => {
      const raw = localStorage.getItem(key);
      const count = raw ? safeParseCount(raw) : 0;
      return { key, label: t(STORAGE_LABELS[key]), count: count ?? 0 };
    })
    .filter((r) => r.count > 0 || localStorage.getItem(r.key));

  if (!rows.length) {
    el.innerHTML = `<p class="settings-hint">${escapeHtml(t("set2.no-data-stored-yet-start-adding"))}</p>`;
    return;
  }

  el.innerHTML = rows
    .map(
      (r) => `
      <div class="settings-summary-row">
        <div class="info">
          <div class="name">${r.label}</div>
        </div>
        <span class="badge badge-info">${r.count}</span>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------
// Move my browser data to server (owners/admins)
// ---------------------------------------------------------------
const IMPORT_SECTION_LABELS = {
  // The texts' keys (D116), looked up when the report is drawn.
  products: "nav.products",
  customers: "nav.customers",
  accounts: "set2.store.accounts",
  leads: "nav.leads",
  deals: "nav.deals",
  leadActivities: "set2.imp.leadActivity",
  quotations: "nav.quotations",
  tasks: "nav.tasks",
  dealFollowUps: "set2.imp.dealFollowUps",
  events: "set2.store.events",
  tickets: "set2.imp.tickets",
  ticketNotes: "set2.imp.ticketNotes",
  customerNotes: "set2.imp.customerNotes",
  documents: "nav.documents",
  campaigns: "set2.store.campaigns",
  campaignNotes: "set2.imp.campaignNotes",
  workflows: "set2.store.workflows",
  sequences: "set2.store.sequences",
  teamInvites: "set2.imp.teamInvites",
};
// Browser keys that move in a later update (none left since Account Champions moved).
const LATER_LABELS = {};
// Session and settings keys are never sent.
const NOT_IMPORTED = new Set([SESSION_KEY, USER_KEY, "crm_member", "crm_company", "crm_ticket_seq", "crm_deals_demo_cleared"]);

function browserDataForImport() {
  const data = {};
  crmKeys().forEach((key) => {
    if (!NOT_IMPORTED.has(key)) data[key] = localStorage.getItem(key);
  });
  return data;
}

function renderImportReport(report, { preview }) {
  const rows = Object.entries(report.sections || {})
    .filter(([, section]) => section.found)
    .map(([name, section]) => {
      const parts = [
        t(preview ? "set2.imp.toAdd" : "set2.imp.added", { n: section.created }),
        section.alreadyImported ? t("set2.moved-before", { alreadyImported: section.alreadyImported }) : "",
        section.merged ? t("set2.matched-an-existing-contact", { merged: section.merged }) : "",
        section.rejected ? t("set2.imp.skipped", { n: section.rejected }) : "",
      ].filter(Boolean);
      // Why records were skipped (a few distinct reasons), e.g. "Rohan has no valid email".
      const reasons = [...new Set((section.rejectedRows || []).map((row) => row.reason))].slice(0, 3);
      return `
        <div class="settings-summary-row">
          <div class="info">
            <div class="name">${escapeHtml(IMPORT_SECTION_LABELS[name] ? t(IMPORT_SECTION_LABELS[name]) : name)}</div>
            <div class="sub">${escapeHtml(parts.join(" · "))}</div>
            ${reasons.length ? `<div class="sub">${escapeHtml(t("set2.imp.skippedWhy", { why: reasons.join("; ") }))}</div>` : ""}
          </div>
          <span class="badge badge-info">${section.found}</span>
        </div>`;
    })
    .join("");
  const later = Object.entries(report.later || {})
    .map(([key, count]) => `${LATER_LABELS[key] || key} (${count})`)
    .join(", ");
  const notes = [...(report.unresolved || []), ...(report.problems || []).map((p) => `${p.key}: ${p.reason}`)].slice(0, 10);
  document.getElementById("serverImportReport").innerHTML = `
    <p class="settings-hint" style="margin:0 0 10px">${preview ? t("set2.preview-nothing-has-been-saved-yet") : t("set2.done-your-team-now-sees-these")}</p>
    ${rows || `<p class="settings-hint">${escapeHtml(t("set2.imp.nothingFound"))}</p>`}
    ${later ? `<p class="settings-hint" style="margin-top:10px">${escapeHtml(t("set2.imp.later", { list: later }))}</p>` : ""}
    ${notes.length ? `<p class="settings-hint" style="margin-top:10px"><strong>${escapeHtml(t("set2.please-check"))}</strong><br>${notes.map(escapeHtml).join("<br>")}</p>` : ""}`;
}

async function moveBrowserDataToServer() {
  const button = document.getElementById("serverImportBtn");
  const data = browserDataForImport();
  if (!Object.keys(data).length) {
    showToast(t("set2.there-is-no-crm-data-in"), "info");
    return;
  }
  button.disabled = true;
  try {
    const preview = await crmApi("/imports/localstorage", jsonRequest("POST", { data, dryRun: true }));
    renderImportReport(preview.report, { preview: true });
    const toAdd = Object.values(preview.report.sections || {}).reduce((sum, section) => sum + section.created, 0);
    if (!toAdd) {
      showToast(t("set2.everything-in-this-browser-is-already"), "success");
      return;
    }
    if (!confirm(t(toAdd === 1 ? "set2.moveConfirm.one" : "set2.moveConfirm.many", { n: toAdd }))) return;
    const result = await crmApi("/imports/localstorage", jsonRequest("POST", { data, dryRun: false }));
    renderImportReport(result.report, { preview: false });
    showToast(t("set2.your-browser-data-is-now-on"), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, t("set2.couldn-t-move-the-data")), "error");
  } finally {
    button.disabled = false;
  }
}

// Export — bundles every crm_* key (raw, already-serialized strings)
// except the session token, so importing elsewhere won't hijack a login.
function exportAllData() {
  const backup = {};
  crmKeys().forEach((key) => {
    if (PROTECTED_KEYS.has(key)) return;
    backup[key] = localStorage.getItem(key);
  });

  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `crm-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(t("set2.backup-downloaded"), "success");
}

// Import — restores raw string values for any crm_* key found in the
// file, skipping the session token so the current login stays intact.
function importAllData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      showToast(t("set2.that-file-isn-t-valid-json"), "error");
      return;
    }
    const keys = Object.keys(parsed).filter(
      (k) => k.startsWith("crm_") && !PROTECTED_KEYS.has(k),
    );
    if (!keys.length) {
      showToast(t("set2.no-recognizable-crm-data-found-in"), "error");
      return;
    }
    if (
      !confirm(
        t(keys.length === 1 ? "set2.overwriteConfirm.one" : "set2.overwriteConfirm.many", { n: keys.length }),
      )
    ) {
      return;
    }
    keys.forEach((key) => {
      const value = parsed[key];
      localStorage.setItem(
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      );
    });
    showToast(t("set2.data-imported-reloading"), "success");
    setTimeout(() => window.location.reload(), 900);
  };
  reader.onerror = () => showToast(t("set2.couldn-t-read-that-file"), "error");
  reader.readAsText(file);
}

function resetAllData() {
  const keys = crmKeys().filter(
    (k) => !PROTECTED_KEYS.has(k) && k !== USER_KEY,
  );
  if (!keys.length) {
    showToast(t("set2.there-s-nothing-to-reset"), "info");
    return;
  }
  const confirmed = confirm(
    t(keys.length === 1 ? "set2.clearConfirm.one" : "set2.clearConfirm.many", { n: keys.length }),
  );
  if (!confirmed) return;

  keys.forEach((key) => localStorage.removeItem(key));
  showToast(t("set2.all-crm-data-cleared-reloading"), "success");
  setTimeout(() => window.location.reload(), 900);
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
initTabs();
activateRequestedTab();
loadProfileForm();
loadMembershipSections();
crmI18n.ready.then(renderStorageSummary); // its labels are texts

document.getElementById("serverImportSection").hidden = !isOrgManager();
document.getElementById("gettingStartedSection").hidden = !isOrgManager(); // D117
document.getElementById("serverExportSection").hidden = !isOrgManager();
document.getElementById("serverExportBtn").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    await crmDownload("/exports/crm", `crm-export-${new Date().toISOString().slice(0, 10)}.json`);
    showToast(t("set2.crm-data-downloaded"), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, t("set2.couldn-t-download-the-crm-data")), "error");
  } finally {
    button.disabled = false;
  }
});
document.getElementById("serverImportBtn").addEventListener("click", moveBrowserDataToServer);
document.getElementById("exportBtn").addEventListener("click", exportAllData);
document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importFileInput").click();
});
document.getElementById("importFileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) importAllData(file);
  e.target.value = "";
});
document.getElementById("resetBtn").addEventListener("click", resetAllData);