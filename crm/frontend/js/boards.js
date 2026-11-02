/**
 * boards.js — Boards (Phase 7B, D87)
 * Saved views of leads or tasks: a table with chosen columns (click a heading to sort), a Kanban
 * board grouped by a field (drag a card, or "Move to…" from the keyboard), or a month calendar on
 * a date. A board saves itself as it is changed; a shared board that is not yours can be saved
 * as your own copy. Records come from GET /boards/:id/items, which reads the lead and task lists,
 * so everyone sees only what they may. Moves use the existing lead and task endpoints.
 */
(function boards() {
const brd = { meta: null, views: [], members: [], view: null, items: [], total: 0, truncated: false, month: null, saveTimer: null, loadSeq: 0, dragId: null, selected: new Set() };
const $b = (id) => document.getElementById(id);
const btr = (key, fallback, vars) => (crmI18n.has(key) ? t(key, vars) : fallback);
const battr = (value) => escapeHtml(String(value ?? ""));

const LEAD_STAGES = ["New", "Contacted", "Quote Sent", "Negotiation", "Won", "Lost"];
const LEAD_SOURCES = ["WhatsApp", "WhatsApp Ad", "IndiaMART", "JustDial", "TradeIndia", "Facebook", "Google Ads", "Website", "Website widget", "Manual", "Import", "API", "Instagram", "Messenger"]; // Instagram, Messenger: G8
const TASK_STATUSES = ["To Do", "In Progress", "Done"];
const TASK_PRIORITIES = ["Low", "Medium", "High"];

const memberName = (id) => brd.members.find((m) => String(m.id) === String(id))?.name || "";
const money = (paise) => (paise == null ? "" : `₹${(Number(paise) / 100).toLocaleString(crmI18n.locale())}`);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(crmI18n.locale(), { day: "2-digit", month: "short", year: "numeric" }) : "");
const dayKey = (value) => {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(new Date(value).getTime() + 330 * 60000).toISOString().slice(0, 10);
};
const fieldLabel = (key) => (key.startsWith("cf.")
  ? brd.meta.objects[brd.view.object].fields.find((f) => f.key === key)?.label || key
  : btr(`board.field.${brd.view?.object}.${key}`, key));
const valueLabel = (field, value) => {
  if (value == null || value === "") return "";
  if (field === "stage") return btr(`stage.${value}`, value);
  if (field === "source") return btr(`source.${value}`, value);
  if (field === "status") return btr(`taskStatus.${value}`, value);
  if (field === "priority") return btr(`priority.${value}`, value);
  if (field === "owner" || field === "assignee") return memberName(value) || btr("board.nobody", "Nobody");
  return String(value);
};

// The value of a field on a record, as text.
function cell(item, key) {
  if (brd.view.object === "lead") {
    switch (key) {
      case "title": return item.title;
      case "contact": return item.contact?.name || "";
      case "company": return item.contact?.company || "";
      case "phone": return item.contact?.phone || "";
      case "stage": return valueLabel("stage", item.stage);
      case "source": return valueLabel("source", item.source);
      case "owner": return memberName(item.ownerId);
      case "value": return money(item.expectedValuePaise);
      case "expectedCloseDate":
      case "followUpAt":
      case "lastActivityAt":
      case "createdAt": return day(item[key]);
      case "probability": return item.probability == null ? "" : `${item.probability}%`;
      default: {
        const v = item.customFields?.[key.slice(3)];
        return Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
      }
    }
  }
  switch (key) {
    case "status": return valueLabel("status", item.status);
    case "priority": return valueLabel("priority", item.priority);
    case "dueDate": return item.dueDate ? day(`${item.dueDate}T00:00:00`) : "";
    case "assignee": return item.assigneeName || memberName(item.assigneeId);
    case "related": return item.relatedName || "";
    case "createdAt": return day(item.createdAt);
    default: return item[key] ?? "";
  }
}
// The raw value a Kanban column groups by.
function groupValue(item, field) {
  if (field === "owner") return item.ownerId ? String(item.ownerId) : "";
  if (field === "assignee") return item.assigneeId ? String(item.assigneeId) : "";
  return item[field] || "";
}
function groupsOf(field) {
  const people = [...brd.members.filter((m) => m.status === "active").map((m) => String(m.id)), ""];
  return { stage: LEAD_STAGES, source: LEAD_SOURCES, owner: people, status: TASK_STATUSES, priority: TASK_PRIORITIES, assignee: people }[field] || [];
}
const dateOf = (item) => (brd.view.object === "task" && brd.view.dateField === "dueDate" ? item.dueDate : item[brd.view.dateField]);

// ---------------------------------------------------------------- the bar
function renderBar() {
  const v = brd.view;
  const mine = brd.views.filter((x) => x.mine);
  const shared = brd.views.filter((x) => !x.mine);
  const option = (x) => `<option value="${battr(x.id)}" ${v && String(x.id) === String(v.id) ? "selected" : ""}>${escapeHtml(x.name)}${x.shared ? " · ⇄" : ""}</option>`;
  $b("brdPick").innerHTML = `${mine.length ? `<optgroup label="${battr(btr("board.mine", "My boards"))}">${mine.map(option).join("")}</optgroup>` : ""}${shared.length ? `<optgroup label="${battr(btr("board.team", "Shared with the team"))}">${shared.map(option).join("")}</optgroup>` : ""}<option value="__new">${escapeHtml(btr("board.new", "New board…"))}</option>`;
  const has = Boolean(v);
  ["brdLayouts", "brdTools"].forEach((id) => { $b(id).hidden = !has; });
  if (!has) return;
  document.querySelectorAll("#brdLayouts [data-layout]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.layout === v.layout)));
  const spec = brd.meta.objects[v.object];
  $b("brdColumnsBtn").hidden = v.layout !== "table";
  $b("brdGroup").hidden = v.layout !== "kanban";
  $b("brdDate").hidden = v.layout !== "calendar";
  $b("brdGroup").innerHTML = spec.groupBy.map((g) => `<option value="${g}" ${g === v.groupBy ? "selected" : ""}>${escapeHtml(btr("board.groupBy", "By {field}", { field: fieldLabel(g) }))}</option>`).join("");
  $b("brdDate").innerHTML = spec.dateFields.map((d) => `<option value="${d}" ${d === v.dateField ? "selected" : ""}>${escapeHtml(btr("board.dateBy", "On {field}", { field: fieldLabel(d) }))}</option>`).join("");
  $b("brdShared").checked = v.shared;
  $b("brdShared").disabled = !v.canEdit;
  $b("brdDelete").hidden = !v.canEdit;
  $b("brdReadOnly").hidden = v.canEdit;
  renderFilters();
}

function renderFilters() {
  const v = brd.view;
  const f = v.filters || {};
  const isLead = v.object === "lead";
  const chipsOf = (key, list, labelOf) => `<div class="brd-chips" data-filter="${key}" role="group" aria-label="${battr(btr(`board.filter.${key}`, key))}">${list.map((x) => `<label class="chip-radio"><input type="checkbox" value="${battr(x)}" ${(f[key] || []).includes(x) ? "checked" : ""} ${v.canEdit ? "" : "disabled"} /> ${escapeHtml(labelOf(x))}</label>`).join("")}</div>`;
  const whoKey = isLead ? "ownerId" : "assigneeId";
  $b("brdFilters").innerHTML = `
    <input type="search" id="brdSearch" value="${battr(f.q || "")}" placeholder="${battr(btr("board.search", "Search"))}" aria-label="${battr(btr("board.search", "Search"))}" ${v.canEdit ? "" : "disabled"} />
    <select id="brdWho" aria-label="${battr(btr(`board.filter.${whoKey}`, "Whose"))}" ${v.canEdit ? "" : "disabled"}>
      <option value="">${escapeHtml(btr("board.anyone", "Anyone's"))}</option>
      <option value="me" ${f[whoKey] === "me" ? "selected" : ""}>${escapeHtml(btr("board.me", "Mine"))}</option>
      ${brd.members.filter((m) => m.status === "active").map((m) => `<option value="${battr(m.id)}" ${String(f[whoKey]) === String(m.id) ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}
    </select>
    ${isLead ? chipsOf("stages", LEAD_STAGES, (s) => valueLabel("stage", s)) : chipsOf("statuses", TASK_STATUSES, (s) => valueLabel("status", s))}
    ${isLead ? "" : chipsOf("priorities", TASK_PRIORITIES, (s) => valueLabel("priority", s))}`;
}

// ---------------------------------------------------------------- the body
function renderTable() {
  const v = brd.view;
  const cols = v.columns.length ? v.columns : brd.meta.objects[v.object].defaultColumns;
  const sortKey = (key) => ({ value: "expectedValuePaise" }[key] || key);
  const sortable = new Set(brd.meta.objects[v.object].sorts);
  // Leads can be ticked for the bulk bar (D89).
  const pick = v.object === "lead";
  const allOn = pick && brd.items.length && brd.items.every((item) => brd.selected.has(String(item.id)));
  const pickHead = pick ? `<th scope="col" class="brd-pick"><input type="checkbox" data-select-all ${allOn ? "checked" : ""} aria-label="${battr(btr("bulk.selectAll", "Select all"))}" /></th>` : "";
  const pickCell = (item) => (pick ? `<td class="brd-pick"><input type="checkbox" data-select="${battr(item.id)}" ${brd.selected.has(String(item.id)) ? "checked" : ""} aria-label="${battr(item.title)}" /></td>` : "");
  const head = cols.map((key) => {
    const sk = sortKey(key);
    if (!sortable.has(sk)) return `<th scope="col">${escapeHtml(fieldLabel(key))}</th>`;
    const dir = v.sort === sk ? "asc" : v.sort === `-${sk}` ? "desc" : "";
    return `<th scope="col" aria-sort="${dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}"><button type="button" class="brd-sort" data-sort="${sk}">${escapeHtml(fieldLabel(key))} <i class="fa-solid ${dir === "asc" ? "fa-arrow-up" : dir === "desc" ? "fa-arrow-down" : "fa-sort"}" aria-hidden="true"></i></button></th>`;
  }).join("");
  const rows = brd.items.map((item) => `<tr>${pickCell(item)}${cols.map((key, i) => {
    const text = escapeHtml(cell(item, key));
    if (i === 0 && v.object === "lead" && item.contactId) return `<td><a href="customer-360.html?id=${encodeURIComponent(item.contactId)}">${text}</a></td>`;
    return `<td>${text}</td>`;
  }).join("")}</tr>`).join("");
  $b("brdBody").innerHTML = brd.items.length
    ? `<div class="brd-table-wrap"><table class="brd-table"><thead><tr>${pickHead}${head}</tr></thead><tbody>${rows}</tbody></table></div>${brd.total > brd.items.length ? `<p class="brd-hint">${escapeHtml(btr("board.showing", "Showing {n} of {total}.", { n: brd.items.length, total: brd.total }))}</p>` : ""}`
    : `<p class="brd-empty">${escapeHtml(btr("board.empty", "Nothing here with these filters."))}</p>`;
}

const canMove = (field) => ["stage", "owner", "source", "status", "priority", "assignee"].includes(field);
function cardHtml(item) {
  const v = brd.view;
  const extra = (v.columns.length ? v.columns : brd.meta.objects[v.object].defaultColumns).filter((k) => k !== "title" && k !== v.groupBy).slice(0, 3)
    .map((k) => cell(item, k)).filter(Boolean);
  return `<article class="brd-card" draggable="true" data-id="${battr(item.id)}" tabindex="-1">
      <strong>${escapeHtml(item.title || "")}</strong>
      ${extra.length ? `<span class="brd-card-meta">${escapeHtml(extra.join(" · "))}</span>` : ""}
      ${canMove(v.groupBy) ? `<button type="button" class="brd-move" data-move="${battr(item.id)}">${escapeHtml(btr("board.moveTo", "Move to…"))}</button>` : ""}
    </article>`;
}
function renderKanban() {
  const v = brd.view;
  const field = v.groupBy;
  const columns = groupsOf(field);
  const sumOf = (list) => (v.object === "lead" ? list.reduce((s, i) => s + (Number(i.expectedValuePaise) || 0), 0) : null);
  $b("brdBody").innerHTML = `<div class="brd-kanban">${columns.map((value) => {
    const list = brd.items.filter((item) => groupValue(item, field) === value);
    const sum = sumOf(list);
    return `<section class="brd-col" data-group="${battr(value)}" aria-label="${battr(valueLabel(field, value))}">
        <header><span>${escapeHtml(valueLabel(field, value))}</span><span class="brd-count">${list.length}${sum ? ` · ${escapeHtml(money(sum))}` : ""}</span></header>
        <div class="brd-col-body">${list.map(cardHtml).join("")}</div>
      </section>`;
  }).join("")}</div>${brd.truncated ? `<p class="brd-hint">${escapeHtml(btr("board.truncated", "Showing the first {n}. Add a filter to see the rest.", { n: brd.items.length }))}</p>` : ""}`;
}

function monthRange() {
  const m = brd.month;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7)); // weeks start on Monday
  const end = new Date(start);
  end.setDate(start.getDate() + 42);
  return { first, start, end };
}
function renderCalendar() {
  const { first, start } = monthRange();
  const byDay = new Map();
  brd.items.forEach((item) => {
    const key = dayKey(dateOf(item));
    if (!key) return;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(item);
  });
  const todayKey = dayKey(new Date().toISOString());
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(crmI18n.locale(), { weekday: "short" }));
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const list = byDay.get(key) || [];
    const outside = d.getMonth() !== first.getMonth();
    return `<div class="brd-day${outside ? " outside" : ""}${key === todayKey ? " today" : ""}${list.length ? " has-items" : ""}" data-day="${key}">
        <span class="brd-day-num">${d.getDate()} <span class="brd-day-name">${escapeHtml(d.toLocaleDateString(crmI18n.locale(), { weekday: "short" }))}</span></span>
        ${list.slice(0, 4).map((item) => `<span class="brd-event" title="${battr(item.title)}">${escapeHtml(item.title)}</span>`).join("")}
        ${list.length > 4 ? `<span class="brd-more">${escapeHtml(btr("board.more", "+{n} more", { n: list.length - 4 }))}</span>` : ""}
      </div>`;
  }).join("");
  $b("brdBody").innerHTML = `<div class="brd-cal-head">
      <button type="button" class="btn btn-outline" data-month="-1" aria-label="${battr(btr("board.prevMonth", "Previous month"))}"><i class="fa-solid fa-chevron-left"></i></button>
      <h3>${escapeHtml(first.toLocaleDateString(crmI18n.locale(), { month: "long", year: "numeric" }))}</h3>
      <button type="button" class="btn btn-outline" data-month="1" aria-label="${battr(btr("board.nextMonth", "Next month"))}"><i class="fa-solid fa-chevron-right"></i></button>
      <button type="button" class="btn btn-outline" data-month="0">${escapeHtml(btr("board.today", "Today"))}</button>
    </div>
    <div class="brd-cal" role="grid">${weekdays.map((w) => `<div class="brd-weekday">${escapeHtml(w)}</div>`).join("")}${cells}</div>
    ${brd.items.length ? "" : `<p class="brd-empty">${escapeHtml(btr("board.emptyMonth", "Nothing on these dates."))}</p>`}`;
}

// The bulk bar (D89): how many are ticked, and what to do with them.
function renderBulk() {
  const bar = $b("brdBulk");
  const n = brd.selected.size;
  bar.hidden = !n || brd.view?.object !== "lead" || brd.view?.layout !== "table";
  if (bar.hidden) return;
  bar.querySelector(".brd-bulk-count").textContent = btr("bulk.selected", "{n} selected", { n });
  // Only owners and admins give records to someone else (the server says no to anyone else, D100).
  bar.querySelector('[data-bulk="assign"]').hidden = !isOrgManager();
}

const FOLLOW_UP_DAYS = [[1, "dialer.fu.tomorrow"], [3, "dialer.fu.3days"], [7, "dialer.fu.week"], [null, "bulk.noFollowUp"]];
async function bulkParams(action) {
  const menu = (title, options) => crmMoveMenu.open({ title, current: "", options });
  switch (action) {
    case "assign": {
      const to = await menu(btr("bulk.assign", "Give to…"), [...brd.members.filter((m) => m.status === "active").map((m) => ({ value: String(m.id), label: m.name })), { value: "none", label: btr("board.nobody", "Nobody") }]);
      return to ? { ownerId: to === "none" ? null : to } : null;
    }
    case "stage": {
      const stage = await menu(btr("bulk.stage", "Move to…"), LEAD_STAGES.map((s) => ({ value: s, label: valueLabel("stage", s) })));
      if (!stage) return null;
      if (stage !== "Lost") return { stage };
      const lostReason = prompt(btr("board.lostReason", "Why was it lost?"));
      return lostReason ? { stage, lostReason } : null;
    }
    case "followUp": {
      const pick = await menu(btr("bulk.followUp", "Follow up…"), FOLLOW_UP_DAYS.map(([days, key]) => ({ value: String(days), label: btr(key, key) })));
      if (!pick) return null;
      if (pick === "null") return { at: null };
      const at = new Date(Date.now() + Number(pick) * 24 * 60 * 60 * 1000);
      at.setUTCHours(4, 30, 0, 0);
      return { at: at.toISOString() };
    }
    case "tag": {
      const tag = prompt(btr("bulk.tagPrompt", "Tag to add"));
      return tag && tag.trim() ? { tag: tag.trim().slice(0, 50) } : null;
    }
    case "sequence": {
      const sequences = await crmApi("/sequences?limit=100").catch(() => []);
      const active = sequences.filter((s) => s.status === "Active");
      if (!active.length) {
        showToast(btr("bulk.noSequences", "No active sequences."), "error");
        return null;
      }
      const id = await menu(btr("bulk.sequence", "Add to sequence…"), active.map((s) => ({ value: String(s.id), label: s.name })));
      return id ? { sequenceId: id } : null;
    }
    case "sms": {
      const conn = await crmApi("/sms/connection").catch(() => ({ templates: [] }));
      if (!conn.templates?.length) {
        showToast(btr("bulk.noSms", "No SMS templates: an owner or admin adds them in Settings → SMS."), "error");
        return null;
      }
      const key = await menu(btr("bulk.sms", "Send SMS…"), conn.templates.map((x) => ({ value: x.key, label: x.name })));
      const template = conn.templates.find((x) => x.key === key);
      if (!template) return null;
      const variables = {};
      for (const name of template.variables) {
        if (/name/i.test(name)) variables[name] = "contact.name";
        else if (/company|firm/i.test(name)) variables[name] = "contact.company";
        else {
          const words = prompt(btr("bulk.smsBlank", "Words for ##{name}##", { name }));
          if (!words) return null;
          variables[name] = `text:${words.slice(0, 200)}`;
        }
      }
      if (!confirm(btr("bulk.smsConfirm", "Send “{name}” to {n} customers?", { name: template.name, n: brd.selected.size }))) return null;
      return { template: key, variables };
    }
    default:
      return null;
  }
}

async function runBulk(action) {
  const ids = [...brd.selected];
  if (!ids.length) return;
  if (action === "dialer") {
    try {
      const session = await crmApi("/dialer/sessions", jsonRequest("POST", { leadIds: ids, name: brd.view.name }));
      location.href = `dialer.html?id=${encodeURIComponent(session.id)}`;
    } catch (error) {
      showToast(apiErrorMessage(error, btr("bulk.failed", "Could not do it.")), "error");
    }
    return;
  }
  const params = await bulkParams(action);
  if (!params) return;
  const bar = $b("brdBulk");
  bar.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  try {
    // A move starts workflows only with "Run automations too" (D100).
    const runAutomations = action === "stage" && $b("brdRunAutomations").checked;
    const result = await crmApi("/bulk/leads", { ...jsonRequest("POST", { action, ids, params, runAutomations }), headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() } });
    const titleOf = (id) => brd.items.find((x) => String(x.id) === String(id))?.title || id;
    $b("brdBulkResult").innerHTML = result.failed.length
      ? `<p>${escapeHtml(btr("bulk.partly", "{done} of {total} done. These were not:", { done: result.done, total: result.total }))}</p><ul>${result.failed.map((f) => `<li><strong>${escapeHtml(titleOf(f.id))}</strong>: ${escapeHtml(f.message)}</li>`).join("")}</ul>`
      : "";
    $b("brdBulkResult").hidden = !result.failed.length;
    showToast(btr("bulk.done", "{done} of {total} done.", { done: result.done, total: result.total }), result.failed.length ? "info" : "success");
    brd.selected = new Set(result.failed.map((f) => String(f.id)));
    await loadItems();
  } catch (error) {
    showToast(apiErrorMessage(error, btr("bulk.failed", "Could not do it.")), "error");
  } finally {
    bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    renderBulk();
  }
}

function renderBody() {
  if (!brd.view) {
    $b("brdBody").innerHTML = `<div class="brd-start"><p>${escapeHtml(btr("board.startHint", "A board shows your leads or tasks the way you like: a table, columns to drag between, or a calendar."))}</p>
      ${Object.keys(brd.meta.objects).map((o) => `<button type="button" class="btn btn-primary" data-start="${o}">${escapeHtml(btr(`board.start.${o}`, o))}</button>`).join(" ")}</div>`;
    return;
  }
  ({ table: renderTable, kanban: renderKanban, calendar: renderCalendar })[brd.view.layout]();
  renderBulk();
}

// ---------------------------------------------------------------- loading and saving
async function loadItems() {
  const seq = ++brd.loadSeq;
  const v = brd.view;
  if (!v) { renderBody(); return; }
  let params = "";
  if (v.layout === "calendar") {
    const { start, end } = monthRange();
    params = `?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
  }
  $b("brdBody").setAttribute("aria-busy", "true");
  try {
    const data = await crmApi(`/boards/${encodeURIComponent(v.id)}/items${params}`);
    if (seq !== brd.loadSeq) return;
    brd.items = data.items;
    brd.total = data.total;
    brd.truncated = data.truncated;
    renderBody();
  } catch (error) {
    if (seq === brd.loadSeq) $b("brdBody").innerHTML = `<p class="brd-empty">${escapeHtml(apiErrorMessage(error, btr("board.loadFailed", "Could not load the board.")))}</p>`;
  } finally {
    $b("brdBody").removeAttribute("aria-busy");
  }
}

// A change to the board: saved at once (debounced) when it is yours, else it asks for a copy.
function change(patch, { reload = true, debounce = 0 } = {}) {
  const v = brd.view;
  if (!v.canEdit) {
    showToast(btr("board.readOnlyHint", "This board is the team's. Save a copy to change it."), "info");
    renderBar();
    return;
  }
  Object.assign(v, patch);
  renderBar();
  if (reload && v.layout !== "calendar") renderBody();
  clearTimeout(brd.saveTimer);
  brd.saveTimer = setTimeout(async () => {
    try {
      const saved = await crmApi(`/boards/${encodeURIComponent(v.id)}`, jsonRequest("PATCH", patch));
      Object.assign(v, saved);
      const index = brd.views.findIndex((x) => String(x.id) === String(saved.id));
      if (index >= 0) brd.views[index] = { ...brd.views[index], ...saved };
      renderBar();
      if (reload) loadItems();
    } catch (error) {
      showToast(apiErrorMessage(error, btr("board.saveFailed", "Could not save the board.")), "error");
    }
  }, debounce);
}

async function openView(id) {
  brd.selected = new Set();
  $b("brdBulkResult").hidden = true;
  brd.view = id ? { ...(brd.views.find((x) => String(x.id) === String(id)) || await crmApi(`/boards/${encodeURIComponent(id)}`)) } : null;
  brd.month = brd.month || new Date();
  history.replaceState(null, "", brd.view ? `?id=${encodeURIComponent(brd.view.id)}` : location.pathname);
  renderBar();
  await loadItems();
}

async function createBoard(object, { name, from } = {}) {
  const base = from ? { layout: from.layout, columns: from.columns, groupBy: from.groupBy, dateField: from.dateField, sort: from.sort, filters: from.filters } : {};
  try {
    const view = await crmApi("/boards", jsonRequest("POST", { object, name: name || btr(`board.defaultName.${object}`, object), ...base }));
    brd.views.push(view);
    await openView(view.id);
    showToast(btr("board.saved", "Board saved."), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, btr("board.saveFailed", "Could not save the board.")), "error");
  }
}

// ---------------------------------------------------------------- moving cards
async function moveCard(id, to) {
  const v = brd.view;
  const item = brd.items.find((x) => String(x.id) === String(id));
  if (!item || groupValue(item, v.groupBy) === to) return;
  const before = { ...item };
  const field = v.groupBy;
  let body;
  let path;
  if (v.object === "lead") {
    if (field === "stage") {
      let lostReason;
      if (to === "Lost") {
        lostReason = prompt(btr("board.lostReason", "Why was it lost?"));
        if (!lostReason) return;
      }
      path = [`/leads/${encodeURIComponent(id)}/stage`, "POST", { stage: to, version: item.version, ...(lostReason && { lostReason }) }];
      item.stage = to;
    } else {
      body = field === "owner" ? { ownerId: to || null } : { [field]: to };
      path = [`/leads/${encodeURIComponent(id)}`, "PATCH", { ...body, version: item.version }];
      if (field === "owner") item.ownerId = to || null; else item[field] = to;
    }
  } else {
    body = field === "assignee" ? { assigneeId: to || null } : { [field]: to };
    path = [`/tasks/${encodeURIComponent(id)}`, "PATCH", body];
    if (field === "assignee") item.assigneeId = to || null; else item[field] = to;
  }
  renderBody(); // at once; put back if the server refuses
  try {
    const saved = await crmApi(path[0], jsonRequest(path[1], path[2]));
    Object.assign(item, saved);
    renderBody();
  } catch (error) {
    Object.keys(item).forEach((k) => delete item[k]);
    Object.assign(item, before);
    renderBody();
    showToast(apiErrorMessage(error, btr("board.moveFailed", "The move was not saved; the card went back.")), "error");
  }
}

function setupKanban() {
  const body = $b("brdBody");
  body.addEventListener("dragstart", (event) => {
    const card = event.target.closest?.(".brd-card");
    if (!card) return;
    brd.dragId = card.dataset.id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", brd.dragId);
  });
  body.addEventListener("dragover", (event) => {
    const col = event.target.closest(".brd-col");
    if (!col || !brd.dragId) return;
    event.preventDefault();
    body.querySelectorAll(".brd-col.drop").forEach((c) => c.classList.remove("drop"));
    col.classList.add("drop");
  });
  body.addEventListener("drop", (event) => {
    const col = event.target.closest(".brd-col");
    if (!col || !brd.dragId) return;
    event.preventDefault();
    const id = brd.dragId;
    brd.dragId = null;
    moveCard(id, col.dataset.group);
  });
  body.addEventListener("dragend", () => {
    brd.dragId = null;
    body.querySelectorAll(".brd-col.drop").forEach((c) => c.classList.remove("drop"));
  });
}

// ---------------------------------------------------------------- columns dialog
function openColumns() {
  const v = brd.view;
  const fields = brd.meta.objects[v.object].fields;
  const chosen = v.columns.length ? v.columns : brd.meta.objects[v.object].defaultColumns;
  $b("brdColumnList").innerHTML = fields.map((f) => `<label class="brd-col-choice"><input type="checkbox" value="${battr(f.key)}" ${chosen.includes(f.key) ? "checked" : ""} /> ${escapeHtml(fieldLabel(f.key))}</label>`).join("");
  $b("brdColumnsDialog").showModal();
}
function saveColumns() {
  const v = brd.view;
  const order = brd.meta.objects[v.object].fields.map((f) => f.key);
  const before = v.columns.length ? v.columns : brd.meta.objects[v.object].defaultColumns;
  const picked = [...$b("brdColumnList").querySelectorAll("input:checked")].map((i) => i.value);
  // Kept columns stay where they were; new ones go at the end, in the field order.
  const columns = [...before.filter((k) => picked.includes(k)), ...order.filter((k) => picked.includes(k) && !before.includes(k))].slice(0, 12);
  $b("brdColumnsDialog").close();
  if (!columns.length) return;
  change({ columns }, { reload: false });
  renderTable();
}

// ---------------------------------------------------------------- start
async function startBoards() {
  await crmI18n.ready;
  try {
    const [meta, views, members] = await Promise.all([crmApi("/boards/meta"), crmApi("/boards"), crmApi("/members?limit=100").catch(() => [])]);
    Object.assign(brd, { meta, views, members });
  } catch (error) {
    $b("brdBody").innerHTML = `<p class="brd-empty">${escapeHtml(apiErrorMessage(error, btr("board.loadFailed", "Could not load the board.")))}</p>`;
    return;
  }
  const wanted = new URLSearchParams(location.search).get("id");
  const first = brd.views.find((x) => String(x.id) === wanted) || brd.views.find((x) => x.mine) || brd.views[0];
  await openView(first?.id || null);

  $b("brdPick").addEventListener("change", (event) => {
    if (event.target.value === "__new") {
      $b("brdNewName").value = "";
      $b("brdNewObject").innerHTML = Object.keys(brd.meta.objects).map((o) => `<option value="${o}">${escapeHtml(btr(`board.object.${o}`, o))}</option>`).join("");
      $b("brdNewDialog").showModal();
      renderBar();
      return;
    }
    openView(event.target.value);
  });
  $b("brdNewForm").addEventListener("submit", (event) => {
    event.preventDefault();
    $b("brdNewDialog").close();
    createBoard($b("brdNewObject").value, { name: $b("brdNewName").value.trim() });
  });
  $b("brdNewCancel").addEventListener("click", () => $b("brdNewDialog").close());
  $b("brdLayouts").addEventListener("click", (event) => {
    const b = event.target.closest("[data-layout]");
    if (!b || !brd.view || b.dataset.layout === brd.view.layout) return;
    // Saved first, then read: the items follow the board's saved layout.
    return change({ layout: b.dataset.layout });
  });
  $b("brdGroup").addEventListener("change", (event) => change({ groupBy: event.target.value }));
  $b("brdDate").addEventListener("change", (event) => change({ dateField: event.target.value }));
  $b("brdShared").addEventListener("change", (event) => change({ shared: event.target.checked }, { reload: false }));
  $b("brdColumnsBtn").addEventListener("click", openColumns);
  $b("brdColumnsDone").addEventListener("click", saveColumns);
  $b("brdSaveAs").addEventListener("click", () => {
    const name = prompt(btr("board.copyName", "Name of your copy"), `${brd.view.name} (${btr("board.copy", "copy")})`);
    if (name) createBoard(brd.view.object, { name: name.slice(0, 80), from: brd.view });
  });
  $b("brdDelete").addEventListener("click", async () => {
    if (!confirm(btr("board.deleteConfirm", "Delete this board? The records stay."))) return;
    try {
      await crmApi(`/boards/${encodeURIComponent(brd.view.id)}`, { method: "DELETE" });
      brd.views = brd.views.filter((x) => String(x.id) !== String(brd.view.id));
      showToast(btr("board.deleted", "Board deleted."), "success");
      await openView(brd.views.find((x) => x.mine)?.id || brd.views[0]?.id || null);
    } catch (error) {
      showToast(apiErrorMessage(error, btr("board.saveFailed", "Could not save the board.")), "error");
    }
  });
  $b("brdFilters").addEventListener("change", (event) => {
    const v = brd.view;
    const group = event.target.closest("[data-filter]");
    if (group) return change({ filters: { ...v.filters, [group.dataset.filter]: [...group.querySelectorAll("input:checked")].map((i) => i.value) } });
    if (event.target.id === "brdWho") return change({ filters: { ...v.filters, [v.object === "lead" ? "ownerId" : "assigneeId"]: event.target.value || undefined } });
    return undefined;
  });
  $b("brdFilters").addEventListener("input", (event) => {
    if (event.target.id === "brdSearch") change({ filters: { ...brd.view.filters, q: event.target.value } }, { debounce: 400 });
  });
  $b("brdBody").addEventListener("click", async (event) => {
    const start = event.target.closest("[data-start]");
    if (start) return createBoard(start.dataset.start);
    const sort = event.target.closest("[data-sort]");
    if (sort) {
      const key = sort.dataset.sort;
      return change({ sort: brd.view.sort === key ? `-${key}` : key });
    }
    const month = event.target.closest("[data-month]");
    if (month) {
      const step = Number(month.dataset.month);
      brd.month = step ? new Date(brd.month.getFullYear(), brd.month.getMonth() + step, 1) : new Date();
      return loadItems();
    }
    const move = event.target.closest("[data-move]");
    if (move) {
      const field = brd.view.groupBy;
      const to = await crmMoveMenu.open({ title: btr("board.moveTo", "Move to…"), current: groupValue(brd.items.find((x) => String(x.id) === move.dataset.move) || {}, field), options: groupsOf(field).map((g) => ({ value: g, label: valueLabel(field, g) })), returnFocus: move });
      if (to != null && to !== false) moveCard(move.dataset.move, to);
    }
    return undefined;
  });
  setupKanban();
  $b("brdBody").addEventListener("change", (event) => {
    if (event.target.matches("[data-select-all]")) {
      brd.items.forEach((item) => (event.target.checked ? brd.selected.add(String(item.id)) : brd.selected.delete(String(item.id))));
      renderTable();
    } else if (event.target.matches("[data-select]")) {
      if (event.target.checked) brd.selected.add(event.target.dataset.select); else brd.selected.delete(event.target.dataset.select);
    } else return;
    renderBulk();
  });
  $b("brdBulk").addEventListener("click", (event) => {
    const button = event.target.closest("[data-bulk]");
    if (button?.dataset.bulk === "clear") {
      brd.selected = new Set();
      renderTable();
      renderBulk();
    } else if (button) runBulk(button.dataset.bulk);
  });
}

startBoards();
})();
