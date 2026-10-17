/**
 * custom-fields.js — the company's own fields (D73) in the customer, lead and deal forms and on
 * Customer 360. Owners and admins set them up in Settings → Custom fields.
 *   cfMount(container, object, values)  draws the inputs ("contact" or "lead") with a record's values
 *   cfRead(container)                    { key: value } for the API, or undefined (fields not loaded)
 *   cfShowErrors(container, error)       marks the fields the API refused; true when it marked any
 *   cfFilledValues(object, values)       the filled values as [{ label, text }] (Customer 360)
 * Phase 1B (D74), for the Customers, Leads and Deals lists:
 *   cfFilterBar({ container, object, storageKey, onChange })  "Filter by field" with up to 3 chips
 *   cfApplyFilters(records, filters, fields, valuesOf)        the records every filter matches
 *   cfSearchText(fields, values)          the words the page's search box finds a record by
 *   cfListColumns(fields), cfDisplayValue(field, value)       the chosen columns and their cells
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

// The fields already loaded ([] until cfLoad has finished).
function cfFields(object) {
  return cfFieldsReady[object] || [];
}

function cfOptionLabel(field, value) {
  const option = (field.options || []).find((o) => o.value === value);
  if (!option) return "";
  return option.archived ? t("cf.removedChoice", { label: option.label }) : option.label;
}

function cfInputHtml(field, value, idPrefix) {
  const id = `${idPrefix}_${field.key}`;
  const star = field.required ? ' <span class="cf-required" aria-hidden="true">*</span>' : "";
  const required = field.required ? ' aria-required="true"' : "";
  const help = field.helpText ? `<div class="cf-help" id="${id}_help">${escapeHtml(field.helpText)}</div>` : "";
  const described = field.helpText ? ` aria-describedby="${id}_help"` : "";
  const label = `<label for="${id}">${escapeHtml(field.label)}${star}</label>`;
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
    case "checkbox":
      return `<div class="field" data-cf-key="${escapeHtml(field.key)}"><label class="cf-check" for="${id}"><input type="checkbox" id="${id}"${value === true ? " checked" : ""}${described} /> <span>${escapeHtml(field.label)}${star}</span></label>${help}<div class="cf-error" role="alert"></div></div>`;
    default:
      input = `<input type="text" id="${id}" maxlength="255" value="${escapeHtml(current)}"${required}${described} />`;
  }
  return `<div class="field" data-cf-key="${escapeHtml(field.key)}">${label}${input}${help}<div class="cf-error" role="alert"></div></div>`;
}

function cfRender(container, fields, values) {
  container.cfFields = fields;
  container.hidden = !fields || !fields.length;
  if (container.hidden) {
    container.innerHTML = "";
    return;
  }
  const prefix = container.id || "cf";
  container.innerHTML = `<div class="cf-section-title">${escapeHtml(t("cf.moreDetails"))}</div>${fields.map((field) => cfInputHtml(field, values?.[field.key], prefix)).join("")}`;
}

async function cfMount(container, object, values = {}) {
  if (!container) return;
  container.cfFields = undefined; // until loaded, the form sends no custom fields at all
  const ticket = Symbol("cf");
  container.cfTicket = ticket;
  const fields = await cfLoad(object);
  if (container.cfTicket !== ticket) return; // the form was opened again meanwhile
  cfRender(container, fields, values);
}

// Every active field, so an emptied one is cleared (and a required one is asked for).
function cfRead(container) {
  const fields = container?.cfFields;
  if (!fields || !fields.length) return undefined;
  const values = {};
  for (const field of fields) {
    const el = container.querySelector(`[data-cf-key="${CSS.escape(field.key)}"] input, [data-cf-key="${CSS.escape(field.key)}"] select, [data-cf-key="${CSS.escape(field.key)}"] textarea`);
    if (!el) continue;
    if (field.type === "checkbox") values[field.key] = el.checked;
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

function cfDisplayValue(field, value) {
  if (value == null || value === "") return "";
  switch (field.type) {
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

// The filled values, in the fields' order, as [{ label, text }] (read-only views such as Customer 360).
async function cfFilledValues(object, values = {}) {
  const fields = (await cfLoad(object)) || [];
  return fields
    .map((field) => ({ label: field.label, text: cfDisplayValue(field, values?.[field.key]) }))
    .filter((row) => row.text);
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
    if (!CF_NO_VALUE.has(operator)) {
      value = field.type === "dropdown"
        ? [...form.querySelectorAll(".cf-f-value input:checked")].map((input) => input.value).join(",")
        : (form.querySelector(".cf-f-input")?.value || "").trim();
      if (!value || (field.type === "number" && !Number.isFinite(cfReadNumber(value)))) {
        showToast(t("cf.err.filterValue"), "error");
        return;
      }
    }
    filters = [...valid(), { key: field.key, operator, value }].slice(0, CF_MAX_PAGE_FILTERS);
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
