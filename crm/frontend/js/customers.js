requireAuth();
renderSidebarUser();

const modalOverlay = document.getElementById("modalOverlay");
const customerForm = document.getElementById("customerForm");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  // Quotes too: the result is also used inside HTML attributes.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function statusBadge(status) {
  return status === "Active"
    ? `<span class="badge badge-success">${escapeHtml(t("stage.Active"))}</span>`
    : `<span class="badge badge-neutral">${escapeHtml(t("stage.Inactive"))}</span>`;
}

// ---------------------------------------------------------------
// Add Product (inline, opened from inside the Customer modal)
// ---------------------------------------------------------------
const productModalOverlay = document.getElementById("productModalOverlay");
const productForm = document.getElementById("productForm");

function categoryList() {
  return [
    ...new Set(
      getProducts()
        .map((p) => (p.category || "").trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}
function populateCategoryDatalist() {
  const el = document.getElementById("categoryOptions");
  if (!el) return;
  el.innerHTML = categoryList()
    .map((c) => `<option value="${escapeHtml(c)}"></option>`)
    .join("");
}

function openProductModal() {
  productForm.reset();
  populateCategoryDatalist();
  document.getElementById("productModalTitle").textContent = t("leads.new-product");
  document.getElementById("editProductId").value = "";
  productModalOverlay.classList.add("open");
}
function closeProductModal() {
  productModalOverlay.classList.remove("open");
  productForm.reset();
}

document
  .getElementById("addProductFromCustomerBtn")
  .addEventListener("click", openProductModal);
document
  .getElementById("productModalClose")
  .addEventListener("click", closeProductModal);
document
  .getElementById("productCancelBtn")
  .addEventListener("click", closeProductModal);
productModalOverlay.addEventListener("click", (e) => {
  if (e.target === productModalOverlay) closeProductModal();
});

productForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("pName").value.trim();
  if (!name) {
    showToast(t("leads.productNameRequired"), "error");
    return;
  }
  const product = {
    name,
    category: document.getElementById("pCategory").value.trim(),
    price: document.getElementById("pPrice").value,
    quantity: document.getElementById("pQuantity").value,
    description: document.getElementById("pDescription").value.trim(),
  };
  try {
    const saved = await saveProduct(null, product);
    showToast(t("leads.productAdded"), "success");
    closeProductModal();
    // Refresh the dropdown in the customer modal and auto-select the new product
    populateProductOptions(saved.id);
  } catch (error) {
    showToast(apiErrorMessage(error, t("customers.err.addProduct")), "error");
  }
});

// ---------------------------------------------------------------
// Product dropdown (same crm_products data used on the Leads page)
// ---------------------------------------------------------------
function populateProductOptions(selectedId = "") {
  const select = document.getElementById("fProduct");
  const products = getProducts();
  const options = products
    .map(
      (p) =>
        `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${escapeHtml(
          p.name,
        )}${p.price ? " — ₹" + Number(p.price).toLocaleString(crmI18n.locale()) : ""}</option>`,
    )
    .join("");
  select.innerHTML = `<option value="">${escapeHtml(t("leads.add-product-2"))}</option>${options}`;
}

function getProductName(productId) {
  if (!productId) return "—";
  const p = getProducts().find((pr) => pr.id === productId);
  return p ? p.name : "—";
}

function openModal(customer = null) {
  document.getElementById("modalTitle").textContent = t(customer ? "customers.edit" : "customers.new");
  document.getElementById("editId").value = customer ? customer.id : "";
  document.getElementById("fName").value = customer ? customer.name : "";
  document.getElementById("fEmail").value = customer ? customer.email : "";
  document.getElementById("fPhone").value = customer
    ? customer.phone || ""
    : "";
  document.getElementById("fCompany").value = customer
    ? customer.company || ""
    : "";
  populateProductOptions(customer ? customer.product || "" : "");
  document.getElementById("fStatus").value = customer
    ? customer.status
    : "Active";
  document.getElementById("fCity").value = customer ? customer.city || "" : "";
  document.getElementById("fState").value = customer ? customer.state || "" : "";
  document.getElementById("fTags").value = customer ? (customer.tags || []).join(", ") : "";
  document.getElementById("fConsent").value = customer ? customer.consent?.marketing || "unknown" : "unknown";
  modalOverlay.classList.add("open");
}
function closeModal() {
  modalOverlay.classList.remove("open");
  customerForm.reset();
}

document.getElementById("addBtn").addEventListener("click", () => openModal());
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

customerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("editId").value;
  const data = {
    name: document.getElementById("fName").value.trim(),
    email: document.getElementById("fEmail").value.trim(),
    phone: document.getElementById("fPhone").value.trim(),
    company: document.getElementById("fCompany").value.trim(),
    product: document.getElementById("fProduct").value,
    status: document.getElementById("fStatus").value,
    city: document.getElementById("fCity").value.trim(),
    state: document.getElementById("fState").value.trim(),
    // Same tag twice (any capitals) is kept once.
    tags: document.getElementById("fTags").value.split(",").map((t) => t.trim()).filter(Boolean)
      .filter((t, i, all) => all.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i),
    marketingConsent: document.getElementById("fConsent").value,
  };
  if (!data.name || !data.email) {
    showToast(t("customers.nameEmailRequired"), "error");
    return;
  }
  try {
    // A new customer is a contact that already buys from you (lifecycle "customer").
    await saveContact(id || null, id ? data : { ...data, lifecycle: "customer" });
    showToast(t(id ? "customers.updated" : "customers.added"), "success");
    closeModal();
    renderTable();
  } catch (error) {
    showToast(apiErrorMessage(error, t("customers.err.save")), "error");
  }
});

function renderTable() {
  const searchTerm = document.getElementById("searchInput").value.toLowerCase();
  const statusFilter = document.getElementById("filterStatus").value;
  const container = document.getElementById("customersTable");

  const filtered = getCustomers().filter((c) => {
    const matchesSearch =
      c.name.toLowerCase().includes(searchTerm) ||
      c.email.toLowerCase().includes(searchTerm) ||
      (c.company || "").toLowerCase().includes(searchTerm) ||
      (c.tags || []).some((t) => t.toLowerCase().includes(searchTerm));
    const matchesStatus = statusFilter === "all" || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-users"></i><p>${escapeHtml(t("customers.empty"))}</p></div>`;
    return;
  }

  container.innerHTML = `
    <table>
      <thead><tr><th>${escapeHtml(t("col.name"))}</th><th>${escapeHtml(t("leads.email"))}</th><th>${escapeHtml(t("leads.phone"))}</th><th>${escapeHtml(t("col.company"))}</th><th>${escapeHtml(t("col.product"))}</th><th>${escapeHtml(t("customers.col.tags"))}</th><th>${escapeHtml(t("col.status"))}</th><th></th></tr></thead>
      <tbody>
        ${filtered
          .map(
            (c) => `
          <tr>
            <td>${escapeHtml(c.name)}</td>
            <td>${escapeHtml(c.email)}</td>
            <td>${escapeHtml(c.phone) || "—"}</td>
            <td>${escapeHtml(c.company) || "—"}</td>
            <td>${escapeHtml(getProductName(c.product))}</td>
            <td>${(c.tags || []).map((t) => `<span class="badge badge-neutral">${escapeHtml(t)}</span>`).join(" ") || "—"}${c.consent?.marketing === "opted_out" ? ` <span class="badge badge-danger" title="${escapeHtml(crmI18n.t("customers.noOffersTitle"))}">${escapeHtml(crmI18n.t("customers.noOffers"))}</span>` : ""}</td>
            <td>${statusBadge(c.status)}</td>
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-btn" data-id="${c.id}" title="${escapeHtml(crmI18n.t("common.edit"))}" aria-label="${escapeHtml(crmI18n.t("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-btn" data-id="${c.id}" title="${escapeHtml(crmI18n.t("common.delete"))}" aria-label="${escapeHtml(crmI18n.t("common.delete"))}"><i class="fa-solid fa-trash"></i></button>
              </div>
            </td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  container.querySelectorAll(".edit-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const customer = getCustomers().find((c) => c.id === btn.dataset.id);
      openModal(customer);
    }),
  );
  container.querySelectorAll(".delete-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm(t("customers.confirmDelete"))) return;
      try {
        await removeContact(btn.dataset.id);
        showToast(t("customers.deleted"), "success");
        renderTable();
      } catch (error) {
        showToast(apiErrorMessage(error, t("customers.err.delete")), "error");
      }
    }),
  );
}

document.getElementById("searchInput").addEventListener("input", renderTable);
document.getElementById("filterStatus").addEventListener("change", renderTable);

crmReady(["contacts", "products", "members"], renderTable);
