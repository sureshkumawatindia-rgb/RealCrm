/**
 * products.js — Products module (catalog table + KPIs)
 * Products live on the CRM backend (getProducts / saveProduct / removeProduct
 * in app.js). How many leads want each product comes from the server's count (D115).
 * Reuses shared helpers from app.js (showToast, renderSidebarUser,
 * initSidebarToggle, requireAuth).
 */

requireAuth();
renderSidebarUser();
initSidebarToggle();

const modalOverlay = document.getElementById("modalOverlay");
const productForm = document.getElementById("productForm");

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  // Quotes too: the result is also used inside HTML attributes.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatCurrency(n) {
  const num = Number(n) || 0;
  return "₹" + num.toLocaleString(crmI18n.locale());
}
function qtyOf(p) {
  return p.quantity === "" || p.quantity == null ? null : Number(p.quantity);
}
function stockBadge(p) {
  const qty = qtyOf(p);
  if (qty === null) return '<span class="badge badge-neutral">—</span>';
  if (qty === 0) return `<span class="badge badge-danger">${escapeHtml(t("products.stock.out"))}</span>`;
  if (qty <= 5) return `<span class="badge badge-warning">${escapeHtml(t("products.stock.low", { qty }))}</span>`;
  return `<span class="badge badge-success">${escapeHtml(t("products.stock.in", { qty }))}</span>`;
}
function productPriceSummary(p) {
  const pricing = getProductPricing(p);
  return `<div class="product-price-summary">
    <span>${escapeHtml(t("products.sum.price", { amount: formatCurrency(pricing.basePrice) }))}</span>
    <span>GST (${pricing.gstPercentage}%): ${formatCurrency(pricing.gstAmount)}</span>
    <strong>${escapeHtml(t("products.sum.total", { amount: formatCurrency(pricing.finalPrice) }))}</strong>
  </div>`;
}
// The WhatsApp catalog (Phase 8C): where each product stands with Meta.
function catalogBadge(p) {
  if (!p.inCatalog) return '<span class="text-muted">—</span>';
  const state = p.catalog || {};
  if (state.status === "synced") return `<span class="badge badge-success" title="${escapeHtml(t("products.cat.inTitle"))}">${escapeHtml(t("products.cat.in"))}</span>`;
  if (state.status === "error") return `<span class="badge badge-danger" title="${escapeHtml(state.error || "")}">${escapeHtml(t("products.cat.attention"))}</span>`;
  return `<span class="badge badge-warning" title="${escapeHtml(t("products.cat.waitingTitle"))}">${escapeHtml(t("products.cat.waiting"))}</span>`;
}
async function loadCatalogBar() {
  const bar = document.getElementById("catalogBar");
  let state;
  try {
    state = await crmApi("/products/whatsapp-catalog");
  } catch {
    bar.hidden = true;
    return;
  }
  const manager = isOrgManager();
  if (!state.available || (!state.catalogs.length && !manager)) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  if (!state.catalogs.length) {
    const link = `<a href="Settings.html?tab=whatsapp">${escapeHtml(t("products.bar.settingsLink"))}</a>`;
    bar.innerHTML = `<span><i class="fa-brands fa-whatsapp" style="color:var(--wa)"></i> ${t("products.bar.connect", { link })}</span>`;
    return;
  }
  const c = state.catalogs[0];
  const p = state.products;
  const name = `<strong>${escapeHtml(c.name || c.catalogId)}</strong>`;
  const lastSync = c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString(crmI18n.locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  bar.innerHTML = `<span><i class="fa-brands fa-whatsapp" style="color:var(--wa)"></i> ${t("products.bar.catalog", { name, synced: p.synced, included: p.included })}${p.failed ? ` · <span style="color:var(--danger)">${escapeHtml(t("products.bar.failed", { n: p.failed }))}</span>` : ""}${lastSync ? ` · ${escapeHtml(t("products.bar.lastSync", { date: lastSync }))}` : ""} · ${escapeHtml(t("products.bar.gst"))}</span>
    ${manager ? `<button class="btn btn-outline" type="button" id="catalogSyncBtn"><i class="fa-solid fa-rotate"></i> ${escapeHtml(t("products.bar.sync"))}</button>` : ""}`;
  document.getElementById("catalogSyncBtn")?.addEventListener("click", async (event) => {
    event.target.disabled = true;
    try {
      await crmApi("/products/whatsapp-catalog/sync", jsonRequest("POST", {}));
      await crmLoad(["products"], { force: true });
      showToast(t("products.synced"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("products.err.sync")), "error");
    }
    renderAll();
    loadCatalogBar();
  });
}

function categoryList() {
  return [
    ...new Set(getProducts().map((p) => (p.category || "").trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
}
function startInlineProductEdit(cell) {
  if (cell.querySelector("input")) return;
  const product = getProducts().find((p) => p.id === cell.closest("tr").dataset.id);
  if (!product) return;
  const field = cell.dataset.field;
  const input = document.createElement("input");
  input.className = "inline-edit-input";
  input.type = field === "name" || field === "category" ? "text" : "number";
  if (input.type === "number") {
    input.min = "0";
    input.step = field === "price" ? "0.01" : "1";
  }
  input.value = product[field] == null ? "" : product[field];
  cell.textContent = "";
  cell.appendChild(input);
  input.focus();
  input.select();
  let finished = false;
  const save = async () => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (field === "name" && !value) {
      showToast(t("products.needName"), "error");
      renderTable();
      return;
    }
    try {
      await saveProduct(product.id, { [field]: value });
      showToast(t("products.updated"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("products.err.update")), "error");
    }
    renderAll();
  };
  input.addEventListener("blur", save);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); input.blur(); }
    if (event.key === "Escape") { finished = true; renderTable(); }
  });
}

// ---------------------------------------------------------------
// Filters
// ---------------------------------------------------------------
function getFilteredProducts() {
  const q = (document.getElementById("searchInput").value || "")
    .toLowerCase()
    .trim();
  const category = document.getElementById("filterCategory").value;
  const stock = document.getElementById("filterStock").value;

  return getProducts().filter((p) => {
    if (q) {
      const hay = `${p.name} ${p.category || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (category !== "all" && (p.category || "") !== category) return false;

    if (stock !== "all") {
      const qty = qtyOf(p);
      if (stock === "out" && qty !== 0) return false;
      if (stock === "low" && !(qty !== null && qty > 0 && qty <= 5))
        return false;
      if (stock === "in" && !(qty !== null && qty > 5)) return false;
    }
    return true;
  });
}

function populateFilterCategories() {
  const sel = document.getElementById("filterCategory");
  const current = sel.value;
  sel.innerHTML =
    `<option value="all">${escapeHtml(t("products.all-categories"))}</option>` +
    categoryList()
      .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
      .join("");
  sel.value = current || "all";
}
function populateCategoryDatalist() {
  document.getElementById("categoryOptions").innerHTML = categoryList()
    .map((c) => `<option value="${escapeHtml(c)}"></option>`)
    .join("");
}

// ---------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------
function renderKpis() {
  const products = getProducts();
  const stockValue = products.reduce((sum, p) => {
    const qty = qtyOf(p);
    return sum + Number(p.price || 0) * (qty || 0);
  }, 0);
  const lowStock = products.filter((p) => {
    const qty = qtyOf(p);
    return qty !== null && qty > 0 && qty <= 5;
  }).length;
  const outOfStock = products.filter((p) => qtyOf(p) === 0).length;

  const cards = [
    { label: t("products.kpi.total"), value: products.length, cls: "" },
    { label: t("products.kpi.stockValue"), value: formatCurrency(stockValue), cls: "info" },
    { label: t("products.kpi.low"), value: lowStock, cls: "warning" },
    { label: t("products.out-of-stock"), value: outOfStock, cls: outOfStock ? "warning" : "" },
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
// Table
// ---------------------------------------------------------------
// Leads per product, counted by the server over every lead (Phase 3, D115).
let leadCounts = new Map();
async function loadLeadCounts() {
  try {
    const summary = await crmLeadSummary({ fresh: true });
    leadCounts = new Map(summary.products.map((row) => [String(row.productId), row.count]));
  } catch {
    /* the column shows what it had */
  }
}
const leadCountOf = (id) => leadCounts.get(String(id)) || 0;

function renderTable() {
  const products = getFilteredProducts();
  const wrap = document.getElementById("productsTable");

  if (!products.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-box-open"></i>
        <p>${escapeHtml(t("products.empty"))}</p>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>${escapeHtml(t("col.product"))}</th>
          <th>${escapeHtml(t("products.col.category"))}</th>
          <th>${escapeHtml(t("products.col.price"))}</th>
          <th>${escapeHtml(t("products.col.stock"))}</th>
          <th>${escapeHtml(t("nav.leads"))}</th>
          <th>WhatsApp</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${products
          .map((p) => {
            const leadCount = leadCountOf(p.id);
            return `
          <tr data-id="${p.id}">
            <td class="inline-edit-cell" data-field="name"><strong>${escapeHtml(p.name)}</strong></td>
            <td class="inline-edit-cell" data-field="category">${escapeHtml(p.category) || "—"}</td>
            <td class="inline-edit-cell" data-field="price">${productPriceSummary(p)}</td>
            <td class="inline-edit-cell" data-field="quantity">${stockBadge(p)}</td>
            <td><span class="badge ${leadCount ? "badge-info" : "badge-neutral"}">${leadCount}</span></td>
            <td>${catalogBadge(p)}</td>
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-row" data-id="${p.id}" title="${escapeHtml(t("common.edit"))}" aria-label="${escapeHtml(t("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-row" data-id="${p.id}" title="${escapeHtml(t("common.delete"))}" aria-label="${escapeHtml(t("common.delete"))}"><i class="fa-solid fa-trash"></i></button>
              </div>
            </td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;

  wrap.querySelectorAll(".edit-row").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal(btn.dataset.id);
    }),
  );
  wrap.querySelectorAll(".inline-edit-cell").forEach((cell) => cell.addEventListener("click", (event) => {
    event.stopPropagation();
    startInlineProductEdit(cell);
  }));
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
// Modal — add / edit / delete
// ---------------------------------------------------------------
function openModal(id) {
  productForm.reset();
  populateCategoryDatalist();

  const deleteBtn = document.getElementById("deleteBtn");

  if (id) {
    const product = getProducts().find((p) => p.id === id);
    if (!product) return;
    document.getElementById("modalTitle").textContent = t("products.edit");
    document.getElementById("editId").value = product.id;
    document.getElementById("pName").value = product.name;
    document.getElementById("pCategory").value = product.category || "";
    document.getElementById("pPrice").value = product.price || "";
    document.getElementById("pQuantity").value = product.quantity ?? "";
    document.getElementById("pGst").value = product.gstPercentage ?? product.gst ?? 0;
    document.getElementById("pDescription").value = product.description || "";
    document.getElementById("pHsn").value = product.hsnSac || "";
    document.getElementById("pUnit").value = product.unit || "";
    document.getElementById("pSku").value = product.sku || "";
    document.getElementById("pImage").value = (product.images || [])[0] || "";
    document.getElementById("pInCatalog").checked = Boolean(product.inCatalog);
    const state = product.catalog || {};
    document.getElementById("pCatalogState").textContent = !product.inCatalog ? ""
      : state.status === "synced" ? t("products.state.in")
        : state.status === "error" ? t("products.state.error", { error: state.error }) : t("products.state.waiting");
    deleteBtn.style.display = "inline-flex";
  } else {
    document.getElementById("modalTitle").textContent = t("products.new-product");
    document.getElementById("editId").value = "";
    document.getElementById("pCatalogState").textContent = "";
    deleteBtn.style.display = "none";
  }

  modalOverlay.classList.add("open");
}
function closeModal() {
  modalOverlay.classList.remove("open");
  productForm.reset();
}

async function confirmDelete(id) {
  const product = getProducts().find((p) => p.id === id);
  if (!product) return;
  const leadCount = leadCountOf(id);
  const warning = leadCount
    ? ` ${t(leadCount === 1 ? "products.del.one" : "products.del.many", { n: leadCount })}`
    : "";
  if (!confirm(`${t("products.confirmDelete", { name: product.name })}${warning}`)) return;
  try {
    await removeProduct(id);
    showToast(t("products.deleted"), "success");
    renderAll();
  } catch (error) {
    showToast(apiErrorMessage(error, t("products.err.delete")), "error");
  }
}

// ---------------------------------------------------------------
// Full render
// ---------------------------------------------------------------
function renderAll() {
  renderKpis();
  populateFilterCategories();
  renderTable();
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
crmReady(["products", "members"], async () => {
  await loadLeadCounts();
  renderAll();
  loadCatalogBar();
  openFromAddress((id) => {
    if (!getProducts().some((p) => p.id === id)) return false;
    openModal(id);
  });
});

document.getElementById("searchInput").addEventListener("input", renderTable);
document
  .getElementById("filterCategory")
  .addEventListener("change", renderTable);
document.getElementById("filterStock").addEventListener("change", renderTable);
document.getElementById("clearFiltersBtn").addEventListener("click", () => {
  document.getElementById("searchInput").value = "";
  document.getElementById("filterCategory").value = "all";
  document.getElementById("filterStock").value = "all";
  renderTable();
});

document.getElementById("addBtn").addEventListener("click", () => openModal(null));
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

document.getElementById("deleteBtn").addEventListener("click", () => {
  const id = document.getElementById("editId").value;
  if (id) {
    closeModal();
    confirmDelete(id);
  }
});

productForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("editId").value;
  const data = {
    name: document.getElementById("pName").value.trim(),
    category: document.getElementById("pCategory").value.trim(),
    price: document.getElementById("pPrice").value,
    quantity: document.getElementById("pQuantity").value,
    gst: document.getElementById("pGst").value || "0",
    description: document.getElementById("pDescription").value.trim(),
    hsnSac: document.getElementById("pHsn").value.trim(),
    unit: document.getElementById("pUnit").value.trim(),
    sku: document.getElementById("pSku").value.trim(),
    image: document.getElementById("pImage").value.trim(),
    inCatalog: document.getElementById("pInCatalog").checked,
  };
  if (!data.name) {
    showToast(t("products.needName"), "error");
    return;
  }
  try {
    await saveProduct(id || null, data);
    showToast(t(id ? "products.updated" : "products.added"), "success");
    closeModal();
    renderAll();
  } catch (error) {
    showToast(apiErrorMessage(error, t("products.err.save")), "error");
  }
});