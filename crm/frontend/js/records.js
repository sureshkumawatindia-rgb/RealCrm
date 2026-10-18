/**
 * records.js — the company's own records (Phase 1C, D75): records.html?object=x_machines
 * One page for every object the company made in Settings → Custom fields: the list with search,
 * "Filter by field" and the chosen columns, and a form with the record's name, its customer (a
 * link picker) and the object's own fields. ?open=<id> opens a record; ?new=1&contactId=<id>
 * starts one for a customer (from Customer 360). Records follow the Customers module's access.
 * Uses app.js and js/custom-fields.js.
 */
const recParams = new URLSearchParams(window.location.search);
const recMember = getCurrentMember() || {};
const recCanWrite = isOrgManager() || recMember.role === "agent";
const recCanDelete = isOrgManager() || (recMember.permissions || []).includes("customers:delete");
let recObject = null; // the object this page shows
let recRows = []; // its records, as the API returns them
let recEditing = null; // the record in the form, or null for a new one
let recFilters = null; // cfFilterBar, once the object is known

const recBox = () => document.getElementById("recordCustomFields");

async function recLoadRecords() {
  const rows = [];
  for (let page = 1; page <= 50; page += 1) {
    const body = await crmRequest(`/records?object=${encodeURIComponent(recObject.key)}&page=${page}&limit=100`);
    rows.push(...body.data);
    if (!body.pagination?.hasNextPage) break;
  }
  recRows = rows;
}

function recCustomerText(record) {
  if (!record.contact) return "";
  if (record.contact.hidden) return t("cf.hidden");
  return record.contact.name || "";
}

function recRenderTable() {
  const container = document.getElementById("recordsTable");
  const fields = cfFields(recObject.key);
  const columns = cfListColumns(fields);
  const term = document.getElementById("searchInput").value.trim().toLowerCase();
  const searched = recRows.filter((r) => !term || `${r.name} ${recCustomerText(r)} ${cfSearchText(fields, r.customFields)}`.toLowerCase().includes(term));
  const rows = cfApplyFilters(searched, recFilters?.filters() || [], fields);
  if (!rows.length) {
    const empty = recRows.length ? t("rec.emptyFiltered") : t("rec.empty", { name: recObject.singular });
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-${escapeHtml(recObject.icon)}"></i><p>${escapeHtml(empty)}</p></div>`;
    return;
  }
  const edit = escapeHtml(t("common.edit"));
  container.innerHTML = `
    <table>
      <thead><tr><th>${escapeHtml(t("rec.name"))}</th><th>${escapeHtml(t("rec.customer"))}</th><th>${escapeHtml(t("rec.owner"))}</th>${columns.map((f) => `<th>${escapeHtml(f.label)}</th>`).join("")}<th></th></tr></thead>
      <tbody>
        ${rows
          .map((r) => `
          <tr data-id="${escapeHtml(r.id)}" class="rec-row">
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td>${r.contact && !r.contact.hidden && !r.contact.missing ? `<a href="customer-360.html?id=${encodeURIComponent(r.contact.id)}">${escapeHtml(r.contact.name)}</a>` : escapeHtml(recCustomerText(r)) || "—"}</td>
            <td>${escapeHtml(memberName(r.ownerId)) || "—"}</td>
            ${columns.map((f) => `<td>${escapeHtml(cfDisplayValue(f, r.customFields?.[f.key], r.customFieldLinks?.[f.key])) || "—"}</td>`).join("")}
            <td><div class="row-actions"><button class="icon-btn edit-btn" type="button" data-id="${escapeHtml(r.id)}" title="${edit}" aria-label="${edit}"><i class="fa-solid fa-pen"></i></button></div></td>
          </tr>`)
          .join("")}
      </tbody>
    </table>`;
  container.querySelectorAll(".edit-btn").forEach((button) => button.addEventListener("click", () => recOpen(recRows.find((r) => r.id === button.dataset.id))));
}

// The form: a record, or a new one (optionally for a customer: { id, name }).
function recOpen(record = null, customer = null) {
  recEditing = record;
  const name = recObject.singular;
  document.getElementById("modalTitle").textContent = t(record ? "rec.edit" : "rec.new", { name });
  document.getElementById("fName").value = record?.name || "";
  const linkedId = record ? (record.contact?.missing ? "" : record.contactId || "") : customer?.id || "";
  const linkedText = record ? recCustomerText(record) : customer?.name || "";
  document.getElementById("fCustomerBox").innerHTML = cfLinkPickerHtml("fCustomer", "contact", linkedId, linkedText);
  cfWireLinks(document.getElementById("recordForm"));
  cfClearErrors(recBox());
  cfMount(recBox(), recObject.key, record?.customFields, record?.customFieldLinks);
  document.getElementById("deleteBtn").hidden = !record || !recCanDelete;
  document.getElementById("saveBtn").hidden = !recCanWrite;
  document.getElementById("modalOverlay").classList.add("open");
  document.getElementById("fName").focus();
}

function recClose() {
  document.getElementById("modalOverlay").classList.remove("open");
  document.getElementById("recordForm").reset();
  recEditing = null;
}

async function recSave(event) {
  event.preventDefault();
  const name = document.getElementById("fName").value.trim();
  if (!name) {
    showToast(t("rec.err.name"), "error");
    return;
  }
  const payload = {
    name,
    contactId: document.querySelector("#fCustomerBox .cf-link-value").value || null,
  };
  const customFields = cfRead(recBox());
  if (customFields) payload.customFields = customFields;
  const save = document.getElementById("saveBtn");
  save.disabled = true;
  try {
    if (recEditing) await crmApi(`/records/${recEditing.id}`, jsonRequest("PATCH", { ...payload, version: recEditing.version }));
    else await crmApi("/records", jsonRequest("POST", { ...payload, object: recObject.key }));
    showToast(t(recEditing ? "rec.saved" : "rec.added"), "success");
    recClose();
    await recLoadRecords();
    recRenderTable();
  } catch (error) {
    const contactError = (error.errors || []).some((e) => e.field === "contactId");
    showToast(cfShowErrors(recBox(), error) ? t("cf.fixFields") : contactError ? t("rec.err.customer") : apiErrorMessage(error, t("rec.err.save")), "error");
  } finally {
    save.disabled = false;
  }
}

async function recDelete() {
  if (!recEditing || !confirm(t("rec.confirmDelete", { name: recEditing.name }))) return;
  try {
    await crmApi(`/records/${recEditing.id}`, { method: "DELETE" });
    showToast(t("rec.deleted"), "success");
    recClose();
    await recLoadRecords();
    recRenderTable();
  } catch (error) {
    showToast(apiErrorMessage(error, t("rec.err.delete")), "error");
  }
}

// ?open=<id> or ?new=1&contactId=<id>, then the address is cleaned so a reload does not repeat it.
async function recOpenFromAddress() {
  const openId = recParams.get("open");
  if (openId) {
    let record = recRows.find((r) => r.id === openId);
    if (!record) record = await crmApi(`/records/${encodeURIComponent(openId)}`).catch(() => null);
    if (record) recOpen(record);
  } else if (recParams.get("new") === "1" && recCanWrite) {
    const contactId = recParams.get("contactId");
    const contact = contactId ? await crmApi(`/contacts/${encodeURIComponent(contactId)}`).catch(() => null) : null;
    recOpen(null, contact ? { id: contact.id, name: contact.name } : null);
  }
  if (openId || recParams.get("new")) window.history.replaceState({}, "", `records.html?object=${encodeURIComponent(recObject.key)}`);
}

function recShowNoObjects(text) {
  document.getElementById("recordsTable").innerHTML = `<div class="empty-state"><i class="fa-solid fa-layer-group"></i><p>${escapeHtml(text)}</p>${isOrgManager() ? `<a class="btn btn-outline" href="Settings.html?tab=fields">${escapeHtml(t("rec.goSettings"))}</a>` : ""}</div>`;
}

crmReady(["members"], async () => {
  let objects = [];
  try {
    objects = await crmApi("/custom-objects");
  } catch (error) {
    recShowNoObjects(apiErrorMessage(error, t("rec.err.load")));
    return;
  }
  if (!objects.length) {
    recShowNoObjects(t("rec.noObjects"));
    return;
  }
  recObject = objects.find((o) => o.key === recParams.get("object")) || objects[0];
  document.getElementById("recTitle").textContent = recObject.plural;
  document.title = `${recObject.plural} | YELLOW CRM`;
  document.getElementById("addLabel").textContent = t("rec.new", { name: recObject.singular });
  document.getElementById("addBtn").hidden = !recCanWrite;
  recFilters = cfFilterBar({
    container: document.getElementById("recordCfFilters"),
    object: recObject.key,
    storageKey: `recordsFieldFilters_${recObject.key}`,
    onChange: recRenderTable,
  });
  try {
    await recLoadRecords();
  } catch (error) {
    recShowNoObjects(apiErrorMessage(error, t("rec.err.load")));
    return;
  }
  recRenderTable();
  recOpenFromAddress();
});

document.getElementById("searchInput").addEventListener("input", () => recObject && recRenderTable());
document.getElementById("addBtn").addEventListener("click", () => recOpen());
document.getElementById("modalClose").addEventListener("click", recClose);
document.getElementById("cancelBtn").addEventListener("click", recClose);
document.getElementById("deleteBtn").addEventListener("click", recDelete);
document.getElementById("recordForm").addEventListener("submit", recSave);
document.getElementById("recordsTable").addEventListener("click", (event) => {
  const row = event.target.closest(".rec-row");
  if (row && !event.target.closest("a, button")) recOpen(recRows.find((r) => r.id === row.dataset.id));
});
document.getElementById("modalOverlay").addEventListener("click", (event) => {
  if (event.target.id === "modalOverlay") recClose();
});
