/**
 * products.js — Products module (catalog table + KPIs)
 * Persists to localStorage under 'crm_products' via the shared
 * getProducts/addProduct/updateProduct/deleteProduct helpers in app.js.
 * Reads 'crm_leads' (via getLeads) to show how many leads want each
 * product. Reuses shared helpers from app.js (showToast,
 * renderSidebarUser, initSidebarToggle, requireAuth).
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
  return div.innerHTML;
}
function formatCurrency(n) {
  const num = Number(n) || 0;
  return "₹" + num.toLocaleString("en-IN");
}
function qtyOf(p) {
  return p.quantity === "" || p.quantity == null ? null : Number(p.quantity);
}
function stockBadge(p) {
  const qty = qtyOf(p);
  if (qty === null) return '<span class="badge badge-neutral">—</span>';
  if (qty === 0) return `<span class="badge badge-danger">Out of stock</span>`;
  if (qty <= 5) return `<span class="badge badge-warning">Low · ${qty}</span>`;
  return `<span class="badge badge-success">In stock · ${qty}</span>`;
}
function productPriceSummary(p) {
  const pricing = getProductPricing(p);
  return `<div class="product-price-summary">
    <span>Price: ${formatCurrency(pricing.basePrice)}</span>
    <span>GST (${pricing.gstPercentage}%): ${formatCurrency(pricing.gstAmount)}</span>
    <strong>Total: ${formatCurrency(pricing.finalPrice)}</strong>
  </div>`;
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
  const save = () => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (field === "name" && !value) {
      showToast("Product name is required.", "error");
      renderTable();
      return;
    }
    if (field === "price") {
      const pricing = calculateProductPricing(value, product.gstPercentage ?? product.gst);
      updateProduct(product.id, {
        price: value,
        ...pricing,
        gst: pricing.gstPercentage,
      });
    } else {
      updateProduct(product.id, { [field]: value });
    }
    showToast("Product updated.", "success");
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
    `<option value="all">All Categories</option>` +
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
    { label: "Total Products", value: products.length, cls: "" },
    { label: "Total Stock Value", value: formatCurrency(stockValue), cls: "info" },
    { label: "Low Stock", value: lowStock, cls: "warning" },
    { label: "Out of Stock", value: outOfStock, cls: outOfStock ? "warning" : "" },
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
// Table
// ---------------------------------------------------------------
function renderTable() {
  const products = getFilteredProducts();
  const leads = getLeads();
  const wrap = document.getElementById("productsTable");

  if (!products.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-box-open"></i>
        <p>No products found. Add your first one.</p>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th>Category</th>
          <th>Price</th>
          <th>Stock</th>
          <th>Leads</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${products
          .map((p) => {
            const leadCount = leads.filter((l) => l.product === p.id).length;
            return `
          <tr data-id="${p.id}">
            <td class="inline-edit-cell" data-field="name"><strong>${escapeHtml(p.name)}</strong></td>
            <td class="inline-edit-cell" data-field="category">${escapeHtml(p.category) || "—"}</td>
            <td class="inline-edit-cell" data-field="price">${productPriceSummary(p)}</td>
            <td class="inline-edit-cell" data-field="quantity">${stockBadge(p)}</td>
            <td><span class="badge ${leadCount ? "badge-info" : "badge-neutral"}">${leadCount}</span></td>
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-row" data-id="${p.id}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-row" data-id="${p.id}"><i class="fa-solid fa-trash"></i></button>
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
    document.getElementById("modalTitle").textContent = "Edit Product";
    document.getElementById("editId").value = product.id;
    document.getElementById("pName").value = product.name;
    document.getElementById("pCategory").value = product.category || "";
    document.getElementById("pPrice").value = product.price || "";
    document.getElementById("pQuantity").value = product.quantity ?? "";
    document.getElementById("pGst").value = product.gstPercentage ?? product.gst ?? 0;
    document.getElementById("pDescription").value = product.description || "";
    deleteBtn.style.display = "inline-flex";
  } else {
    document.getElementById("modalTitle").textContent = "New Product";
    document.getElementById("editId").value = "";
    deleteBtn.style.display = "none";
  }

  modalOverlay.classList.add("open");
}
function closeModal() {
  modalOverlay.classList.remove("open");
  productForm.reset();
}

function confirmDelete(id) {
  const product = getProducts().find((p) => p.id === id);
  if (!product) return;
  const leadCount = getLeads().filter((l) => l.product === id).length;
  const warning = leadCount
    ? ` ${leadCount} lead${leadCount === 1 ? " is" : "s are"} linked to it and will show as unassigned.`
    : "";
  if (confirm(`Delete "${product.name}"? This can't be undone.${warning}`)) {
    deleteProduct(id);
    showToast("Product deleted.", "success");
    renderAll();
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
renderAll();

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

productForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("editId").value;
  const data = {
    name: document.getElementById("pName").value.trim(),
    category: document.getElementById("pCategory").value.trim(),
    price: document.getElementById("pPrice").value,
    quantity: document.getElementById("pQuantity").value,
    gst: document.getElementById("pGst").value || "0",
    description: document.getElementById("pDescription").value.trim(),
  };
  if (!data.name) {
    showToast("Product name is required.", "error");
    return;
  }
  const pricing = calculateProductPricing(data.price, data.gst);
  Object.assign(data, pricing, { price: data.price, gst: pricing.gstPercentage });
  if (id) {
    updateProduct(id, data);
    showToast("Product updated.", "success");
  } else {
    addProduct(data);
    showToast("Product added.", "success");
  }
  closeModal();
  renderAll();
});