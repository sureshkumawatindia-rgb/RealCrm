/**
 * marketing.js — Marketing module (Campaign Kanban + Table)
 * Persists to localStorage under 'crm_campaigns'.
 * Reuses shared helpers from app.js (getAgents, showToast,
 * renderSidebarUser, initSidebarToggle, requireAuth).
 */

const CAMPAIGNS_KEY = "crm_campaigns";

const STATUSES = ["Draft", "Scheduled", "Active", "Paused", "Completed"];
const STATUS_DOT = {
  Draft: "var(--text-faint)",
  Scheduled: "var(--info)",
  Active: "var(--success)",
  Paused: "var(--warning)",
  Completed: "var(--brand-darker)",
};
const STATUS_BADGE_CLASS = {
  Draft: "badge-status-draft",
  Scheduled: "badge-status-scheduled",
  Active: "badge-status-active",
  Paused: "badge-status-paused",
  Completed: "badge-status-completed",
};
const TYPE_ICON = {
  Email: "fa-envelope",
  Social: "fa-hashtag",
  SMS: "fa-comment-sms",
  Ads: "fa-rectangle-ad",
  Event: "fa-calendar-star",
};

let currentView = "kanban";
let draggingId = null;

// ---------------------------------------------------------------
// Storage
// ---------------------------------------------------------------
function getCampaigns() {
  const raw = localStorage.getItem(CAMPAIGNS_KEY);
  return raw ? JSON.parse(raw) : [];
}
function saveCampaigns(list) {
  localStorage.setItem(CAMPAIGNS_KEY, JSON.stringify(list));
}
function addCampaign(campaign) {
  const list = getCampaigns();
  campaign.id =
    "cm_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  campaign.createdAt = new Date().toISOString();
  campaign.notes = [];
  list.unshift(campaign);
  saveCampaigns(list);
  return campaign;
}
function updateCampaign(id, patch) {
  const list = getCampaigns();
  const idx = list.findIndex((c) => c.id === id);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...patch };
    saveCampaigns(list);
  }
  return list[idx];
}
function deleteCampaign(id) {
  saveCampaigns(getCampaigns().filter((c) => c.id !== id));
}
function getCampaign(id) {
  return getCampaigns().find((c) => c.id === id);
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
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function ownerNames() {
  return getAgents().map((a) => a.name);
}

// ---------------------------------------------------------------
// Filters
// ---------------------------------------------------------------
function getFilteredCampaigns() {
  const q = (document.getElementById("searchInput").value || "")
    .toLowerCase()
    .trim();
  const type = document.getElementById("filterType").value;
  const status = document.getElementById("filterStatus").value;
  const owner = document.getElementById("filterOwner").value;

  return getCampaigns().filter((c) => {
    if (q) {
      const hay =
        `${c.name} ${c.owner || ""} ${c.audience || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (type !== "all" && c.type !== type) return false;
    if (status !== "all" && c.status !== status) return false;
    if (owner !== "all" && c.owner !== owner) return false;
    return true;
  });
}

// ---------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------
function renderKpis() {
  const campaigns = getCampaigns();
  const active = campaigns.filter((c) => c.status === "Active");
  const totalBudget = campaigns.reduce((s, c) => s + Number(c.budget || 0), 0);
  const totalLeads = campaigns.reduce(
    (s, c) => s + Number(c.leadsGenerated || 0),
    0,
  );

  const cards = [
    { label: "Total Campaigns", value: campaigns.length, cls: "" },
    { label: "Active Campaigns", value: active.length, cls: "success" },
    { label: "Total Budget", value: formatCurrency(totalBudget), cls: "info" },
    { label: "Leads Generated", value: totalLeads, cls: "warning" },
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
  const campaigns = getFilteredCampaigns();
  const board = document.getElementById("kanbanView");

  board.innerHTML = STATUSES.map((status) => {
    const statusCampaigns = campaigns.filter((c) => c.status === status);
    const totalBudget = statusCampaigns.reduce(
      (s, c) => s + Number(c.budget || 0),
      0,
    );

    const cardsHtml = statusCampaigns.length
      ? statusCampaigns.map((c) => campaignCardHtml(c)).join("")
      : `<div class="kanban-col-empty">No campaigns</div>`;

    return `
      <div class="kanban-col" data-status="${status}">
        <div class="kanban-col-head">
          <div class="kanban-col-head-title">
            <span class="kanban-dot" style="background:${STATUS_DOT[status]}"></span>
            <h4>${status}</h4>
          </div>
          <span class="kanban-count">${statusCampaigns.length}</span>
        </div>
        <div class="kanban-col-value">${formatCurrency(totalBudget)} budget</div>
        <div class="kanban-col-body" data-drop-status="${status}">
          ${cardsHtml}
        </div>
      </div>`;
  }).join("");

  attachDragEvents();
}

function campaignCardHtml(c) {
  const overdue =
    c.endDate && c.status !== "Completed" && c.endDate < todayStr();
  return `
    <div class="campaign-card" draggable="true" data-id="${c.id}">
      <div class="campaign-card__top">
        <div class="campaign-card__name">${escapeHtml(c.name)}</div>
        <span class="campaign-card__type"><i class="fa-solid ${TYPE_ICON[c.type] || "fa-bullhorn"}"></i> ${escapeHtml(c.type || "")}</span>
      </div>
      ${c.audience ? `<div class="campaign-card__audience"><i class="fa-solid fa-users"></i> ${escapeHtml(c.audience)}</div>` : ""}
      <div class="campaign-card__stats">
        <span>Budget: <strong>${formatCurrency(c.budget)}</strong></span>
        <span>Leads: <strong>${c.leadsGenerated || 0}</strong></span>
      </div>
      <div class="campaign-card__foot">
        <div class="campaign-card__owner">
          <span class="campaign-card__owner-avatar">${initials(c.owner)}</span>
          ${escapeHtml((c.owner || "").split(" ")[0] || "Unassigned")}
        </div>
        <div class="campaign-card__date ${overdue ? "overdue" : ""}">
          ${overdue ? '<i class="fa-solid fa-triangle-exclamation"></i> ' : ""}${formatDate(c.startDate)}
        </div>
      </div>
    </div>`;
}

function attachDragEvents() {
  document.querySelectorAll(".campaign-card").forEach((card) => {
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
      const newStatus = col.dataset.status;
      const campaign = getCampaign(draggingId);
      if (!campaign || campaign.status === newStatus) return;
      updateCampaign(draggingId, { status: newStatus });
      showToast(`Moved "${campaign.name}" to ${newStatus}`, "success");
      renderAll();
    });
  });
}

// ---------------------------------------------------------------
// Table view
// ---------------------------------------------------------------
function renderTable() {
  const campaigns = getFilteredCampaigns();
  const wrap = document.getElementById("campaignsTable");

  if (!campaigns.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-bullhorn"></i>
        <div>No campaigns match your filters.</div>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Campaign</th>
          <th>Type</th>
          <th>Status</th>
          <th>Budget</th>
          <th>Leads</th>
          <th>Start Date</th>
          <th>Owner</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${campaigns
          .map(
            (c) => `
          <tr data-id="${c.id}">
            <td><strong>${escapeHtml(c.name)}</strong></td>
            <td>${escapeHtml(c.type)}</td>
            <td><span class="badge ${STATUS_BADGE_CLASS[c.status]}">${c.status}</span></td>
            <td>${formatCurrency(c.budget)}</td>
            <td>${c.leadsGenerated || 0}</td>
            <td>${formatDate(c.startDate)}</td>
            <td>${escapeHtml(c.owner || "—")}</td>
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-row" data-id="${c.id}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-row" data-id="${c.id}"><i class="fa-solid fa-trash"></i></button>
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
// Right panel — Owners
// ---------------------------------------------------------------
function renderTeamTab() {
  const campaigns = getCampaigns();
  const agents = getAgents();
  const names = agents.length
    ? agents.map((a) => a.name)
    : [...new Set(campaigns.map((c) => c.owner).filter(Boolean))];

  const el = document.getElementById("teamTabContent");
  if (!names.length) {
    el.innerHTML = `<div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-user-group"></i><div>No agents yet.</div></div>`;
    return;
  }

  el.innerHTML = names
    .map((name) => {
      const agent = agents.find((a) => a.name === name);
      const count = campaigns.filter((c) => c.owner === name).length;
      const budget = campaigns
        .filter((c) => c.owner === name)
        .reduce((s, c) => s + Number(c.budget || 0), 0);
      return `
        <div class="team-member-row">
          <div class="avatar">${initials(name)}</div>
          <div class="info">
            <div class="name">${escapeHtml(name)}</div>
            <div class="sub">${agent ? escapeHtml(agent.role) : "Campaign Owner"} · ${formatCurrency(budget)}</div>
          </div>
          <span class="count">${count}</span>
        </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Right panel — Timeline (upcoming start dates)
// ---------------------------------------------------------------
function renderCalendarTab() {
  const campaigns = getCampaigns()
    .filter((c) => c.startDate && c.status !== "Completed")
    .sort((a, b) => (a.startDate > b.startDate ? 1 : -1))
    .slice(0, 10);

  const el = document.getElementById("calendarTabContent");
  if (!campaigns.length) {
    el.innerHTML = `<div class="empty-state" style="padding:20px 10px"><i class="fa-solid fa-calendar-days"></i><div>No upcoming campaigns.</div></div>`;
    return;
  }

  el.innerHTML = campaigns
    .map((c) => {
      const dt = new Date(c.startDate);
      return `
      <div class="calendar-row">
        <div class="calendar-date-chip">
          <span class="d">${dt.getDate()}</span>
          <span class="m">${dt.toLocaleDateString("en-IN", { month: "short" })}</span>
        </div>
        <div class="info">
          <div class="name">${escapeHtml(c.name)}</div>
          <div class="sub">${escapeHtml(c.type)} · ${c.status}</div>
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

function openModal(id) {
  const overlay = document.getElementById("modalOverlay");
  const form = document.getElementById("campaignForm");
  form.reset();
  populateOwnerSelect();

  const deleteBtn = document.getElementById("deleteBtn");
  const timelineSection = document.getElementById("timelineSection");

  if (id) {
    const campaign = getCampaign(id);
    if (!campaign) return;
    document.getElementById("modalTitle").textContent = "Edit Campaign";
    document.getElementById("editId").value = campaign.id;
    document.getElementById("fName").value = campaign.name;
    document.getElementById("fType").value = campaign.type;
    document.getElementById("fStatus").value = campaign.status;
    document.getElementById("fStartDate").value = campaign.startDate || "";
    document.getElementById("fEndDate").value = campaign.endDate || "";
    document.getElementById("fBudget").value = campaign.budget || "";
    document.getElementById("fLeadsGenerated").value =
      campaign.leadsGenerated || "";
    document.getElementById("fAudience").value = campaign.audience || "";
    document.getElementById("fOwner").value = campaign.owner || "";
    document.getElementById("fDescription").value = campaign.description || "";
    deleteBtn.style.display = "inline-flex";
    timelineSection.style.display = "block";
    renderTimeline(campaign);
  } else {
    document.getElementById("modalTitle").textContent = "New Campaign";
    document.getElementById("editId").value = "";
    document.getElementById("fType").value = "Email";
    document.getElementById("fStatus").value = "Draft";
    deleteBtn.style.display = "none";
    timelineSection.style.display = "none";
  }

  overlay.classList.add("open");
}
function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
}

function renderTimeline(campaign) {
  const el = document.getElementById("timelineList");
  const notes = campaign.notes || [];
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

function addNoteToCampaign() {
  const id = document.getElementById("editId").value;
  if (!id) return;
  const input = document.getElementById("noteInput");
  const text = input.value.trim();
  if (!text) return;
  const campaign = getCampaign(id);
  const notes = campaign.notes || [];
  notes.push({
    text,
    at: new Date().toISOString(),
    author: getCurrentUser()?.name || "You",
  });
  const updated = updateCampaign(id, { notes });
  input.value = "";
  renderTimeline(updated);
  showToast("Note added", "success");
}

function confirmDelete(id) {
  const campaign = getCampaign(id);
  if (!campaign) return;
  if (confirm(`Delete "${campaign.name}"? This can't be undone.`)) {
    deleteCampaign(id);
    showToast("Campaign deleted", "success");
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
  renderCalendarTab();
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  requireAuth();
  renderSidebarUser();
  initSidebarToggle();

  renderAll();

  // Search & filters
  ["searchInput", "filterType", "filterStatus", "filterOwner"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => {
      currentView === "kanban" ? renderKanban() : renderTable();
    });
    el.addEventListener("change", () => {
      currentView === "kanban" ? renderKanban() : renderTable();
    });
  });
  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    document.getElementById("searchInput").value = "";
    document.getElementById("filterType").value = "all";
    document.getElementById("filterStatus").value = "all";
    document.getElementById("filterOwner").value = "all";
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

  // Notes
  document
    .getElementById("addNoteBtn")
    .addEventListener("click", addNoteToCampaign);
  document.getElementById("noteInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addNoteToCampaign();
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
  document.getElementById("campaignForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("editId").value;
    const payload = {
      name: document.getElementById("fName").value.trim(),
      type: document.getElementById("fType").value,
      status: document.getElementById("fStatus").value,
      startDate: document.getElementById("fStartDate").value,
      endDate: document.getElementById("fEndDate").value,
      budget: parseFloat(document.getElementById("fBudget").value) || 0,
      leadsGenerated:
        parseInt(document.getElementById("fLeadsGenerated").value, 10) || 0,
      audience: document.getElementById("fAudience").value.trim(),
      owner: document.getElementById("fOwner").value,
      description: document.getElementById("fDescription").value.trim(),
    };

    if (!payload.name || !payload.startDate) {
      showToast("Please fill in all required fields", "error");
      return;
    }

    if (id) {
      updateCampaign(id, payload);
      showToast("Campaign updated", "success");
    } else {
      addCampaign(payload);
      showToast("Campaign created", "success");
    }
    closeModal();
    renderAll();
  });
});
