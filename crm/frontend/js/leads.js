requireAuth();
renderSidebarUser();

const modalOverlay = document.getElementById("modalOverlay");
const leadForm = document.getElementById("leadForm");
const productModalOverlay = document.getElementById("productModalOverlay");
const productForm = document.getElementById("productForm");
const notesModalOverlay = document.getElementById("notesModalOverlay");

let currentNotesLeadId = null;

// True while the Add/Edit Product modal was opened from inside the
// New/Edit Lead modal (via the inline "Add Product" button), so that
// on save we can auto-select the product back on the lead form.
let openedProductModalFromLead = false;

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function statusBadge(status) {
  const map = {
    New: "badge-info",
    "In Progress": "badge-warning",
    Won: "badge-success",
    Lost: "badge-danger",
  };
  return `<span class="badge ${map[status] || "badge-neutral"}">${status}</span>`;
}

// ---------------------------------------------------------------
// Product dropdown (shared by the lead form)
// ---------------------------------------------------------------
function renderProductOptions(selectedId = "") {
  const select = document.getElementById("fProduct");
  if (!select) return;
  const products = getProducts();
  select.innerHTML =
    '<option value="">— Add Product —</option>' +
    products
      .map(
        (p) =>
          `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${escapeHtml(
            p.name,
          )}${p.price ? " — ₹" + Number(p.price).toLocaleString("en-IN") : ""}</option>`,
      )
      .join("");
}

function getProductName(productId) {
  if (!productId) return "—";
  const p = getProducts().find((pr) => pr.id === productId);
  return p ? p.name : "—";
}

function productPriceSummary(p) {
  const pricing = getProductPricing(p);
  const formatCurrency = (value) => "₹" + value.toLocaleString("en-IN");
  return `<div class="product-price-summary">
    <span>Price: ${formatCurrency(pricing.basePrice)}</span>
    <span>GST (${pricing.gstPercentage}%): ${formatCurrency(pricing.gstAmount)}</span>
    <strong>Total: ${formatCurrency(pricing.finalPrice)}</strong>
  </div>`;
}

function startInlinePanelProductEdit(cell) {
  if (cell.querySelector("input")) return;
  const product = getProducts().find((item) => item.id === cell.closest("tr").dataset.id);
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
      renderProductsPanel();
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
    renderProductOptions();
    renderProductsPanel();
    renderTable();
  };
  input.addEventListener("blur", save);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); input.blur(); }
    if (event.key === "Escape") { finished = true; renderProductsPanel(); }
  });
}

// Distinct category names across all products, used to power the
// autocomplete list on the Category field — same source of truth
// (crm_products) that the standalone Products page reads and writes.
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

// ---------------------------------------------------------------
// Products panel — shows every product with how many leads want it
// ---------------------------------------------------------------
function renderProductsPanel() {
  const products = getProducts();
  const leads = getLeads();
  const el = document.getElementById("productsPanel");
  if (!el) return;

  if (!products.length) {
    el.innerHTML = `<div class="empty-state"><i class="fa-solid fa-box-open"></i><p>No products yet. Use "Add Product" above.</p></div>`;
    return;
  }

  el.innerHTML = `
    <table>
      <thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Qty in Stock</th><th>Leads</th><th></th></tr></thead>
      <tbody>
        ${products
          .map((p) => {
            const count = leads.filter((l) => l.product === p.id).length;
            const qty =
              p.quantity === "" || p.quantity == null
                ? null
                : Number(p.quantity);
            const qtyLabel =
              qty === null
                ? "—"
                : `<span class="badge ${qty === 0 ? "badge-danger" : qty <= 5 ? "badge-warning" : "badge-success"}">${qty}</span>`;
            return `
          <tr data-id="${p.id}">
            <td class="inline-edit-cell" data-field="name">${escapeHtml(p.name)}</td>
            <td class="inline-edit-cell" data-field="category">${escapeHtml(p.category) || "—"}</td>
            <td class="inline-edit-cell" data-field="price">${productPriceSummary(p)}</td>
            <td class="inline-edit-cell" data-field="quantity">${qtyLabel}</td>
            <td><span class="badge ${count ? "badge-info" : "badge-neutral"}">${count}</span></td>
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-product-btn" data-id="${p.id}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-product-btn" data-id="${p.id}"><i class="fa-solid fa-trash"></i></button>
              </div>
            </td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;

  el.querySelectorAll(".inline-edit-cell").forEach((cell) => cell.addEventListener("click", (event) => {
    event.stopPropagation();
    startInlinePanelProductEdit(cell);
  }));
  el.querySelectorAll(".edit-product-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const product = getProducts().find((p) => p.id === btn.dataset.id);
      openProductModal(product);
    }),
  );
  el.querySelectorAll(".delete-product-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (
        confirm(
          "Delete this product? Leads linked to it will show as unassigned.",
        )
      ) {
        deleteProduct(btn.dataset.id);
        showToast("Product deleted.", "success");
        renderProductsPanel();
        renderProductOptions();
        renderTable();
      }
    }),
  );
}

function toggleQuantityField(qtyValue = "") {
  const productId = document.getElementById("fProduct").value;
  const wrap = document.getElementById("fQuantityWrap");
  const qtyInput = document.getElementById("fQuantity");
  if (!productId) {
    wrap.style.display = "none";
    qtyInput.value = "";
    return;
  }
  wrap.style.display = "";
  qtyInput.value = qtyValue;
  const product = getProducts().find((p) => p.id === productId);
  if (product && product.quantity !== "" && product.quantity != null) {
    qtyInput.placeholder = `In stock: ${product.quantity}`;
  } else {
    qtyInput.placeholder = "e.g. 2";
  }
}

// Auto-fill Value (₹) as price × quantity. The field stays a normal
// input, so the user can still type over it manually at any time.
function autoFillValue() {
  const productId = document.getElementById("fProduct").value;
  const qty = Number(document.getElementById("fQuantity").value);
  const valueInput = document.getElementById("fValue");
  if (!productId || !qty) return;
  const product = getProducts().find((p) => p.id === productId);
  if (!product || !product.price) return;
  valueInput.value = Number(product.price) * qty;
}

document.getElementById("fProduct").addEventListener("change", () => {
  toggleQuantityField();
  autoFillValue();
  const product = getProducts().find((p) => p.id === document.getElementById("fProduct").value);
  quotationItems = product ? [{ productId: product.id, quantity: document.getElementById("fQuantity").value || 1, unitPrice: product.price || "", discount: 0, tax: 0 }] : [];
  document.getElementById("productPricingFields").hidden = !product;
  document.getElementById("fUnitPrice").value = product?.price || "";
  renderQuotationItems();
  renderQuotationTotals();
});
document.getElementById("fQuantity").addEventListener("input", () => {
  autoFillValue();
  if (quotationItems[0]) quotationItems[0].quantity = document.getElementById("fQuantity").value;
  renderQuotationTotals();
});

// ---------------------------------------------------------------
// Lead modal
// ---------------------------------------------------------------
let quotationItems = [];
function quotationDatePlus(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}
function quotationTotals() {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  quotationItems.forEach((item) => {
    const base = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0);
    const itemDiscount = Number(item.discount) || 0;
    subtotal += base;
    discount += itemDiscount;
    tax += (base - itemDiscount) * (Number(item.tax) || 0) / 100;
  });
  return { subtotal, discount, tax, grandTotal: subtotal - discount + tax };
}
function renderQuotationItems() {
  const container = document.getElementById("quotationItems");
  container.innerHTML = quotationItems.slice(1).map((item, index) => {
    const rowIndex = index + 1;
    const product = getProducts().find((p) => p.id === item.productId);
    const amount = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0) - (Number(item.discount) || 0);
    return `<div class="quotation-item" data-index="${rowIndex}"><div><label>Product</label><select data-field="productId"><option value="">Select product</option>${getProducts().map((p) => `<option value="${p.id}" ${p.id === item.productId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></div><div><label>Qty</label><input type="number" min="1" data-field="quantity" value="${escapeHtml(item.quantity || 1)}" /></div><div><label>Unit Price</label><input type="number" min="0" step="0.01" data-field="unitPrice" value="${escapeHtml(item.unitPrice || product?.price || "")}" /></div><div><label>Discount (₹)</label><input type="number" min="0" step="0.01" data-field="discount" value="${escapeHtml(item.discount || 0)}" /></div><div><label>GST %</label><input type="number" min="0" step="0.01" data-field="tax" value="${escapeHtml(item.tax || 0)}" /></div><div><label>Amount</label><input value="₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}" readonly /></div><button class="icon-btn danger remove-quotation-item" type="button" title="Remove item"><i class="fa-solid fa-trash"></i></button></div>`;
  }).join("");
  container.querySelectorAll("[data-field]").forEach((field) => field.addEventListener("input", () => {
    const item = quotationItems[Number(field.closest(".quotation-item").dataset.index)];
    item[field.dataset.field] = field.value;
    if (field.dataset.field === "productId") { const product = getProducts().find((p) => p.id === field.value); if (product) item.unitPrice = product.price || ""; }
    renderQuotationItems();
    renderQuotationTotals();
  }));
  container.querySelectorAll(".remove-quotation-item").forEach((button) => button.addEventListener("click", () => { quotationItems.splice(Number(button.closest(".quotation-item").dataset.index), 1); renderQuotationItems(); renderQuotationTotals(); }));
}
function renderQuotationTotals() {
  const totals = quotationTotals();
  document.getElementById("fAmount").value = "₹" + totals.grandTotal.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  document.getElementById("fValue").value = totals.grandTotal || "";
}
function openModal(lead = null) {
  document.getElementById("modalTitle").textContent = lead
    ? "Edit Lead"
    : "New Lead";
  document.getElementById("editId").value = lead ? lead.id : "";
  document.getElementById("fName").value = lead ? lead.name : "";
  document.getElementById("fEmail").value = lead ? lead.email || "" : "";
  document.getElementById("fPhone").value = lead ? lead.phone || "" : "";
  document.getElementById("fCompany").value = lead ? lead.company || "" : "";
  document.getElementById("fStatus").value = lead ? lead.status : "New";
  document.getElementById("fValue").value = lead ? lead.value || "" : "";
  document.getElementById("fFollowUp").value = lead ? lead.followUp || "" : "";
  document.getElementById("fNotes").value = lead ? lead.notes || "" : "";
  const availableProducts = getProducts();
  const selectedProductId = lead?.product || (availableProducts.length === 1 ? availableProducts[0].id : "");
  renderProductOptions(selectedProductId);
  toggleQuantityField(lead ? lead.quantity || "" : "");
  const product = getProducts().find((p) => p.id === (lead?.product || ""));
  quotationItems = product ? [{ productId: product.id, quantity: lead.quantity || 1, unitPrice: product.price || "", discount: 0, tax: 0 }] : [];
  document.getElementById("productPricingFields").hidden = !product;
  document.getElementById("fUnitPrice").value = product?.price || "";
  document.getElementById("fDiscount").value = 0;
  document.getElementById("fTax").value = 0;
  renderQuotationItems();
  renderQuotationTotals();
  document.getElementById("fProduct").dispatchEvent(new Event("change"));
  modalOverlay.classList.add("open");
}
function closeModal() {
  modalOverlay.classList.remove("open");
  leadForm.reset();
  document.getElementById("fQuantityWrap").style.display = "none";
  document.getElementById("productPricingFields").hidden = true;
  quotationItems = [];
}

document.getElementById("addBtn").addEventListener("click", () => openModal());
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.getElementById("fUnitPrice").addEventListener("input", () => { if (quotationItems[0]) quotationItems[0].unitPrice = document.getElementById("fUnitPrice").value; renderQuotationTotals(); });
document.getElementById("fDiscount").addEventListener("input", () => { if (quotationItems[0]) quotationItems[0].discount = document.getElementById("fDiscount").value; renderQuotationTotals(); });
document.getElementById("fTax").addEventListener("input", () => { if (quotationItems[0]) quotationItems[0].tax = document.getElementById("fTax").value; renderQuotationTotals(); });

leadForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("editId").value;
  const data = {
    name: document.getElementById("fName").value.trim(),
    email: document.getElementById("fEmail").value.trim(),
    phone: document.getElementById("fPhone").value.trim(),
    company: document.getElementById("fCompany").value.trim(),
    product: document.getElementById("fProduct").value,
    quantity: document.getElementById("fProduct").value
      ? document.getElementById("fQuantity").value
      : "",
    status: document.getElementById("fStatus").value,
    value: document.getElementById("fValue").value,
    followUp: document.getElementById("fFollowUp").value,
    notes: document.getElementById("fNotes").value.trim(),
  };
  if (!data.name) {
    showToast("Full name is required.", "error");
    return;
  }
  let leadMessage = id ? "Lead updated" : "Lead created successfully";
  if (id) {
    const existingLead = getLeads().find((lead) => lead.id === id);
    updateLead(id, data);
    if (existingLead?.status !== "Won" && data.status === "Won") {
      const customerId = ensureWonCustomer({ ...existingLead, ...data }, "lead");
      updateLead(id, { convertedCustomerId: customerId });
    }
    addLeadActivity(id, "Lead updated", "Lead details updated");
  } else {
    const savedLead = addLead(data);
    addLeadActivity(savedLead.id, "Lead created", "Lead created");
  }
  const leadId = id || getLeads()[0]?.id;
  let quotationNumber = "";
  if (data.product && leadId && quotationItems.length) {
    const totals = quotationTotals();
    const quotationData = { leadId, leadName: data.name, company: data.company, email: data.email, phone: data.phone, quotationDate: new Date().toISOString().slice(0, 10), validUntil: quotationDatePlus(30), items: quotationItems, ...totals, status: "Draft" };
    const quotation = addQuotation(quotationData);
    quotationNumber = quotation.quotationNumber;
    addLeadActivity(leadId, "Quotation created", `Quotation created: ${quotationNumber}`);
  }
  closeModal();
  if (quotationNumber) showToast(`Lead and quotation created successfully · ${quotationNumber}`, "success");
  else showToast(`${leadMessage}.`, "success");
  renderProductsPanel();
  renderTable();
});

// ---------------------------------------------------------------
// Product modal
// ---------------------------------------------------------------
function openProductModal(product = null) {
  productForm.reset();
  populateCategoryDatalist();
  document.getElementById("productModalTitle").textContent = product
    ? "Edit Product"
    : "New Product";
  document.getElementById("editProductId").value = product ? product.id : "";
  document.getElementById("pName").value = product ? product.name : "";
  document.getElementById("pCategory").value = product
    ? product.category || ""
    : "";
  document.getElementById("pPrice").value = product ? product.price || "" : "";
  document.getElementById("pQuantity").value = product ? product.quantity ?? "" : "";
  document.getElementById("pGst").value = product
    ? product.gstPercentage ?? product.gst ?? 0
    : 0;
  document.getElementById("pDescription").value = product
    ? product.description || ""
    : "";
  productModalOverlay.classList.add("open");
}
function closeProductModal() {
  productModalOverlay.classList.remove("open");
  productForm.reset();
}

document
  .getElementById("addProductBtn")
  .addEventListener("click", () => openProductModal());

// Inline "Add Product" button inside the New/Edit Lead modal.
document
  .getElementById("addProductFromLeadBtn")
  .addEventListener("click", () => {
    openedProductModalFromLead = true;
    openProductModal();
  });

document
  .getElementById("productModalClose")
  .addEventListener("click", () => {
    openedProductModalFromLead = false;
    closeProductModal();
  });
document
  .getElementById("productCancelBtn")
  .addEventListener("click", () => {
    openedProductModalFromLead = false;
    closeProductModal();
  });
productModalOverlay.addEventListener("click", (e) => {
  if (e.target === productModalOverlay) {
    openedProductModalFromLead = false;
    closeProductModal();
  }
});

productForm.addEventListener("submit", (e) => {
  e.preventDefault();

  const cameFromLead = openedProductModalFromLead;
  openedProductModalFromLead = false;

  const editId = document.getElementById("editProductId").value;
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
    gst: document.getElementById("pGst").value || "0",
    description: document.getElementById("pDescription").value.trim(),
  };
  const pricing = calculateProductPricing(product.price, product.gst);
  Object.assign(product, pricing, { price: product.price, gst: pricing.gstPercentage });

  let savedId = editId;
  if (editId) {
    updateProduct(editId, product);
    showToast("Product updated.", "success");
  } else {
    const saved = addProduct(product);
    savedId = saved.id;
    showToast("Product added.", "success");
  }
  closeProductModal();
  renderProductOptions(savedId);
  renderProductsPanel();
  renderTable();

  // Came from the "New/Edit Lead" modal — select the freshly created
  // product back on the lead form and refresh the dependent fields.
  if (cameFromLead) {
    document.getElementById("fProduct").value = savedId;
    document.getElementById("fProduct").dispatchEvent(new Event("change"));
  }
});

// ---------------------------------------------------------------
// Lead notes (multiple, per-lead — separate from the single "Notes"
// textarea in the lead form). Stored on lead.noteEntries as an
// array of { id, title, text, createdAt }.
// ---------------------------------------------------------------
function getLeadNoteEntries(lead) {
  return Array.isArray(lead && lead.noteEntries) ? lead.noteEntries : [];
}

function openNotesModal(leadId) {
  const lead = getLeads().find((l) => l.id === leadId);
  if (!lead) return;
  currentNotesLeadId = leadId;
  document.getElementById("notesModalTitle").textContent =
    "Notes — " + lead.name;
  renderNotesList();
  notesModalOverlay.classList.add("open");
}

function closeNotesModal() {
  notesModalOverlay.classList.remove("open");
  currentNotesLeadId = null;
}

function renderNotesList() {
  const container = document.getElementById("notesList");
  const lead = getLeads().find((l) => l.id === currentNotesLeadId);
  if (!container || !lead) return;

  const notes = getLeadNoteEntries(lead);

  if (!notes.length) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-list-check"></i><p>No notes yet. Click "+ Note" to add the first one.</p></div>`;
    return;
  }

  container.innerHTML = notes
    .map(
      (n) => `
      <div class="note-item" data-id="${n.id}">
        <div class="note-item-head">
          <input
            type="text"
            class="note-title-input"
            data-id="${n.id}"
            value="${escapeHtml(n.title)}"
            placeholder="Note title"
          />
          <button class="icon-btn danger delete-note-btn" data-id="${n.id}" title="Delete note">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
        <textarea
          class="note-text-input"
          data-id="${n.id}"
          rows="3"
          placeholder="Write a note..."
        >${escapeHtml(n.text)}</textarea>
      </div>`,
    )
    .join("");

  container
    .querySelectorAll(".note-title-input")
    .forEach((inp) =>
      inp.addEventListener("change", () =>
        saveNoteField(inp.dataset.id, "title", inp.value.trim() || "Untitled"),
      ),
    );
  container
    .querySelectorAll(".note-text-input")
    .forEach((ta) =>
      ta.addEventListener("change", () =>
        saveNoteField(ta.dataset.id, "text", ta.value),
      ),
    );
  container.querySelectorAll(".delete-note-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Delete this note?")) {
        deleteNoteEntry(btn.dataset.id);
      }
    }),
  );
}

function saveNoteField(noteId, field, value) {
  const lead = getLeads().find((l) => l.id === currentNotesLeadId);
  if (!lead) return;
  const notes = getLeadNoteEntries(lead);
  const idx = notes.findIndex((n) => n.id === noteId);
  if (idx === -1) return;
  notes[idx] = { ...notes[idx], [field]: value };
  updateLead(currentNotesLeadId, { noteEntries: notes });
  renderTable();
}

function addNoteEntry() {
  const lead = getLeads().find((l) => l.id === currentNotesLeadId);
  if (!lead) return;
  const notes = getLeadNoteEntries(lead);
  const newNote = {
    id: "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: `Note ${notes.length + 1}`,
    text: "",
    createdAt: new Date().toISOString(),
  };
  notes.push(newNote);
  updateLead(currentNotesLeadId, { noteEntries: notes });
  renderNotesList();
  renderTable();

  // Focus the newly added note's textarea so the user can start typing.
  requestAnimationFrame(() => {
    const el = document.querySelector(
      `.note-text-input[data-id="${newNote.id}"]`,
    );
    if (el) el.focus();
  });
}

function deleteNoteEntry(noteId) {
  const lead = getLeads().find((l) => l.id === currentNotesLeadId);
  if (!lead) return;
  const notes = getLeadNoteEntries(lead).filter((n) => n.id !== noteId);
  updateLead(currentNotesLeadId, { noteEntries: notes });
  renderNotesList();
  renderTable();
}

function startInlineLeadEdit(cell) {
  if (cell.querySelector("input, select")) return;
  const lead = getLeads().find((item) => item.id === cell.closest("tr").dataset.id);
  if (!lead) return;
  const field = cell.dataset.field;
  const control = document.createElement(field === "product" || field === "status" ? "select" : "input");
  control.className = "inline-edit-input";
  if (field === "product") {
    control.innerHTML = '<option value="">— Add Product —</option>' + getProducts().map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`).join("");
    control.value = lead.product || "";
  } else if (field === "status") {
    control.innerHTML = ["New", "In Progress", "Won", "Lost"].map((status) => `<option>${status}</option>`).join("");
    control.value = lead.status || "New";
  } else {
    control.type = field === "value" ? "number" : field === "followUp" ? "date" : field === "email" ? "email" : "text";
    if (field === "value") control.min = "0";
    control.value = lead[field] || "";
  }
  cell.textContent = "";
  cell.appendChild(control);
  control.focus();
  if (control.select) control.select();
  let finished = false;
  const save = () => {
    if (finished) return;
    finished = true;
    const patch = { [field]: control.value };
    if (field === "product") {
      const product = getProducts().find((item) => item.id === control.value);
      patch.quantity = product ? lead.quantity || "" : "";
    }
    updateLead(lead.id, patch);
    if (field === "status" && lead.status !== "Won" && patch.status === "Won") {
      const customerId = ensureWonCustomer({ ...lead, ...patch }, "lead");
      updateLead(lead.id, { convertedCustomerId: customerId });
    }
    renderTable();
  };
  control.addEventListener("blur", save);
  control.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); control.blur(); }
    if (event.key === "Escape") { finished = true; renderTable(); }
  });
}

document.getElementById("addNoteBtn").addEventListener("click", addNoteEntry);
document
  .getElementById("notesModalClose")
  .addEventListener("click", closeNotesModal);
document
  .getElementById("notesDoneBtn")
  .addEventListener("click", closeNotesModal);
notesModalOverlay.addEventListener("click", (e) => {
  if (e.target === notesModalOverlay) closeNotesModal();
});

// ---------------------------------------------------------------
// Leads table
// ---------------------------------------------------------------
function renderTable() {
  const searchTerm = document.getElementById("searchInput").value.toLowerCase();
  const statusFilter = document.getElementById("filterStatus").value;
  const container = document.getElementById("leadsTable");

  const filtered = getLeads().filter((l) => {
    const matchesSearch =
      l.name.toLowerCase().includes(searchTerm) ||
      (l.email || "").toLowerCase().includes(searchTerm) ||
      (l.company || "").toLowerCase().includes(searchTerm);
    const matchesStatus = statusFilter === "all" || l.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-bullseye"></i><p>No leads found. Add your first one.</p></div>`;
    return;
  }

  container.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Product</th><th>Status</th><th>Value</th><th>Follow-up</th><th></th></tr></thead>
      <tbody>
        ${filtered
          .map((l) => {
            const noteCount = getLeadNoteEntries(l).length;
            return `
          <tr data-id="${l.id}">
            <td class="inline-edit-cell" data-field="name">${escapeHtml(l.name)}</td>
            <td class="inline-edit-cell" data-field="company">${escapeHtml(l.company) || "—"}</td>
            <td class="inline-edit-cell" data-field="email">${escapeHtml(l.email) || "—"}</td>
            <td class="inline-edit-cell" data-field="product">${escapeHtml(getProductName(l.product))}${l.product && l.quantity ? ` <span class="badge badge-neutral">x${escapeHtml(l.quantity)}</span>` : ""}</td>
            <td class="inline-edit-cell" data-field="status">${statusBadge(l.status)}</td>
            <td class="inline-edit-cell" data-field="value">${l.value ? "₹" + Number(l.value).toLocaleString("en-IN") : "—"}</td>
            <td class="inline-edit-cell" data-field="followUp">${l.followUp || "—"}</td>
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-btn" data-id="${l.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn notes-btn" data-id="${l.id}" title="Notes">
                  <i class="fa-solid fa-list-check"></i>${noteCount ? ` <span class="badge badge-info notes-count-badge">${noteCount}</span>` : ""}
                </button>
                <button class="icon-btn danger delete-btn" data-id="${l.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
              </div>
            </td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
  container.querySelectorAll(".edit-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const lead = getLeads().find((l) => l.id === btn.dataset.id);
      openModal(lead);
    }),
  );
  container.querySelectorAll(".inline-edit-cell").forEach((cell) => cell.addEventListener("click", (event) => {
    event.stopPropagation();
    startInlineLeadEdit(cell);
  }));
  container.querySelectorAll(".notes-btn").forEach((btn) =>
    btn.addEventListener("click", () => openNotesModal(btn.dataset.id)),
  );
  container.querySelectorAll(".delete-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("Delete this lead?")) {
        deleteLead(btn.dataset.id);
        showToast("Lead deleted.", "success");
        renderProductsPanel();
        renderTable();
      }
    }),
  );
}

document.getElementById("searchInput").addEventListener("input", renderTable);
document.getElementById("filterStatus").addEventListener("change", renderTable);

renderProductOptions();
renderProductsPanel();
renderTable();
