/**
 * settings-fields.js — Settings → Custom fields (D73–D75, owners and admins)
 * The company's own objects (Machines, Sites … with their pages under "Your records") and the
 * fields of customers, of leads & deals and of each object: add, edit, reorder, archive and
 * restore. Archiving hides a field or an object and keeps its values and records. The forms draw
 * the fields with js/custom-fields.js.
 * Sections (D76): under the fields, headings that group them in the forms (1 or 2 columns), edited
 * in place and saved together; each field's form also has a Section choice.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsFields() {
  if (!isOrgManager()) return leaveManagerTab("fields");
  document.getElementById("fieldsTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const MAX_FIELDS = 50; // backend/src/constants/customFields.js MAX_ACTIVE_FIELDS
  const MAX_OBJECTS = 10; // MAX_CUSTOM_OBJECTS
  const MAX_SECTIONS = 10; // MAX_SECTIONS
  const ICONS = ["box", "gear", "truck", "building", "location-dot", "file-contract", "shield-halved", "wrench", "bolt", "tag", "user-gear", "warehouse"];
  let object = "contact";
  let fields = []; // active and archived, for the chosen object
  let objects = []; // the company's own objects, active and archived
  let editing = null; // the field in the form, or null when adding one
  let editingObject = null;
  let layout = { sections: [], version: 0 }; // the chosen object's saved sections
  let draft = []; // the sections being edited: [{ id?, label, columns, fieldIds }]
  let dirty = false; // the draft has changes that are not saved
  let loaded = false;
  let busy = false;

  const active = () => fields.filter((field) => field.status === "active");
  const archived = () => fields.filter((field) => field.status === "archived");
  const activeObjects = () => objects.filter((o) => o.status === "active");
  // What a link field can point to, by name.
  const targetName = (target) =>
    target === "contact" ? t("cf.obj.contact") : target === "lead" ? t("cf.obj.lead") : objects.find((o) => o.key === target)?.plural || target;
  const sectionName = (id) => layout.sections.find((s) => s.id === id)?.label;
  // A section the list or the request no longer knows comes as a field error (INVALID_SECTION).
  const codeOf = (error) => (error?.errors?.some((e) => e.code === "INVALID_SECTION") ? "INVALID_SECTION" : error?.code);
  // The API's own words, except where the page has them in its language.
  const errorText = (error, fallbackKey) =>
    ["FIELD_LIMIT", "VERSION_CONFLICT", "COLUMN_LIMIT", "SECTION_LIMIT", "INVALID_SECTION"].includes(codeOf(error))
      ? t(`cf.err.${codeOf(error)}`)
      : error?.code === "OBJECT_LIMIT"
        ? t("co.err.OBJECT_LIMIT")
        : apiErrorMessage(error, t(fallbackKey));

  function badges(field) {
    const list = [`<span class="badge badge-neutral">${escapeHtml(t(`cf.type.${field.type}`))}</span>`];
    if (field.type === "lookup") list.push(`<span class="badge badge-info">${escapeHtml(t("cf.linkBadge", { name: targetName(field.lookupTarget) }))}</span>`);
    if (sectionName(field.sectionId)) list.push(`<span class="badge badge-neutral"><i class="fa-solid fa-layer-group" aria-hidden="true"></i> ${escapeHtml(t("cf.sectionBadge", { name: sectionName(field.sectionId) }))}</span>`);
    if (field.required) list.push(`<span class="badge badge-warning">${escapeHtml(t("cf.requiredBadge"))}</span>`);
    if (field.listColumn) list.push(`<span class="badge badge-success">${escapeHtml(t("cf.columnBadge"))}</span>`);
    if (field.type === "dropdown") list.push(`<span class="badge badge-info">${escapeHtml(t("cf.choiceCount", { count: field.options.filter((o) => !o.archived).length }))}</span>`);
    return list.join("");
  }

  function moveButtons(index, count) {
    const up = escapeHtml(t("cf.moveUp"));
    const down = escapeHtml(t("cf.moveDown"));
    return `<div class="cf-move">
        <button type="button" class="icon-btn" data-act="up" aria-label="${up}" title="${up}"${index === 0 ? " disabled" : ""}><i class="fa-solid fa-chevron-up"></i></button>
        <button type="button" class="icon-btn" data-act="down" aria-label="${down}" title="${down}"${index === count - 1 ? " disabled" : ""}><i class="fa-solid fa-chevron-down"></i></button>
      </div>`;
  }

  function rowHtml(field, index, count) {
    return `<div class="cf-row" data-id="${escapeHtml(field.id)}">
      ${moveButtons(index, count)}
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

  function emptyText() {
    if (object === "contact") return t("cf.emptyContact");
    if (object === "lead") return t("cf.emptyLead");
    return t("cf.emptyObject", { name: targetName(object) });
  }

  function render() {
    const list = active();
    $("cfCount").textContent = t("cf.count", { used: list.length, max: MAX_FIELDS });
    $("cfAdd").disabled = list.length >= MAX_FIELDS;
    $("cfList").innerHTML = list.length
      ? list.map((field, index) => rowHtml(field, index, list.length)).join("")
      : `<p class="settings-hint">${escapeHtml(emptyText())}</p>`;
    const old = archived();
    $("cfArchivedBox").hidden = !old.length;
    $("cfArchivedTitle").textContent = t("cf.archivedTitle", { count: old.length });
    $("cfArchived").innerHTML = old.map(archivedRowHtml).join("");
    renderSections();
  }

  async function load() {
    const asked = object;
    try {
      const [list, saved] = await Promise.all([
        crmApi(`/custom-fields?object=${encodeURIComponent(asked)}&status=all`),
        crmApi(`/custom-fields/layout?object=${encodeURIComponent(asked)}`),
      ]);
      if (asked !== object) return; // another object was chosen meanwhile
      fields = list;
      layout = saved;
      syncDraft();
      render();
    } catch (error) {
      if (asked !== object) return;
      $("cfList").innerHTML = `<p class="settings-hint">${escapeHtml(errorText(error, "cf.err.load"))}</p>`;
    }
  }

  // --- sections (D76) ---------------------------------------------------------
  // The draft follows what is saved, unless it has unsaved changes: then fields that are gone
  // leave it, and a field just given a section (in its form) joins that section.
  function syncDraft() {
    const list = active();
    if (!dirty) {
      draft = layout.sections.map((s) => ({ ...s, fieldIds: list.filter((f) => f.sectionId === s.id).map((f) => f.id) }));
      return;
    }
    const ids = new Set(list.map((f) => f.id));
    for (const section of draft) section.fieldIds = section.fieldIds.filter((id) => ids.has(id));
    for (const field of list) {
      const home = field.sectionId && draft.find((s) => s.id === field.sectionId);
      if (home && !draft.some((s) => s.fieldIds.includes(field.id))) home.fieldIds.push(field.id);
    }
  }

  // "in Machine details": where a field is now, when that is another section.
  function placeText(fieldId, index) {
    const other = draft.findIndex((s, i) => i !== index && s.fieldIds.includes(fieldId));
    return other < 0 ? "" : t("cf.sec.inOther", { name: draft[other].label.trim() || t("cf.sec.unnamed") });
  }

  function sectionCardHtml(section, index) {
    const list = active();
    const name = escapeHtml(t("cf.sec.name"));
    const boxes = list
      .map((field) => `<label class="cf-check-inline"><input type="checkbox" value="${escapeHtml(field.id)}"${section.fieldIds.includes(field.id) ? " checked" : ""} /> <span>${escapeHtml(field.label)}</span><small class="cf-sec-where">${escapeHtml(placeText(field.id, index))}</small></label>`)
      .join("");
    return `<div class="cf-sec" data-index="${index}">
      <div class="cf-sec-head">
        ${moveButtons(index, draft.length)}
        <input type="text" class="cf-sec-name" maxlength="40" value="${escapeHtml(section.label)}" aria-label="${name}" placeholder="${escapeHtml(t("cf.sec.namePlaceholder"))}" />
        <div class="cf-sec-cols" role="radiogroup" aria-label="${escapeHtml(t("cf.sec.columns"))}">
          ${[1, 2].map((n) => `<button type="button" role="radio" class="btn btn-outline${section.columns === n ? " active" : ""}" data-cols="${n}" aria-checked="${section.columns === n}">${escapeHtml(t(n === 1 ? "cf.sec.one" : "cf.sec.two"))}</button>`).join("")}
        </div>
        <button type="button" class="btn btn-outline" data-act="remove-section">${escapeHtml(t("cf.sec.remove"))}</button>
      </div>
      <div class="cf-sec-fields" role="group" aria-label="${escapeHtml(t("cf.sec.fields"))}">${boxes || `<span class="settings-hint">${escapeHtml(t("cf.sec.noFields"))}</span>`}</div>
    </div>`;
  }

  function renderSections(focus) {
    $("cfSectionsBox").hidden = false;
    $("cfSectionList").innerHTML = draft.length ? draft.map(sectionCardHtml).join("") : `<p class="settings-hint">${escapeHtml(t("cf.sec.empty"))}</p>`;
    $("cfSectionAdd").disabled = draft.length >= MAX_SECTIONS;
    $("cfSectionSave").disabled = !dirty || busy;
    $("cfSectionState").textContent = dirty ? t("cf.sec.unsaved") : draft.length >= MAX_SECTIONS ? t("cf.sec.full", { max: MAX_SECTIONS }) : "";
    if (focus) $("cfSectionList").querySelector(focus)?.focus();
  }

  // Ticks and "in …" notes follow the draft without drawing the cards again (the focus stays).
  function refreshMarks() {
    $("cfSectionList").querySelectorAll(".cf-sec").forEach((card) => {
      const index = Number(card.dataset.index);
      card.querySelectorAll(".cf-sec-fields input").forEach((box) => {
        box.checked = draft[index].fieldIds.includes(box.value);
        box.closest("label").querySelector(".cf-sec-where").textContent = placeText(box.value, index);
      });
    });
  }

  function markDirty() {
    dirty = true;
    $("cfSectionSave").disabled = busy;
    $("cfSectionState").textContent = t("cf.sec.unsaved");
  }

  async function saveSections() {
    if (busy) return;
    const unnamed = [...$("cfSectionList").querySelectorAll(".cf-sec-name")].find((input) => !input.value.trim());
    if (unnamed) {
      showToast(t("cf.err.sectionName"), "error");
      unnamed.focus();
      return;
    }
    busy = true;
    $("cfSectionSave").disabled = true;
    try {
      const sections = draft.map((s) => ({ ...(s.id && { id: s.id }), label: s.label.trim(), columns: s.columns, fieldIds: s.fieldIds }));
      await crmApi("/custom-fields/layout", jsonRequest("PUT", { object, version: layout.version, sections }));
      dirty = false;
      showToast(t("cf.sec.saved"), "success");
    } catch (error) {
      showToast(errorText(error, "cf.err.save"), "error");
      // Someone else changed them: start again from what is saved now.
      if (["VERSION_CONFLICT", "INVALID_SECTION"].includes(codeOf(error))) dirty = false;
    } finally {
      busy = false;
    }
    await load();
  }

  // The field form's Section choice: the saved sections ("More details" = none).
  function fillSectionChoice(chosen) {
    $("cfSectionField").hidden = !layout.sections.length;
    $("cfSection").innerHTML = [["", t("cf.moreDetails")], ...layout.sections.map((s) => [s.id, s.label])]
      .map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`)
      .join("");
    $("cfSection").value = layout.sections.some((s) => s.id === chosen) ? chosen : "";
  }

  // --- the company's own objects (D75) ------------------------------------
  function objectRowHtml(o, index, count) {
    return `<div class="cf-row" data-id="${escapeHtml(o.id)}">
      ${moveButtons(index, count)}
      <div class="co-row-icon"><i class="fa-solid fa-${escapeHtml(o.icon)}"></i></div>
      <div class="cf-row-main">
        <div class="cf-row-name">${escapeHtml(o.plural)}</div>
        <div class="cf-help">${escapeHtml(t("co.oneIs", { name: o.singular }))}</div>
      </div>
      <div class="cf-row-actions">
        <button type="button" class="btn btn-outline" data-act="edit">${escapeHtml(t("cf.edit"))}</button>
        <button type="button" class="btn btn-outline" data-act="archive">${escapeHtml(t("cf.archive"))}</button>
      </div>
    </div>`;
  }

  function renderObjects() {
    const list = activeObjects();
    $("coCount").textContent = t("co.count", { used: list.length, max: MAX_OBJECTS });
    $("coAdd").disabled = list.length >= MAX_OBJECTS;
    $("coList").innerHTML = list.length
      ? list.map((o, index) => objectRowHtml(o, index, list.length)).join("")
      : `<p class="settings-hint">${escapeHtml(t("co.empty"))}</p>`;
    const old = objects.filter((o) => o.status === "archived");
    $("coArchivedBox").hidden = !old.length;
    $("coArchivedTitle").textContent = t("co.archivedTitle", { count: old.length });
    $("coArchived").innerHTML = old
      .map((o) => `<div class="cf-row" data-id="${escapeHtml(o.id)}"><div class="co-row-icon"><i class="fa-solid fa-${escapeHtml(o.icon)}"></i></div><div class="cf-row-main"><div class="cf-row-name">${escapeHtml(o.plural)}</div></div><div class="cf-row-actions"><button type="button" class="btn btn-outline" data-act="restore">${escapeHtml(t("cf.restore"))}</button></div></div>`)
      .join("");
    // The switch: Customers | Leads & Deals | one button per active object.
    $("cfObjectSwitch").querySelectorAll("[data-cf-dynamic]").forEach((button) => button.remove());
    $("cfObjectSwitch").insertAdjacentHTML(
      "beforeend",
      list.map((o) => `<button type="button" class="btn btn-outline" data-cf-object="${escapeHtml(o.key)}" data-cf-dynamic aria-pressed="false"><i class="fa-solid fa-${escapeHtml(o.icon)}"></i> ${escapeHtml(o.plural)}</button>`).join(""),
    );
    if (!["contact", "lead"].includes(object) && !list.some((o) => o.key === object)) chooseObject("contact");
    else markObject();
    // What a new link field can point to.
    $("cfTarget").innerHTML = [["contact", t("cf.obj.contact")], ["lead", t("cf.obj.lead")], ...list.map((o) => [o.key, o.plural])]
      .map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`)
      .join("");
  }

  async function loadObjects() {
    try {
      objects = await crmApi("/custom-objects?status=all");
      renderObjects();
    } catch (error) {
      $("coList").innerHTML = `<p class="settings-hint">${escapeHtml(errorText(error, "cf.err.load"))}</p>`;
    }
  }

  function iconPickerHtml(chosen) {
    return ICONS.map((icon) => `<label class="co-icon" title="${escapeHtml(t(`co.icons.${icon}`))}"><input type="radio" name="coIcon" value="${icon}"${icon === chosen ? " checked" : ""} aria-label="${escapeHtml(t(`co.icons.${icon}`))}" /><i class="fa-solid fa-${icon}"></i></label>`).join("");
  }

  function openObjectForm(o = null) {
    editingObject = o;
    $("coFormTitle").textContent = t(o ? "co.editTitle" : "co.addTitle");
    $("coSingular").value = o?.singular || "";
    $("coPlural").value = o?.plural || "";
    $("coIcons").innerHTML = iconPickerHtml(o?.icon || "box");
    $("coForm").hidden = false;
    $("coAdd").hidden = true;
    $("coSingular").focus();
  }

  function closeObjectForm() {
    $("coForm").reset();
    $("coForm").hidden = true;
    $("coAdd").hidden = false;
    editingObject = null;
  }

  async function saveObject(event) {
    event.preventDefault();
    if (busy) return;
    const body = { singular: $("coSingular").value.trim(), plural: $("coPlural").value.trim(), icon: $("coForm").querySelector('input[name="coIcon"]:checked')?.value || "box" };
    if (!body.singular || !body.plural) {
      showToast(t("co.err.name"), "error");
      return;
    }
    busy = true;
    $("coSave").disabled = true;
    try {
      const created = editingObject ? null : await crmApi("/custom-objects", jsonRequest("POST", body));
      if (editingObject) await crmApi(`/custom-objects/${editingObject.id}`, jsonRequest("PATCH", { ...body, version: editingObject.version }));
      showToast(t(editingObject ? "co.saved" : "co.addedNext"), "success");
      closeObjectForm();
      await loadObjects();
      crmRefreshRecordNav(); // js/app.js: the "Your records" menu
      if (created) {
        // Straight on to its fields: the switch on the new object and the add-field form open.
        chooseObject(created.key);
        openForm();
        $("cfForm").scrollIntoView({ block: "center", behavior: "smooth" });
      }
    } catch (error) {
      showToast(errorText(error, "cf.err.save"), "error");
      if (error.code === "VERSION_CONFLICT") {
        closeObjectForm();
        await loadObjects();
      }
    } finally {
      busy = false;
      $("coSave").disabled = false;
    }
  }

  async function objectAct(path, successKey) {
    if (busy) return;
    busy = true;
    try {
      await crmApi(path, { method: "POST" });
      showToast(t(successKey), "success");
      await loadObjects();
      crmRefreshRecordNav();
    } catch (error) {
      showToast(errorText(error, "cf.err.save"), "error");
    } finally {
      busy = false;
    }
  }

  async function moveObject(id, step) {
    const ids = activeObjects().map((o) => o.id);
    const from = ids.indexOf(id);
    const to = from + step;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    try {
      await crmApi("/custom-objects/reorder", jsonRequest("POST", { ids }));
      await loadObjects();
      crmRefreshRecordNav();
    } catch (error) {
      showToast(errorText(error, "cf.err.save"), "error");
    }
  }

  // --- the field form -----------------------------------------------------
  function optionRowHtml(option = {}) {
    const name = escapeHtml(t("cf.choiceName"));
    const remove = escapeHtml(t("cf.removeChoice"));
    return `<div class="cf-option-row"${option.value ? ` data-value="${escapeHtml(option.value)}"` : ""}>
      <input type="text" maxlength="60" value="${escapeHtml(option.label || "")}" aria-label="${name}" placeholder="${name}" />
      <button type="button" class="icon-btn" data-act="remove-option" aria-label="${remove}" title="${remove}"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  }

  // The type buttons (one click per type); locked while editing, since a type never changes.
  function setType(type, { locked = false } = {}) {
    $("cfType").value = type;
    $("cfTypePicker").querySelectorAll(".cf-type-option").forEach((button) => {
      const on = button.dataset.type === type;
      button.classList.toggle("active", on);
      button.setAttribute("aria-checked", String(on));
      button.disabled = locked && !on;
    });
    showTypeParts();
  }

  function showTypeParts() {
    $("cfOptionsField").hidden = $("cfType").value !== "dropdown";
    $("cfTargetField").hidden = $("cfType").value !== "lookup";
  }

  function openForm(field = null) {
    editing = field;
    $("cfFormTitle").textContent = t(field ? "cf.editTitle" : "cf.addTitle");
    $("cfLabel").value = field?.label || "";
    setType(field?.type || "text", { locked: Boolean(field) });
    $("cfCancel").textContent = t("common.cancel");
    $("cfTypeFixed").hidden = !field;
    if (field?.type === "lookup" && ![...$("cfTarget").options].some((o) => o.value === field.lookupTarget)) {
      $("cfTarget").insertAdjacentHTML("beforeend", `<option value="${escapeHtml(field.lookupTarget)}">${escapeHtml(targetName(field.lookupTarget))}</option>`);
    }
    $("cfTarget").value = field?.lookupTarget || "contact";
    $("cfTarget").disabled = Boolean(field);
    $("cfHelp").value = field?.helpText || "";
    $("cfRequired").checked = Boolean(field?.required);
    $("cfListColumn").checked = Boolean(field?.listColumn);
    fillSectionChoice(field?.sectionId);
    const options = field ? field.options.filter((o) => !o.archived) : [{}, {}];
    $("cfOptionRows").innerHTML = options.map(optionRowHtml).join("");
    showTypeParts();
    $("cfForm").hidden = false;
    $("cfAdd").hidden = true;
    $("cfLabel").focus();
  }

  // After adding a field the form stays open for the next one; "Done" closes it.
  function nextField() {
    const section = $("cfSection").value; // the next field likely goes to the same section
    $("cfForm").reset();
    fillSectionChoice(section);
    setType("text");
    $("cfOptionRows").innerHTML = [{}, {}].map(optionRowHtml).join("");
    showTypeParts();
    $("cfCancel").textContent = t("cf.done");
    $("cfLabel").focus();
  }

  function closeForm() {
    $("cfForm").reset();
    setType("text");
    $("cfForm").hidden = true;
    $("cfAdd").hidden = false;
    $("cfTarget").disabled = false;
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
    if (!$("cfSectionField").hidden) body.sectionId = $("cfSection").value || null;
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
      else await crmApi("/custom-fields", jsonRequest("POST", { ...body, object, type, ...(type === "lookup" && { lookupTarget: $("cfTarget").value }) }));
      showToast(t(editing ? "cf.saved" : "cf.added"), "success");
      if (editing) closeForm();
      else nextField();
      await load();
    } catch (error) {
      showToast(errorText(error, "cf.err.save"), "error");
      if (error.code === "VERSION_CONFLICT") {
        closeForm();
        await load();
      } else if (codeOf(error) === "INVALID_SECTION") {
        // The section was removed meanwhile: the choice is drawn again from what is saved.
        const kept = editing;
        await load();
        fillSectionChoice(kept?.sectionId);
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

  function markObject() {
    $("cfObjectSwitch").querySelectorAll("[data-cf-object]").forEach((b) => {
      b.classList.toggle("active", b.dataset.cfObject === object);
      b.setAttribute("aria-pressed", String(b.dataset.cfObject === object));
    });
  }

  function chooseObject(key) {
    object = key;
    dirty = false; // unsaved sections of the page left behind are dropped
    draft = [];
    layout = { sections: [], version: 0 };
    markObject();
    closeForm();
    load();
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
  $("coList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    const id = button?.closest(".cf-row")?.dataset.id;
    if (!id) return;
    if (button.dataset.act === "up") moveObject(id, -1);
    if (button.dataset.act === "down") moveObject(id, 1);
    if (button.dataset.act === "edit") openObjectForm(objects.find((o) => o.id === id));
    if (button.dataset.act === "archive") {
      if (editingObject?.id === id) closeObjectForm();
      objectAct(`/custom-objects/${id}/archive`, "co.archived");
    }
  });
  $("coArchived").addEventListener("click", (event) => {
    const button = event.target.closest('button[data-act="restore"]');
    const id = button?.closest(".cf-row")?.dataset.id;
    if (id) objectAct(`/custom-objects/${id}/restore`, "co.restored");
  });
  $("cfOptionRows").addEventListener("click", (event) => {
    const button = event.target.closest('button[data-act="remove-option"]');
    if (button) button.closest(".cf-option-row").remove();
  });
  $("cfAddOption").addEventListener("click", () => {
    $("cfOptionRows").insertAdjacentHTML("beforeend", optionRowHtml());
    $("cfOptionRows").lastElementChild.querySelector("input").focus();
  });
  $("cfTypePicker").addEventListener("click", (event) => {
    const button = event.target.closest(".cf-type-option");
    if (button && !button.disabled && !editing) setType(button.dataset.type);
  });
  // Enter on a type button saves the field, as Enter in the name box does (not just "click" it again).
  $("cfTypePicker").addEventListener("keydown", (event) => {
    const button = event.target.closest(".cf-type-option");
    if (!button || event.key !== "Enter") return;
    event.preventDefault();
    if (!editing && !button.disabled) setType(button.dataset.type);
    $("cfForm").requestSubmit();
  });
  // Sections: typing a name, ticking fields, columns, ↑ ↓ and Remove change the draft; Save sends it.
  $("cfSectionList").addEventListener("input", (event) => {
    const input = event.target.closest(".cf-sec-name");
    if (!input) return;
    draft[Number(input.closest(".cf-sec").dataset.index)].label = input.value;
    markDirty();
    refreshMarks();
  });
  $("cfSectionList").addEventListener("change", (event) => {
    const box = event.target.closest(".cf-sec-fields input");
    if (!box) return;
    const index = Number(box.closest(".cf-sec").dataset.index);
    // A field is in one section at most: ticking it here takes it out of the other.
    for (const section of draft) section.fieldIds = section.fieldIds.filter((id) => id !== box.value);
    if (box.checked) draft[index].fieldIds.push(box.value);
    markDirty();
    refreshMarks();
  });
  $("cfSectionList").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    const card = button?.closest(".cf-sec");
    if (!card) return;
    const index = Number(card.dataset.index);
    if (button.dataset.cols) {
      draft[index].columns = Number(button.dataset.cols);
      card.querySelectorAll("[data-cols]").forEach((b) => {
        b.classList.toggle("active", b === button);
        b.setAttribute("aria-checked", String(b === button));
      });
      markDirty();
    } else if (button.dataset.act === "up" || button.dataset.act === "down") {
      const to = index + (button.dataset.act === "up" ? -1 : 1);
      if (to < 0 || to >= draft.length) return;
      [draft[index], draft[to]] = [draft[to], draft[index]];
      markDirty();
      renderSections(`.cf-sec[data-index="${to}"] [data-act="${button.dataset.act}"]:not(:disabled)`);
    } else if (button.dataset.act === "remove-section") {
      draft.splice(index, 1);
      markDirty();
      renderSections(draft.length ? `.cf-sec[data-index="${Math.max(0, index - 1)}"] .cf-sec-name` : null);
      if (!draft.length) $("cfSectionAdd").focus();
    }
  });
  $("cfSectionAdd").addEventListener("click", () => {
    if (draft.length >= MAX_SECTIONS) return;
    draft.push({ label: "", columns: 1, fieldIds: [] });
    markDirty();
    renderSections(`.cf-sec[data-index="${draft.length - 1}"] .cf-sec-name`);
    // Its field ticks too, not only the name box.
    $("cfSectionList").lastElementChild.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  $("cfSectionSave").addEventListener("click", saveSections);
  $("cfAdd").addEventListener("click", () => openForm());
  $("cfCancel").addEventListener("click", closeForm);
  $("cfForm").addEventListener("submit", save);
  $("coAdd").addEventListener("click", () => openObjectForm());
  $("coCancel").addEventListener("click", closeObjectForm);
  $("coForm").addEventListener("submit", saveObject);
  $("cfObjectSwitch").addEventListener("click", (event) => {
    const button = event.target.closest("[data-cf-object]");
    if (button && button.dataset.cfObject !== object) chooseObject(button.dataset.cfObject);
  });

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    loadObjects();
    load();
  }
  document.querySelector('.settings-tab[data-panel="fields"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="fields"]').classList.contains("active")) loadOnce();
})();
