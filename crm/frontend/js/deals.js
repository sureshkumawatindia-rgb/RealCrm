/**
 * deals.js — Deals page: the Kanban + table view of the lead pipeline. Since D84 the Kanban is
 * the chosen pipeline's board from GET /pipelines/:id/board (its own stages, next activity and
 * flags per lead); the filters narrow its cards. Deals are server leads (getDeals / createLead /
 * updateLeadRecord / changeLeadStage / removeLead in app.js); the follow-up panel shows server tasks with
 * origin "deal_followup". Reuses shared helpers from app.js (getAgents, getAccounts,
 * getCustomers, showToast, renderSidebarUser, initSidebarToggle, requireAuth).
 */

// Shown in the form; the server sets the real probability from the stage.
const STAGE_DEFAULT_PROB = {
  New: 10,
  Contacted: 25,
  "Quote Sent": 50,
  Negotiation: 75,
  Won: 100,
  Lost: 0,
};
const STAGE_BADGE_CLASS = {
  New: "badge-stage-lead",
  Contacted: "badge-stage-qualified",
  "Quote Sent": "badge-stage-proposal",
  Negotiation: "badge-stage-negotiation",
  Won: "badge-stage-won",
  Lost: "badge-stage-lost",
};

let currentView = "kanban";

function getDeal(id) {
  return getDeals().find((d) => String(d.id) === String(id));
}

// The quick follow-ups in the right panel: tasks created from this page.
function getDealTasks() {
  return getTasks()
    .filter((t) => t.origin === "deal_followup")
    .map((t) => ({ id: t.id, text: t.title, done: t.status === "Done", due: t.dueDate }));
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function formatCurrency(n) {
  const num = Number(n) || 0;
  return "₹" + num.toLocaleString(crmI18n.locale());
}
function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(crmI18n.locale(), {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
function initials(name) {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}
function ownerNames() {
  return getAgents().map((a) => a.name);
}
function accountNames() {
  return getAccounts()
    .map((a) => a.name)
    .filter(Boolean);
}
function contactNames() {
  return getCustomers()
    .map((c) => c.name)
    .filter(Boolean);
}

// ---------------------------------------------------------------
// Filters
// ---------------------------------------------------------------
// Filters on the company's own fields (D74), for the board and the table.
const dealFieldFilters = cfFilterBar({
  container: document.getElementById("dealCfFilters"),
  object: "lead",
  storageKey: "dealsFieldFilters",
  onChange: () => {
    if (!crmCache.leads) return;
    if (currentView === "kanban") renderKanban();
    else renderTable();
  },
});

function getFilteredDeals() {
  const q = (document.getElementById("searchInput").value || "")
    .toLowerCase()
    .trim();
  const stage = document.getElementById("filterStage").value;
  const owner = document.getElementById("filterOwner").value;
  const min = parseFloat(document.getElementById("filterMinValue").value);
  const max = parseFloat(document.getElementById("filterMaxValue").value);
  const closeBy = document.getElementById("filterCloseDate").value;

  const fields = cfFields("lead");
  const deals = getDeals().filter((d) => {
    if (q) {
      const hay =
        `${d.name} ${d.account} ${d.owner} ${d.contact || ""} ${cfSearchText(fields, d.customFields)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (stage !== "all" && d.stage !== stage) return false;
    if (owner !== "all" && d.owner !== owner) return false;
    if (!isNaN(min) && d.value < min) return false;
    if (!isNaN(max) && d.value > max) return false;
    if (closeBy && d.closeDate && d.closeDate > closeBy) return false;
    return true;
  });
  return cfApplyFilters(deals, dealFieldFilters.filters(), fields);
}

// ---------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------
function renderKpis() {
  const deals = getDeals();
  const open = deals.filter((d) => d.stage !== "Won" && d.stage !== "Lost");
  const pipelineValue = open.reduce((sum, d) => sum + Number(d.value || 0), 0);

  const now = new Date();
  const wonThisMonth = deals.filter((d) => {
    if (d.stage !== "Won" || !d.closeDate) return false;
    const c = new Date(d.closeDate);
    return (
      c.getMonth() === now.getMonth() && c.getFullYear() === now.getFullYear()
    );
  });
  const wonValue = wonThisMonth.reduce(
    (sum, d) => sum + Number(d.value || 0),
    0,
  );

  const cards = [
    { label: t("deals.kpi.total"), value: deals.length, cls: "" },
    {
      label: t("deals.kpi.pipeline"),
      value: formatCurrency(pipelineValue),
      cls: "info",
    },
    {
      label: t("deals.kpi.won"),
      value: `${wonThisMonth.length} · ${formatCurrency(wonValue)}`,
      cls: "success",
    },
    { label: t("deals.kpi.progress"), value: open.length, cls: "warning" },
  ];

  document.getElementById("kpiGrid").innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card ${c.cls}">
        <div class="label">${escapeHtml(c.label)}</div>
        <div class="value">${escapeHtml(String(c.value))}</div>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------
// Kanban view
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Pipelines (D84): the board of the chosen pipeline, from the server; the filters above narrow its
// cards and the column totals follow what is shown. A move shows at once; when the server refuses
// it (someone else moved the deal, a lost reason is missing …) the card goes back and the toast
// says why.
// ---------------------------------------------------------------
let pipelines = [];
let pipelineId = null;
let board = null; // the last board from the server
let boardAsked = null;

async function loadPipelines() {
  pipelines = await crmApi("/pipelines");
  const remembered = getPreference("dealsPipeline", "");
  const chosen = pipelines.find((p) => String(p.id) === remembered) || pipelines.find((p) => p.isDefault) || pipelines[0];
  pipelineId = chosen ? chosen.id : null;
  renderPipelinePicker();
}

async function loadBoard() {
  if (!pipelineId) return;
  const asked = crmApi(`/pipelines/${pipelineId}/board`);
  boardAsked = asked;
  const data = await asked;
  if (boardAsked === asked) board = data;
}

function refreshBoard() {
  return loadBoard()
    .then(() => { if (currentView === "kanban") renderKanban(); })
    .catch((error) => showToast(apiErrorMessage(error, t("pipe.loadFailed")), "error"));
}

function renderPipelinePicker() {
  const bar = document.querySelector(".nav-bar-kanban-card");
  if (!bar) return;
  bar.classList.add("pipe-picker");
  bar.innerHTML = pipelines.map((p) => `<button type="button" data-pipeline="${escapeHtml(p.id)}" class="${String(p.id) === String(pipelineId) ? "active" : ""}">${escapeHtml(p.name)} <span class="pipe-count">${p.openLeads}</span></button>`).join("")
    + (isOrgManager() ? `<a class="pipe-settings" href="Settings.html?tab=pipelines"><i class="fa-solid fa-gear" aria-hidden="true"></i> ${escapeHtml(t("pipe.edit"))}</a>` : "");
}

const paiseToRupees = (paise) => Math.round(Number(paise) || 0) / 100;

function nextActivityText(next) {
  if (!next) return "";
  const when = next.date ? formatDate(next.date) : "";
  if (next.type === "followUp") return t("pipe.next.followUp", { date: when });
  return `${next.title}${when ? ` · ${when}` : ""}${next.time ? ` ${next.time}` : ""}`;
}

function boardCardHtml(card, stage) {
  const deal = getDeal(card.id);
  const name = deal?.name || card.title;
  const account = deal?.account || card.company || card.contact;
  const flags = [
    card.flags.overdue && `<span class="pipe-flag overdue"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(t("pipe.flag.overdue"))}</span>`,
    card.flags.noNextStep && `<span class="pipe-flag none">${escapeHtml(t("pipe.flag.noNext"))}</span>`,
    card.flags.quiet && `<span class="pipe-flag quiet"><i class="fa-regular fa-moon" aria-hidden="true"></i> ${escapeHtml(t("pipe.flag.quiet", { days: card.idleDays }))}</span>`,
  ].filter(Boolean).join("");
  const next = nextActivityText(card.nextActivity);
  return `
    <div class="deal-card" draggable="true" data-id="${escapeHtml(card.id)}" data-stage-id="${escapeHtml(stage.id)}">
      <div class="deal-card__name">${escapeHtml(name)}</div>
      ${account ? `<div class="deal-card__account"><i class="fa-solid fa-building"></i> ${escapeHtml(account)}</div>` : ""}
      <div class="deal-card__value">${formatCurrency(paiseToRupees(card.valuePaise))}</div>
      ${next ? `<div class="deal-card__next${card.flags.overdue ? " overdue" : ""}"><i class="fa-regular fa-calendar" aria-hidden="true"></i> ${escapeHtml(next)}</div>` : ""}
      ${flags ? `<div class="pipe-flags">${flags}</div>` : ""}
      <div class="deal-card__foot">
        <div class="deal-card__owner">
          <span class="deal-card__owner-avatar">${initials(card.owner)}</span>
          ${escapeHtml((card.owner || "").split(" ")[0] || t("pipe.noOwner"))}
        </div>
      </div>
      ${kanbanMoveButton(card.id)}
    </div>`;
}

function renderKanban() {
  const el = document.getElementById("kanbanView");
  if (!board) {
    el.innerHTML = `<div class="kanban-col-empty">${escapeHtml(t("pipe.loading"))}</div>`;
    return;
  }
  const shown = new Set(getFilteredDeals().map((d) => String(d.id)));
  const columns = board.columns.map((col) => {
    const cards = col.leads.filter((card) => shown.has(String(card.id)));
    const value = cards.reduce((sum, card) => sum + card.valuePaise, 0);
    const weighted = cards.reduce((sum, card) => sum + Math.round((card.valuePaise * col.stage.probability) / 100), 0);
    return `
      <div class="kanban-col" data-stage-id="${escapeHtml(col.stage.id)}">
        <div class="kanban-col-head">
          <div class="kanban-col-head-title"><h4>${escapeHtml(col.stage.name)}</h4></div>
          <span class="kanban-count">${cards.length}</span>
        </div>
        <div class="kanban-col-value">${formatCurrency(paiseToRupees(value))} <span class="pipe-weighted" title="${escapeHtml(t("pipe.weightedHint", { pct: col.stage.probability }))}">${escapeHtml(t("pipe.weighted", { value: formatCurrency(paiseToRupees(weighted)) }))}</span></div>
        <div class="kanban-col-body" data-drop-stage="${escapeHtml(col.stage.id)}">
          ${cards.length ? cards.map((card) => boardCardHtml(card, col.stage)).join("") : `<div class="kanban-col-empty">${escapeHtml(t("deals.noDeals"))}</div>`}
          ${col.more ? `<div class="kanban-col-empty">${escapeHtml(t("pipe.more", { n: col.more }))}</div>` : ""}
        </div>
      </div>`;
  });
  const closed = ["Won", "Lost"].map((stage) => {
    const total = board.last30Days[stage === "Won" ? "won" : "lost"];
    return `<div class="kanban-close ${stage.toLowerCase()}" data-close="${stage}">
      <i class="fa-solid ${stage === "Won" ? "fa-trophy" : "fa-circle-xmark"}" aria-hidden="true"></i>
      <strong>${escapeHtml(crmLabel("stage", stage))}</strong>
      <span>${escapeHtml(t("pipe.closed30", { n: total.count, value: formatCurrency(paiseToRupees(total.valuePaise)) }))}</span>
      <small>${escapeHtml(t("pipe.dropHere"))}</small>
    </div>`;
  });
  el.innerHTML = `${columns.join("")}<div class="kanban-closers">${closed.join("")}</div>`;
  attachDragEvents();
}

const cardOnBoard = (id) => {
  for (const col of board?.columns || []) {
    const card = col.leads.find((l) => String(l.id) === String(id));
    if (card) return { col, card };
  }
  return null;
};

// A deal to another stage (or Won / Lost): on the board at once; back with the reason if refused.
async function moveOnBoard(id, target) {
  const found = cardOnBoard(id);
  if (!found) return;
  const { col, card } = found;
  if (target.stageId && String(col.stage.id) === String(target.stageId)) return;
  const lostReason = target.close === "Lost" ? askLostReason(card.title) : null;
  if (target.close === "Lost" && !lostReason) return;
  const before = JSON.parse(JSON.stringify(board));
  col.leads = col.leads.filter((l) => l !== card);
  const toCol = target.stageId ? board.columns.find((c) => String(c.stage.id) === String(target.stageId)) : null;
  if (toCol) toCol.leads.unshift({ ...card, pipelineStageId: toCol.stage.id });
  else {
    const total = board.last30Days[target.close === "Won" ? "won" : "lost"];
    total.count += 1;
    total.valuePaise += card.valuePaise;
  }
  renderKanban();
  const where = toCol ? toCol.stage.name : crmLabel("stage", target.close);
  try {
    const body = toCol ? { pipelineStageId: toCol.stage.id, version: card.version } : { stage: target.close, version: card.version, ...(lostReason && { lostReason }) };
    cacheLead(await crmApi(`/leads/${id}/stage`, jsonRequest("POST", body)));
    showToast(t("deals.moved", { name: card.title, stage: where }), "success");
    renderKpis();
    await refreshBoard(); // fresh versions, next steps and flags
  } catch (error) {
    board = before; // back where it was
    renderKanban();
    const conflict = error?.code === "VERSION_CONFLICT";
    showToast(conflict ? t("pipe.conflict") : t("pipe.putBack", { why: apiErrorMessage(error, t("deals.err.move")) }), "error");
    if (conflict) refreshBoard();
  }
}

let draggingId = null;
function attachDragEvents() {
  document.querySelectorAll("#kanbanView .deal-card").forEach((card) => {
    card.addEventListener("click", () => openModal(card.dataset.id));
    card.querySelector(".kanban-move")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const found = cardOnBoard(card.dataset.id);
      if (!found) return;
      const value = await crmMoveMenu.open({
        title: t("deals.moveTo", { name: found.card.title }), current: `stage:${found.col.stage.id}`, returnFocus: event.currentTarget,
        options: [
          ...board.columns.map((c) => ({ value: `stage:${c.stage.id}`, label: c.stage.name })),
          { value: "close:Won", label: crmLabel("stage", "Won"), color: "var(--success)" },
          { value: "close:Lost", label: crmLabel("stage", "Lost"), color: "var(--danger)" },
        ],
      });
      if (!value) return;
      const [kind, ref] = value.split(":");
      moveOnBoard(card.dataset.id, kind === "stage" ? { stageId: ref } : { close: ref });
    });
    card.addEventListener("dragstart", (event) => {
      draggingId = card.dataset.id;
      card.classList.add("dragging");
      event.dataTransfer?.setData("text/plain", draggingId);
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      draggingId = null;
    });
  });
  document.querySelectorAll("#kanbanView .kanban-col, #kanbanView .kanban-close").forEach((zone) => {
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drag-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drag-over");
      const id = draggingId || e.dataTransfer?.getData("text/plain");
      if (!id) return;
      moveOnBoard(id, zone.dataset.close ? { close: zone.dataset.close } : { stageId: zone.dataset.stageId });
    });
  });
}

// ---------------------------------------------------------------
// Table view
// ---------------------------------------------------------------
function renderTable() {
  const deals = getFilteredDeals();
  const wrap = document.getElementById("dealsTable");
  const columns = cfListColumns(cfFields("lead"));

  if (!deals.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-handshake"></i>
        <div>${escapeHtml(t("deals.empty.filtered"))}</div>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>${escapeHtml(t("dash.add.deal"))}</th>
          <th>${escapeHtml(t("deals.col.account"))}</th>
          <th>${escapeHtml(t("col.value"))}</th>
          <th>${escapeHtml(t("deals.col.stage"))}</th>
          <th>${escapeHtml(t("deals.col.probability"))}</th>
          <th>${escapeHtml(t("deals.col.closeDate"))}</th>
          <th>${escapeHtml(t("leads.col.owner"))}</th>
          ${columns.map((field) => `<th>${escapeHtml(field.label)}</th>`).join("")}
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${deals
          .map(
            (d) => `
          <tr data-id="${d.id}">
            <td><strong>${escapeHtml(d.name)}</strong></td>
            <td>${escapeHtml(d.account)}</td>
            <td>${formatCurrency(d.value)}</td>
            <td><span class="badge ${STAGE_BADGE_CLASS[d.stage]}">${escapeHtml(crmLabel("stage", d.stage))}</span></td>
            <td>${d.probability}%</td>
            <td>${formatDate(d.closeDate)}</td>
            <td>${escapeHtml(d.owner)}</td>
            ${columns.map((field) => `<td>${escapeHtml(cfDisplayValue(field, d.customFields?.[field.key], d.customFieldLinks?.[field.key])) || "—"}</td>`).join("")}
            <td>
              <div class="row-actions">
                <button class="icon-btn edit-row" data-id="${d.id}" title="${escapeHtml(t("common.edit"))}" aria-label="${escapeHtml(t("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger delete-row" data-id="${d.id}" title="${escapeHtml(t("common.delete"))}" aria-label="${escapeHtml(t("common.delete"))}"><i class="fa-solid fa-trash"></i></button>
              </div>
            </td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  wrap.querySelectorAll(".edit-row").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal(btn.dataset.id);
    }),
  );
  wrap.querySelectorAll(".delete-row").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDelete(btn.dataset.id);
    }),
  );
  wrap
    .querySelectorAll("tbody tr")
    .forEach((row) =>
      row.addEventListener("click", () => openModal(row.dataset.id)),
    );
}

// ---------------------------------------------------------------
// Right panel — Team
// ---------------------------------------------------------------
function renderTeamTab() {
  const deals = getDeals();
  const agents = getAgents();
  const names = agents.length
    ? agents.map((a) => a.name)
    : [...new Set(deals.map((d) => d.owner))];

  const el = document.getElementById("teamTabContent");
  if (!names.length) {
    el.innerHTML = `<div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-user-group"></i><div>${escapeHtml(t("deals.noAgents"))}</div></div>`;
    return;
  }

  el.innerHTML = names
    .map((name) => {
      const agent = agents.find((a) => a.name === name);
      const count = deals.filter((d) => d.owner === name).length;
      const value = deals
        .filter(
          (d) => d.owner === name && d.stage !== "Won" && d.stage !== "Lost",
        )
        .reduce((sum, d) => sum + Number(d.value || 0), 0);
      return `
        <div class="team-member-row">
          <div class="avatar">${initials(name)}</div>
          <div class="info">
            <div class="name">${escapeHtml(name)}</div>
            <div class="sub">${escapeHtml(agent ? crmLabel("role", agent.role) : t("deals.owner"))} · ${escapeHtml(t("deals.openValue", { value: formatCurrency(value) }))}</div>
          </div>
          <span class="count">${count}</span>
        </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Right panel — Tasks
// ---------------------------------------------------------------
function renderTasksTab() {
  const tasks = getDealTasks();
  const el = document.getElementById("tasksTabContent");

  const list = tasks.length
    ? tasks
        .map(
          (t) => `
      <div class="task-row ${t.done ? "done" : ""}">
        <input type="checkbox" data-id="${t.id}" class="task-toggle" ${t.done ? "checked" : ""} />
        <div class="task-text">
          ${escapeHtml(t.text)}
          ${t.due ? `<span class="task-due"><i class="fa-regular fa-clock"></i> ${formatDate(t.due)}</span>` : ""}
        </div>
        <button class="icon-btn danger task-delete" data-id="${t.id}" title="${escapeHtml(crmI18n.t("common.delete"))}" aria-label="${escapeHtml(crmI18n.t("common.delete"))}"><i class="fa-solid fa-xmark"></i></button>
      </div>`,
        )
        .join("")
    : `<div class="empty-state" style="padding:20px 10px"><i class="fa-solid fa-list-check"></i><div>${escapeHtml(t("deals.noTasks"))}</div></div>`;

  el.innerHTML = `
    ${list}
    <div class="task-add-row">
      <input type="text" id="newTaskInput" placeholder="${escapeHtml(t("deals.addTaskPlaceholder"))}" />
      <button class="btn btn-outline" id="addTaskBtn" title="${escapeHtml(t("common.add"))}" aria-label="${escapeHtml(t("common.add"))}"><i class="fa-solid fa-plus"></i></button>
    </div>`;

  el.querySelectorAll(".task-toggle").forEach((cb) =>
    cb.addEventListener("change", () => {
      saveTask(cb.dataset.id, { status: cb.checked ? "Done" : "To Do" })
        .catch((error) => showToast(apiErrorMessage(error, t("inbox.ctx.taskFailed")), "error"))
        .finally(renderTasksTab);
    }),
  );
  el.querySelectorAll(".task-delete").forEach((btn) =>
    btn.addEventListener("click", () => {
      removeTask(btn.dataset.id)
        .catch((error) => showToast(apiErrorMessage(error, t("deals.err.deleteTask")), "error"))
        .finally(renderTasksTab);
    }),
  );
  document
    .getElementById("addTaskBtn")
    .addEventListener("click", addTaskFromInput);
  document.getElementById("newTaskInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTaskFromInput();
  });
}

async function addTaskFromInput() {
  const input = document.getElementById("newTaskInput");
  const text = input.value.trim();
  if (!text) return;
  try {
    await saveTask(null, { title: text, status: "To Do", origin: "deal_followup", assignee: getCurrentUser()?.name || "" });
    input.value = "";
  } catch (error) {
    showToast(apiErrorMessage(error, t("deals.err.addTask")), "error");
  }
  renderTasksTab();
}

// ---------------------------------------------------------------
// Right panel — Calendar
// ---------------------------------------------------------------
function renderCalendarTab() {
  const deals = getDeals()
    .filter((d) => d.stage !== "Won" && d.stage !== "Lost" && d.closeDate)
    .sort((a, b) => (a.closeDate > b.closeDate ? 1 : -1))
    .slice(0, 10);

  const el = document.getElementById("calendarTabContent");
  if (!deals.length) {
    el.innerHTML = `<div class="empty-state" style="padding:20px 10px"><i class="fa-solid fa-calendar-days"></i><div>${escapeHtml(t("deals.noCloseDates"))}</div></div>`;
    return;
  }

  el.innerHTML = deals
    .map((d) => {
      const dt = new Date(d.closeDate);
      return `
      <div class="calendar-row">
        <div class="calendar-date-chip">
          <span class="d">${dt.getDate()}</span>
          <span class="m">${dt.toLocaleDateString(crmI18n.locale(), { month: "short" })}</span>
        </div>
        <div class="info">
          <div class="name">${escapeHtml(d.name)}</div>
          <div class="sub">${escapeHtml(d.account)} · ${escapeHtml(crmLabel("stage", d.stage))}</div>
        </div>
      </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Modal — add / edit
// ---------------------------------------------------------------
function populateOwnerSelect() {
  const sel = document.getElementById("fOwner");
  const agents = getAgents();
  sel.innerHTML = agents
    .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`)
    .join("");
  const me = getCurrentMember();
  if (me) sel.value = me.id;
}
function populateFilterOwners() {
  const sel = document.getElementById("filterOwner");
  const current = sel.value;
  sel.innerHTML =
    `<option value="all">${escapeHtml(t("deals.allOwners"))}</option>` +
    ownerNames()
      .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
      .join("");
  sel.value = current || "all";
}
function populateDatalists() {
  document.getElementById("accountOptions").innerHTML = accountNames()
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
  document.getElementById("contactOptions").innerHTML = contactNames()
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

function openModal(id) {
  const overlay = document.getElementById("modalOverlay");
  const form = document.getElementById("dealForm");
  form.reset();
  populateOwnerSelect();
  populateDatalists();

  const deleteBtn = document.getElementById("deleteBtn");
  const timelineSection = document.getElementById("timelineSection");
  const deal = id ? getDeal(id) : null;
  if (id && !deal) return;
  cfMount(document.getElementById("dealCustomFields"), "lead", deal?.customFields, deal?.customFieldLinks);

  if (deal) {
    document.getElementById("modalTitle").textContent = t("deals.edit");
    document.getElementById("editId").value = deal.id;
    document.getElementById("fName").value = deal.name;
    document.getElementById("fAccount").value = deal.account;
    document.getElementById("fContact").value = deal.contact || "";
    document.getElementById("fValue").value = deal.value;
    document.getElementById("fCloseDate").value = deal.closeDate || "";
    document.getElementById("fStage").value = deal.stage;
    if (deal.ownerId) document.getElementById("fOwner").value = deal.ownerId;
    document.getElementById("fProbability").value = deal.probability;
    document.getElementById("fProbabilityValue").textContent =
      `${deal.probability}%`;
    deleteBtn.style.display = "inline-flex";
    timelineSection.style.display = "block";
    renderTimeline(deal);
  } else {
    document.getElementById("modalTitle").textContent = t("dash.newDeal");
    document.getElementById("editId").value = "";
    document.getElementById("fStage").value = "New";
    document.getElementById("fProbability").value = STAGE_DEFAULT_PROB.New;
    document.getElementById("fProbabilityValue").textContent =
      `${STAGE_DEFAULT_PROB.New}%`;
    deleteBtn.style.display = "none";
    timelineSection.style.display = "none";
  }

  overlay.classList.add("open");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
}

// Every stage move of the deal, oldest first, with the time it spent in each (D84).
const durationText = (ms) => {
  if (ms === null || ms === undefined) return "";
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor(ms / 3600000);
  return days >= 1 ? t("pipe.days", { n: days }) : hours >= 1 ? t("pipe.hours", { n: hours }) : t("pipe.lessThanHour");
};
async function renderStageHistory(deal) {
  let box = document.getElementById("stageHistory");
  if (!box) {
    box = document.createElement("div");
    box.id = "stageHistory";
    box.className = "stage-history";
    document.getElementById("timelineSection").appendChild(box);
  }
  box.innerHTML = "";
  let entries = [];
  try {
    entries = await crmApi(`/leads/${deal.id}/stage-history`);
  } catch {
    return; // the timeline above still shows the stage changes
  }
  if (!entries.length) return;
  box.innerHTML = `<div class="stage-history-title">${escapeHtml(t("pipe.history"))}</div>${entries.map((e) => `
    <div class="stage-history-row">
      <span>${e.from.name ? `${escapeHtml(e.from.name)} → ` : ""}<strong>${escapeHtml(e.to.name)}</strong></span>
      <span class="meta">${escapeHtml([formatDate(e.at), e.actorName, e.from.name && durationText(e.msInFrom) ? t("pipe.after", { time: durationText(e.msInFrom) }) : ""].filter(Boolean).join(" · "))}</span>
    </div>`).join("")}`;
}

async function renderTimeline(deal) {
  renderStageHistory(deal);
  const el = document.getElementById("timelineList");
  el.innerHTML = `<div class="text-muted" style="font-size:12.5px">${escapeHtml(t("deals.loadingActivity"))}</div>`;
  let activities = [];
  try {
    activities = await getLeadActivities(deal.id);
  } catch (error) {
    el.innerHTML = `<div class="text-muted" style="font-size:12.5px">${escapeHtml(apiErrorMessage(error, t("deals.err.activity")))}</div>`;
    return;
  }
  el.innerHTML = activities.length
    ? activities
        .map(
          (n) => `
      <div class="timeline-item">
        <span class="dot"></span>
        <div class="body">
          <div class="text">${n.mentions?.length ? withMentions(n.text, n.mentions) : escapeHtml(n.text || crmLabel("leadHistory", n.type))}</div>
          <div class="meta">${escapeHtml(n.actorName || "")} · ${formatDate(n.createdAt)}</div>
        </div>
      </div>`,
        )
        .join("")
    : `<div class="text-muted" style="font-size:12.5px">${escapeHtml(t("deals.noActivity"))}</div>`;
}

// @mentions (D87): typing "@" and a name lists the teammates who can open this deal; the ones
// still written in the note when it is added get a bell note.
const mention = { picked: new Map(), options: [], active: 0, timer: null, seq: 0 };
function withMentions(text, mentions) {
  let html = escapeHtml(text || "");
  for (const m of mentions) {
    if (m.name) html = html.split(escapeHtml(`@${m.name}`)).join(`<span class="mention">@${escapeHtml(m.name)}</span>`);
  }
  return html;
}
function mentionList() {
  let list = document.getElementById("mentionList");
  if (!list) {
    list = document.createElement("div");
    list.id = "mentionList";
    list.className = "mention-list";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    document.querySelector(".note-input-row")?.insertAdjacentElement("afterend", list);
  }
  return list;
}
function closeMentions() {
  mentionList().hidden = true;
  mention.options = [];
}
function mentionQuery(input) {
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const match = before.match(/(?:^|\s)@([^\s@]{0,30})$/u);
  return match ? match[1] : null;
}
function renderMentions() {
  const list = mentionList();
  list.hidden = !mention.options.length;
  list.innerHTML = mention.options.map((m, i) => `<button type="button" role="option" class="mention-option${i === mention.active ? " active" : ""}" aria-selected="${i === mention.active}" data-mention="${i}">@${escapeHtml(m.name)}</button>`).join("");
}
function onNoteInput() {
  const input = document.getElementById("noteInput");
  const id = document.getElementById("editId").value;
  const q = id ? mentionQuery(input) : null;
  clearTimeout(mention.timer);
  if (q === null) return closeMentions();
  mention.timer = setTimeout(async () => {
    const seq = ++mention.seq;
    try {
      const options = await crmApi(`/leads/${encodeURIComponent(id)}/mentionable?q=${encodeURIComponent(q)}`);
      if (seq !== mention.seq) return;
      mention.options = options;
      mention.active = 0;
      renderMentions();
    } catch {
      closeMentions();
    }
  }, 200);
  return undefined;
}
function pickMention(index) {
  const m = mention.options[index];
  const input = document.getElementById("noteInput");
  if (!m) return;
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret).replace(/@([^\s@]{0,30})$/u, `@${m.name} `);
  input.value = before + input.value.slice(caret);
  input.setSelectionRange(before.length, before.length);
  mention.picked.set(String(m.id), m.name);
  closeMentions();
  input.focus();
}
function onNoteKey(event) {
  if (mentionList().hidden) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    mention.active = (mention.active + (event.key === "ArrowDown" ? 1 : -1) + mention.options.length) % mention.options.length;
    renderMentions();
  } else if (event.key === "Enter") {
    event.preventDefault();
    event.stopImmediatePropagation();
    pickMention(mention.active);
  } else if (event.key === "Escape") {
    event.stopPropagation();
    closeMentions();
  }
}

async function addNoteToDeal() {
  const id = document.getElementById("editId").value;
  if (!id) return;
  const input = document.getElementById("noteInput");
  const text = input.value.trim();
  if (!text) return;
  const mentions = [...mention.picked].filter(([, name]) => text.includes(`@${name}`)).map(([memberId]) => memberId);
  try {
    await addLeadNote(id, text, mentions);
    mention.picked.clear();
    closeMentions();
    input.value = "";
    renderTimeline(getDeal(id));
    showToast(t("c360.noteAdded"), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, t("inbox.err.note")), "error");
  }
}

async function confirmDelete(id) {
  const deal = getDeal(id);
  if (!deal) return;
  if (!confirm(t("deals.confirmDelete", { name: deal.name }))) return;
  try {
    await removeLead(id);
    showToast(t("deals.deleted"), "success");
  } catch (error) {
    showToast(apiErrorMessage(error, t("deals.err.delete")), "error");
  }
  renderAll();
}

// ---------------------------------------------------------------
// Full render
// ---------------------------------------------------------------
let boardLoadedOnce = false;
function renderAll() {
  renderKpis();
  populateFilterOwners();
  if (currentView === "kanban") {
    renderKanban();
    if (boardLoadedOnce) refreshBoard(); // a save or a delete changed the deals
    boardLoadedOnce = Boolean(board);
  } else {
    renderTable();
  }
  renderTeamTab();
  renderTasksTab();
  renderCalendarTab();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  // Quotes too: the result is also used inside HTML attributes.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  requireAuth();
  renderSidebarUser();
  initSidebarToggle();

  crmReady(["leads", "members", "contacts", "tasks"], async () => {
    try {
      await loadPipelines();
      await loadBoard();
    } catch (error) {
      showToast(apiErrorMessage(error, t("pipe.loadFailed")), "error");
    }
    renderAll();
    openFromAddress((id) => {
      if (!getDeals().some((d) => d.id === id)) return false;
      openModal(id);
    });
  });
  // The pipeline picker (D84).
  document.querySelector(".nav-bar-kanban-card")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pipeline]");
    if (!button || String(button.dataset.pipeline) === String(pipelineId)) return;
    pipelineId = button.dataset.pipeline;
    setPreference("dealsPipeline", pipelineId);
    board = null;
    renderPipelinePicker();
    renderKanban();
    refreshBoard();
  });

  // Search & filters
  [
    "searchInput",
    "filterStage",
    "filterOwner",
    "filterMinValue",
    "filterMaxValue",
    "filterCloseDate",
  ].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => {
      currentView === "kanban" ? renderKanban() : renderTable();
    });
  });
  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    document.getElementById("searchInput").value = "";
    document.getElementById("filterStage").value = "all";
    document.getElementById("filterOwner").value = "all";
    document.getElementById("filterMinValue").value = "";
    document.getElementById("filterMaxValue").value = "";
    document.getElementById("filterCloseDate").value = "";
    currentView === "kanban" ? renderKanban() : renderTable();
  });

  // View toggle
  document.getElementById("viewKanbanBtn").addEventListener("click", () => {
    currentView = "kanban";
    document.getElementById("viewKanbanBtn").classList.add("active");
    document.getElementById("viewTableBtn").classList.remove("active");
    document.getElementById("kanbanView").style.display = "flex";
    document.getElementById("tableView").style.display = "none";
    renderKanban();
  });
  document.getElementById("viewTableBtn").addEventListener("click", () => {
    currentView = "table";
    document.getElementById("viewTableBtn").classList.add("active");
    document.getElementById("viewKanbanBtn").classList.remove("active");
    document.getElementById("tableView").style.display = "block";
    document.getElementById("kanbanView").style.display = "none";
    renderTable();
  });

  // Side panel tabs
  document.querySelectorAll(".side-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll(".side-tab")
        .forEach((t) => t.classList.remove("active"));
      document
        .querySelectorAll(".side-tab-content")
        .forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      document
        .querySelector(`[data-tab-content="${tab.dataset.tab}"]`)
        .classList.add("active");
    });
  });

  // Modal open/close
  document
    .getElementById("addBtn")
    .addEventListener("click", () => openModal(null));
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("cancelBtn").addEventListener("click", closeModal);
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "modalOverlay") closeModal();
  });

  // Probability slider live value
  document.getElementById("fProbability").addEventListener("input", (e) => {
    document.getElementById("fProbabilityValue").textContent =
      `${e.target.value}%`;
  });
  // Stage change suggests a default probability
  document.getElementById("fStage").addEventListener("change", (e) => {
    const suggested = STAGE_DEFAULT_PROB[e.target.value];
    document.getElementById("fProbability").value = suggested;
    document.getElementById("fProbabilityValue").textContent = `${suggested}%`;
  });

  // Notes, with the @ picker (D87) answering its keys before the note's own Enter.
  const noteInput = document.getElementById("noteInput");
  noteInput.addEventListener("keydown", onNoteKey, true);
  noteInput.addEventListener("input", onNoteInput);
  noteInput.setAttribute("aria-controls", "mentionList");
  mentionList().addEventListener("mousedown", (event) => {
    const option = event.target.closest("[data-mention]");
    if (!option) return;
    event.preventDefault();
    pickMention(Number(option.dataset.mention));
  });
  document
    .getElementById("addNoteBtn")
    .addEventListener("click", addNoteToDeal);
  document.getElementById("noteInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addNoteToDeal();
    }
  });

  // Delete from modal
  document.getElementById("deleteBtn").addEventListener("click", () => {
    const id = document.getElementById("editId").value;
    if (id) {
      closeModal();
      confirmDelete(id);
    }
  });

  // Save (create / update)
  document.getElementById("dealForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("editId").value;
    const name = document.getElementById("fName").value.trim();
    const account = document.getElementById("fAccount").value.trim();
    const contact = document.getElementById("fContact").value.trim();
    const closeDate = document.getElementById("fCloseDate").value;
    const stage = document.getElementById("fStage").value;

    if (!name || !account || !closeDate) {
      showToast(t("deals.required"), "error");
      return;
    }
    const existing = id ? getDeal(id) : null;
    const lostReason = stage === "Lost" && existing?.stage !== "Lost" ? askLostReason(name) : null;
    if (stage === "Lost" && existing?.stage !== "Lost" && !lostReason) return;

    const payload = {
      title: name,
      contact: { name: contact || account, company: account },
      expectedValuePaise: toPaise(document.getElementById("fValue").value) ?? 0,
      expectedCloseDate: closeDate,
      stage,
      ...(lostReason && { lostReason }),
      ownerId: document.getElementById("fOwner").value || null,
    };
    const customFieldsBox = document.getElementById("dealCustomFields");
    const customFields = cfRead(customFieldsBox);
    if (customFields) payload.customFields = customFields;
    try {
      if (id) await updateLeadRecord(id, payload);
      else await createLead(payload);
      showToast(t(id ? "deals.updated" : "deals.created"), "success");
    } catch (error) {
      showToast(cfShowErrors(customFieldsBox, error) ? t("cf.fixFields") : apiErrorMessage(error, t("deals.err.save")), "error");
      return;
    }
    closeModal();
    renderAll();
  });

  // Deep link support: Dashboard's "New Deal" / "+ New" quick actions land
  // here with ?new=1 — auto-open the New Deal modal, then clean the URL
  // so refreshing the page doesn't reopen it.
  const params = new URLSearchParams(window.location.search);
  if (params.get("new") === "1") {
    crmI18n.ready.then(() => openModal(null)); // its title comes from the texts
    window.history.replaceState({}, "", window.location.pathname);
  }
});