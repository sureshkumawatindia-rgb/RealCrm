/**
 * settings.js — Settings module
 * - Your Profile: edits 'crm_user' (the object app.js's getCurrentUser reads), uploads the
 *   company logo, connects Gmail and switches between companies.
 * - Company Profile: the organization on the backend (loadCompanyProfile/saveCompanyProfile).
 * - Team & Access: members and invites on the backend; owners/admins manage them.
 * - Data & Privacy: export/import/reset every 'crm_*' key in localStorage.
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

// ---------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------
function initTabs() {
  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
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
    });
  });
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
    user?.name || "Unnamed User";
  document.getElementById("profileEmailPreview").textContent =
    user?.email || "";
  const img = document.getElementById("profileAvatarPreview");
  if (user?.picture) {
    img.src = user.picture;
    img.style.visibility = "visible";
  } else {
    img.style.visibility = "hidden";
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
        <strong>Upload your logo</strong>
        <span>Drag &amp; drop your logo here or <span class="logo-browse">Browse</span></span>
        <span>PNG, JPG, JPEG, SVG, WebP · Max 2 MB</span>
      </div>`;
    return;
  }
  zone.innerHTML = `
    <div class="logo-preview">
      <img alt="CRM logo preview" />
      <div class="logo-preview-actions">
        <button class="logo-action" type="button" data-logo-action="change">Change Logo</button>
        <button class="logo-action" type="button" data-logo-action="remove">Remove Logo</button>
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
    setLogoUploadError("Invalid file type. Choose a PNG, JPG, JPEG, SVG, or WebP image.");
    return;
  }
  if (file.size > LOGO_MAX_SIZE) {
    setLogoUploadError("File size must be less than 2 MB.");
    return;
  }
  setLogoUploadError();
  selectedLogo = file;
  const reader = new FileReader();
  reader.onload = () => renderLogoUpload(reader.result);
  reader.onerror = () => {
    selectedLogo = null;
    setLogoUploadError("Logo upload failed. Please try again.");
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
    setLogoUploadError(error.message || "Couldn't load company profile.");
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
    showToast("Logo removed.", "success");
  } catch (error) {
    showToast(error.message || "Logo removal failed.", "error");
  }
}

async function uploadSelectedLogo() {
  const formData = new FormData();
  formData.append("logo", selectedLogo);
  organization = await crmApi("/organization/logo", { method: "POST", body: formData });
  selectedLogo = null;
  renderLogoUpload(organization.logoUrl);
}

function setGmailStatus(message, isError = false) {
  const status = document.getElementById("gmailConnectionStatus");
  const error = document.getElementById("gmailConnectionError");
  if (status) status.textContent = isError ? "Connection failed" : message;
  if (error) {
    error.textContent = isError ? message : "";
    error.hidden = !isError;
  }
}

async function loadGmailConnection() {
  try {
    const connection = await crmApi("/gmail/connection");
    if (!connection.connected) {
      setGmailStatus("Not connected");
      return;
    }
    setGmailStatus(`Connected as ${connection.emailAddress}`);
    const profile = await crmApi("/gmail/profile");
    setGmailStatus(`Connected as ${profile.emailAddress} · ${profile.messagesTotal || 0} messages`);
  } catch (error) {
    setGmailStatus(error.message || "Unable to fetch Gmail connection.", true);
  }
}

function showGmailCallbackResult() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("gmail");
  if (result === "connected") {
    showToast(`Gmail connected as ${params.get("email") || "your account"}.`, "success");
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (result === "error") {
    setGmailStatus(`Google authorization failed: ${params.get("reason") || "unknown error"}`, true);
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

async function connectGmail() {
  const button = document.getElementById("connectGmailBtn");
  button.disabled = true;
  setGmailStatus("Opening Google authorization...");
  try {
    const result = await crmApi("/gmail/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnUrl: window.location.href }),
    });
    window.location.assign(result.authorizationUrl);
  } catch (error) {
    button.disabled = false;
    setGmailStatus(error.message || "Unable to start Gmail authorization.", true);
  }
}

document.getElementById("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("uName").value.trim();
  const email = document.getElementById("uEmail").value.trim();
  if (!name || !email) {
    showToast("Name and email are required.", "error");
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
    showToast(selectedLogo ? "Profile updated." : "Profile updated.", "success");
  } catch (error) {
    showToast(error.message || "Logo upload failed. Please try again.", "error");
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
  savedLabel.textContent = "Loading…";
  try {
    const { company, localOnly } = await loadCompanyProfile();
    fillCompanyForm(company);
    savedLabel.textContent = localOnly ? "Only in this browser" : companyHasDetails(company) ? "Saved" : "Not set up yet";
    if (localOnly) setCompanyNote("These details are only saved in this browser. Click Save Company Profile to share them with your team.");
  } catch (error) {
    fillCompanyForm(getCompanyInfo());
    savedLabel.textContent = "";
    setCompanyNote(apiErrorMessage(error, "Couldn't load the company profile."));
  }
  if (!isOrgManager()) {
    document.querySelectorAll("#companyForm input, #companyForm select, #companyForm textarea, #companyForm button")
      .forEach((input) => { input.disabled = true; });
    setCompanyNote("Only an owner or admin can edit the company profile.");
  }
}

document.getElementById("companyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = readCompanyForm();
  if (!data.name) {
    showToast("Company name is required.", "error");
    return;
  }
  try {
    await saveCompanyProfile(data);
    document.getElementById("companyLastSaved").textContent = "Saved";
    setCompanyNote("");
    renderCompanyDashboardCard(); // no-op unless this ran on dashboard.html
    showToast("Company profile saved.", "success");
  } catch (error) {
    showToast(apiErrorMessage(error, "Couldn't save the company profile."), "error");
  }
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
  document.getElementById("teamCount").textContent = `${members.length} member${members.length === 1 ? "" : "s"}`;

  el.innerHTML = members
    .map((m) => {
      const isSelf = String(m.id) === String(me?.id);
      const editable = isOrgManager() && !isSelf && (me.role === "owner" || !["owner", "admin"].includes(m.role));
      const access = ["owner", "admin"].includes(m.role)
        ? "All modules"
        : `${m.modules.length} module${m.modules.length === 1 ? "" : "s"}`;
      return `
      <div class="settings-summary-row">
        <div style="display:flex; align-items:center; gap:12px; min-width:0;">
          <div class="team-avatar" style="width:38px;height:38px;flex-shrink:0;border-radius:50%;background:var(--brand-light,#eef2ff);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12.5px;color:var(--brand-darker,#4338ca);">${escapeHtml(initials(m.name || m.email))}</div>
          <div class="info" style="min-width:0;">
            <div class="name">${escapeHtml(m.name || m.email)}${isSelf ? ' <span class="badge badge-neutral">You</span>' : ""}${m.status === "disabled" ? ' <span class="badge badge-danger">Disabled</span>' : ""}</div>
            <div class="sub">${escapeHtml(m.email)} · ${access}</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          ${editable
            ? `<select data-member-role="${escapeHtml(m.id)}" aria-label="Role">${roleOptions(m.role)}</select>
               <button class="icon-btn danger" type="button" data-remove-member="${escapeHtml(m.id)}" data-member-name="${escapeHtml(m.name || m.email)}" title="Remove from team"><i class="fa-solid fa-user-minus"></i></button>`
            : `<span class="badge badge-brand">${ROLE_LABELS[m.role] || escapeHtml(m.role)}</span>`}
        </div>
      </div>`;
    })
    .join("");
}

async function loadTeam() {
  const el = document.getElementById("teamMemberList");
  el.innerHTML = `<p class="settings-hint">Loading team…</p>`;
  try {
    renderMembers(await crmApi("/members?limit=100"));
  } catch (error) {
    el.innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, "Couldn't load the team."))}</p>`;
  }
  document.getElementById("inviteSection").hidden = !isOrgManager();
  if (isOrgManager()) loadInvites();
}

document.getElementById("teamMemberList").addEventListener("change", async (e) => {
  const select = e.target.closest("[data-member-role]");
  if (!select) return;
  try {
    await crmApi(`/members/${select.dataset.memberRole}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: select.value }),
    });
    showToast(`Role changed to ${ROLE_LABELS[select.value]}.`, "success");
  } catch (error) {
    showToast(apiErrorMessage(error, "Couldn't change the role."), "error");
  }
  loadTeam();
});

document.getElementById("teamMemberList").addEventListener("click", async (e) => {
  const button = e.target.closest("[data-remove-member]");
  if (!button) return;
  if (!confirm(`Remove ${button.dataset.memberName} from the team? They will lose access right away.`)) return;
  try {
    await crmApi(`/members/${button.dataset.removeMember}`, { method: "DELETE" });
    showToast("Member removed.", "success");
  } catch (error) {
    showToast(apiErrorMessage(error, "Couldn't remove the member."), "error");
  }
  loadTeam();
});

function showInviteLink(email, serverLink) {
  // Share the sign-in page of the address this CRM is open on (the one Google already
  // accepts for this team), not the server's default address.
  const token = new URL(serverLink).searchParams.get("invite");
  const link = new URL(`login.html?invite=${encodeURIComponent(token)}`, window.location.href).toString();
  const companyName = getCompanyInfo()?.name || "our company";
  document.getElementById("inviteLinkEmail").textContent = email;
  document.getElementById("inviteLinkText").textContent = link;
  document.getElementById("whatsappInviteLink").href =
    `https://wa.me/?text=${encodeURIComponent(`Join ${companyName} on YELLOW CRM: ${link}`)}`;
  document.getElementById("inviteLinkBox").hidden = false;
}

document.getElementById("copyInviteBtn").addEventListener("click", async () => {
  const link = document.getElementById("inviteLinkText").textContent;
  try {
    await navigator.clipboard.writeText(link);
    showToast("Invite link copied.", "success");
  } catch {
    showToast("Copy failed — select the link and copy it by hand.", "error");
  }
});

function renderInvites(invites) {
  const el = document.getElementById("pendingInviteList");
  if (!invites.length) {
    el.innerHTML = `<p class="settings-hint" style="margin:0">No pending invites.</p>`;
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
          <div class="sub">${ROLE_LABELS[invite.role] || escapeHtml(invite.role)} · ${expired ? "Expired" : `Link valid until ${escapeHtml(when)}`}</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-outline" type="button" data-resend-invite="${escapeHtml(invite.id)}" data-invite-email="${escapeHtml(invite.email)}">
            <i class="fa-solid fa-link"></i> New Link
          </button>
          <button class="icon-btn danger" type="button" data-revoke-invite="${escapeHtml(invite.id)}" title="Cancel invite"><i class="fa-solid fa-xmark"></i></button>
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
    el.innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, "Couldn't load invites."))}</p>`;
  }
}

document.getElementById("pendingInviteList").addEventListener("click", async (e) => {
  const resend = e.target.closest("[data-resend-invite]");
  const revoke = e.target.closest("[data-revoke-invite]");
  try {
    if (resend) {
      const result = await crmApi(`/invites/${resend.dataset.resendInvite}/resend`, { method: "POST" });
      showInviteLink(resend.dataset.inviteEmail, result.link);
      showToast("New invite link created. The old link no longer works.", "success");
    } else if (revoke) {
      if (!confirm("Cancel this invite? The link will stop working.")) return;
      await crmApi(`/invites/${revoke.dataset.revokeInvite}`, { method: "DELETE" });
      showToast("Invite cancelled.", "success");
    } else {
      return;
    }
  } catch (error) {
    showToast(apiErrorMessage(error, "That didn't work. Please try again."), "error");
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
    showToast("Invite created. Share the link with them.", "success");
    loadInvites();
  } catch (error) {
    showToast(apiErrorMessage(error, "Couldn't create the invite."), "error");
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
          ? '<span class="badge badge-success">Current</span>'
          : `<button class="btn btn-outline" type="button" data-switch-org="${escapeHtml(m.organizationId)}">Switch</button>`}
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
    showToast(apiErrorMessage(error, "Couldn't switch company."), "error");
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
  crm_customers: "Customers",
  crm_leads: "Leads",
  crm_accounts: "Accounts",
  crm_agents: "Agents",
  crm_products: "Products",
  crm_deals: "Deals",
  crm_deal_tasks: "Deal Follow-up Tasks",
  crm_tasks: "Tasks",
  crm_calendar_events: "Calendar Events",
  crm_campaigns: "Campaigns",
  crm_workflows: "Workflows",
  crm_sequences: "Sequences",
};

function renderStorageSummary() {
  const el = document.getElementById("storageSummaryList");
  const rows = Object.keys(STORAGE_LABELS)
    .map((key) => {
      const raw = localStorage.getItem(key);
      const count = raw ? safeParseCount(raw) : 0;
      return { key, label: STORAGE_LABELS[key], count: count ?? 0 };
    })
    .filter((r) => r.count > 0 || localStorage.getItem(r.key));

  if (!rows.length) {
    el.innerHTML = `<p class="settings-hint">No data stored yet — start adding customers, leads, or deals and they'll show up here.</p>`;
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
  products: "Products",
  customers: "Customers",
  accounts: "Accounts",
  leads: "Leads",
  deals: "Deals",
  leadActivities: "Lead activity",
  quotations: "Quotations",
  tasks: "Tasks",
  dealFollowUps: "Deal follow-ups",
  events: "Calendar events",
  tickets: "Support tickets",
  ticketNotes: "Ticket replies",
  customerNotes: "Customer notes",
  documents: "Documents",
  campaigns: "Campaigns",
  campaignNotes: "Campaign notes",
  workflows: "Workflows",
  sequences: "Sequences",
};
const LATER_LABELS = {
  crm_agents: "Account Champions",
};
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
        `${section.created} ${preview ? "to add" : "added"}`,
        section.alreadyImported ? `${section.alreadyImported} already on the server` : "",
        section.merged ? `${section.merged} matched an existing contact` : "",
        section.rejected ? `${section.rejected} skipped` : "",
      ].filter(Boolean);
      return `
        <div class="settings-summary-row">
          <div class="info">
            <div class="name">${escapeHtml(IMPORT_SECTION_LABELS[name] || name)}</div>
            <div class="sub">${escapeHtml(parts.join(" · "))}</div>
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
    <p class="settings-hint" style="margin:0 0 10px">${preview ? "Preview — nothing has been saved yet." : "Done. Your team now sees these records."}</p>
    ${rows || '<p class="settings-hint">No customers, leads, deals, products or quotations found in this browser.</p>'}
    ${later ? `<p class="settings-hint" style="margin-top:10px">Moves in a later update (still safe in this browser): ${escapeHtml(later)}.</p>` : ""}
    ${notes.length ? `<p class="settings-hint" style="margin-top:10px"><strong>Please check:</strong><br>${notes.map(escapeHtml).join("<br>")}</p>` : ""}`;
}

async function moveBrowserDataToServer() {
  const button = document.getElementById("serverImportBtn");
  const data = browserDataForImport();
  if (!Object.keys(data).length) {
    showToast("There is no CRM data in this browser.", "info");
    return;
  }
  button.disabled = true;
  try {
    const preview = await crmApi("/imports/localstorage", jsonRequest("POST", { data, dryRun: true }));
    renderImportReport(preview.report, { preview: true });
    const toAdd = Object.values(preview.report.sections || {}).reduce((sum, section) => sum + section.created, 0);
    if (!toAdd) {
      showToast("Everything in this browser is already on the server.", "success");
      return;
    }
    if (!confirm(`Move ${toAdd} record${toAdd === 1 ? "" : "s"} to the server now? Nothing in this browser is deleted.`)) return;
    const result = await crmApi("/imports/localstorage", jsonRequest("POST", { data, dryRun: false }));
    renderImportReport(result.report, { preview: false });
    showToast("Your browser data is now on the server.", "success");
  } catch (error) {
    showToast(apiErrorMessage(error, "Couldn't move the data."), "error");
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
  showToast("Backup downloaded.", "success");
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
      showToast("That file isn't valid JSON.", "error");
      return;
    }
    const keys = Object.keys(parsed).filter(
      (k) => k.startsWith("crm_") && !PROTECTED_KEYS.has(k),
    );
    if (!keys.length) {
      showToast("No recognizable CRM data found in that file.", "error");
      return;
    }
    if (
      !confirm(
        `This will overwrite ${keys.length} data set${keys.length === 1 ? "" : "s"} with the contents of the file. Continue?`,
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
    showToast("Data imported. Reloading...", "success");
    setTimeout(() => window.location.reload(), 900);
  };
  reader.onerror = () => showToast("Couldn't read that file.", "error");
  reader.readAsText(file);
}

function resetAllData() {
  const keys = crmKeys().filter(
    (k) => !PROTECTED_KEYS.has(k) && k !== USER_KEY,
  );
  if (!keys.length) {
    showToast("There's nothing to reset.", "info");
    return;
  }
  const confirmed = confirm(
    `Delete all CRM data (${keys.length} data set${keys.length === 1 ? "" : "s"})? This can't be undone. You'll stay signed in.`,
  );
  if (!confirmed) return;

  keys.forEach((key) => localStorage.removeItem(key));
  showToast("All CRM data cleared. Reloading...", "success");
  setTimeout(() => window.location.reload(), 900);
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
initTabs();
activateRequestedTab();
showGmailCallbackResult();
loadProfileForm();
loadMembershipSections();
document.getElementById("connectGmailBtn").addEventListener("click", connectGmail);
loadGmailConnection();
renderStorageSummary();

document.getElementById("serverImportSection").hidden = !isOrgManager();
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