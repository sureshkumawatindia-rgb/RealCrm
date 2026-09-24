/**
 * calendar.js — Calendar module (month view)
 * Persists events to localStorage under 'crm_calendar_events'.
 * Also overlays due Tasks ('crm_tasks') and Deal close dates ('crm_deals')
 * as read-only chips so everything scheduled shows up in one place.
 * Reuses shared helpers from app.js (getAgents, getCustomers, getLeads,
 * getAccounts, showToast, renderSidebarUser, initSidebarToggle, requireAuth).
 */

requireAuth();
renderSidebarUser();

const EVENTS_KEY = "crm_calendar_events";
const EVENT_TYPES = [
  "Meeting",
  "Call",
  "Follow-up",
  "Demo",
  "Deadline",
  "Reminder",
];
const TYPE_DOT = {
  Meeting: "var(--info)",
  Call: "var(--brand-darker)",
  "Follow-up": "var(--warning)",
  Demo: "#7c3aed",
  Deadline: "var(--danger)",
  Reminder: "var(--success)",
};
const TYPE_CHIP_CLASS = {
  Meeting: "chip-meeting",
  Call: "chip-call",
  "Follow-up": "chip-followup",
  Demo: "chip-demo",
  Deadline: "chip-deadline",
  Reminder: "chip-reminder",
};

let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth(); // 0-indexed
let activeDayDate = null; // yyyy-mm-dd used when "Add Event" launched from day cell/agenda modal

// ---------------------------------------------------------------
// Storage — events
// ---------------------------------------------------------------
function getEvents() {
  const raw = localStorage.getItem(EVENTS_KEY);
  return raw ? JSON.parse(raw) : [];
}
function saveEvents(list) {
  localStorage.setItem(EVENTS_KEY, JSON.stringify(list));
}
function addEvent(ev) {
  const list = getEvents();
  ev.id =
    "ev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  ev.createdAt = new Date().toISOString();
  list.unshift(ev);
  saveEvents(list);
  return ev;
}
function updateEventRecord(id, patch) {
  const list = getEvents();
  const idx = list.findIndex((e) => e.id === id);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...patch };
    saveEvents(list);
  }
  return list[idx];
}
function deleteEventRecord(id) {
  saveEvents(getEvents().filter((e) => e.id !== id));
}
function getEvent(id) {
  return getEvents().find((e) => e.id === id);
}

// Read Tasks / Deals directly — their helpers live in tasks.js / deals.js,
// which aren't loaded on this page.
function readTasks() {
  const raw = localStorage.getItem("crm_tasks");
  return raw ? JSON.parse(raw) : [];
}
function readDeals() {
  const raw = localStorage.getItem("crm_deals");
  return raw ? JSON.parse(raw) : [];
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function pad2(n) {
  return String(n).padStart(2, "0");
}
function dateKey(y, m, d) {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}
function todayStr() {
  const t = new Date();
  return dateKey(t.getFullYear(), t.getMonth(), t.getDate());
}
function formatDateLong(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
function formatTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(m)} ${period}`;
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
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
function assigneeNames() {
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
function leadNames() {
  return getLeads()
    .map((l) => l.name)
    .filter(Boolean);
}
function dealNames() {
  return readDeals()
    .map((d) => d.name)
    .filter(Boolean);
}
function relatedOptionsForType(type) {
  switch (type) {
    case "Customer":
      return contactNames();
    case "Lead":
      return leadNames();
    case "Account":
      return accountNames();
    case "Deal":
      return dealNames();
    default:
      return [];
  }
}

// ---------------------------------------------------------------
// Filters (calendar grid + KPI honor these)
// ---------------------------------------------------------------
function activeType() {
  return document.getElementById("filterType").value;
}
function activeAssignee() {
  return document.getElementById("filterAssignee").value;
}

function getFilteredEvents() {
  const type = activeType();
  const assignee = activeAssignee();
  return getEvents().filter((e) => {
    if (type !== "all" && e.type !== type) return false;
    if (assignee !== "all" && e.assignee !== assignee) return false;
    return true;
  });
}
function getFilteredTasks() {
  const assignee = activeAssignee();
  return readTasks().filter((t) => {
    if (!t.dueDate) return false;
    if (assignee !== "all" && t.assignee !== assignee) return false;
    return true;
  });
}
function getFilteredDeals() {
  const assignee = activeAssignee();
  return readDeals().filter((d) => {
    if (!d.closeDate) return false;
    if (assignee !== "all" && d.owner !== assignee) return false;
    return true;
  });
}

// ---------------------------------------------------------------
// Day items — merge events + tasks + deals for a given date
// ---------------------------------------------------------------
function itemsForDate(dateStr) {
  const events = getFilteredEvents()
    .filter((e) => e.date === dateStr)
    .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""))
    .map((e) => ({ kind: "event", data: e }));

  const tasks = getFilteredTasks()
    .filter((t) => t.dueDate === dateStr)
    .map((t) => ({ kind: "task", data: t }));

  const deals = getFilteredDeals()
    .filter(
      (d) => d.closeDate === dateStr && d.stage !== "Won" && d.stage !== "Lost",
    )
    .map((d) => ({ kind: "deal", data: d }));

  return [...events, ...tasks, ...deals];
}

function chipHtml(item) {
  if (item.kind === "event") {
    const e = item.data;
    const label = e.startTime
      ? `${formatTime(e.startTime)} ${e.title}`
      : e.title;
    return `<div class="day-chip ${TYPE_CHIP_CLASS[e.type]}" data-kind="event" data-id="${e.id}" title="${escapeHtml(e.title)}"><i class="fa-solid fa-circle"></i>${escapeHtml(label)}</div>`;
  }
  if (item.kind === "task") {
    const t = item.data;
    const overdue = t.status !== "Done" && t.dueDate < todayStr();
    return `<div class="day-chip chip-task ${overdue ? "overdue" : ""}" data-kind="task" data-id="${t.id}" title="Task: ${escapeHtml(t.title)}"><i class="fa-solid fa-list-check"></i>${escapeHtml(t.title)}</div>`;
  }
  const d = item.data;
  return `<div class="day-chip chip-deal" data-kind="deal" data-id="${d.id}" title="Deal close: ${escapeHtml(d.name)}"><i class="fa-solid fa-handshake"></i>${escapeHtml(d.name)}</div>`;
}

// ---------------------------------------------------------------
// KPI cards (based on unfiltered real data)
// ---------------------------------------------------------------
function renderKpis() {
  const events = getEvents();
  const tasks = readTasks();
  const today = todayStr();

  const todayEvents = events.filter((e) => e.date === today);

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const weekStartStr = dateKey(
    weekStart.getFullYear(),
    weekStart.getMonth(),
    weekStart.getDate(),
  );
  const weekEndStr = dateKey(
    weekEnd.getFullYear(),
    weekEnd.getMonth(),
    weekEnd.getDate(),
  );
  const thisWeekEvents = events.filter(
    (e) => e.date >= weekStartStr && e.date <= weekEndStr,
  );

  const overdueTasks = tasks.filter(
    (t) => t.dueDate && t.dueDate < today && t.status !== "Done",
  );
  const upcomingEvents = events.filter((e) => e.date >= today);

  const cards = [
    { label: "Today's Events", value: todayEvents.length, cls: "info" },
    { label: "This Week", value: thisWeekEvents.length, cls: "" },
    { label: "Overdue Tasks", value: overdueTasks.length, cls: "warning" },
    { label: "Upcoming Events", value: upcomingEvents.length, cls: "success" },
  ];

  document.getElementById("kpiGrid").innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card ${c.cls}">
        <div class="label">${c.label}</div>
        <div class="value">${c.value}</div>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------
function renderCalendar() {
  document.getElementById("monthLabel").textContent = new Date(
    viewYear,
    viewMonth,
    1,
  ).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const firstDay = new Date(viewYear, viewMonth, 1);
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();
  const leading = firstDay.getDay();
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;

  const today = todayStr();
  const cells = [];

  for (let i = 0; i < totalCells; i++) {
    let y = viewYear,
      m = viewMonth,
      d,
      otherMonth = false;
    if (i < leading) {
      m = viewMonth - 1;
      y = m < 0 ? viewYear - 1 : viewYear;
      m = (m + 12) % 12;
      d = daysInPrevMonth - leading + i + 1;
      otherMonth = true;
    } else if (i >= leading + daysInMonth) {
      m = viewMonth + 1;
      y = m > 11 ? viewYear + 1 : viewYear;
      m = m % 12;
      d = i - leading - daysInMonth + 1;
      otherMonth = true;
    } else {
      d = i - leading + 1;
    }
    cells.push({ y, m, d, otherMonth });
  }

  const grid = document.getElementById("calendarGrid");
  grid.innerHTML = cells
    .map(({ y, m, d, otherMonth }) => {
      const dateStr = dateKey(y, m, d);
      const items = itemsForDate(dateStr);
      const visible = items.slice(0, 3);
      const extra = items.length - visible.length;

      return `
      <div class="calendar-cell ${otherMonth ? "other-month" : ""} ${dateStr === today ? "is-today" : ""}" data-date="${dateStr}">
        <span class="day-number">${d}</span>
        <button type="button" class="day-add" data-date="${dateStr}" title="Add event"><i class="fa-solid fa-plus"></i></button>
        ${visible.map((it) => chipHtml(it)).join("")}
        ${extra > 0 ? `<div class="day-chip-more">+${extra} more</div>` : ""}
      </div>`;
    })
    .join("");

  attachGridEvents();
}

function attachGridEvents() {
  document.querySelectorAll(".calendar-cell").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      if (e.target.closest(".day-chip") || e.target.closest(".day-add")) return;
      const dateStr = cell.dataset.date;
      const items = itemsForDate(dateStr);
      if (items.length > 0) {
        openDayAgenda(dateStr, items);
      } else {
        openModal(null, dateStr);
      }
    });
  });

  document.querySelectorAll(".day-add").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal(null, btn.dataset.date);
    }),
  );

  document.querySelectorAll('.day-chip[data-kind="event"]').forEach((chip) =>
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal(chip.dataset.id);
    }),
  );
  document.querySelectorAll('.day-chip[data-kind="task"]').forEach((chip) =>
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      showToast("Task details open on the Tasks page", "info");
      window.location.href = "Tasks.html";
    }),
  );
  document.querySelectorAll('.day-chip[data-kind="deal"]').forEach((chip) =>
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      showToast("Lead pipeline details open on the Leads page", "info");
      window.location.href = "leads.html?focus=pipeline";
    }),
  );
}

// ---------------------------------------------------------------
// Day agenda modal
// ---------------------------------------------------------------
function openDayAgenda(dateStr, items) {
  activeDayDate = dateStr;
  document.getElementById("dayModalTitle").textContent =
    formatDateLong(dateStr);

  const list = document.getElementById("dayAgendaList");
  list.innerHTML = items
    .map((it) => {
      if (it.kind === "event") {
        const e = it.data;
        return `
        <div class="day-agenda-item" data-kind="event" data-id="${e.id}">
          <span class="dot" style="background:${TYPE_DOT[e.type]}"></span>
          <div class="info">
            <div class="title">${escapeHtml(e.title)}</div>
            <div class="meta">${e.type}${e.startTime ? " · " + formatTime(e.startTime) : ""}${e.assignee ? " · " + escapeHtml(e.assignee) : ""}</div>
          </div>
        </div>`;
      }
      if (it.kind === "task") {
        const t = it.data;
        return `
        <div class="day-agenda-item" data-kind="task">
          <span class="dot" style="background:var(--text-faint)"></span>
          <div class="info">
            <div class="title">${escapeHtml(t.title)}</div>
            <div class="meta">Task · ${t.priority} priority${t.assignee ? " · " + escapeHtml(t.assignee) : ""}</div>
          </div>
        </div>`;
      }
      const d = it.data;
      return `
      <div class="day-agenda-item" data-kind="deal">
        <span class="dot" style="background:var(--brand-darker)"></span>
        <div class="info">
          <div class="title">${escapeHtml(d.name)}</div>
          <div class="meta">Deal close · ${d.stage}${d.owner ? " · " + escapeHtml(d.owner) : ""}</div>
        </div>
      </div>`;
    })
    .join("");

  list.querySelectorAll('.day-agenda-item[data-kind="event"]').forEach((row) =>
    row.addEventListener("click", () => {
      closeDayModal();
      openModal(row.dataset.id);
    }),
  );
  list.querySelectorAll('.day-agenda-item[data-kind="task"]').forEach((row) =>
    row.addEventListener("click", () => {
      window.location.href = "Tasks.html";
    }),
  );
  list.querySelectorAll('.day-agenda-item[data-kind="deal"]').forEach((row) =>
    row.addEventListener("click", () => {
      window.location.href = "leads.html?focus=pipeline";
    }),
  );

  document.getElementById("dayModalOverlay").classList.add("open");
}
function closeDayModal() {
  document.getElementById("dayModalOverlay").classList.remove("open");
}

// ---------------------------------------------------------------
// Assignee picker (button + dropdown, pulls Account Champions agents)
// ---------------------------------------------------------------
function setAssigneeValue(name, role) {
  document.getElementById("fAssignee").value = name || "";
  const avatarEl = document.getElementById("assigneeTriggerAvatar");
  const labelEl = document.getElementById("assigneeTriggerLabel");
  if (name) {
    avatarEl.textContent = initials(name);
    labelEl.textContent = role ? `${name} · ${role}` : name;
    labelEl.classList.remove("is-placeholder");
  } else {
    avatarEl.textContent = "?";
    labelEl.textContent = "Select agent";
    labelEl.classList.add("is-placeholder");
  }
}
function buildAssigneeMenu() {
  const menu = document.getElementById("assigneeMenu");
  const agents = getAgents();
  const selected = document.getElementById("fAssignee").value;

  if (!agents.length) {
    menu.innerHTML = `<div class="assignee-picker__empty">No agents yet. Add one from <a href="accounts.html">Account Champions</a>.</div>`;
    return;
  }

  menu.innerHTML = agents
    .map(
      (a) => `
      <div class="assignee-picker__item ${a.name === selected ? "selected" : ""}" data-name="${escapeHtml(a.name)}" data-role="${escapeHtml(a.role || "")}">
        <span class="avatar">${initials(a.name)}</span>
        <div class="info">
          <div class="name">${escapeHtml(a.name)}</div>
          <div class="role">${escapeHtml(a.role || "Agent")}</div>
        </div>
        <i class="fa-solid fa-check check"></i>
      </div>`,
    )
    .join("");

  menu.querySelectorAll(".assignee-picker__item").forEach((item) =>
    item.addEventListener("click", () => {
      setAssigneeValue(item.dataset.name, item.dataset.role);
      closeAssigneeMenu();
    }),
  );
}
function openAssigneeMenu() {
  buildAssigneeMenu();
  document.getElementById("assigneePicker").classList.add("open");
}
function closeAssigneeMenu() {
  document.getElementById("assigneePicker").classList.remove("open");
}
function toggleAssigneeMenu() {
  const picker = document.getElementById("assigneePicker");
  picker.classList.contains("open") ? closeAssigneeMenu() : openAssigneeMenu();
}
document.getElementById("assigneeTrigger").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleAssigneeMenu();
});
document.addEventListener("click", (e) => {
  const picker = document.getElementById("assigneePicker");
  if (picker.classList.contains("open") && !picker.contains(e.target)) {
    closeAssigneeMenu();
  }
});

// ---------------------------------------------------------------
// Filter dropdown population
// ---------------------------------------------------------------
function populateFilterAssignee() {
  const sel = document.getElementById("filterAssignee");
  const current = sel.value;
  sel.innerHTML =
    `<option value="all">All Agents</option>` +
    assigneeNames()
      .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
      .join("");
  sel.value = current || "all";
}
function populateRelatedOptions(type) {
  document.getElementById("relatedOptions").innerHTML = relatedOptionsForType(
    type,
  )
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

// ---------------------------------------------------------------
// Right panel — Upcoming
// ---------------------------------------------------------------
function renderUpcomingTab() {
  const today = todayStr();
  const events = getEvents()
    .filter((e) => e.date >= today)
    .map((e) => ({ kind: "event", date: e.date, data: e }));
  const tasks = readTasks()
    .filter((t) => t.dueDate && t.dueDate >= today && t.status !== "Done")
    .map((t) => ({ kind: "task", date: t.dueDate, data: t }));
  const deals = readDeals()
    .filter(
      (d) =>
        d.closeDate &&
        d.closeDate >= today &&
        d.stage !== "Won" &&
        d.stage !== "Lost",
    )
    .map((d) => ({ kind: "deal", date: d.closeDate, data: d }));

  const merged = [...events, ...tasks, ...deals]
    .sort((a, b) => (a.date > b.date ? 1 : -1))
    .slice(0, 10);

  const el = document.getElementById("upcomingTabContent");
  if (!merged.length) {
    el.innerHTML = `<div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-calendar-check"></i><div>Nothing scheduled yet.</div></div>`;
    return;
  }

  el.innerHTML = merged
    .map((it) => {
      const dt = new Date(it.date + "T00:00:00");
      const d = dt.getDate();
      const m = dt.toLocaleDateString("en-IN", { month: "short" });
      let name, sub;
      if (it.kind === "event") {
        name = it.data.title;
        sub = `${it.data.type}${it.data.startTime ? " · " + formatTime(it.data.startTime) : ""}`;
      } else if (it.kind === "task") {
        name = it.data.title;
        sub = `Task · ${it.data.priority} priority`;
      } else {
        name = it.data.name;
        sub = `Deal close · ${it.data.stage}`;
      }
      return `
        <div class="agenda-row" data-kind="${it.kind}" data-id="${it.data.id}">
          <div class="agenda-date-chip"><span class="d">${d}</span><span class="m">${m}</span></div>
          <div class="info">
            <div class="name">${escapeHtml(name)}</div>
            <div class="sub">${escapeHtml(sub)}</div>
          </div>
        </div>`;
    })
    .join("");

  el.querySelectorAll('.agenda-row[data-kind="event"]').forEach((row) =>
    row.addEventListener("click", () => openModal(row.dataset.id)),
  );
  el.querySelectorAll('.agenda-row[data-kind="task"]').forEach((row) =>
    row.addEventListener("click", () => (window.location.href = "Tasks.html")),
  );
  el.querySelectorAll('.agenda-row[data-kind="deal"]').forEach((row) =>
    row.addEventListener("click", () => (window.location.href = "leads.html?focus=pipeline")),
  );
}

// ---------------------------------------------------------------
// Right panel — Team workload
// ---------------------------------------------------------------
function renderTeamTab() {
  const agents = getAgents();
  const events = getEvents();
  const el = document.getElementById("teamTabContent");

  if (!agents.length) {
    el.innerHTML = `<div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-user-group"></i><div>No agents yet.</div></div>`;
    return;
  }

  const today = todayStr();
  el.innerHTML = agents
    .map((a) => {
      const upcoming = events.filter(
        (e) => e.assignee === a.name && e.date >= today,
      ).length;
      return `
        <div class="team-member-row">
          <div class="avatar">${initials(a.name)}</div>
          <div class="info">
            <div class="name">${escapeHtml(a.name)}</div>
            <div class="sub">${escapeHtml(a.role || "Agent")}</div>
          </div>
          <span class="count">${upcoming}</span>
        </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Modal — add / edit event
// ---------------------------------------------------------------
function openModal(id, prefillDate) {
  const overlay = document.getElementById("modalOverlay");
  const form = document.getElementById("eventForm");
  form.reset();
  closeAssigneeMenu();
  populateRelatedOptions(document.getElementById("fRelatedType").value);

  const deleteBtn = document.getElementById("deleteBtn");

  if (id) {
    const ev = getEvent(id);
    if (!ev) return;
    document.getElementById("modalTitle").textContent = "Edit Event";
    document.getElementById("editId").value = ev.id;
    document.getElementById("fTitle").value = ev.title;
    document.getElementById("fType").value = ev.type;
    document.getElementById("fDate").value = ev.date;
    document.getElementById("fStartTime").value = ev.startTime || "";
    document.getElementById("fEndTime").value = ev.endTime || "";
    const agent = getAgents().find((a) => a.name === ev.assignee);
    setAssigneeValue(ev.assignee || "", agent ? agent.role : "");
    document.getElementById("fRelatedType").value = ev.relatedType || "";
    populateRelatedOptions(ev.relatedType || "");
    document.getElementById("fRelatedName").value = ev.relatedName || "";
    document.getElementById("fDescription").value = ev.description || "";
    deleteBtn.style.display = "inline-flex";
  } else {
    document.getElementById("modalTitle").textContent = "New Event";
    document.getElementById("editId").value = "";
    document.getElementById("fType").value = "Meeting";
    document.getElementById("fDate").value =
      prefillDate || activeDayDate || todayStr();
    setAssigneeValue("", "");
    deleteBtn.style.display = "none";
  }

  overlay.classList.add("open");
}
function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
}
function confirmDelete(id) {
  const ev = getEvent(id);
  if (!ev) return;
  if (confirm(`Delete "${ev.title}"? This can't be undone.`)) {
    deleteEventRecord(id);
    showToast("Event deleted", "success");
    renderAll();
  }
}

// ---------------------------------------------------------------
// Full render
// ---------------------------------------------------------------
function renderAll() {
  renderKpis();
  populateFilterAssignee();
  renderCalendar();
  renderUpcomingTab();
  renderTeamTab();
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
initSidebarToggle();
renderAll();

document.getElementById("prevMonthBtn").addEventListener("click", () => {
  viewMonth -= 1;
  if (viewMonth < 0) {
    viewMonth = 11;
    viewYear -= 1;
  }
  renderCalendar();
});
document.getElementById("nextMonthBtn").addEventListener("click", () => {
  viewMonth += 1;
  if (viewMonth > 11) {
    viewMonth = 0;
    viewYear += 1;
  }
  renderCalendar();
});
document.getElementById("todayBtn").addEventListener("click", () => {
  const t = new Date();
  viewYear = t.getFullYear();
  viewMonth = t.getMonth();
  renderCalendar();
});

document
  .getElementById("filterType")
  .addEventListener("change", renderCalendar);
document
  .getElementById("filterAssignee")
  .addEventListener("change", renderCalendar);

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

// Add / Edit modal open-close
document
  .getElementById("addBtn")
  .addEventListener("click", () => openModal(null));
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
document.getElementById("modalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});

// Day agenda modal open-close
document
  .getElementById("dayModalClose")
  .addEventListener("click", closeDayModal);
document
  .getElementById("dayModalCloseBtn")
  .addEventListener("click", closeDayModal);
document.getElementById("dayModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "dayModalOverlay") closeDayModal();
});
document.getElementById("dayModalAddBtn").addEventListener("click", () => {
  closeDayModal();
  openModal(null, activeDayDate);
});

// Related type change -> refresh related record suggestions
document.getElementById("fRelatedType").addEventListener("change", (e) => {
  populateRelatedOptions(e.target.value);
  document.getElementById("fRelatedName").value = "";
  document.getElementById("fRelatedName").placeholder = e.target.value
    ? `Select a ${e.target.value.toLowerCase()}...`
    : "Select a type first";
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
document.getElementById("eventForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("editId").value;
  const payload = {
    title: document.getElementById("fTitle").value.trim(),
    type: document.getElementById("fType").value,
    date: document.getElementById("fDate").value,
    startTime: document.getElementById("fStartTime").value,
    endTime: document.getElementById("fEndTime").value,
    assignee: document.getElementById("fAssignee").value,
    relatedType: document.getElementById("fRelatedType").value,
    relatedName: document.getElementById("fRelatedName").value.trim(),
    description: document.getElementById("fDescription").value.trim(),
  };

  if (!payload.title || !payload.date) {
    showToast("Please fill in all required fields", "error");
    return;
  }
  if (!payload.relatedType) payload.relatedName = "";

  if (id) {
    updateEventRecord(id, payload);
    showToast("Event updated", "success");
  } else {
    addEvent(payload);
    showToast("Event created", "success");
  }
  closeModal();
  renderAll();
});

// ---------------------------------------------------------------
// Deep link support: Dashboard's "New Event" / "+ New" quick actions
// land here with ?new=1 — auto-open the New Event modal, then clean
// the URL so refreshing the page doesn't reopen it.
// ---------------------------------------------------------------
(function handleQuickAddDeepLink() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("new") === "1") {
    openModal(null);
    window.history.replaceState({}, "", window.location.pathname);
  }
})();