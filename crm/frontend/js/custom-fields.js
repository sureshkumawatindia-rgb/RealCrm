/**
 * custom-fields.js — the company's own fields (D73) in the customer, lead and deal forms and on
 * Customer 360. Owners and admins set them up in Settings → Custom fields.
 *   cfMount(container, object, values)  draws the inputs ("contact" or "lead") with a record's values
 *   cfRead(container)                    { key: value } for the API, or undefined (fields not loaded)
 *   cfShowErrors(container, error)       marks the fields the API refused; true when it marked any
 *   cfFilledValues(object, values)       the filled values as [{ label, text, heading }] (Customer 360)
 * Phase 1B (D74), for the Customers, Leads and Deals lists:
 *   cfFilterBar({ container, object, storageKey, onChange })  "Filter by field" with up to 3 chips
 *   cfApplyFilters(records, filters, fields, valuesOf)        the records every filter matches
 *   cfSearchText(fields, values)          the words the page's search box finds a record by
 *   cfListColumns(fields), cfDisplayValue(field, value, link) the chosen columns and their cells
 * Phase 1C (D75): link fields — cfLinkPickerHtml / cfWireLinks (search and pick one record).
 * Phase 1D (D76): sections — cfLoadLayout(object), cfGroups(fields, sections); the forms and
 * Customer 360 show the fields under their sections' headings, then "More details".
 * Loads after app.js. Names start with cf: page scripts share one global scope.
 */
const cfFieldsByObject = {};
const cfFieldsReady = {}; // object → the loaded fields, for page renders that cannot wait

// The active fields, once per page. A member who may not see them (or a failed request) gets none.
function cfLoad(object) {
  if (!cfFieldsByObject[object]) {
    cfFieldsByObject[object] = crmApi(`/custom-fields?object=${encodeURIComponent(object)}`)
      .then((fields) => {
        cfFieldsReady[object] = fields || [];
        return fields;
      })
      .catch(() => {
        delete cfFieldsByObject[object];
        return null;
      });
  }
  return cfFieldsByObject[object];
}

const cfLayoutsByObject = {};

// The object's sections (D76), once per page; none when they cannot be read.
function cfLoadLayout(object) {
  if (!cfLayoutsByObject[object]) {
    cfLayoutsByObject[object] = crmApi(`/custom-fields/layout?object=${encodeURIComponent(object)}`)
      .then((layout) => layout?.sections || [])
      .catch(() => {
        delete cfLayoutsByObject[object];
        return [];
      });
  }
  return cfLayoutsByObject[object];
}

// The fields grouped as the forms show them: each section in order (one without fields is left
// out), then the fields of no section, or of one removed meanwhile, as { section: null }.
function cfGroups(fields, sections) {
  const groups = new Map((sections || []).map((section) => [section.id, { section, fields: [] }]));
  const rest = { section: null, fields: [] };
  for (const field of fields || []) (groups.get(field.sectionId) || rest).fields.push(field);
  return [...groups.values(), rest].filter((group) => group.fields.length);
}

// The fields already loaded ([] until cfLoad has finished).
function cfFields(object) {
  return cfFieldsReady[object] || [];
}

function cfOptionLabel(field, value) {
  const option = (field.options || []).find((o) => o.value === value);
  if (!option) return "";
  return option.archived ? t("cf.removedChoice", { label: option.label }) : option.label;
}

// link: for a link field, { id, name } | { id, hidden } | { id, missing } of the record it points to.
function cfInputHtml(field, value, idPrefix, link) {
  const id = `${idPrefix}_${field.key}`;
  // "See only" for this member (D77): shown, never sent, and not asked for.
  const locked = field.canEdit === false;
  const star = field.required && !locked ? ' <span class="cf-required" aria-hidden="true">*</span>' : "";
  const required = field.required && !locked ? ' aria-required="true"' : "";
  const helpText = [field.helpText, locked && t("cf.access.locked")].filter(Boolean).join(" · ");
  const help = helpText ? `<div class="cf-help" id="${id}_help">${locked ? '<i class="fa-solid fa-lock" aria-hidden="true"></i> ' : ""}${escapeHtml(helpText)}</div>` : "";
  const described = (helpText ? ` aria-describedby="${id}_help"` : "") + (locked ? " disabled" : "");
  const label = `<label for="${id}">${escapeHtml(field.label)}${star}</label>`;
  // A long text takes the whole row of a 2-column section.
  const wide = field.type === "textarea" ? " cf-wide" : "";
  const current = value == null ? "" : String(value);
  let input;
  switch (field.type) {
    case "textarea":
      input = `<textarea id="${id}" rows="3" maxlength="2000"${required}${described}>${escapeHtml(current)}</textarea>`;
      break;
    case "number":
      // Text, not type=number: the browser would quietly drop what it cannot read; the API says why.
      input = `<input type="text" inputmode="decimal" id="${id}" value="${escapeHtml(current)}"${required}${described} />`;
      break;
    case "date":
      input = `<input type="date" id="${id}" value="${escapeHtml(current)}"${required}${described} />`;
      break;
    case "dropdown": {
      // A choice archived since stays on the record that has it.
      const choices = (field.options || []).filter((o) => !o.archived || o.value === current);
      input = `<select id="${id}"${required}${described}><option value="">${escapeHtml(t("cf.choose"))}</option>${choices
        .map((o) => `<option value="${escapeHtml(o.value)}"${o.value === current ? " selected" : ""}>${escapeHtml(cfOptionLabel(field, o.value))}</option>`)
        .join("")}</select>`;
      break;
    }
    case "lookup":
      // "See only": the linked record's name, nothing to pick.
      if (locked) {
        input = `<input type="text" id="${id}" value="${escapeHtml(cfLinkText(link))}"${described} />`;
        break;
      }
      // A deleted record is not kept: the next save clears the link.
      input = cfLinkPickerHtml(id, field.lookupTarget, link?.missing ? "" : current, cfLinkText(link), `${required}${described}`);
      break;
    case "checkbox":
      return `<div class="field" data-cf-key="${escapeHtml(field.key)}"><label class="cf-check" for="${id}"><input type="checkbox" id="${id}"${value === true ? " checked" : ""}${described} /> <span>${escapeHtml(field.label)}${star}</span></label>${help}<div class="cf-error" role="alert"></div></div>`;
    default:
      input = `<input type="text" id="${id}" maxlength="255" value="${escapeHtml(current)}"${required}${described} />`;
  }
  return `<div class="field${wide}" data-cf-key="${escapeHtml(field.key)}">${label}${input}${help}<div class="cf-error" role="alert"></div></div>`;
}

function cfRender(container, fields, values, links, sections = []) {
  container.cfFields = fields;
  container.hidden = !fields || !fields.length;
  if (container.hidden) {
    container.innerHTML = "";
    return;
  }
  const prefix = container.id || "cf";
  container.innerHTML = cfGroups(fields, sections)
    .map(({ section, fields: list }, index) => `
      <div class="cf-group${section?.columns === 2 ? " cf-cols-2" : ""}" role="group" aria-labelledby="${prefix}_g${index}">
        <div class="cf-section-title" id="${prefix}_g${index}">${escapeHtml(section ? section.label : t("cf.moreDetails"))}</div>
        <div class="cf-grid">${list.map((field) => cfInputHtml(field, values?.[field.key], prefix, links?.[field.key])).join("")}</div>
      </div>`)
    .join("");
  cfWireLinks(container);
}

// links: the record's customFieldLinks, for the names of the records its link fields point to.
async function cfMount(container, object, values = {}, links = {}) {
  if (!container) return;
  container.cfFields = undefined; // until loaded, the form sends no custom fields at all
  const ticket = Symbol("cf");
  container.cfTicket = ticket;
  const [fields, sections] = await Promise.all([cfLoad(object), cfLoadLayout(object)]);
  if (container.cfTicket !== ticket) return; // the form was opened again meanwhile
  cfRender(container, fields, values, links, sections);
}

// Every active field, so an emptied one is cleared (and a required one is asked for).
function cfRead(container) {
  const fields = container?.cfFields;
  if (!fields || !fields.length) return undefined;
  const values = {};
  for (const field of fields) {
    if (field.canEdit === false) continue; // "see only" (D77): the server keeps its value
    const el = container.querySelector(`[data-cf-key="${CSS.escape(field.key)}"] input, [data-cf-key="${CSS.escape(field.key)}"] select, [data-cf-key="${CSS.escape(field.key)}"] textarea`);
    if (!el) continue;
    if (field.type === "checkbox") values[field.key] = el.checked;
    else if (field.type === "lookup") values[field.key] = el.closest(".cf-link").querySelector(".cf-link-value").value || null;
    else values[field.key] = el.value.trim() === "" ? null : el.value.trim();
  }
  return values;
}

function cfClearErrors(container) {
  container?.querySelectorAll(".field.cf-invalid").forEach((el) => {
    el.classList.remove("cf-invalid");
    el.querySelector(".cf-error").textContent = "";
  });
}

// The API names each refused field (customFields.<key>) with a code; the text is in the page's language.
function cfShowErrors(container, error) {
  cfClearErrors(container);
  const fields = container?.cfFields || [];
  let first = null;
  for (const item of error?.errors || []) {
    const key = /^customFields\.(.+)$/.exec(item.field || "")?.[1];
    const box = key && container.querySelector(`[data-cf-key="${CSS.escape(key)}"]`);
    if (!box) continue;
    const field = fields.find((f) => f.key === key);
    const text = t(`cf.err.${item.code}`, { label: field?.label || key });
    box.classList.add("cf-invalid");
    box.querySelector(".cf-error").textContent = text === `cf.err.${item.code}` ? item.message : text;
    first = first || box;
  }
  if (first) first.querySelector("input, select, textarea")?.focus();
  return Boolean(first);
}

function cfDisplayValue(field, value, link) {
  if (value == null || value === "") return "";
  switch (field.type) {
    case "lookup":
      return cfLinkText(link);
    case "dropdown":
      return cfOptionLabel(field, value);
    case "checkbox":
      return value === true ? t("cf.yes") : "";
    case "number":
      return Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 });
    case "date":
      return new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    default:
      return String(value);
  }
}

// The filled values as [{ label, text, heading }] in the forms' order (read-only views such as
// Customer 360). heading: the section's name, "More details" after sections, null when the
// object has no sections.
async function cfFilledValues(object, values = {}, links = {}) {
  const [fields, sections] = await Promise.all([cfLoad(object), cfLoadLayout(object)]);
  const groups = cfGroups(fields || [], sections);
  const sectioned = groups.some((group) => group.section);
  return groups.flatMap(({ section, fields: list }) => list
    .map((field) => ({
      label: field.label,
      text: cfDisplayValue(field, values?.[field.key], links?.[field.key]),
      heading: section ? section.label : sectioned ? t("cf.moreDetails") : null,
    }))
    .filter((row) => row.text));
}

// --- Phase 1B (D74): filters, list columns and search on the list pages -----------------------
// The operators and rules of backend/src/services/customFieldFilters.js; the backend tests check
// cfMatches against the same table of cases as the server.
const CF_OPERATORS = {
  text: ["has", "is", "empty", "filled"],
  textarea: ["has", "is", "empty", "filled"],
  number: ["eq", "gt", "gte", "lt", "lte", "empty", "filled"],
  date: ["eq", "before", "after", "from", "to", "empty", "filled"],
  dropdown: ["in", "empty", "filled"],
  checkbox: ["yes", "no"],
};
const CF_NO_VALUE = new Set(["empty", "filled", "yes", "no"]);
const CF_MAX_PAGE_FILTERS = 3;
const CF_MAX_COLUMNS = 3;

// "1,25,000", "₹ 2,500", "Rs. 99.50" → a number; NaN when it is not one.
function cfReadNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
  const text = String(raw ?? "").trim().replace(/^(₹|rs\.?|inr)\s*/i, "").replace(/[,\s]/g, "");
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
}

// Does one record's value pass one filter?
function cfMatches(field, stored, operator, raw = "") {
  const empty = stored === undefined || stored === null || stored === "";
  if (operator === "empty") return empty;
  if (operator === "filled") return !empty;
  const want = String(raw ?? "").trim();
  switch (field.type) {
    case "text":
    case "textarea": {
      if (empty || !want) return false;
      const have = String(stored).toLowerCase();
      return operator === "is" ? have === want.toLowerCase() : have.includes(want.toLowerCase());
    }
    case "number": {
      const number = cfReadNumber(want);
      if (empty || typeof stored !== "number" || !Number.isFinite(number)) return false;
      return { eq: stored === number, gt: stored > number, gte: stored >= number, lt: stored < number, lte: stored <= number }[operator] || false;
    }
    case "date": {
      if (empty || !want) return false;
      const have = String(stored); // YYYY-MM-DD sorts like a date
      return { eq: have === want, before: have < want, after: have > want, from: have >= want, to: have <= want }[operator] || false;
    }
    case "dropdown":
      return !empty && want.split(",").map((value) => value.trim()).includes(stored);
    case "checkbox":
      return operator === "yes" ? stored === true : stored !== true;
    case "lookup":
      return !empty && String(stored) === want;
    default:
      return false;
  }
}

// The records every filter ({ key, operator, value }) matches. Filters on fields that are gone are ignored.
function cfApplyFilters(records, filters, fields, valuesOf = (record) => record.customFields) {
  const active = (filters || [])
    .map((filter) => ({ ...filter, field: (fields || []).find((field) => field.key === filter.key) }))
    .filter((filter) => filter.field && (CF_OPERATORS[filter.field.type] || []).includes(filter.operator));
  if (!active.length) return records;
  return records.filter((record) => active.every((filter) => cfMatches(filter.field, valuesOf(record)?.[filter.key], filter.operator, filter.value)));
}

// What a page's search box finds a record by: its text fields and its dropdowns' choice names.
function cfSearchText(fields, values) {
  return (fields || [])
    .filter((field) => ["text", "textarea", "dropdown"].includes(field.type))
    .map((field) => (field.type === "dropdown" ? cfOptionLabel(field, values?.[field.key]) : values?.[field.key] ?? ""))
    .join(" ")
    .toLowerCase();
}

// The chips as the API's cf=<key>:<operator>:<value> (D82: "Download Excel" sends the same filters).
function cfQueryParams(filters, params = new URLSearchParams()) {
  for (const filter of filters || []) params.append("cf", [filter.key, filter.operator, Array.isArray(filter.value) ? filter.value.join(",") : filter.value ?? ""].join(":"));
  return params;
}

// Download Excel on a list page (D82, owners and admins): the server makes the file from the
// same search and filters; the button only shows for those who may download.
function cfExportButton({ button, path, name, params }) {
  if (!button || !isOrgManager()) return;
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await crmDownload(`${path}?${params()}`, `${name}-${new Date().toISOString().slice(0, 10)}.xlsx`);
      showToast(t("xl.downloaded"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("xl.downloadFailed")), "error");
    } finally {
      button.disabled = false;
    }
  });
}

// The fields owners and admins chose as list columns (Settings → Custom fields).
function cfListColumns(fields) {
  return (fields || []).filter((field) => field.listColumn).slice(0, CF_MAX_COLUMNS);
}

function cfOperatorLabel(field, operator) {
  return t(field.type === "date" && operator === "eq" ? "cf.op.on" : `cf.op.${operator}`);
}

// "Filter by field" on a list page: up to 3 chips, remembered in this browser for this page.
// onChange runs when the chips change (and once the fields are in). Returns { filters() }.
function cfFilterBar({ container, object, storageKey, onChange }) {
  let fields = [];
  const saved = getPreference(storageKey, []);
  let filters = Array.isArray(saved) ? saved : [];
  const fieldOf = (key) => fields.find((field) => field.key === key);
  const valid = () => filters.filter((filter) => fieldOf(filter.key) && CF_OPERATORS[fieldOf(filter.key).type].includes(filter.operator));
  const changed = () => {
    setPreference(storageKey, filters);
    render();
    onChange();
  };

  function chipText(filter) {
    const field = fieldOf(filter.key);
    let value = "";
    if (!CF_NO_VALUE.has(filter.operator)) {
      if (field.type === "dropdown") value = filter.value.split(",").map((v) => cfOptionLabel(field, v) || v).join(", ");
      else if (field.type === "lookup") value = filter.label || t("cf.hidden");
      else if (field.type === "date") value = cfDisplayValue(field, filter.value);
      else value = filter.value;
    }
    // "Credit days is more than 30" / "Credit days इससे ज़्यादा: 30" (the Hindi words carry the colon).
    return [field.label, cfOperatorLabel(field, filter.operator), value].filter(Boolean).join(" ");
  }

  function render() {
    container.hidden = !fields.length;
    if (!fields.length) {
      container.innerHTML = "";
      return;
    }
    const list = valid();
    const remove = escapeHtml(t("cf.removeFilter"));
    container.innerHTML = `
      <div class="cf-chips">
        ${list.map((filter, index) => `<span class="cf-chip">${escapeHtml(chipText(filter))}<button type="button" class="cf-chip-x" data-index="${index}" aria-label="${remove}" title="${remove}"><i class="fa-solid fa-xmark"></i></button></span>`).join("")}
        <button type="button" class="btn btn-outline cf-filter-add"${list.length >= CF_MAX_PAGE_FILTERS ? " disabled" : ""}><i class="fa-solid fa-filter"></i> <span>${escapeHtml(t("cf.filterBy"))}</span></button>
        ${list.length ? `<button type="button" class="link-clear cf-filter-clear">${escapeHtml(t("cf.clearFilters"))}</button>` : ""}
      </div>
      <form class="cf-filter-form" hidden autocomplete="off">
        <select class="cf-f-field" aria-label="${escapeHtml(t("cf.filterField"))}">${fields.map((field) => `<option value="${escapeHtml(field.key)}">${escapeHtml(field.label)}</option>`).join("")}</select>
        <select class="cf-f-op" aria-label="${escapeHtml(t("cf.filterCondition"))}"></select>
        <div class="cf-f-value"></div>
        <div class="cf-f-actions">
          <button type="submit" class="btn btn-primary">${escapeHtml(t("cf.apply"))}</button>
          <button type="button" class="btn btn-outline cf-f-cancel">${escapeHtml(t("common.cancel"))}</button>
        </div>
      </form>`;
  }

  function fillOperators() {
    const form = container.querySelector(".cf-filter-form");
    const field = fieldOf(form.querySelector(".cf-f-field").value);
    form.querySelector(".cf-f-op").innerHTML = CF_OPERATORS[field.type]
      .map((operator) => `<option value="${operator}">${escapeHtml(cfOperatorLabel(field, operator))}</option>`)
      .join("");
    fillValue();
  }

  function fillValue() {
    const form = container.querySelector(".cf-filter-form");
    const field = fieldOf(form.querySelector(".cf-f-field").value);
    const operator = form.querySelector(".cf-f-op").value;
    const box = form.querySelector(".cf-f-value");
    const label = escapeHtml(t("cf.filterValue"));
    if (CF_NO_VALUE.has(operator)) box.innerHTML = "";
    else if (field.type === "dropdown") {
      box.innerHTML = field.options
        .filter((o) => !o.archived)
        .map((o) => `<label class="cf-check-inline"><input type="checkbox" value="${escapeHtml(o.value)}" /> <span>${escapeHtml(o.label)}</span></label>`)
        .join("");
    } else if (field.type === "lookup") {
      box.innerHTML = cfLinkPickerHtml(`${container.id || "cf"}_filterLink`, field.lookupTarget, "", "", ` aria-label="${label}"`);
      cfWireLinks(box);
    } else if (field.type === "date") box.innerHTML = `<input type="date" class="cf-f-input" aria-label="${label}" />`;
    else if (field.type === "number") box.innerHTML = `<input type="text" inputmode="decimal" class="cf-f-input" aria-label="${label}" placeholder="${label}" />`;
    else box.innerHTML = `<input type="text" class="cf-f-input" maxlength="100" aria-label="${label}" placeholder="${label}" />`;
  }

  container.addEventListener("click", (event) => {
    const remove = event.target.closest(".cf-chip-x");
    if (remove) {
      filters = valid().filter((_, index) => index !== Number(remove.dataset.index));
      changed();
    } else if (event.target.closest(".cf-filter-clear")) {
      filters = [];
      changed();
    } else if (event.target.closest(".cf-filter-add")) {
      const form = container.querySelector(".cf-filter-form");
      form.hidden = false;
      fillOperators();
      form.querySelector(".cf-f-field").focus();
    } else if (event.target.closest(".cf-f-cancel")) {
      container.querySelector(".cf-filter-form").hidden = true;
    }
  });
  container.addEventListener("change", (event) => {
    if (event.target.matches(".cf-f-field")) fillOperators();
    else if (event.target.matches(".cf-f-op")) fillValue();
  });
  container.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    const field = fieldOf(form.querySelector(".cf-f-field").value);
    const operator = form.querySelector(".cf-f-op").value;
    let value = "";
    let label = "";
    if (!CF_NO_VALUE.has(operator)) {
      if (field.type === "lookup") {
        value = form.querySelector(".cf-link-value")?.value || "";
        label = form.querySelector(".cf-link-search")?.value || "";
      } else {
        value = field.type === "dropdown"
          ? [...form.querySelectorAll(".cf-f-value input:checked")].map((input) => input.value).join(",")
          : (form.querySelector(".cf-f-input")?.value || "").trim();
      }
      if (!value || (field.type === "number" && !Number.isFinite(cfReadNumber(value)))) {
        showToast(t("cf.err.filterValue"), "error");
        return;
      }
    }
    filters = [...valid(), { key: field.key, operator, value, ...(label && { label }) }].slice(0, CF_MAX_PAGE_FILTERS);
    changed();
  });

  Promise.all([cfLoad(object), crmI18n.ready]).then(([loaded]) => {
    fields = loaded || [];
    filters = valid(); // chips for fields that are gone are dropped quietly
    render();
    onChange();
  });
  return { filters: () => (fields.length ? valid() : []) };
}

// --- Phase 1C (D75): link fields — a search-and-pick box for one record -----------------------
// The name a link shows: the record's name, "Hidden" for one this member may not see, "" when
// the record was deleted.
function cfLinkText(link) {
  if (!link) return "";
  if (link.hidden) return t("cf.hidden");
  return link.name || "";
}

function cfLinkPickerHtml(id, target, currentId, currentText, attrs = "") {
  const clear = escapeHtml(t("cf.clearLink"));
  return `<div class="cf-link" data-target="${escapeHtml(target)}">
    <input type="text" id="${id}" class="cf-link-search" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="${id}_list" placeholder="${escapeHtml(t("cf.pickRecord"))}" value="${escapeHtml(currentText)}"${attrs} />
    <input type="hidden" class="cf-link-value" value="${escapeHtml(currentId)}" />
    <button type="button" class="icon-btn cf-link-clear" aria-label="${clear}" title="${clear}"${currentId ? "" : " hidden"}><i class="fa-solid fa-xmark"></i></button>
    <ul class="cf-link-list" id="${id}_list" role="listbox" hidden></ul>
  </div>`;
}

async function cfLinkSearch(box) {
  const input = box.querySelector(".cf-link-search");
  const list = box.querySelector(".cf-link-list");
  const ticket = (box.cfSearchTicket = (box.cfSearchTicket || 0) + 1);
  let results = [];
  try {
    results = await crmApi(`/lookup?target=${encodeURIComponent(box.dataset.target)}&q=${encodeURIComponent(input.value.trim())}`);
  } catch {
    results = [];
  }
  if (box.cfSearchTicket !== ticket || document.activeElement !== input) return; // typed on, or left
  list.innerHTML = results.length
    ? results.map((r, i) => `<li role="option" id="${input.id}_o${i}" data-id="${escapeHtml(r.id)}" data-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}${r.subtitle ? `<small>${escapeHtml(r.subtitle)}</small>` : ""}</li>`).join("")
    : `<li class="cf-link-none" aria-disabled="true">${escapeHtml(t("cf.noMatches"))}</li>`;
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function cfLinkClose(box) {
  const list = box.querySelector(".cf-link-list");
  list.hidden = true;
  box.querySelector(".cf-link-search").setAttribute("aria-expanded", "false");
  box.querySelector(".cf-link-search").removeAttribute("aria-activedescendant");
}

function cfLinkPick(box, item) {
  box.querySelector(".cf-link-value").value = item.dataset.id;
  box.querySelector(".cf-link-search").value = item.dataset.name;
  box.querySelector(".cf-link-clear").hidden = false;
  cfLinkClose(box);
}

// The pickers inside a container (a form, a filter box): typing searches the records this member
// may see; a pick sets the link; × clears it. Text left without a pick links nothing.
function cfWireLinks(container) {
  if (!container || container.cfLinksWired) return;
  container.cfLinksWired = true;
  let timer = null;
  container.addEventListener("input", (event) => {
    const input = event.target.closest(".cf-link-search");
    if (!input) return;
    const box = input.closest(".cf-link");
    box.querySelector(".cf-link-value").value = "";
    box.querySelector(".cf-link-clear").hidden = !input.value;
    clearTimeout(timer);
    timer = setTimeout(() => cfLinkSearch(box), 250);
  });
  container.addEventListener("focusin", (event) => {
    const input = event.target.closest(".cf-link-search");
    if (input && input.closest(".cf-link").querySelector(".cf-link-list").hidden) cfLinkSearch(input.closest(".cf-link"));
  });
  container.addEventListener("focusout", (event) => {
    const box = event.target.closest(".cf-link");
    if (!box) return;
    setTimeout(() => {
      if (box.contains(document.activeElement)) return;
      cfLinkClose(box);
      if (!box.querySelector(".cf-link-value").value) {
        box.querySelector(".cf-link-search").value = "";
        box.querySelector(".cf-link-clear").hidden = true;
      }
    }, 150);
  });
  container.addEventListener("keydown", (event) => {
    const input = event.target.closest(".cf-link-search");
    if (!input) return;
    const box = input.closest(".cf-link");
    const list = box.querySelector(".cf-link-list");
    const items = [...list.querySelectorAll("li[data-id]")];
    const current = items.findIndex((item) => item.classList.contains("active"));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) return cfLinkSearch(box);
      const next = items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
      items.forEach((item) => item.classList.toggle("active", item === next));
      if (next) input.setAttribute("aria-activedescendant", next.id);
    } else if (event.key === "Enter" && !list.hidden) {
      event.preventDefault(); // a pick, not the form's submit
      if (items[current]) cfLinkPick(box, items[current]);
    } else if (event.key === "Escape" && !list.hidden) {
      event.preventDefault();
      cfLinkClose(box);
    }
  });
  container.addEventListener("mousedown", (event) => {
    const item = event.target.closest(".cf-link-list li[data-id]");
    if (!item) return;
    event.preventDefault(); // keep the focus in the box
    cfLinkPick(item.closest(".cf-link"), item);
  });
  container.addEventListener("click", (event) => {
    const clear = event.target.closest(".cf-link-clear");
    if (!clear) return;
    const box = clear.closest(".cf-link");
    box.querySelector(".cf-link-value").value = "";
    box.querySelector(".cf-link-search").value = "";
    clear.hidden = true;
    box.querySelector(".cf-link-search").focus();
  });
}
