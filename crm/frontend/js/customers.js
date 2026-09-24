requireAuth();
renderSidebarUser();

const modalOverlay = document.getElementById("modalOverlay");
const customerForm = document.getElementById("customerForm");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function statusBadge(status) {
  return status === "Active"
    ? '<span class="badge badge-success">Active</span>'
    : '<span class="badge badge-neutral">Inactive</span>';
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
  document.getElementById("productModalTitle").textContent = "New Product";
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

productForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("pName").value.trim();
  if (!name) {
    showToast("Product name is required.", "error");
    return;
  }
  const product = {
    name,
    category: document.getElementById("pCategory").value.trim(),
    price: document.getElementById("pPrice").value,
    quantity: document.getElementById("pQuantity").value,
    description: document.getElementById("pDescription").value.trim(),
  };
  const saved = addProduct(product);
  showToast("Product added.", "success");
  closeProductModal();

  // Refresh the dropdown in the customer modal and auto-select the new product
  populateProductOptions(saved.id);
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
        )}${p.price ? " — ₹" + Number(p.price).toLocaleString("en-IN") : ""}</option>`,
    )
    .join("");
  select.innerHTML = `<option value="">— Add product —</option>${options}`;
}

function getProductName(productId) {
  if (!productId) return "—";
  const p = getProducts().find((pr) => pr.id === productId);
  return p ? p.name : "—";
}

function openModal(customer = null) {
  document.getElementById("modalTitle").textContent = customer
    ? "Edit Customer"
    : "New Customer";
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

customerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("editId").value;
  const data = {
    name: document.getElementById("fName").value.trim(),
    email: document.getElementById("fEmail").value.trim(),
    phone: document.getElementById("fPhone").value.trim(),
    company: document.getElementById("fCompany").value.trim(),
    product: document.getElementById("fProduct").value,
    status: document.getElementById("fStatus").value,
  };
  if (!data.name || !data.email) {
    showToast("Name and email are required.", "error");
    return;
  }
  if (id) {
    updateCustomer(id, data);
    showToast("Customer updated.", "success");
  } else {
    addCustomer(data);
    showToast("Customer added.", "success");
  }
  closeModal();
  renderTable();
});

function renderTable() {
  const searchTerm = document.getElementById("searchInput").value.toLowerCase();
  const statusFilter = document.getElementById("filterStatus").value;
  const container = document.getElementById("customersTable");

  const filtered = getCustomers().filter((c) => {
    const matchesSearch =
      c.name.toLowerCase().includes(searchTerm) ||
      c.email.toLowerCase().includes(searchTerm) ||
      (c.company || "").toLowerCase().includes(searchTerm);
    const matchesStatus = statusFilter === "all" || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-users"></i><p>No customers found. Add your first one.</p></div>`;
    return;
  }

  container.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Company</th><th>Product</th><th>Status</th><th></th></tr></thead>
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
            <td>${statusBadge(c.status)}</td>
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-btn" data-id="${c.id}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-btn" data-id="${c.id}"><i class="fa-solid fa-trash"></i></button>
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
    btn.addEventListener("click", () => {
      if (confirm("Delete this customer?")) {
        deleteCustomer(btn.dataset.id);
        showToast("Customer deleted.", "success");
        renderTable();
      }
    }),
  );
}

document.getElementById("searchInput").addEventListener("input", renderTable);
document.getElementById("filterStatus").addEventListener("change", renderTable);

renderTable();