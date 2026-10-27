/**
 * workflow-builder.js — the visual workflow builder (Phase 7A, D86)
 * A workflow drawn as a flow: "When" (the trigger) → "Only if" (conditions) → numbered steps.
 * Steps are added between cards, moved by dragging or with Up/Down (keyboard), and removed.
 * Every change is checked by the server (POST /workflows/check) and each problem shows on its
 * card and field. "Try it on a lead" (POST /workflows/preview) shows what the workflow would do
 * to one real lead, sending and changing nothing. Recipes (GET /workflows/recipes) start a new
 * one. The engine, its runs, pause and stop are the Sales Automation ones (D30s).
 * The company's own fields (D99) are conditions ("cf.contact.<key>"), template blanks and
 * {{contact.cf.<key>}} placeholders; "Insert a detail" under a text puts one in at the cursor.
 */
const wfb = {
  meta: null, members: [], templates: [], sequences: [], workflows: [], recipes: [], smsTemplates: [],
  draft: null, problems: [], preview: null, dirty: false, checkTimer: null, checkSeq: 0, dragFrom: null,
  linkNames: {}, // id → name of records chosen in link-field conditions
};
const $w = (id) => document.getElementById(id);

const TRIGGER_FIELDS = {
  "lead.created": ["sources"], "message.received": ["keywords"], "lead.stage_changed": ["toStages", "fromStages"], "lead.no_reply": ["hours"],
  "quotation.not_accepted": ["days"], "order.stage_changed": ["orderStages"], "payment.received": [], "payment.overdue": ["days"], "task.overdue": [],
};
const STEP_DEFAULTS = {
  "whatsapp.text": { text: "" }, "whatsapp.template": { templateId: "", variables: {} }, assign: { memberId: "" }, "tag.add": { tag: "" }, "tag.remove": { tag: "" },
  "stage.change": { stage: "Contacted" }, "task.create": { title: "", dueInDays: 1, assignTo: "owner", priority: "Medium" }, "agent.notify": { to: "owner", message: "" },
  wait: { amount: 1, unit: "hours" }, "webhook.call": { url: "" }, "sequence.enroll": { sequenceId: "" }, "payment.link": {}, "sms.send": { template: "", variables: {} },
};
const STEP_ICONS = {
  "whatsapp.text": "fa-brands fa-whatsapp", "whatsapp.template": "fa-brands fa-whatsapp", assign: "fa-solid fa-user-check", "tag.add": "fa-solid fa-tag", "tag.remove": "fa-solid fa-tag",
  "stage.change": "fa-solid fa-arrow-right", "task.create": "fa-solid fa-list-check", "agent.notify": "fa-solid fa-bell", wait: "fa-solid fa-hourglass-half",
  "webhook.call": "fa-solid fa-satellite-dish", "sequence.enroll": "fa-solid fa-route", "payment.link": "fa-solid fa-indian-rupee-sign", "sms.send": "fa-solid fa-comment-sms",
};
const CONDITION_DEFAULTS = { source: ["IndiaMART"], stage: ["New"], tag: "", owner: "", businessHours: undefined };

const tr = (key, fallback, vars) => (crmI18n.has(key) ? t(key, vars) : fallback);
const blankDraft = () => ({ id: null, name: "", status: "Draft", trigger: { type: "lead.created", params: {} }, conditions: [], steps: [{ type: "task.create", params: { ...STEP_DEFAULTS["task.create"], title: "Call {{contact.name}}" } }] });
const payloadOf = (d) => ({ name: d.name, trigger: d.trigger, conditions: d.conditions, steps: d.steps });
const attr = (value) => escapeHtml(String(value ?? ""));

// ---------------------------------------------------------------- fields
function options(list, current, labelOf = (v) => v) {
  return list.map((v) => `<option value="${attr(v)}" ${String(v) === String(current ?? "") ? "selected" : ""}>${escapeHtml(labelOf(v))}</option>`).join("");
}
function chips(path, list, chosen, labelOf = (v) => v) {
  const set = new Set(chosen || []);
  return `<div class="wfb-chips" data-path="${attr(path)}" role="group">${list.map((v) => `<label class="chip-radio"><input type="checkbox" value="${attr(v)}" ${set.has(v) ? "checked" : ""} /> ${escapeHtml(labelOf(v))}</label>`).join("")}</div>`;
}
const fieldLabel = (key) => tr(`wfb.field.${key}`, key);
const field = (path, key, control) => `<div class="field wfb-field" data-field-path="${attr(path)}"><label>${escapeHtml(fieldLabel(key))}</label>${control}<div class="wfb-field-error" hidden></div></div>`;

// ---------------------------------------------------------------- the company's own fields (D99)
const objectName = (object) => tr(`wfb.cf.${object}`, object === "contact" ? "Customer" : "Lead");
const customFieldOf = (object, key) => (wfb.meta.customFields || []).find((f) => f.object === object && f.key === key);
// "contact.cf.zone" (a blank or placeholder) → "Customer: Zone"; a built-in one by its own words.
function detailLabel(spec) {
  const [object, cf, key] = spec.split(".");
  const custom = cf === "cf" ? customFieldOf(object, key) : null;
  if (custom) return `${objectName(object)}: ${custom.label}`;
  return tr(`wfb.ph.${spec}`, tr(`wfb.var.${spec}`, spec));
}
const conditionSpec = (field) => wfb.meta.conditions.find((f) => f.field === field) || null;
function conditionLabel(field) {
  const spec = conditionSpec(field);
  if (spec?.customField) return `${objectName(spec.customField.object)}: ${spec.customField.label}`;
  if (/^cf\./.test(field)) return tr("wfb.cf.unknown", "A field you cannot use here");
  return tr(`wfb.cond.${field}`, spec?.label || field);
}
function opLabel(spec, op) {
  if (!spec?.customField) return tr(`wfb.op.${op}`, op);
  if (op === "notIn") return tr("wfb.op.notIn", "is none of");
  if (op === "eq" && spec.customField.type === "date") return tr("cf.op.on", "is on");
  return tr(`cf.op.${op}`, op);
}
const NO_VALUE_OPS = new Set(["empty", "filled", "yes", "no"]);

function fieldConditionValue(custom, condition, base) {
  if (NO_VALUE_OPS.has(condition.op)) return "";
  const path = `${base}.value`;
  switch (custom.type) {
    case "number": return `<input type="number" step="any" data-path="${attr(path)}" data-kind="number" value="${attr(condition.value ?? "")}" aria-label="${attr(tr("wfb.cf.value", "Value"))}" />`;
    case "date": return `<input type="date" data-path="${attr(path)}" value="${attr(condition.value || "")}" aria-label="${attr(tr("wfb.cf.value", "Value"))}" />`;
    case "dropdown": return chips(path, (custom.options || []).map((o) => o.value), condition.value, (v) => custom.options.find((o) => o.value === v)?.label || v);
    case "lookup": {
      const id = condition.value || "";
      return cfLinkPickerHtml(`wfbLink_${base.replace(/\W/g, "_")}`, custom.lookupTarget, id, wfb.linkNames[id] || "", ` aria-label="${attr(tr("wfb.cf.value", "Value"))}"`)
        .replace('class="cf-link-value"', `class="cf-link-value" data-path="${attr(path)}"`);
    }
    default: return `<input type="text" maxlength="100" data-path="${attr(path)}" value="${attr(condition.value || "")}" aria-label="${attr(tr("wfb.cf.value", "Value"))}" />`;
  }
}

// The names of records chosen in link-field conditions, for the pickers (GET /lookup?id=).
async function loadLinkNames(conditions) {
  const wanted = (conditions || []).filter((c) => conditionSpec(c.field)?.customField?.type === "lookup" && c.value && !wfb.linkNames[c.value]);
  await Promise.all(wanted.map(async (c) => {
    try {
      const [record] = await crmApi(`/lookup?target=${encodeURIComponent(conditionSpec(c.field).customField.lookupTarget)}&id=${encodeURIComponent(c.value)}`);
      wfb.linkNames[c.value] = record?.name || tr("cf.hidden", "Hidden");
    } catch {
      wfb.linkNames[c.value] = tr("cf.hidden", "Hidden");
    }
  }));
}

// "Insert a detail…" under a text: the customer's, the lead's (their own fields too) and others.
function insertPicker(path) {
  const all = wfb.meta.placeholders || [];
  const group = (name, list) => (list.length ? `<optgroup label="${attr(name)}">${list.map((p) => `<option value="${attr(p)}">${escapeHtml(detailLabel(p))}</option>`).join("")}</optgroup>` : "");
  return `<select class="wfb-insert" data-insert-for="${attr(path)}" aria-label="${attr(tr("wfb.insert", "Insert a detail…"))}">
    <option value="">${escapeHtml(tr("wfb.insert", "Insert a detail…"))}</option>
    ${group(objectName("contact"), all.filter((p) => p.startsWith("contact.")))}
    ${group(objectName("lead"), all.filter((p) => p.startsWith("lead.")))}
    ${group(tr("wfb.insert.other", "Other"), all.filter((p) => !/^(contact|lead)\./.test(p)))}
  </select>`;
}

// Puts {{detail}} in at the cursor of the text it belongs to.
function insertDetail(select) {
  const target = $w("wfbFlow").querySelector(`[data-path="${CSS.escape(select.dataset.insertFor)}"]`);
  const detail = select.value;
  select.value = "";
  if (!target || !detail) return;
  const text = `{{${detail}}}`;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  target.value = target.value.slice(0, start) + text + target.value.slice(end);
  target.focus();
  target.setSelectionRange(start + text.length, start + text.length);
  target.dispatchEvent(new Event("input", { bubbles: true }));
}
const memberOptions = (current, extra = []) => `<option value="">${escapeHtml(tr("wfb.chooseOne", "Choose…"))}</option>${extra.map(([v, label]) => `<option value="${v}" ${v === current ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}${wfb.members.filter((m) => m.status === "active").map((m) => `<option value="${attr(m.id)}" ${String(m.id) === String(current) ? "selected" : ""}>${escapeHtml(m.name || m.email)}</option>`).join("")}`;
const stageLabel = (s) => tr(`stage.${s}`, s);

function triggerFields(trigger) {
  const p = trigger.params || {};
  const base = "trigger.params";
  return (TRIGGER_FIELDS[trigger.type] || []).map((key) => {
    if (key === "sources") return field(`${base}.sources`, "sources", chips(`${base}.sources`, wfb.meta.sources, p.sources));
    if (key === "keywords") return field(`${base}.keywords`, "keywords", `<input type="text" data-path="${base}.keywords" data-kind="list" value="${attr((p.keywords || []).join(", "))}" placeholder="price, rate, catalogue" />`);
    if (key === "toStages" || key === "fromStages") return field(`${base}.${key}`, key, chips(`${base}.${key}`, wfb.meta.leadStages, p[key], stageLabel));
    if (key === "orderStages") return field(`${base}.toStages`, "toStages", chips(`${base}.toStages`, wfb.meta.orderStages, p.toStages));
    return field(`${base}.${key}`, key, `<input type="number" min="1" data-path="${base}.${key}" data-kind="number" value="${attr(p[key] ?? (key === "hours" ? 24 : 3))}" />`);
  }).join("");
}

function variablesFields(base, params) {
  const template = wfb.templates.find((x) => String(x.id) === String(params.templateId));
  if (!template) return "";
  const needed = [
    ...(template.header?.variables || []).map((name) => ["header", name]),
    ...(template.body?.variables || []).map((name) => ["body", name]),
    ...(template.buttons || []).filter((b) => b.variables?.length).map((b) => ["buttons", String(b.index)]),
  ];
  return needed.map(([part, name]) => {
    const path = `${base}.variables.${part}.${name}`;
    const spec = params.variables?.[part]?.[name] || "";
    const fixed = spec.startsWith("text:");
    const select = `<select data-path="${attr(path)}" data-kind="variable">${`<option value="">${escapeHtml(tr("wfb.chooseOne", "Choose…"))}</option>`}${wfb.meta.variableValues.map((v) => `<option value="${v}" ${spec === v ? "selected" : ""}>${escapeHtml(detailLabel(v))}</option>`).join("")}<option value="text:" ${fixed ? "selected" : ""}>${escapeHtml(tr("wfb.fixedText", "Fixed words…"))}</option></select>`;
    const words = fixed ? `<input type="text" data-path="${attr(path)}" data-kind="fixed" value="${attr(spec.slice(5))}" />` : "";
    return `<div class="field wfb-field" data-field-path="${attr(path)}"><label>${escapeHtml(`{{${name}}}`)}</label>${select}${words}<div class="wfb-field-error" hidden></div></div>`;
  }).join("");
}

// One blank of a template: a CRM value, or fixed words (WhatsApp and SMS templates).
function blankField(path, label, spec) {
  const fixed = spec.startsWith("text:");
  const select = `<select data-path="${attr(path)}" data-kind="variable"><option value="">${escapeHtml(tr("wfb.chooseOne", "Choose…"))}</option>${wfb.meta.variableValues.map((v) => `<option value="${v}" ${spec === v ? "selected" : ""}>${escapeHtml(detailLabel(v))}</option>`).join("")}<option value="text:" ${fixed ? "selected" : ""}>${escapeHtml(tr("wfb.fixedText", "Fixed words…"))}</option></select>`;
  const words = fixed ? `<input type="text" data-path="${attr(path)}" data-kind="fixed" value="${attr(spec.slice(5))}" />` : "";
  return `<div class="field wfb-field" data-field-path="${attr(path)}"><label>${escapeHtml(label)}</label>${select}${words}<div class="wfb-field-error" hidden></div></div>`;
}

function stepFields(step, index) {
  const p = step.params || {};
  const base = `steps.${index}.params`;
  const text = (key, value, tag = "input") => (tag === "textarea"
    ? `<textarea rows="3" data-path="${base}.${key}">${escapeHtml(value || "")}</textarea>`
    : `<input type="text" data-path="${base}.${key}" value="${attr(value)}" />`);
  const hint = `<p class="wfb-hint">${escapeHtml(tr("wfb.placeholderHint", "Use {{contact.name}}, {{lead.title}}, {{owner.name}} … for the customer's own details."))}</p>`;
  switch (step.type) {
    case "whatsapp.text": return field(`${base}.text`, "text", text("text", p.text, "textarea") + insertPicker(`${base}.text`)) + hint;
    case "whatsapp.template": {
      const sendable = wfb.templates.filter((x) => x.sendable);
      const control = sendable.length
        ? `<select data-path="${base}.templateId"><option value="">${escapeHtml(tr("wfb.chooseOne", "Choose…"))}</option>${sendable.map((x) => `<option value="${attr(x.id)}" ${String(x.id) === String(p.templateId) ? "selected" : ""}>${escapeHtml(`${x.name} (${x.language || ""})`)}</option>`).join("")}</select>`
        : `<p class="wfb-hint">${escapeHtml(tr("wfb.noTemplates", "No WhatsApp templates you can use (they come from Settings → WhatsApp, with the Inbox)."))}</p>`;
      return field(`${base}.templateId`, "templateId", control) + variablesFields(base, p);
    }
    case "assign": return field(`${base}.memberId`, "memberId", `<select data-path="${base}.memberId">${memberOptions(p.memberId)}</select>`);
    case "tag.add":
    case "tag.remove": return field(`${base}.tag`, "tag", text("tag", p.tag));
    case "stage.change": return field(`${base}.stage`, "stage", `<select data-path="${base}.stage">${options(wfb.meta.leadStages, p.stage, stageLabel)}</select>`)
      + (p.stage === "Lost" ? field(`${base}.lostReason`, "lostReason", text("lostReason", p.lostReason)) : "");
    case "task.create": return field(`${base}.title`, "title", text("title", p.title) + insertPicker(`${base}.title`))
      + `<div class="wfb-row">${field(`${base}.dueInDays`, "dueInDays", `<input type="number" min="0" max="365" data-path="${base}.dueInDays" data-kind="number" value="${attr(p.dueInDays ?? 1)}" />`)}`
      + `${field(`${base}.priority`, "priority", `<select data-path="${base}.priority">${options(["Low", "Medium", "High"], p.priority || "Medium", (v) => tr(`priority.${v}`, v))}</select>`)}</div>`
      + field(`${base}.assignTo`, "assignTo", `<select data-path="${base}.assignTo">${memberOptions(p.assignTo || "owner", [["owner", tr("wfb.owner", "The lead's owner")]])}</select>`) + hint;
    case "agent.notify": return field(`${base}.to`, "to", `<select data-path="${base}.to">${memberOptions(p.to || "owner", [["owner", tr("wfb.owner", "The lead's owner")], ["managers", tr("wfb.managers", "Owners and admins")]])}</select>`)
      + field(`${base}.message`, "message", text("message", p.message, "textarea") + insertPicker(`${base}.message`)) + hint;
    case "wait": return `<div class="wfb-row">${field(`${base}.amount`, "amount", `<input type="number" min="1" max="999" data-path="${base}.amount" data-kind="number" value="${attr(p.amount ?? 1)}" />`)}`
      + `${field(`${base}.unit`, "unit", `<select data-path="${base}.unit">${options(["minutes", "hours", "days"], p.unit || "hours", (u) => tr(`wfb.unit.${u}`, u))}</select>`)}</div>`;
    case "webhook.call": return field(`${base}.url`, "url", `<input type="url" data-path="${base}.url" value="${attr(p.url)}" placeholder="https://" />`);
    case "sequence.enroll": return field(`${base}.sequenceId`, "sequenceId", `<select data-path="${base}.sequenceId"><option value="">${escapeHtml(tr("wfb.chooseOne", "Choose…"))}</option>${wfb.sequences.map((s) => `<option value="${attr(s.id)}" ${String(s.id) === String(p.sequenceId) ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}</select>`);
    case "sms.send": {
      const templates = wfb.smsTemplates;
      if (!templates.length) return `<p class="wfb-hint">${escapeHtml(tr("wfb.noSms", "No SMS templates yet: an owner or admin adds them in Settings → SMS."))}</p>`;
      const chosen = templates.find((x) => x.key === p.template);
      return field(`${base}.template`, "smsTemplate", `<select data-path="${base}.template"><option value="">${escapeHtml(tr("wfb.chooseOne", "Choose…"))}</option>${templates.map((x) => `<option value="${attr(x.key)}" ${x.key === p.template ? "selected" : ""}>${escapeHtml(x.name)}</option>`).join("")}</select>`)
        + (chosen ? `<p class="wfb-hint">${escapeHtml(chosen.text)}</p>` + chosen.variables.map((name) => blankField(`${base}.variables.${name}`, `##${name}##`, p.variables?.[name] || "")).join("") : "");
    }
    case "payment.link": return `<p class="wfb-hint">${escapeHtml(tr("wfb.paymentHint", "Sends the order's payment link on WhatsApp. Use it with order or payment triggers."))}</p>`;
    default: return "";
  }
}

function conditionRow(condition, index) {
  const base = `conditions.${index}`;
  const fields = wfb.meta.conditions;
  // A field this member may not use, or one archived since (D99), stays as it is: its own entry.
  const kept = !fields.some((f) => f.field === condition.field) && /^cf\./.test(condition.field);
  const spec = kept ? { field: condition.field, ops: [condition.op] } : fields.find((f) => f.field === condition.field) || fields[0];
  const choices = [...(kept ? [condition.field] : []), ...fields.map((f) => f.field)];
  let value = "";
  if (condition.field === "source") value = chips(`${base}.value`, wfb.meta.sources, condition.value);
  else if (condition.field === "stage") value = chips(`${base}.value`, wfb.meta.leadStages, condition.value, stageLabel);
  else if (condition.field === "tag") value = `<input type="text" data-path="${base}.value" value="${attr(condition.value)}" />`;
  else if (condition.field === "owner" && ["is", "isNot"].includes(condition.op)) value = `<select data-path="${base}.value">${memberOptions(condition.value)}</select>`;
  else if (spec.customField) value = fieldConditionValue(spec.customField, condition, base);
  return `<div class="wfb-condition" data-card="condition" data-index="${index}">
    <div class="wfb-row">
      <select data-path="${base}.field" aria-label="${attr(tr("wfb.field.conditionField", "What to check"))}">${options(choices, condition.field, conditionLabel)}</select>
      <select data-path="${base}.op" aria-label="${attr(tr("wfb.field.op", "How"))}">${options(spec.ops, condition.op, (o) => opLabel(spec, o))}</select>
      <button type="button" class="btn btn-outline wfb-icon-btn" data-act="remove-condition" data-index="${index}" aria-label="${attr(tr("wfb.remove", "Remove"))}"><i class="fa-solid fa-xmark"></i></button>
    </div>
    ${value ? `<div class="wfb-field" data-field-path="${base}.value">${value}</div>` : ""}
    <div class="wfb-card-problems" hidden></div>
  </div>`;
}

// ---------------------------------------------------------------- the flow
function addButton(at) {
  return `<div class="wfb-gap"><button type="button" class="wfb-add" data-act="add-step" data-at="${at}" aria-label="${attr(tr("wfb.addStep", "Add a step here"))}" title="${attr(tr("wfb.addStep", "Add a step here"))}"><i class="fa-solid fa-plus"></i></button></div>`;
}

function renderFlow() {
  const d = wfb.draft;
  const triggerLabel = (type) => tr(`wfb.trigger.${type}`, wfb.meta.triggers.find((x) => x.type === type)?.label || type);
  const stepsHtml = d.steps.map((step, index) => `
    <article class="wfb-card wfb-step" data-card="step" data-index="${index}" draggable="true" aria-label="${attr(tr("wfb.stepN", `Step ${index + 1}`, { n: index + 1 }))}">
      <header class="wfb-card-head">
        <span class="wfb-grip" title="${attr(tr("wfb.drag", "Drag to move"))}" aria-hidden="true"><i class="fa-solid fa-grip-vertical"></i></span>
        <span class="wfb-num">${index + 1}</span>
        <i class="${STEP_ICONS[step.type] || "fa-solid fa-circle"} wfb-icon" aria-hidden="true"></i>
        <select data-path="steps.${index}.type" aria-label="${attr(tr("wfb.field.stepType", "What to do"))}">${options(wfb.meta.actions.map((a) => a.type), step.type, (a) => tr(`wfb.action.${a}`, wfb.meta.actions.find((x) => x.type === a)?.label || a))}</select>
        <span class="wfb-card-tools">
          <button type="button" class="btn btn-outline wfb-icon-btn" data-act="up" data-index="${index}" ${index === 0 ? "disabled" : ""} aria-label="${attr(tr("wfb.up", "Move up"))}"><i class="fa-solid fa-arrow-up"></i></button>
          <button type="button" class="btn btn-outline wfb-icon-btn" data-act="down" data-index="${index}" ${index === d.steps.length - 1 ? "disabled" : ""} aria-label="${attr(tr("wfb.down", "Move down"))}"><i class="fa-solid fa-arrow-down"></i></button>
          <button type="button" class="btn btn-outline wfb-icon-btn" data-act="remove-step" data-index="${index}" aria-label="${attr(tr("wfb.remove", "Remove"))}"><i class="fa-solid fa-trash"></i></button>
        </span>
      </header>
      <div class="wfb-card-body">${stepFields(step, index)}</div>
      <div class="wfb-preview-line" hidden></div>
      <div class="wfb-card-problems" hidden></div>
    </article>${addButton(index + 1)}`).join("");

  $w("wfbFlow").innerHTML = `
    <article class="wfb-card wfb-trigger" data-card="trigger">
      <header class="wfb-card-head"><span class="wfb-label">${escapeHtml(tr("wfb.when", "When"))}</span>
        <select data-path="trigger.type" aria-label="${attr(tr("wfb.when", "When"))}">${options(wfb.meta.triggers.map((x) => x.type), d.trigger.type, triggerLabel)}</select></header>
      <div class="wfb-card-body">${triggerFields(d.trigger)}</div>
      <div class="wfb-preview-line" hidden></div>
      <div class="wfb-card-problems" hidden></div>
    </article>
    <div class="wfb-gap"><span class="wfb-line"></span></div>
    <article class="wfb-card wfb-conditions" data-card="conditions">
      <header class="wfb-card-head"><span class="wfb-label">${escapeHtml(tr("wfb.onlyIf", "Only if"))}</span></header>
      <div class="wfb-card-body">
        ${d.conditions.length ? d.conditions.map(conditionRow).join("") : `<p class="wfb-hint">${escapeHtml(tr("wfb.noConditions", "Every time (no conditions)."))}</p>`}
        ${d.conditions.length < 10 ? `<button type="button" class="btn btn-outline" data-act="add-condition"><i class="fa-solid fa-plus"></i> ${escapeHtml(tr("wfb.addCondition", "Add a condition"))}</button>` : ""}
      </div>
      <div class="wfb-preview-line" hidden></div>
    </article>
    ${addButton(0)}
    ${stepsHtml}`;
  showProblems();
  showPreview();
}

function renderHeader() {
  const d = wfb.draft;
  $w("wfbName").value = d.name;
  $w("wfbOn").checked = d.status === "Active";
  $w("wfbDelete").hidden = !d.id;
  $w("wfbPick").innerHTML = `<option value="">${escapeHtml(tr("wfb.pick.new", "New workflow"))}</option>${wfb.workflows.map((w) => `<option value="${attr(w.id)}" ${String(w.id) === String(d.id) ? "selected" : ""}>${escapeHtml(w.name)}${w.status === "Active" ? "" : ` (${escapeHtml(tr(`wfb.status.${w.status}`, w.status))})`}</option>`).join("")}`;
  $w("wfbRunsPanel").hidden = !d.id;
}

// ---------------------------------------------------------------- problems
function problemText(p) {
  if (p.code === "REQUIRED" && p.field) return tr("wfb.problem.required", p.message, { field: fieldLabel(p.field) });
  return crmI18n.has(`wfb.problem.${p.code}`) ? t(`wfb.problem.${p.code}`) : p.message;
}

function showProblems() {
  const flow = $w("wfbFlow");
  flow.querySelectorAll(".wfb-card-problems").forEach((box) => { box.hidden = true; box.innerHTML = ""; });
  flow.querySelectorAll(".wfb-field-error").forEach((box) => { box.hidden = true; box.textContent = ""; });
  flow.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
  flow.querySelectorAll(".wfb-card.has-error, .wfb-card.has-warning").forEach((el) => el.classList.remove("has-error", "has-warning"));
  $w("wfbName").classList.toggle("invalid", wfb.problems.some((p) => p.path === "name"));
  for (const p of wfb.problems) {
    const card = p.card === "trigger" ? flow.querySelector('[data-card="trigger"]')
      : p.card === "step" ? flow.querySelector(`[data-card="step"][data-index="${p.index}"]`)
        : p.card === "condition" ? flow.querySelector(`[data-card="condition"][data-index="${p.index}"]`)
          : p.path === "steps" ? flow.querySelector('[data-card="conditions"]') : null;
    if (!card) continue;
    const container = card.closest(".wfb-card") || card;
    container.classList.add(p.level === "warning" ? "has-warning" : "has-error");
    // The field's own place when it has one; else under the card.
    const fieldBox = [...card.querySelectorAll("[data-field-path]")].find((el) => p.path === el.dataset.fieldPath || p.path.startsWith(`${el.dataset.fieldPath}.`));
    if (fieldBox && p.level === "error") {
      const error = fieldBox.querySelector(".wfb-field-error");
      fieldBox.querySelector("input, select, textarea, .wfb-chips")?.classList.add("invalid");
      if (error) {
        error.hidden = false;
        error.textContent = problemText(p);
        continue;
      }
    }
    const box = card.querySelector(":scope > .wfb-card-problems") || container.querySelector(".wfb-card-problems");
    if (!box) continue;
    box.hidden = false;
    box.insertAdjacentHTML("beforeend", `<p class="wfb-problem wfb-${p.level}"><i class="fa-solid ${p.level === "warning" ? "fa-circle-info" : "fa-triangle-exclamation"}" aria-hidden="true"></i> ${escapeHtml(problemText(p))}</p>`);
  }
  const errors = wfb.problems.filter((p) => p.level === "error").length;
  const warnings = wfb.problems.length - errors;
  const badge = $w("wfbStatus");
  badge.className = `badge ${errors ? "badge-danger" : warnings ? "badge-warning" : "badge-success"}`;
  badge.textContent = errors ? tr("wfb.problems", `${errors} problems`, { n: errors }) : warnings ? tr("wfb.warnings", `${warnings} notes`, { n: warnings }) : tr("wfb.ready", "Ready");
  badge.dataset.jump = errors || warnings ? "1" : "";
}

function scheduleCheck() {
  wfb.dirty = true;
  wfb.preview = null;
  clearTimeout(wfb.checkTimer);
  wfb.checkTimer = setTimeout(runCheck, 450);
}
// A new workflow's empty name is not called a problem until it is saved or typed in.
async function runCheck({ withName = false } = {}) {
  const seq = ++wfb.checkSeq;
  const body = payloadOf(wfb.draft);
  if (!withName && !wfb.draft.id && !wfb.draft.name && !wfb.nameTouched) delete body.name;
  try {
    const result = await crmApi("/workflows/check", jsonRequest("POST", body));
    if (seq !== wfb.checkSeq) return result;
    wfb.problems = result.problems;
    showProblems();
    return result;
  } catch {
    return null; /* the next change checks again */
  }
}

// ---------------------------------------------------------------- editing
function setAt(path, value) {
  const keys = path.split(".");
  let target = wfb.draft;
  keys.slice(0, -1).forEach((key, i) => {
    if (target[key] == null || typeof target[key] !== "object") target[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    target = target[key];
  });
  target[keys.at(-1)] = value;
}

function readControl(el) {
  if (el.dataset.kind === "number") return el.value === "" ? "" : Number(el.value);
  if (el.dataset.kind === "list") return el.value.split(",").map((s) => s.trim()).filter(Boolean);
  return el.value;
}

function onFlowChange(event) {
  const el = event.target;
  if (el.matches(".wfb-insert")) return insertDetail(el);
  // A record picked in a link-field condition (D99): its name is kept for the next drawing.
  if (el.matches(".cf-link-value")) {
    if (el.value) wfb.linkNames[el.value] = el.closest(".cf-link").querySelector(".cf-link-search").value;
    setAt(el.dataset.path, el.value);
    return scheduleCheck();
  }
  const chipGroup = el.closest(".wfb-chips");
  if (chipGroup) {
    setAt(chipGroup.dataset.path, [...chipGroup.querySelectorAll("input:checked")].map((i) => i.value));
    return scheduleCheck();
  }
  const path = el.dataset.path;
  if (!path) return undefined;
  if (el.dataset.kind === "variable" || el.dataset.kind === "fixed") {
    const value = el.dataset.kind === "fixed" ? `text:${el.value}` : el.value;
    setAt(path, value);
    if (el.dataset.kind === "variable") renderFlow();
    return scheduleCheck();
  }
  setAt(path, readControl(el));
  // A new type gets that type's settings; a new condition field its own ops and value.
  if (/^steps\.\d+\.type$/.test(path)) {
    const index = Number(path.split(".")[1]);
    wfb.draft.steps[index].params = JSON.parse(JSON.stringify(STEP_DEFAULTS[el.value] || {}));
    renderFlow();
  } else if (path === "trigger.type") {
    wfb.draft.trigger.params = {};
    renderFlow();
  } else if (/^conditions\.\d+\.field$/.test(path)) {
    const index = Number(path.split(".")[1]);
    const spec = wfb.meta.conditions.find((f) => f.field === el.value);
    if (spec) wfb.draft.conditions[index] = { field: el.value, op: spec.ops[0], ...(CONDITION_DEFAULTS[el.value] !== undefined && { value: CONDITION_DEFAULTS[el.value] }) };
    renderFlow();
  } else if (/^conditions\.\d+\.op$/.test(path) || /^steps\.\d+\.params\.(stage|templateId|template)$/.test(path)) {
    renderFlow();
  }
  return scheduleCheck();
}

function moveStep(from, to) {
  const steps = wfb.draft.steps;
  if (to < 0 || to >= steps.length || from === to) return;
  const [step] = steps.splice(from, 1);
  steps.splice(to, 0, step);
  renderFlow();
  scheduleCheck();
  $w("wfbFlow").querySelector(`[data-card="step"][data-index="${to}"] [data-act="${to > from ? "down" : "up"}"]:not([disabled])`)?.focus()
    || $w("wfbFlow").querySelector(`[data-card="step"][data-index="${to}"] select`)?.focus();
}

async function onFlowClick(event) {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const index = Number(button.dataset.index);
  const d = wfb.draft;
  switch (button.dataset.act) {
    case "add-step": {
      const type = await crmMoveMenu.open({ title: tr("wfb.addStep", "Add a step here"), current: "", options: wfb.meta.actions.map((a) => ({ value: a.type, label: tr(`wfb.action.${a.type}`, a.label) })), returnFocus: button });
      if (!type) return;
      if (d.steps.length >= 20) return showToast(tr("wfb.problem.TOO_MANY", "At most 20 steps."), "error");
      const at = Number(button.dataset.at);
      d.steps.splice(at, 0, { type, params: JSON.parse(JSON.stringify(STEP_DEFAULTS[type])) });
      renderFlow();
      scheduleCheck();
      $w("wfbFlow").querySelector(`[data-card="step"][data-index="${at}"] .wfb-card-body :is(input, select, textarea)`)?.focus();
      return;
    }
    case "remove-step":
      d.steps.splice(index, 1);
      break;
    case "up":
      return moveStep(index, index - 1);
    case "down":
      return moveStep(index, index + 1);
    case "add-condition":
      d.conditions.push({ field: "source", op: "in", value: ["IndiaMART"] });
      break;
    case "remove-condition":
      d.conditions.splice(index, 1);
      break;
    default:
      return;
  }
  renderFlow();
  scheduleCheck();
}

// Drag and drop (mouse); Up/Down do the same from the keyboard.
function setupDrag() {
  const flow = $w("wfbFlow");
  flow.addEventListener("dragstart", (event) => {
    const card = event.target.closest?.('[data-card="step"]');
    if (!card || event.target.closest("input, select, textarea")) return;
    wfb.dragFrom = Number(card.dataset.index);
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(wfb.dragFrom));
  });
  flow.addEventListener("dragover", (event) => {
    if (wfb.dragFrom == null) return;
    const card = event.target.closest('[data-card="step"]');
    if (!card) return;
    event.preventDefault();
    flow.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
    const rect = card.getBoundingClientRect();
    card.classList.add(event.clientY < rect.top + rect.height / 2 ? "drop-before" : "drop-after");
  });
  flow.addEventListener("drop", (event) => {
    const card = event.target.closest('[data-card="step"]');
    if (wfb.dragFrom == null || !card) return;
    event.preventDefault();
    let to = Number(card.dataset.index) + (card.classList.contains("drop-after") ? 1 : 0);
    if (to > wfb.dragFrom) to -= 1;
    const from = wfb.dragFrom;
    wfb.dragFrom = null;
    moveStep(from, to);
  });
  flow.addEventListener("dragend", () => {
    wfb.dragFrom = null;
    flow.querySelectorAll(".dragging, .drop-before, .drop-after").forEach((el) => el.classList.remove("dragging", "drop-before", "drop-after"));
  });
}

// ---------------------------------------------------------------- preview
function stepSentence(s) {
  const f = s.facts || {};
  if (s.status === "skip" && s.reason === "ALREADY" && crmI18n.has(`wfb.skip.ALREADY.${s.type}`)) return t(`wfb.skip.ALREADY.${s.type}`, { member: f.member, tag: f.tag, to: stageLabel(f.to) });
  if (s.status === "skip") return tr(`wfb.skip.${s.reason}`, s.reason, { missing: (f.missing || []).map((m) => `{{${m}}}`).join(", ") });
  const when = (iso) => new Date(iso).toLocaleString(crmI18n.locale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  switch (s.type) {
    case "whatsapp.text": return tr("wfb.pv.whatsapp.text", "", { text: f.text });
    case "whatsapp.template": {
      const vars = Object.values(f.variables || {}).flatMap((part) => Object.entries(part).map(([k, v]) => `{{${k}}} = ${v}`)).join(", ");
      return tr("wfb.pv.whatsapp.template", "", { template: f.template, vars: vars ? `(${vars})` : "" });
    }
    case "assign": return tr("wfb.pv.assign", "", { member: f.member });
    case "tag.add": return tr("wfb.pv.tag.add", "", { tag: f.tag });
    case "tag.remove": return tr("wfb.pv.tag.remove", "", { tag: f.tag });
    case "stage.change": return tr("wfb.pv.stage.change", "", { deal: f.deal, from: stageLabel(f.from), to: stageLabel(f.to) });
    case "task.create": return tr("wfb.pv.task.create", "", { title: f.title, assignee: f.assignee === "owner" ? tr("wfb.owner", "The lead's owner") : f.assignee, due: new Date(`${f.due}T00:00:00`).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short" }) });
    case "agent.notify": {
      const to = f.to === "owner" ? (f.ownerName || tr("wfb.owner", "The lead's owner")) : f.to === "managers" ? tr("wfb.managers", "Owners and admins") : f.to;
      return tr("wfb.pv.agent.notify", "", { to, message: f.message });
    }
    case "wait": return tr("wfb.pv.wait", "", { until: when(f.until) });
    case "webhook.call": return tr("wfb.pv.webhook.call", "", { host: f.host });
    case "sequence.enroll": return tr("wfb.pv.sequence.enroll", "", { sequence: f.sequence });
    case "sms.send": return tr("wfb.pv.sms.send", "", { template: f.template, text: f.text });
    default: return "";
  }
}

function showPreview() {
  const flow = $w("wfbFlow");
  flow.querySelectorAll(".wfb-preview-line").forEach((el) => { el.hidden = true; el.innerHTML = ""; el.className = "wfb-preview-line"; });
  flow.querySelectorAll(".wfb-condition .wfb-pv").forEach((el) => el.remove());
  const p = wfb.preview;
  $w("wfbPreviewResult").innerHTML = "";
  if (!p) return;
  const line = (el, cls, html) => {
    if (!el) return;
    el.hidden = false;
    el.classList.add(cls);
    el.innerHTML = html;
  };
  if (p.trigger.matchesLead !== null) {
    line(flow.querySelector('[data-card="trigger"] .wfb-preview-line'), p.trigger.matchesLead ? "pv-do" : "pv-skip", escapeHtml(tr(p.trigger.matchesLead ? "wfb.triggerMatch" : "wfb.triggerNoMatch", "")));
  }
  p.conditions.forEach((c) => {
    const row = flow.querySelector(`[data-card="condition"][data-index="${c.index}"]`);
    row?.insertAdjacentHTML("beforeend", `<p class="wfb-pv ${c.passed ? "pv-do" : "pv-skip"}"><i class="fa-solid ${c.passed ? "fa-check" : "fa-xmark"}" aria-hidden="true"></i> ${escapeHtml(tr(c.passed ? "wfb.cond.pass" : "wfb.cond.fail", ""))} · ${escapeHtml(tr("wfb.cond.actual", "", { value: c.actual === "" ? "—" : c.field === "stage" ? stageLabel(c.actual) : c.actual }))}</p>`);
  });
  p.steps.forEach((s) => {
    const cls = !p.wouldRun ? "pv-off" : s.status === "skip" ? "pv-skip" : s.status === "wait" ? "pv-wait" : "pv-do";
    const icon = s.status === "skip" ? "fa-forward" : s.status === "wait" ? "fa-hourglass-half" : "fa-check";
    line(flow.querySelector(`[data-card="step"][data-index="${s.index}"] .wfb-preview-line`), cls, `<i class="fa-solid ${icon}" aria-hidden="true"></i> ${escapeHtml(stepSentence(s))}`);
  });
  $w("wfbPreviewResult").innerHTML = `<p class="wfb-pv-summary ${p.wouldRun ? "pv-do" : "pv-skip"}">${escapeHtml(tr(p.wouldRun ? "wfb.wouldRun" : "wfb.wouldNotRun", "", { name: p.lead.contactName || p.lead.title }))}</p>
    <p class="wfb-hint">${escapeHtml(tr("wfb.previewSafe", "Nothing was sent or changed."))}</p>`;
}

async function searchLeads(query) {
  const box = $w("wfbLeadResults");
  if (query.trim().length < 2) { box.innerHTML = ""; return; }
  try {
    const leads = await crmApi(`/leads?q=${encodeURIComponent(query.trim())}&limit=6`);
    box.innerHTML = leads.length ? leads.map((l) => `<button type="button" class="wfb-lead" data-lead="${attr(l.id)}">${escapeHtml(l.title)}<span>${escapeHtml(l.contact?.name || l.contactName || "")} · ${escapeHtml(stageLabel(l.stage))}</span></button>`).join("")
      : `<p class="wfb-hint">${escapeHtml(tr("wfb.noLeads", "No lead with that name."))}</p>`;
  } catch (error) {
    box.innerHTML = `<p class="wfb-hint">${escapeHtml(apiErrorMessage(error, tr("wfb.loadFailed", "Could not load.")))}</p>`;
  }
}

async function runPreview(leadId) {
  try {
    wfb.preview = await crmApi("/workflows/preview", jsonRequest("POST", { draft: payloadOf(wfb.draft), leadId }));
    showPreview();
  } catch (error) {
    wfb.preview = null;
    showPreview();
    await runCheck();
    showToast(apiErrorMessage(error, tr("wfb.previewFailed", "Fix the problems first.")), "error");
  }
}

// ---------------------------------------------------------------- runs
async function loadRuns() {
  const box = $w("wfbRuns");
  if (!wfb.draft.id) { box.innerHTML = ""; return; }
  try {
    const runs = await crmApi(`/workflows/${encodeURIComponent(wfb.draft.id)}/runs?limit=10`);
    box.innerHTML = runs.length ? runs.map((r) => `<div class="wfb-run">
        <span class="badge ${{ done: "badge-success", failed: "badge-danger", waiting: "badge-warning", running: "badge-info" }[r.status] || "badge-neutral"}">${escapeHtml(tr(`wfb.run.${r.status}`, r.status))}</span>
        <span class="wfb-run-label">${escapeHtml(r.subject.label || "")}<small>${escapeHtml(new Date(r.createdAt).toLocaleString(crmI18n.locale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</small></span>
        ${["running", "waiting"].includes(r.status) ? `<button type="button" class="btn btn-outline" data-stop="${attr(r.id)}">${escapeHtml(tr("wfb.stop", "Stop"))}</button>` : ""}
      </div>`).join("") : `<p class="wfb-hint">${escapeHtml(tr("wfb.noRuns", "No runs yet."))}</p>`;
  } catch {
    box.innerHTML = "";
  }
}

// ---------------------------------------------------------------- open, save, delete
function confirmLeave() {
  return !wfb.dirty || confirm(tr("wfb.unsaved", "You have changes that are not saved. Leave them?"));
}

async function openWorkflow(id) {
  if (!id) {
    wfb.draft = blankDraft();
  } else {
    const w = await crmApi(`/workflows/${encodeURIComponent(id)}`);
    wfb.draft = { id: w.id, name: w.name, status: w.status, trigger: w.trigger, conditions: w.conditions, steps: w.steps };
    await loadLinkNames(w.conditions);
  }
  wfb.preview = null;
  wfb.problems = [];
  wfb.dirty = false;
  wfb.nameTouched = false;
  history.replaceState(null, "", id ? `?id=${encodeURIComponent(id)}` : location.pathname);
  renderHeader();
  renderFlow();
  runCheck();
  loadRuns();
}

async function save() {
  const d = wfb.draft;
  d.name = $w("wfbName").value.trim();
  const on = $w("wfbOn").checked;
  const status = on ? "Active" : d.status === "Active" ? "Paused" : d.status || "Draft";
  const result = await runCheck({ withName: true });
  if (result && !result.ok) {
    showToast(tr("wfb.fixFirst", "Fix the problems marked in red first."), "error");
    $w("wfbFlow").querySelector(".has-error")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const button = $w("wfbSave");
  button.disabled = true;
  try {
    const body = { ...payloadOf(d), status };
    const saved = d.id
      ? await crmApi(`/workflows/${encodeURIComponent(d.id)}`, jsonRequest("PATCH", body))
      : await crmApi("/workflows", jsonRequest("POST", body));
    wfb.dirty = false;
    showToast(tr("wfb.saved", "Workflow saved."), "success");
    wfb.workflows = await crmApi("/workflows?limit=100");
    await openWorkflow(saved.id);
  } catch (error) {
    showToast(apiErrorMessage(error, tr("wfb.saveFailed", "Could not save the workflow.")), "error");
  } finally {
    button.disabled = false;
  }
}

async function removeWorkflow() {
  if (!wfb.draft.id || !confirm(tr("wfb.deleteConfirm", "Delete this workflow? Its waiting runs stop."))) return;
  try {
    await crmApi(`/workflows/${encodeURIComponent(wfb.draft.id)}`, { method: "DELETE" });
    showToast(tr("wfb.deleted", "Workflow deleted."), "success");
    wfb.workflows = await crmApi("/workflows?limit=100");
    wfb.dirty = false;
    await openWorkflow(null);
  } catch (error) {
    showToast(apiErrorMessage(error, tr("wfb.saveFailed", "Could not save the workflow.")), "error");
  }
}

function openRecipes() {
  const dialog = $w("wfbRecipeDialog");
  $w("wfbRecipeList").innerHTML = wfb.recipes.map((r) => `<div class="wfb-recipe">
      <strong>${escapeHtml(tr(`wfb.recipe.${r.id}.name`, r.name))}</strong>
      <p>${escapeHtml(tr(`wfb.recipe.${r.id}.desc`, r.description))}</p>
      <button type="button" class="btn btn-primary" data-recipe="${attr(r.id)}">${escapeHtml(tr("wfb.recipeUse", "Use this"))}</button>
    </div>`).join("");
  dialog.showModal();
}

function useRecipe(id) {
  const r = wfb.recipes.find((x) => x.id === id);
  if (!r || !confirmLeave()) return;
  wfb.draft = { id: null, name: tr(`wfb.recipe.${r.id}.name`, r.name), status: "Draft", trigger: r.trigger, conditions: r.conditions, steps: r.steps };
  wfb.preview = null;
  wfb.dirty = true;
  history.replaceState(null, "", location.pathname);
  $w("wfbRecipeDialog").close();
  renderHeader();
  renderFlow();
  runCheck();
  $w("wfbFlow").querySelector(".wfb-card")?.scrollIntoView({ block: "start" });
}

// ---------------------------------------------------------------- start
async function startBuilder() {
  await crmI18n.ready;
  try {
    const [meta, workflows, recipes, members, templates, sequences, smsConnection] = await Promise.allSettled([
      crmApi("/workflows/meta"), crmApi("/workflows?limit=100"), crmApi("/workflows/recipes"), crmApi("/members?limit=100"), crmApi("/templates"), crmApi("/sequences?limit=100"),
      crmApi("/sms/connection"),
    ]);
    if (meta.status !== "fulfilled") throw meta.reason;
    wfb.meta = meta.value;
    wfb.workflows = workflows.status === "fulfilled" ? workflows.value : [];
    wfb.recipes = recipes.status === "fulfilled" ? recipes.value : [];
    wfb.members = members.status === "fulfilled" ? members.value : [];
    wfb.templates = templates.status === "fulfilled" ? templates.value : [];
    wfb.sequences = sequences.status === "fulfilled" ? sequences.value : [];
    wfb.smsTemplates = smsConnection.status === "fulfilled" ? smsConnection.value.templates || [] : [];
    const id = new URLSearchParams(location.search).get("id");
    await openWorkflow(id && wfb.workflows.some((w) => String(w.id) === id) ? id : null);
  } catch (error) {
    $w("wfbFlow").innerHTML = `<p class="wfb-hint">${escapeHtml(apiErrorMessage(error, tr("wfb.loadFailed", "Could not load.")))}</p>`;
    return;
  }

  const flow = $w("wfbFlow");
  cfWireLinks(flow); // link-field conditions (D99)
  flow.addEventListener("change", onFlowChange);
  flow.addEventListener("input", (event) => { if (event.target.matches("input[type=text], input[type=url], textarea")) onFlowChange(event); });
  flow.addEventListener("click", onFlowClick);
  setupDrag();
  $w("wfbName").addEventListener("input", () => { wfb.draft.name = $w("wfbName").value; wfb.nameTouched = true; scheduleCheck(); });
  $w("wfbOn").addEventListener("change", () => { wfb.dirty = true; });
  $w("wfbPick").addEventListener("change", async (event) => {
    if (!confirmLeave()) { renderHeader(); return; }
    await openWorkflow(event.target.value || null);
  });
  $w("wfbSave").addEventListener("click", save);
  $w("wfbDelete").addEventListener("click", removeWorkflow);
  $w("wfbRecipes").addEventListener("click", openRecipes);
  $w("wfbRecipeList").addEventListener("click", (event) => { const b = event.target.closest("[data-recipe]"); if (b) useRecipe(b.dataset.recipe); });
  $w("wfbRecipeClose").addEventListener("click", () => $w("wfbRecipeDialog").close());
  $w("wfbStatus").addEventListener("click", () => $w("wfbFlow").querySelector(".has-error, .has-warning")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  let searchTimer = null;
  $w("wfbLeadSearch").addEventListener("input", (event) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => searchLeads(event.target.value), 300); });
  $w("wfbLeadResults").addEventListener("click", (event) => {
    const b = event.target.closest("[data-lead]");
    if (!b) return;
    $w("wfbLeadResults").querySelectorAll(".wfb-lead").forEach((x) => x.classList.toggle("active", x === b));
    runPreview(b.dataset.lead);
  });
  $w("wfbRuns").addEventListener("click", async (event) => {
    const b = event.target.closest("[data-stop]");
    if (!b) return;
    b.disabled = true;
    try {
      await crmApi(`/automation-runs/${encodeURIComponent(b.dataset.stop)}/cancel`, { method: "POST" });
      showToast(tr("wfb.stopped", "Run stopped."), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, tr("wfb.saveFailed", "Could not save the workflow.")), "error");
    }
    loadRuns();
  });
  window.addEventListener("beforeunload", (event) => { if (wfb.dirty) event.preventDefault(); });
}

startBuilder();
