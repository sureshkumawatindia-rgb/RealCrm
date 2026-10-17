/**
 * documents.js — Documents module (Grid + Table library)
 * Documents live on the CRM backend (getDocuments, saveDocument,
 * removeDocument, downloadDocument in app.js). Uploaded files are kept in
 * the server's private storage and open as downloads; a document can be a
 * web link instead. The server checks the size limit and file type.
 * Reuses shared helpers from app.js (getAgents, getCustomers, getLeads,
 * getAccounts, showToast, renderSidebarUser, initSidebarToggle,
 * requireAuth).
 */

requireAuth();
renderSidebarUser();

const CATEGORIES = [
  "Contract",
  "Invoice",
  "Proposal",
  "Report",
  "Template",
  "Other",
];
const CATEGORY_DOT = {
  Contract: "var(--info)",
  Invoice: "var(--success)",
  Proposal: "var(--warning)",
  Report: "var(--violet)",
  Template: "var(--brand-darker)",
  Other: "var(--text-faint)",
};
const CATEGORY_BADGE_CLASS = {
  Contract: "badge-cat-contract",
  Invoice: "badge-cat-invoice",
  Proposal: "badge-cat-proposal",
  Report: "badge-cat-report",
  Template: "badge-cat-template",
  Other: "badge-cat-other",
};

// What a document is linked to: the server keeps the English type, the page shows the word.
const RELATED_KEYS = { Customer: "orders.customer", Lead: "dash.add.lead", Account: "deals.col.account", Deal: "dash.add.deal" };
const relatedLabel = (type) => (RELATED_KEYS[type] ? crmI18n.t(RELATED_KEYS[type]) : type);
const categoryLabel = (category) => crmLabel("docCategory", category);

let currentView = "grid";
let activeCategoryFilter = null; // set by the nav-bar-kanban-card pills
let sourceMode = "file"; // "file" | "link" — modal toggle
let pendingFile = null; // the File picked in the modal, sent on save

function getDocumentById(id) {
  return getDocuments().find((d) => String(d.id) === String(id));
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(crmI18n.locale(), {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
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
  // Quotes too: the result is also used inside HTML attributes.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function ownerNames() {
  return getAgents().map((a) => a.name);
}
function dealNames() {
  return getDeals().map((d) => d.name).filter(Boolean);
}
function relatedOptionsForType(type) {
  switch (type) {
    case "Customer":
      return getCustomers().map((c) => c.name);
    case "Lead":
      return getLeads().map((l) => l.name);
    case "Account":
      return getAccounts().map((a) => a.name);
    case "Deal":
      return dealNames();
    default:
      return [];
  }
}

function getFileIcon(fileName, mimeType, hasLink) {
  if (hasLink) return { cls: "type-link", icon: "fa-link" };
  const ext = (fileName || "").split(".").pop().toLowerCase();
  if (ext === "pdf") return { cls: "type-pdf", icon: "fa-file-pdf" };
  if (["doc", "docx"].includes(ext))
    return { cls: "type-word", icon: "fa-file-word" };
  if (["xls", "xlsx", "csv"].includes(ext))
    return { cls: "type-excel", icon: "fa-file-excel" };
  if (["ppt", "pptx"].includes(ext))
    return { cls: "type-ppt", icon: "fa-file-powerpoint" };
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext))
    return { cls: "type-image", icon: "fa-file-image" };
  if (["zip", "rar", "7z"].includes(ext))
    return { cls: "type-archive", icon: "fa-file-zipper" };
  if (["txt", "md"].includes(ext))
    return { cls: "type-generic", icon: "fa-file-lines" };
  if ((mimeType || "").startsWith("image/"))
    return { cls: "type-image", icon: "fa-file-image" };
  return { cls: "type-generic", icon: "fa-file" };
}

// ---------------------------------------------------------------
// Filters
// ---------------------------------------------------------------
function getFilteredDocuments() {
  const q = (document.getElementById("searchInput").value || "")
    .toLowerCase()
    .trim();
  const category = document.getElementById("filterCategory").value;
  const relatedType = document.getElementById("filterRelatedType").value;
  const owner = document.getElementById("filterOwner").value;

  return getDocuments().filter((d) => {
    if (q) {
      const hay = `${d.name} ${d.relatedName || ""} ${d.owner || ""} ${(d.tags || []).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const cat = activeCategoryFilter || category;
    if (cat !== "all" && d.category !== cat) return false;
    if (relatedType !== "all") {
      if (relatedType === "") {
        if (d.relatedType) return false;
      } else if (d.relatedType !== relatedType) {
        return false;
      }
    }
    if (owner !== "all" && d.owner !== owner) return false;
    return true;
  });
}

// ---------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------
function renderKpis() {
  const docs = getDocuments();
  const totalBytes = docs.reduce((s, d) => s + (d.fileSize || 0), 0);

  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 7);
  const uploadedThisWeek = docs.filter(
    (d) => d.createdAt && new Date(d.createdAt) >= weekAgo,
  );
  const linked = docs.filter((d) => d.relatedType);

  const cards = [
    { label: crmI18n.t("docs.kpi.total"), value: docs.length, cls: "" },
    { label: crmI18n.t("docs.kpi.storage"), value: formatBytes(totalBytes), cls: "info" },
    { label: crmI18n.t("docs.kpi.week"), value: uploadedThisWeek.length, cls: "success" },
    { label: crmI18n.t("docs.kpi.linked"), value: linked.length, cls: "warning" },
  ];

  document.getElementById("kpiGrid").innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card ${c.cls}">
        <div class="label">${escapeHtml(c.label)}</div>
        <div class="value">${escapeHtml(String(c.value))}</div>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------
// Grid view
// ---------------------------------------------------------------
function renderGrid() {
  const docs = getFilteredDocuments();
  const grid = document.getElementById("gridView");

  if (!docs.length) {
    grid.innerHTML = `
      <div class="empty-state doc-grid-empty">
        <i class="fa-solid fa-file-lines"></i>
        <p>${escapeHtml(crmI18n.t("docs.empty.filtered"))}</p>
      </div>`;
    return;
  }

  grid.innerHTML = docs.map((d) => docCardHtml(d)).join("");

  grid.querySelectorAll(".doc-card").forEach((card) =>
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action]")) return;
      openModal(card.dataset.id);
    }),
  );
  grid.querySelectorAll('[data-action="open"]').forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDocument(btn.dataset.id);
    }),
  );
  grid.querySelectorAll('[data-action="delete"]').forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDelete(btn.dataset.id);
    }),
  );
}

function docCardHtml(d) {
  const { cls, icon } = getFileIcon(d.fileName, d.fileType, !!d.linkUrl);
  const sizeLabel = d.linkUrl
    ? escapeHtml(crmI18n.t("docs.externalLink"))
    : d.fileSize
      ? formatBytes(d.fileSize)
      : "—";
  return `
    <div class="doc-card" data-id="${d.id}">
      <div class="doc-card__top">
        <div class="doc-card__icon ${cls}"><i class="fa-solid ${icon}"></i></div>
        <div style="min-width:0">
          <div class="doc-card__name">${escapeHtml(d.name)}</div>
          <div class="doc-card__meta">${sizeLabel} · ${formatDate(d.createdAt)}</div>
        </div>
      </div>
      ${
        d.relatedName
          ? `<div class="doc-card__related"><i class="fa-solid fa-link"></i> ${escapeHtml(relatedLabel(d.relatedType))}: ${escapeHtml(d.relatedName)}</div>`
          : ""
      }
      <div class="doc-card__tags">
        <span class="doc-tag" style="color:${CATEGORY_DOT[d.category]}">${escapeHtml(categoryLabel(d.category))}</span>
        ${(d.tags || []).map((t) => `<span class="doc-tag">${escapeHtml(t)}</span>`).join("")}
      </div>
      <div class="doc-card__foot">
        <div class="doc-card__owner">
          <span class="doc-card__owner-avatar">${initials(d.owner)}</span>
          ${escapeHtml((d.owner || "").split(" ")[0] || crmI18n.t("dash.unassigned"))}
        </div>
        <div class="doc-card__actions">
          <button class="icon-btn" data-action="open" data-id="${d.id}" title="${escapeHtml(crmI18n.t("docs.open"))}" aria-label="${escapeHtml(crmI18n.t("docs.open"))}"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
          <button class="icon-btn danger" data-action="delete" data-id="${d.id}" title="${escapeHtml(crmI18n.t("common.delete"))}" aria-label="${escapeHtml(crmI18n.t("common.delete"))}"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------
// Category filter pills
// ---------------------------------------------------------------
function initCategoryButtons() {
  const buttons = document.querySelectorAll(".nav-bar-kanban-card button");
  buttons.forEach((btn) => {
    const cat = btn.dataset.cat;
    if (!cat) return;
    btn.addEventListener("click", () => {
      if (activeCategoryFilter === cat) {
        activeCategoryFilter = null;
        btn.classList.remove("active");
      } else {
        buttons.forEach((b) => b.classList.remove("active"));
        activeCategoryFilter = cat;
        btn.classList.add("active");
      }
      currentView === "grid" ? renderGrid() : renderTable();
    });
  });
}

// ---------------------------------------------------------------
// Table view
// ---------------------------------------------------------------
function renderTable() {
  const docs = getFilteredDocuments();
  const wrap = document.getElementById("documentsTable");

  if (!docs.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-file-lines"></i>
        <div>${escapeHtml(crmI18n.t("docs.empty.filtered"))}</div>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>${escapeHtml(crmI18n.t("col.name"))}</th>
          <th>${escapeHtml(crmI18n.t("leads.col.category"))}</th>
          <th>${escapeHtml(crmI18n.t("tasks.related-to"))}</th>
          <th>${escapeHtml(crmI18n.t("leads.col.owner"))}</th>
          <th>${escapeHtml(crmI18n.t("docs.col.size"))}</th>
          <th>${escapeHtml(crmI18n.t("docs.col.uploaded"))}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${docs
          .map(
            (d) => `
          <tr data-id="${d.id}">
            <td><strong>${escapeHtml(d.name)}</strong></td>
            <td><span class="badge ${CATEGORY_BADGE_CLASS[d.category]}">${escapeHtml(categoryLabel(d.category))}</span></td>
            <td>${d.relatedName ? `${escapeHtml(relatedLabel(d.relatedType))}: ${escapeHtml(d.relatedName)}` : "—"}</td>
            <td>${escapeHtml(d.owner || "—")}</td>
            <td>${d.linkUrl ? escapeHtml(crmI18n.t("docs.externalLink")) : d.fileSize ? formatBytes(d.fileSize) : "—"}</td>
            <td>${formatDate(d.createdAt)}</td>
            <td>
              <div class="row-actions">
                <button class="icon-btn open-row" data-id="${d.id}" title="${escapeHtml(crmI18n.t("docs.open"))}" aria-label="${escapeHtml(crmI18n.t("docs.open"))}"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
                <button class="icon-btn edit-row" data-id="${d.id}" title="${escapeHtml(crmI18n.t("common.edit"))}" aria-label="${escapeHtml(crmI18n.t("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-row" data-id="${d.id}" title="${escapeHtml(crmI18n.t("common.delete"))}" aria-label="${escapeHtml(crmI18n.t("common.delete"))}"><i class="fa-solid fa-trash"></i></button>
              </div>
            </td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  wrap.querySelectorAll(".open-row").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDocument(btn.dataset.id);
    }),
  );
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
// Open / download a document
// ---------------------------------------------------------------
function openDocument(id) {
  const doc = getDocumentById(id);
  if (!doc) return;
  if (doc.linkUrl) {
    window.open(doc.linkUrl, "_blank", "noopener");
    return;
  }
  if (doc.hasFile) {
    downloadDocument(doc).catch((error) =>
      showToast(apiErrorMessage(error, crmI18n.t("docs.err.download")), "error"),
    );
    return;
  }
  showToast(crmI18n.t("docs.noFile"), "error");
}

// ---------------------------------------------------------------
// Right panel — Categories breakdown
// ---------------------------------------------------------------
function renderCategoriesTab() {
  const docs = getDocuments();
  const el = document.getElementById("categoriesTabContent");

  el.innerHTML = CATEGORIES.map((cat) => {
    const count = docs.filter((d) => d.category === cat).length;
    const bytes = docs
      .filter((d) => d.category === cat)
      .reduce((s, d) => s + (d.fileSize || 0), 0);
    return `
      <div class="category-row" data-cat="${cat}">
        <span class="dot" style="background:${CATEGORY_DOT[cat]}"></span>
        <div class="info">
          <div class="name">${escapeHtml(categoryLabel(cat))}</div>
          <div class="sub">${bytes ? formatBytes(bytes) : escapeHtml(crmI18n.t("docs.noFiles"))}</div>
        </div>
        <span class="count">${count}</span>
      </div>`;
  }).join("");

  el.querySelectorAll(".category-row").forEach((row) =>
    row.addEventListener("click", () => {
      const cat = row.dataset.cat;
      const buttons = document.querySelectorAll(".nav-bar-kanban-card button");
      if (activeCategoryFilter === cat) {
        activeCategoryFilter = null;
        buttons.forEach((b) => b.classList.remove("active"));
      } else {
        activeCategoryFilter = cat;
        buttons.forEach((b) =>
          b.classList.toggle("active", b.dataset.cat === cat),
        );
      }
      currentView === "grid" ? renderGrid() : renderTable();
    }),
  );
}

// ---------------------------------------------------------------
// Right panel — Recent uploads
// ---------------------------------------------------------------
function renderRecentTab() {
  const docs = getDocuments()
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 10);

  const el = document.getElementById("recentTabContent");
  if (!docs.length) {
    el.innerHTML = `<div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-file-lines"></i><div>${escapeHtml(crmI18n.t("docs.none"))}</div></div>`;
    return;
  }

  el.innerHTML = docs
    .map((d) => {
      const { cls, icon } = getFileIcon(d.fileName, d.fileType, !!d.linkUrl);
      return `
        <div class="recent-row" data-id="${d.id}">
          <div class="icon ${cls}"><i class="fa-solid ${icon}"></i></div>
          <div class="info">
            <div class="name">${escapeHtml(d.name)}</div>
            <div class="sub">${escapeHtml(categoryLabel(d.category))} · ${formatDate(d.createdAt)}</div>
          </div>
        </div>`;
    })
    .join("");

  el.querySelectorAll(".recent-row").forEach((row) =>
    row.addEventListener("click", () => openModal(row.dataset.id)),
  );
}

// ---------------------------------------------------------------
// Modal — source toggle (Upload File / External Link)
// ---------------------------------------------------------------
function setSourceMode(mode) {
  sourceMode = mode;
  document
    .querySelectorAll(".source-toggle__btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  document.getElementById("fileFieldWrap").style.display =
    mode === "file" ? "block" : "none";
  document.getElementById("linkFieldWrap").style.display =
    mode === "link" ? "block" : "none";
}
document.querySelectorAll(".source-toggle__btn").forEach((btn) =>
  btn.addEventListener("click", () => setSourceMode(btn.dataset.mode)),
);

function resetFilePreview() {
  pendingFile = null;
  document.getElementById("fFile").value = "";
  document.getElementById("filePreview").style.display = "none";
}
function showFilePreview(name, size) {
  document.getElementById("filePreviewName").textContent = name;
  document.getElementById("filePreviewSize").textContent = formatBytes(size);
  document.getElementById("filePreview").style.display = "flex";
}
document.getElementById("fFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingFile = file;
  showFilePreview(file.name, file.size);
});
document.getElementById("removeFileBtn").addEventListener("click", resetFilePreview);

// ---------------------------------------------------------------
// Filter dropdown population
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
    : `<option value="" disabled selected>${escapeHtml(crmI18n.t("docs.addAgentFirst"))}</option>`;
}
function populateFilterOwners() {
  const sel = document.getElementById("filterOwner");
  const current = sel.value;
  sel.innerHTML =
    `<option value="all">${escapeHtml(crmI18n.t("deals.allOwners"))}</option>` +
    ownerNames()
      .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
      .join("");
  sel.value = current || "all";
}
function populateRelatedOptions(type) {
  document.getElementById("relatedOptions").innerHTML = relatedOptionsForType(
    type,
  )
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

// ---------------------------------------------------------------
// Modal — add / edit
// ---------------------------------------------------------------
function openModal(id) {
  const overlay = document.getElementById("modalOverlay");
  const form = document.getElementById("documentForm");
  form.reset();
  resetFilePreview();
  populateOwnerSelect();
  populateRelatedOptions(document.getElementById("fRelatedType").value);

  const deleteBtn = document.getElementById("deleteBtn");

  if (id) {
    const doc = getDocumentById(id);
    if (!doc) return;
    document.getElementById("modalTitle").textContent = crmI18n.t("docs.edit");
    document.getElementById("editId").value = doc.id;
    document.getElementById("fName").value = doc.name;
    document.getElementById("fCategory").value = doc.category;
    document.getElementById("fOwner").value = doc.owner || "";
    document.getElementById("fRelatedType").value = doc.relatedType || "";
    populateRelatedOptions(doc.relatedType || "");
    document.getElementById("fRelatedName").value = doc.relatedName || "";
    document.getElementById("fTags").value = (doc.tags || []).join(", ");
    document.getElementById("fDescription").value = doc.description || "";

    if (doc.linkUrl) {
      setSourceMode("link");
      document.getElementById("fLinkUrl").value = doc.linkUrl;
    } else {
      setSourceMode("file");
      document.getElementById("fLinkUrl").value = "";
      if (doc.fileName) showFilePreview(doc.fileName, doc.fileSize || 0);
    }
    deleteBtn.style.display = "inline-flex";
  } else {
    document.getElementById("modalTitle").textContent = crmI18n.t("docs.new-document");
    document.getElementById("editId").value = "";
    document.getElementById("fCategory").value = "Contract";
    setSourceMode("file");
    document.getElementById("fLinkUrl").value = "";
    deleteBtn.style.display = "none";
  }

  overlay.classList.add("open");
}
function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
}

function confirmDelete(id) {
  const doc = getDocumentById(id);
  if (!doc) return;
  if (confirm(crmI18n.t("deals.confirmDelete", { name: doc.name }))) {
    removeDocument(id)
      .then(() => showToast(crmI18n.t("docs.deleted"), "success"))
      .catch((error) => showToast(apiErrorMessage(error, crmI18n.t("docs.err.delete")), "error"))
      .finally(renderAll);
  }
}

// ---------------------------------------------------------------
// Full render
// ---------------------------------------------------------------
function renderAll() {
  renderKpis();
  populateFilterOwners();
  if (currentView === "grid") {
    renderGrid();
  } else {
    renderTable();
  }
  renderCategoriesTab();
  renderRecentTab();
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
initSidebarToggle();
crmReady(["documents", "leads", "contacts", "products", "members"], renderAll);
initCategoryButtons();

// Search & filters
["searchInput", "filterCategory", "filterRelatedType", "filterOwner"].forEach(
  (id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => {
      currentView === "grid" ? renderGrid() : renderTable();
    });
    el.addEventListener("change", () => {
      currentView === "grid" ? renderGrid() : renderTable();
    });
  },
);

document.getElementById("filterCategory").addEventListener("change", () => {
  // Dropdown takes priority over the category pills.
  activeCategoryFilter = null;
  document
    .querySelectorAll(".nav-bar-kanban-card button")
    .forEach((b) => b.classList.remove("active"));
  currentView === "grid" ? renderGrid() : renderTable();
});

document.getElementById("clearFiltersBtn").addEventListener("click", () => {
  document.getElementById("searchInput").value = "";
  document.getElementById("filterCategory").value = "all";
  document.getElementById("filterRelatedType").value = "all";
  document.getElementById("filterOwner").value = "all";
  activeCategoryFilter = null;
  document
    .querySelectorAll(".nav-bar-kanban-card button")
    .forEach((b) => b.classList.remove("active"));
  currentView === "grid" ? renderGrid() : renderTable();
});

// View toggle
document.getElementById("viewGridBtn").addEventListener("click", () => {
  currentView = "grid";
  document.getElementById("viewGridBtn").classList.add("active");
  document.getElementById("viewTableBtn").classList.remove("active");
  document.getElementById("gridView").style.display = "grid";
  document.getElementById("tableView").style.display = "none";
  renderGrid();
});
document.getElementById("viewTableBtn").addEventListener("click", () => {
  currentView = "table";
  document.getElementById("viewTableBtn").classList.add("active");
  document.getElementById("viewGridBtn").classList.remove("active");
  document.getElementById("tableView").style.display = "block";
  document.getElementById("gridView").style.display = "none";
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

// Related type change -> refresh related record suggestions
document.getElementById("fRelatedType").addEventListener("change", (e) => {
  populateRelatedOptions(e.target.value);
  document.getElementById("fRelatedName").value = "";
  document.getElementById("fRelatedName").placeholder = crmI18n.t(e.target.value ? `tasks.select.${e.target.value}` : "tasks.select-a-type-first");
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

// Delete from modal
document.getElementById("deleteBtn").addEventListener("click", () => {
  const id = document.getElementById("editId").value;
  if (id) {
    closeModal();
    confirmDelete(id);
  }
});

// Save (create / update)
document.getElementById("documentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("editId").value;
  const name = document.getElementById("fName").value.trim();
  const tags = document
    .getElementById("fTags")
    .value.split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const payload = {
    name,
    category: document.getElementById("fCategory").value,
    owner: document.getElementById("fOwner").value,
    relatedType: document.getElementById("fRelatedType").value,
    relatedName: document.getElementById("fRelatedName").value.trim(),
    tags,
    description: document.getElementById("fDescription").value.trim(),
  };
  if (!payload.relatedType) payload.relatedName = "";

  if (!payload.name) {
    showToast(crmI18n.t("docs.needName"), "error");
    return;
  }

  let file = null;
  if (sourceMode === "link") {
    const linkUrl = document.getElementById("fLinkUrl").value.trim();
    if (!linkUrl) {
      showToast(crmI18n.t("docs.needLink"), "error");
      return;
    }
    payload.linkUrl = linkUrl;
  } else if (pendingFile) {
    file = pendingFile;
  } else if (!id || !getDocumentById(id)?.hasFile) {
    // Editing without picking a new file keeps the current one.
    showToast(crmI18n.t("docs.needFile"), "error");
    return;
  }

  const saveBtn = e.submitter;
  if (saveBtn) saveBtn.disabled = true;
  try {
    await saveDocument(id || null, payload, file);
    showToast(crmI18n.t(id ? "docs.updated" : "docs.created"), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, crmI18n.t("docs.err.save")), "error");
    return;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
  closeModal();
  renderAll();
});