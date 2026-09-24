/**
 * settings.js — Settings module
 * - Your Profile: edits 'crm_user' (the object app.js's getCurrentUser reads).
 * - Company Profile: edits 'crm_company' via the shared getCompanyInfo/
 *   saveCompanyInfo helpers already in app.js (same object company.html uses).
 * - Team & Access: read-only snapshot pulled from getAgents(); actual
 *   management stays on Account Champions (accounts.html).
 * - Data & Privacy: export/import/reset every 'crm_*' key in localStorage.
 * Reuses shared helpers from app.js (getAgents, getCustomers, getLeads,
 * getAccounts, getProducts, getCompanyInfo, saveCompanyInfo, showToast,
 * renderSidebarUser, initSidebarToggle, requireAuth, getCurrentUser).
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
const PROTECTED_KEYS = new Set([SESSION_KEY]);

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
// Company Profile (reuses getCompanyInfo / saveCompanyInfo from app.js)
// ---------------------------------------------------------------
function loadCompanyForm() {
  const company = getCompanyInfo();
  document.getElementById("cName").value = company?.name || "";
  document.getElementById("cIndustry").value = company?.industry || "";
  document.getElementById("cSize").value = company?.size || "";
  document.getElementById("cFounded").value = company?.founded || "";
  document.getElementById("cLogo").value = company?.logo || "";
  document.getElementById("cWebsite").value = company?.website || "";
  document.getElementById("cEmail").value = company?.email || "";
  document.getElementById("cPhone").value = company?.phone || "";
  document.getElementById("cGst").value = company?.gst || "";
  document.getElementById("cAddress").value = company?.address || "";
  document.getElementById("cCity").value = company?.city || "";
  document.getElementById("cState").value = company?.state || "";
  document.getElementById("cCountry").value = company?.country || "";
  document.getElementById("cPincode").value = company?.pincode || "";
  document.getElementById("cDescription").value = company?.description || "";

  const savedLabel = document.getElementById("companyLastSaved");
  savedLabel.textContent = company ? "Saved" : "Not set up yet";
}

document.getElementById("companyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("cName").value.trim();
  if (!name) {
    showToast("Company name is required.", "error");
    return;
  }
  const data = {
    name,
    industry: document.getElementById("cIndustry").value.trim(),
    size: document.getElementById("cSize").value,
    founded: document.getElementById("cFounded").value,
    logo: document.getElementById("cLogo").value.trim(),
    website: document.getElementById("cWebsite").value.trim(),
    email: document.getElementById("cEmail").value.trim(),
    phone: document.getElementById("cPhone").value.trim(),
    gst: document.getElementById("cGst").value.trim(),
    address: document.getElementById("cAddress").value.trim(),
    city: document.getElementById("cCity").value.trim(),
    state: document.getElementById("cState").value.trim(),
    country: document.getElementById("cCountry").value.trim(),
    pincode: document.getElementById("cPincode").value.trim(),
    description: document.getElementById("cDescription").value.trim(),
  };
  saveCompanyInfo(data);
  document.getElementById("companyLastSaved").textContent = "Saved";
  renderCompanyDashboardCard(); // no-op unless this ran on dashboard.html
  showToast("Company profile saved.", "success");
});

// ---------------------------------------------------------------
// Team & Access — read-only snapshot
// ---------------------------------------------------------------
function renderTeamSummary() {
  const agents = getAgents();
  const el = document.getElementById("teamSummaryList");

  if (!agents.length) {
    el.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-user-plus"></i>
        <p>No agents yet. Add your first one from Account Champions.</p>
      </div>`;
    return;
  }

  el.innerHTML = agents
    .map((a) => {
      const moduleCount = (a.modules || []).length;
      const perms = a.permissions || [];
      return `
      <div class="settings-summary-row">
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="team-avatar" style="width:38px;height:38px;border-radius:50%;background:var(--brand-light,#eef2ff);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12.5px;color:var(--brand-darker,#4338ca);">${initials(a.name)}</div>
          <div class="info">
            <div class="name">${escapeHtml(a.name)}</div>
            <div class="sub">${escapeHtml(a.role || "Agent")} · ${moduleCount} module${moduleCount === 1 ? "" : "s"}</div>
          </div>
        </div>
        <div>
          ${perms.map((p) => `<span class="badge badge-brand" style="margin-left:4px;">${escapeHtml(p)}</span>`).join("") || '<span class="badge badge-neutral">No permissions</span>'}
        </div>
      </div>`;
    })
    .join("");
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
loadCompanyForm();
document.getElementById("connectGmailBtn").addEventListener("click", connectGmail);
loadGmailConnection();
renderTeamSummary();
renderStorageSummary();

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