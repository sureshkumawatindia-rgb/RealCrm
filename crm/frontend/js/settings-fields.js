/**
 * settings-fields.js — Settings → Custom fields (D73, owners and admins)
 * The company's own fields on customers and on leads & deals: add, edit, reorder, archive and
 * restore. Archiving hides a field from the forms and keeps its values. The forms draw the
 * fields with js/custom-fields.js.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsFields() {
  if (!isOrgManager()) return leaveManagerTab("fields");
  document.getElementById("fieldsTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const MAX_FIELDS = 50; // backend/src/constants/customFields.js MAX_ACTIVE_FIELDS
  let object = "contact";
  let fields = []; // active and archived, for the chosen object
  let editing = null; // the field in the form, or null when adding one
  let loaded = false;
  let busy = false;

  const active = () => fields.filter((field) => field.status === "active");
  const archived = () => fields.filter((field) => field.status === "archived");
  // The API's own words, except where the page has them in its language.
  const errorText = (error, fallbackKey) =>
    ["FIELD_LIMIT", "VERSION_CONFLICT", "COLUMN_LIMIT"].includes(error?.code) ? t(`cf.err.${error.code}`) : apiErrorMessage(error, t(fallbackKey));

  function badges(field) {
    const list = [`<span class="badge badge-neutral">${escapeHtml(t(`cf.type.${field.type}`))}</span>`];
    if (field.required) list.push(`<span class="badge badge-warning">${escapeHtml(t("cf.requiredBadge"))}</span>`);
    if (field.listColumn) list.push(`<span class="badge badge-success">${escapeHtml(t("cf.columnBadge"))}</span>`);
    if (field.type === "dropdown") list.push(`<span class="badge badge-info">${escapeHtml(t("cf.choiceCount", { count: field.options.filter((o) => !o.archived).length }))}</span>`);
    return list.join("");
  }

  function rowHtml(field, index, count) {
    const up = escapeHtml(t("cf.moveUp"));
    const down = escapeHtml(t("cf.moveDown"));
    return `<div class="cf-row" data-id="${escapeHtml(field.id)}">
      <div class="cf-move">
        <button type="button" class="icon-btn" data-act="up" aria-label="${up}" title="${up}"${index === 0 ? " disabled" : ""}><i class="fa-solid fa-chevron-up"></i></button>
        <button type="button" class="icon-btn" data-act="down" aria-label="${down}" title="${down}"${index === count - 1 ? " disabled" : ""}><i class="fa-solid fa-chevron-down"></i></button>
      </div>
      <div class="cf-row-main">
        <div class="cf-row-name">${escapeHtml(field.label)}</div>
        <div class="cf-row-meta">${badges(field)}</div>
        ${field.helpText ? `<div class="cf-help">${escapeHtml(field.helpText)}</div>` : ""}
      </div>
      <div class="cf-row-actions">
        <button type="button" class="btn btn-outline" data-act="edit">${escapeHtml(t("cf.edit"))}</button>
        <button type="button" class="btn btn-outline" data-act="archive">${escapeHtml(t("cf.archive"))}</button>
      </div>
    </div>`;
  }

  function archivedRowHtml(field) {
    return `<div class="cf-row" data-id="${escapeHtml(field.id)}">
      <div class="cf-row-main">
        <div class="cf-row-name">${escapeHtml(field.label)}</div>
        <div class="cf-row-meta">${badges(field)}</div>
      </div>
      <div class="cf-row-actions">
        <button type="button" class="btn btn-outline" data-act="restore">${escapeHtml(t("cf.restore"))}</button>
      </div>
    </div>`;
  }

  function render() {
    const list = active();
    $("cfCount").textContent = t("cf.count", { used: list.length, max: MAX_FIELDS });
    $("cfAdd").disabled = list.length >= MAX_FIELDS;
    $("cfList").innerHTML = list.length
      ? list.map((field, index) => rowHtml(field, index, list.length)).join("")
      : `<p class="settings-hint">${escapeHtml(t(object === "contact" ? "cf.emptyContact" : "cf.emptyLead"))}</p>`;
    const old = archived();
    $("cfArchivedBox").hidden = !old.length;
    $("cfArchivedTitle").textContent = t("cf.archivedTitle", { count: old.length });
    $("cfArchived").innerHTML = old.map(archivedRowHtml).join("");
  }

  async function load() {
    try {
      fields = await crmApi(`/custom-fields?object=${object}&status=all`);
      render();
    } catch (error) {
      $("cfList").innerHTML = `<p class="settings-hint">${escapeHtml(errorText(error, "cf.err.load"))}</p>`;
    }
  }

  // --- the add / edit form ------------------------------------------------
  function optionRowHtml(option = {}) {
    const name = escapeHtml(t("cf.choiceName"));
    const remove = escapeHtml(t("cf.removeChoice"));
    return `<div class="cf-option-row"${option.value ? ` data-value="${escapeHtml(option.value)}"` : ""}>
      <input type="text" maxlength="60" value="${escapeHtml(option.label || "")}" aria-label="${name}" placeholder="${name}" />
      <button type="button" class="icon-btn" data-act="remove-option" aria-label="${remove}" title="${remove}"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  }

  function showChoices() {
    $("cfOptionsField").hidden = $("cfType").value !== "dropdown";
  }

  function openForm(field = null) {
    editing = field;
    $("cfFormTitle").textContent = t(field ? "cf.editTitle" : "cf.addTitle");
    $("cfLabel").value = field?.label || "";
    $("cfType").value = field?.type || "text";
    $("cfType").disabled = Boolean(field);
    $("cfTypeFixed").hidden = !field;
    $("cfHelp").value = field?.helpText || "";
    $("cfRequired").checked = Boolean(field?.required);
    $("cfListColumn").checked = Boolean(field?.listColumn);
    const options = field ? field.options.filter((o) => !o.archived) : [{}, {}];
    $("cfOptionRows").innerHTML = options.map(optionRowHtml).join("");
    showChoices();
    $("cfForm").hidden = false;
    $("cfAdd").hidden = true;
    $("cfLabel").focus();
  }

  function closeForm() {
    $("cfForm").reset();
    $("cfForm").hidden = true;
    $("cfAdd").hidden = false;
    editing = null;
  }

  // Kept choices send their value; new ones only a name. A choice left out is archived.
  function readOptions() {
    return [...$("cfOptionRows").querySelectorAll(".cf-option-row")]
      .map((row) => ({ value: row.dataset.value, label: row.querySelector("input").value.trim() }))
      .filter((option) => option.label)
      .map((option) => (option.value ? option : { label: option.label }));
  }

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    const label = $("cfLabel").value.trim();
    if (!label) {
      showToast(t("cf.err.name"), "error");
      $("cfLabel").focus();
      return;
    }
    const type = editing ? editing.type : $("cfType").value;
    const body = { label, helpText: $("cfHelp").value.trim(), required: $("cfRequired").checked, listColumn: $("cfListColumn").checked };
    if (type === "dropdown") {
      body.options = readOptions();
      if (!body.options.length) {
        showToast(t("cf.err.noChoices"), "error");
        return;
      }
    }
    busy = true;
    $("cfSave").disabled = true;
    try {
      if (editing) await crmApi(`/custom-fields/${editing.id}`, jsonRequest("PATCH", { ...body, version: editing.version }));
      else await crmApi("/custom-fields", jsonRequest("POST", { ...body, object, type }));
      showToast(t(editing ? "cf.saved" : "cf.added"), "success");
      closeForm();
      await load();
    } catch (error) {
      showToast(errorText(error, "cf.err.save"), "error");
      if (error.code === "VERSION_CONFLICT") {
        closeForm();
        await load();
      }
    } finally {
      busy = false;
      $("cfSave").disabled = false;
    }
  }

  // --- list actions -----------------------------------------------------
  async function move(id, step) {
    const ids = active().map((field) => field.id);
    const from = ids.indexOf(id);
    const to = from + step;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    try {
      const ordered = await crmApi("/custom-fields/reorder", jsonRequest("POST", { object, ids }));
      fields = [...ordered, ...archived()];
      render();
      $("cfList").querySelector(`.cf-row[data-id="${CSS.escape(id)}"] [data-act="${step < 0 ? "up" : "down"}"]`)?.focus();
    } catch (error) {
      showToast(errorText(error, "cf.err.save"), "error");
      await load();
    }
  }

  async function act(path, successKey) {
    if (busy) return;
    busy = true;
    try {
      await crmApi(path, { method: "POST" });
      showToast(t(successKey), "success");
      await load();
    } catch (error) {
      showToast(errorText(error, "cf.err.save"), "error");
    } finally {
      busy = false;
    }
  }

  $("cfList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    const id = button?.closest(".cf-row")?.dataset.id;
    if (!id) return;
    const field = fields.find((f) => f.id === id);
    if (button.dataset.act === "up") move(id, -1);
    if (button.dataset.act === "down") move(id, 1);
    if (button.dataset.act === "edit") openForm(field);
    if (button.dataset.act === "archive") {
      if (editing?.id === id) closeForm();
      act(`/custom-fields/${id}/archive`, "cf.archived");
    }
  });
  $("cfArchived").addEventListener("click", (event) => {
    const button = event.target.closest('button[data-act="restore"]');
    const id = button?.closest(".cf-row")?.dataset.id;
    if (id) act(`/custom-fields/${id}/restore`, "cf.restored");
  });
  $("cfOptionRows").addEventListener("click", (event) => {
    const button = event.target.closest('button[data-act="remove-option"]');
    if (button) button.closest(".cf-option-row").remove();
  });
  $("cfAddOption").addEventListener("click", () => {
    $("cfOptionRows").insertAdjacentHTML("beforeend", optionRowHtml());
    $("cfOptionRows").lastElementChild.querySelector("input").focus();
  });
  $("cfType").addEventListener("change", showChoices);
  $("cfAdd").addEventListener("click", () => openForm());
  $("cfCancel").addEventListener("click", closeForm);
  $("cfForm").addEventListener("submit", save);
  document.querySelectorAll("[data-cf-object]").forEach((button) =>
    button.addEventListener("click", () => {
      if (button.dataset.cfObject === object) return;
      object = button.dataset.cfObject;
      document.querySelectorAll("[data-cf-object]").forEach((b) => {
        b.classList.toggle("active", b === button);
        b.setAttribute("aria-pressed", String(b === button));
      });
      closeForm();
      load();
    }),
  );

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    load();
  }
  document.querySelector('.settings-tab[data-panel="fields"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="fields"]').classList.contains("active")) loadOnce();
})();
