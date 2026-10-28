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
  // Quotes too: the result is also used inside HTML attributes.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function statusBadge(status) {
  const map = {
    New: "badge-info",
    Contacted: "badge-warning",
    "Quote Sent": "badge-brand",
    Negotiation: "badge-warning",
    Won: "badge-success",
    Lost: "badge-danger",
  };
  return `<span class="badge ${map[status] || "badge-neutral"}">${escapeHtml(crmLabel("stage", status))}</span>`;
}

// ---------------------------------------------------------------
// Product dropdown (shared by the lead form)
// ---------------------------------------------------------------
function renderProductOptions(selectedId = "") {
  const select = document.getElementById("fProduct");
  if (!select) return;
  const products = getProducts();
  select.innerHTML =
    `<option value="">${escapeHtml(t("leads.add-product-2"))}</option>` +
    products
      .map(
        (p) =>
          `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${escapeHtml(
            p.name,
          )}${p.price ? " — ₹" + Number(p.price).toLocaleString(crmI18n.locale()) : ""}</option>`,
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
  const formatCurrency = (value) => "₹" + value.toLocaleString(crmI18n.locale());
  return `<div class="product-price-summary">
    <span>${escapeHtml(t("leads.priceIs", { price: formatCurrency(pricing.basePrice) }))}</span>
    <span>GST (${pricing.gstPercentage}%): ${formatCurrency(pricing.gstAmount)}</span>
    <strong>${escapeHtml(t("leads.totalIs", { total: formatCurrency(pricing.finalPrice) }))}</strong>
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
  const save = async () => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (field === "name" && !value) {
      showToast(t("leads.productNameRequired"), "error");
      renderProductsPanel();
      return;
    }
    try {
      await saveProduct(product.id, { [field]: value });
    } catch (error) {
      showToast(apiErrorMessage(error, t("leads.err.updateProduct")), "error");
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
    el.innerHTML = `<div class="empty-state"><i class="fa-solid fa-box-open"></i><p>${escapeHtml(t("leads.empty.products"))}</p></div>`;
    return;
  }

  el.innerHTML = `
    <table>
      <thead><tr><th>${escapeHtml(t("col.product"))}</th><th>${escapeHtml(t("leads.col.category"))}</th><th>${escapeHtml(t("leads.col.price"))}</th><th>${escapeHtml(t("leads.col.stock"))}</th><th>${escapeHtml(t("nav.leads"))}</th><th></th></tr></thead>
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
                <button class="icon-btn edit-product-btn" data-id="${p.id}" title="${escapeHtml(t("common.edit"))}" aria-label="${escapeHtml(t("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-product-btn" data-id="${p.id}" title="${escapeHtml(t("common.delete"))}" aria-label="${escapeHtml(t("common.delete"))}"><i class="fa-solid fa-trash"></i></button>
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
    btn.addEventListener("click", async () => {
      if (!confirm(t("leads.confirmDeleteProduct"))) return;
      try {
        await removeProduct(btn.dataset.id);
        showToast(t("leads.productDeleted"), "success");
      } catch (error) {
        showToast(apiErrorMessage(error, t("leads.err.deleteProduct")), "error");
      }
      renderProductsPanel();
      renderProductOptions();
      renderTable();
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
    qtyInput.placeholder = t("leads.inStock", { n: product.quantity });
  } else {
    qtyInput.placeholder = t("leads.egQty");
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
  // Keep the quantity already typed (or loaded for an existing lead).
  toggleQuantityField(document.getElementById("fQuantity").value);
  autoFillValue();
});
document.getElementById("fQuantity").addEventListener("input", autoFillValue);

// ---------------------------------------------------------------
// Lead modal
// ---------------------------------------------------------------
// "Quote sent, no reply for N days": leads at Quote Sent whose latest quotation has waited
// that long and the customer has not written on WhatsApp since (GET /quotations/awaiting-reply).
async function loadAwaiting() {
  const list = document.getElementById("awaitingList");
  list.innerHTML = `<p class="text-muted" style="padding: 12px 18px; margin: 0">${escapeHtml(t("cw.loading"))}</p>`;
  try {
    const rows = await crmApi(`/quotations/awaiting-reply?days=${document.getElementById("awaitingDays").value}`);
    const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString(crmI18n.locale(), { maximumFractionDigits: 2 })}`;
    list.innerHTML = rows.length
      ? rows
          .map((r) => `
        <div class="awaiting-row">
          <div class="who"><strong>${escapeHtml(r.lead.contact?.name || r.lead.title)}</strong>
            <div class="meta">${escapeHtml(crmLabel("quoteType", r.quotation.type))} ${escapeHtml(r.quotation.number)} · ${rupees(r.quotation.grandTotalPaise)} · ${escapeHtml(r.quotation.viewCount ? t("leads.opened", { n: r.quotation.viewCount }) : t("leads.notOpened"))}${r.lead.ownerId ? ` · ${escapeHtml(memberName(r.lead.ownerId))}` : ""}</div>
          </div>
          <span class="wait">${escapeHtml(t("dash.wait.days", { n: r.waitingDays }))}</span>
          <a class="btn btn-outline" href="Quotations.html?id=${encodeURIComponent(r.quotation.id)}"><i class="fa-solid fa-file-invoice"></i> ${escapeHtml(t("quoteType.Quotation"))}</a>
          ${r.conversationId ? `<a class="btn btn-outline" href="Inbox.html?c=${encodeURIComponent(r.conversationId)}"><i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("inbox.chat"))}</a>` : ""}
        </div>`)
          .join("")
      : `<p class="text-muted" style="padding: 12px 18px; margin: 0">${escapeHtml(t("leads.nobodyWaiting"))}</p>`;
  } catch (error) {
    list.innerHTML = `<p class="text-muted" style="padding: 12px 18px; margin: 0">${escapeHtml(apiErrorMessage(error, t("leads.err.loadList")))}</p>`;
  }
}
document.getElementById("awaitingBtn").addEventListener("click", () => {
  const panel = document.getElementById("awaitingPanel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) loadAwaiting();
});
document.getElementById("awaitingClose").addEventListener("click", () => {
  document.getElementById("awaitingPanel").hidden = true;
});
document.getElementById("awaitingDays").addEventListener("change", loadAwaiting);

// Quotations are made on the Quotations page (D29), from a saved lead.
function openQuotationFor(leadId) {
  window.location.href = `Quotations.html?new=1&leadId=${encodeURIComponent(leadId)}`;
}
function openModal(lead = null) {
  document.getElementById("modalTitle").textContent = t(lead ? "leads.editLead" : "leads.new-lead");
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
  document.getElementById("fProduct").dispatchEvent(new Event("change"));
  // The change handler recomputes the value from price × quantity; an existing lead keeps its saved value.
  if (lead) document.getElementById("fValue").value = lead.value || "";
  document.getElementById("leadQuoteBtn").hidden = !lead;
  document.getElementById("leadQuoteHint").hidden = !lead;
  cfMount(document.getElementById("leadCustomFields"), "lead", lead?.customFields, lead?.customFieldLinks);
  modalOverlay.classList.add("open");
}
function closeModal() {
  modalOverlay.classList.remove("open");
  leadForm.reset();
  document.getElementById("fQuantityWrap").style.display = "none";
}

document.getElementById("addBtn").addEventListener("click", () => openModal());
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.getElementById("leadQuoteBtn").addEventListener("click", () => {
  const id = document.getElementById("editId").value;
  if (id) openQuotationFor(id);
});

leadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("editId").value;
  const name = document.getElementById("fName").value.trim();
  if (!name) {
    showToast(t("leads.nameRequired"), "error");
    return;
  }
  const status = document.getElementById("fStatus").value;
  const existing = id ? getLeads().find((lead) => lead.id === id) : null;
  let lostReason = null;
  if (status === "Lost" && existing?.status !== "Lost") {
    lostReason = askLostReason(name);
    if (!lostReason) return;
  }
  const productId = document.getElementById("fProduct").value;
  const quantity = document.getElementById("fQuantity").value;
  const payload = {
    contact: {
      name,
      email: document.getElementById("fEmail").value.trim(),
      phone: document.getElementById("fPhone").value.trim(),
      company: document.getElementById("fCompany").value.trim(),
    },
    productId: productId || null,
    quantity: productId && quantity !== "" ? Number(quantity) : null,
    stage: status,
    ...(lostReason && { lostReason }),
    expectedValuePaise: toPaise(document.getElementById("fValue").value),
    followUpAt: document.getElementById("fFollowUp").value || null,
    notes: document.getElementById("fNotes").value.trim(),
  };
  const customFieldsBox = document.getElementById("leadCustomFields");
  const customFields = cfRead(customFieldsBox);
  if (customFields) payload.customFields = customFields;
  try {
    await (id ? updateLeadRecord(id, payload) : createLead(payload));
    closeModal();
    showToast(t(id ? "leads.updated" : "leads.created"), "success");
  } catch (error) {
    showToast(cfShowErrors(customFieldsBox, error) ? t("cf.fixFields") : apiErrorMessage(error, t("leads.err.save")), "error");
    return;
  }
  renderProductsPanel();
  renderTable();
});

// ---------------------------------------------------------------
// Product modal
// ---------------------------------------------------------------
function openProductModal(product = null) {
  productForm.reset();
  populateCategoryDatalist();
  document.getElementById("productModalTitle").textContent = t(product ? "leads.editProduct" : "leads.new-product");
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

productForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const cameFromLead = openedProductModalFromLead;
  openedProductModalFromLead = false;

  const editId = document.getElementById("editProductId").value;
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
    gst: document.getElementById("pGst").value || "0",
    description: document.getElementById("pDescription").value.trim(),
  };
  let savedId = editId;
  try {
    savedId = (await saveProduct(editId || null, product)).id;
    showToast(t(editId ? "leads.productUpdated" : "leads.productAdded"), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, t("leads.err.saveProduct")), "error");
    return;
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
  document.getElementById("notesModalTitle").textContent = t("leads.notesFor", { name: lead.name });
  renderNotesList();
  renderLeadHistory(leadId);
  notesModalOverlay.classList.add("open");
}

// What happened to the lead: who got it and why, the auto-reply, stage changes, enquiries.
const HISTORY_BADGE = { Assigned: "badge-info", "Auto-reply": "badge-success", Enquiry: "badge-warning", "Stage change": "badge-neutral" };
async function renderLeadHistory(leadId) {
  const el = document.getElementById("leadHistoryList");
  el.innerHTML = `<p class="text-muted" style="font-size:12.5px;margin:0">${escapeHtml(t("cw.loading"))}</p>`;
  try {
    const activities = await getLeadActivities(leadId);
    if (currentNotesLeadId !== leadId) return;
    el.innerHTML = activities.length
      ? activities
          .map(
            (a) => `
        <div class="lead-history-item">
          <span class="type"><span class="badge ${HISTORY_BADGE[a.type] || "badge-neutral"}">${escapeHtml(crmLabel("leadHistory", a.type))}</span></span>
          <div>
            <div>${escapeHtml(a.text || "")}</div>
            <div class="meta">${escapeHtml(a.actorName || "")}${a.actorName ? " · " : ""}${escapeHtml(new Date(a.createdAt).toLocaleString(crmI18n.locale(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }))}</div>
          </div>
        </div>`,
          )
          .join("")
      : `<p class="text-muted" style="font-size:12.5px;margin:0">${escapeHtml(t("leads.nothingYet"))}</p>`;
  } catch (error) {
    el.innerHTML = `<p class="text-muted" style="font-size:12.5px;margin:0">${escapeHtml(apiErrorMessage(error, t("leads.err.history")))}</p>`;
  }
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
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-list-check"></i><p>${escapeHtml(t("leads.empty.notes"))}</p></div>`;
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
            placeholder="${escapeHtml(t("leads.noteTitle"))}"
          />
          <button class="icon-btn danger delete-note-btn" data-id="${n.id}" title="${escapeHtml(t("leads.deleteNote"))}">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
        <textarea
          class="note-text-input"
          data-id="${n.id}"
          rows="3"
          placeholder="${escapeHtml(t("leads.writeNote"))}"
        >${escapeHtml(n.text)}</textarea>
      </div>`,
    )
    .join("");

  container
    .querySelectorAll(".note-title-input")
    .forEach((inp) =>
      inp.addEventListener("change", () =>
        saveNoteField(inp.dataset.id, "title", inp.value.trim() || t("leads.untitled")),
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
      if (confirm(t("leads.confirmDeleteNote"))) {
        deleteNoteEntry(btn.dataset.id);
      }
    }),
  );
}

async function persistNoteEntries(notes) {
  try {
    await updateLeadRecord(currentNotesLeadId, { noteEntries: notes });
  } catch (error) {
    showToast(apiErrorMessage(error, t("leads.err.saveNote")), "error");
  }
  renderTable();
}

function saveNoteField(noteId, field, value) {
  const lead = getLeads().find((l) => l.id === currentNotesLeadId);
  if (!lead) return;
  const notes = [...getLeadNoteEntries(lead)];
  const idx = notes.findIndex((n) => n.id === noteId);
  if (idx === -1) return;
  notes[idx] = { ...notes[idx], [field]: value };
  persistNoteEntries(notes);
}

async function addNoteEntry() {
  const lead = getLeads().find((l) => l.id === currentNotesLeadId);
  if (!lead) return;
  const notes = [...getLeadNoteEntries(lead)];
  const newNote = {
    id: "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: t("leads.noteN", { n: notes.length + 1 }),
    text: "",
    createdAt: new Date().toISOString(),
  };
  notes.push(newNote);
  await persistNoteEntries(notes);
  renderNotesList();

  // Focus the newly added note's textarea so the user can start typing.
  requestAnimationFrame(() => {
    const el = document.querySelector(
      `.note-text-input[data-id="${newNote.id}"]`,
    );
    if (el) el.focus();
  });
}

async function deleteNoteEntry(noteId) {
  const lead = getLeads().find((l) => l.id === currentNotesLeadId);
  if (!lead) return;
  const notes = getLeadNoteEntries(lead).filter((n) => n.id !== noteId);
  await persistNoteEntries(notes);
  renderNotesList();
}

function startInlineLeadEdit(cell) {
  if (cell.querySelector("input, select")) return;
  const lead = getLeads().find((item) => item.id === cell.closest("tr").dataset.id);
  if (!lead) return;
  const field = cell.dataset.field;
  const control = document.createElement(field === "product" || field === "status" ? "select" : "input");
  control.className = "inline-edit-input";
  if (field === "product") {
    control.innerHTML = `<option value="">${escapeHtml(t("leads.add-product-2"))}</option>` + getProducts().map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`).join("");
    control.value = lead.product || "";
  } else if (field === "status") {
    control.innerHTML = LEAD_STAGES.map((status) => `<option value="${status}">${escapeHtml(crmLabel("stage", status))}</option>`).join("");
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
  const save = async () => {
    if (finished) return;
    finished = true;
    const value = control.value;
    try {
      if (field === "status") {
        if (value !== lead.status) {
          const lostReason = value === "Lost" ? askLostReason(lead.name) : null;
          if (value !== "Lost" || lostReason) await changeLeadStage(lead.id, value, lostReason);
        }
      } else if (["name", "company", "email"].includes(field)) {
        await updateLeadRecord(lead.id, { contact: { [field]: value.trim() } });
      } else if (field === "product") {
        await updateLeadRecord(lead.id, { productId: value || null, quantity: value ? Number(lead.quantity) || null : null });
      } else if (field === "value") {
        await updateLeadRecord(lead.id, { expectedValuePaise: toPaise(value) });
      } else if (field === "followUp") {
        await updateLeadRecord(lead.id, { followUpAt: value || null });
      }
    } catch (error) {
      showToast(apiErrorMessage(error, t("leads.err.update")), "error");
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
// Filters on the company's own fields (D74); the table is drawn again once the fields are in.
const leadFieldFilters = cfFilterBar({
  container: document.getElementById("leadCfFilters"),
  object: "lead",
  storageKey: "leadsFieldFilters",
  onChange: () => {
    if (crmCache.leads) renderTable();
  },
});

// Download Excel (D82): the same search, stage and field filters as the table.
cfExportButton({
  button: document.getElementById("exportBtn"),
  path: "/leads/export",
  name: "leads",
  params: () => {
    const params = cfQueryParams(leadFieldFilters.filters());
    const q = document.getElementById("searchInput").value.trim();
    const stage = document.getElementById("filterStatus").value;
    if (q) params.set("q", q.slice(0, 100));
    if (stage !== "all") params.set("stage", stage);
    return params;
  },
});

// Tick leads and act on all of them (D100): owner, stage, follow-up, tags, sequence, Excel, delete.
const leadsBulk = crmBulkBar({
  object: "lead",
  bar: document.getElementById("leadsBulk"),
  onDone: async () => {
    await crmLoad(["leads"], { force: true });
    renderProductsPanel();
    renderTable();
  },
});

function renderTable() {
  const searchTerm = document.getElementById("searchInput").value.toLowerCase();
  const statusFilter = document.getElementById("filterStatus").value;
  const container = document.getElementById("leadsTable");
  const fields = cfFields("lead");
  const columns = cfListColumns(fields);

  const searched = getLeads().filter((l) => {
    const matchesSearch =
      l.name.toLowerCase().includes(searchTerm) ||
      (l.email || "").toLowerCase().includes(searchTerm) ||
      (l.company || "").toLowerCase().includes(searchTerm) ||
      (l.source || "").toLowerCase().includes(searchTerm) ||
      (l.title || "").toLowerCase().includes(searchTerm) ||
      cfSearchText(fields, l.customFields).includes(searchTerm);
    const matchesStatus = statusFilter === "all" || l.status === statusFilter;
    return matchesSearch && matchesStatus;
  });
  const filtered = cfApplyFilters(searched, leadFieldFilters.filters(), fields);

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-bullseye"></i><p>${escapeHtml(t("leads.empty.leads"))}</p></div>`;
    leadsBulk.wire(container, []);
    return;
  }

  container.innerHTML = `
    <table>
      <thead><tr>${leadsBulk.head()}<th>${escapeHtml(t("col.name"))}</th><th>${escapeHtml(t("col.company"))}</th><th>${escapeHtml(t("leads.email"))}</th><th>${escapeHtml(t("col.product"))}</th><th>${escapeHtml(t("leads.col.source"))}</th><th>${escapeHtml(t("leads.col.owner"))}</th><th>${escapeHtml(t("col.status"))}</th><th>${escapeHtml(t("col.value"))}</th><th>${escapeHtml(t("leads.col.followUp"))}</th>${columns.map((field) => `<th>${escapeHtml(field.label)}</th>`).join("")}<th></th></tr></thead>
      <tbody>
        ${filtered
          .map((l) => {
            const noteCount = getLeadNoteEntries(l).length;
            // An enquiry from a lead source names the product in its title when it is not in the catalogue.
            const productText = l.product ? getProductName(l.product) : l.title && !/ enquiry$/.test(l.title) ? l.title : "—";
            return `
          <tr data-id="${l.id}">
            ${leadsBulk.cell(l.id, l.name)}
            <td class="inline-edit-cell" data-field="name">${escapeHtml(l.name)}</td>
            <td class="inline-edit-cell" data-field="company">${escapeHtml(l.company) || "—"}</td>
            <td class="inline-edit-cell" data-field="email">${escapeHtml(l.email) || "—"}</td>
            <td class="inline-edit-cell" data-field="product">${escapeHtml(productText)}${l.quantity ? ` <span class="badge badge-neutral">x${escapeHtml(l.quantity)}</span>` : ""}</td>
            <td><span class="badge badge-neutral">${escapeHtml(crmLabel("source", l.source || "Manual"))}</span></td>
            <td>${l.owner ? escapeHtml(l.owner) : `<span class="text-muted">${escapeHtml(t("dash.unassigned"))}</span>`}</td>
            <td class="inline-edit-cell" data-field="status">${statusBadge(l.status)}</td>
            <td class="inline-edit-cell" data-field="value">${l.value ? "₹" + Number(l.value).toLocaleString(crmI18n.locale()) : "—"}</td>
            <td class="inline-edit-cell" data-field="followUp">${l.followUp || "—"}</td>
            ${columns.map((field) => `<td>${escapeHtml(cfDisplayValue(field, l.customFields?.[field.key], l.customFieldLinks?.[field.key])) || "—"}</td>`).join("")}
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-btn" data-id="${l.id}" title="${escapeHtml(t("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn quote-btn" data-id="${l.id}" title="${escapeHtml(t("leads.create-quotation"))}"><i class="fa-solid fa-file-invoice"></i></button>
                <button class="icon-btn notes-btn" data-id="${l.id}" title="${escapeHtml(t("leads.notesHistory"))}">
                  <i class="fa-solid fa-list-check"></i>${noteCount ? ` <span class="badge badge-info notes-count-badge">${noteCount}</span>` : ""}
                </button>
                <button class="icon-btn danger delete-btn" data-id="${l.id}" title="${escapeHtml(t("common.delete"))}"><i class="fa-solid fa-trash"></i></button>
              </div>
            </td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
  leadsBulk.wire(container, filtered);
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
  container.querySelectorAll(".quote-btn").forEach((btn) =>
    btn.addEventListener("click", () => openQuotationFor(btn.dataset.id)),
  );
  container.querySelectorAll(".notes-btn").forEach((btn) =>
    btn.addEventListener("click", () => openNotesModal(btn.dataset.id)),
  );
  container.querySelectorAll(".delete-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm(t("leads.confirmDelete"))) return;
      try {
        await removeLead(btn.dataset.id);
        showToast(t("leads.deleted"), "success");
      } catch (error) {
        showToast(apiErrorMessage(error, t("leads.err.delete")), "error");
      }
      renderProductsPanel();
      renderTable();
    }),
  );
}

document.getElementById("searchInput").addEventListener("input", renderTable);
document.getElementById("filterStatus").addEventListener("change", renderTable);

crmReady(["leads", "products", "members"], () => {
  renderProductOptions();
  renderProductsPanel();
  renderTable();
  openFromAddress((id) => {
    const lead = getLeads().find((l) => l.id === id);
    if (!lead) return false;
    openModal(lead);
  });
});
