/**
 * dashboard.js — Overview dashboard
 * Reads across every module's server data (through app.js) and renders a single
 * at-a-glance view. Reuses shared helpers from app.js (getCustomers,
 * getLeads, getAgents, getProducts, showToast, renderSidebarUser,
 * initSidebarToggle, requireAuth); the read* functions below wrap the
 * getters for deals, tasks, events and campaigns.
 */

requireAuth();
renderSidebarUser();
initSidebarToggle();

const STAGE_DOT = {
  New: "var(--info)",
  Contacted: "var(--brand-darker)",
  "Quote Sent": "var(--warning)",
  Negotiation: "#7c3aed",
  Won: "var(--success)",
  Lost: "var(--danger)",
};
const CAMPAIGN_STATUS_TAG = {
  Draft: "badge-neutral",
  Scheduled: "badge-info",
  Active: "badge-success",
  Paused: "badge-warning",
  Completed: "badge-brand",
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  // Quotes too: the result is also used inside HTML attributes.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
function formatCurrency(n) {
  const num = Number(n) || 0;
  return "₹" + num.toLocaleString("en-IN");
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function statusBadge(status) {
  const map = {
    New: "badge-info",
    Contacted: "badge-warning",
    "Quote Sent": "badge-brand",
    Negotiation: "badge-warning",
    Won: "badge-success",
    Lost: "badge-danger",
    Active: "badge-success",
    Inactive: "badge-neutral",
  };
  return `<span class="badge ${map[status] || "badge-neutral"}">${escapeHtml(status)}</span>`;
}

// ---------------------------------------------------------------
// Page-local names for the shared getters
// ---------------------------------------------------------------
function readDeals() {
  return getDeals();
}
function readTasks() {
  return getTasks();
}
function readEvents() {
  return getEvents();
}
function readCampaigns() {
  return getCampaigns();
}

// ---------------------------------------------------------------
// Header
// ---------------------------------------------------------------
function renderHeader() {
  const user = getCurrentUser();
  const firstName = (user?.name || "").split(" ")[0];
  document.getElementById("greetingHeading").textContent = firstName
    ? `Welcome back, ${firstName}`
    : "Dashboard";
  document.getElementById("topbarDate").textContent =
    new Date().toLocaleDateString("en-IN", {
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
}

// ---------------------------------------------------------------
// Header quick actions — "New Deal" button + "+ New" dropdown
// (Deal / Lead / Task / Event). Each option jumps to the owning
// module with ?new=1 so that page auto-opens its "New" modal.
// ---------------------------------------------------------------
const QUICK_ADD_DESTINATIONS = {
  lead: "leads.html",
  task: "Tasks.html",
  event: "Calendar.html",
};

function goToQuickAdd(target) {
  const page = QUICK_ADD_DESTINATIONS[target];
  if (!page) return;
  window.location.href = `${page}?new=1`;
}

function initQuickActions() {
  const dealBtn = document.getElementById("quickDealBtn");
  const picker = document.getElementById("quickAddPicker");
  const trigger = document.getElementById("quickAddTrigger");
  const menu = document.getElementById("quickAddMenu");
  if (!dealBtn || !picker || !trigger || !menu) return;

  dealBtn.addEventListener("click", () => goToQuickAdd("lead"));

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    picker.classList.toggle("open");
  });

  menu.querySelectorAll("button[data-target]").forEach((btn) => {
    btn.addEventListener("click", () => goToQuickAdd(btn.dataset.target));
  });

  document.addEventListener("click", (e) => {
    if (picker.classList.contains("open") && !picker.contains(e.target)) {
      picker.classList.remove("open");
    }
  });
}

// ---------------------------------------------------------------
// KPI row (Phase 9): counted on the server from every record (GET /reports/dashboard);
// the older counts from the loaded records stay as a fallback.
// ---------------------------------------------------------------
function formatWait(minutes) {
  if (minutes == null) return "";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}
async function renderServerKpis() {
  let d;
  try {
    d = await crmApi("/reports/dashboard");
  } catch {
    return; // the cards from the loaded records stay
  }
  const money = (paise) => formatCurrency(Math.round((paise || 0) / 100));
  const cards = [
    {
      label: "Chats waiting for a reply", value: d.chats.waitingForReply, route: "Inbox.html",
      sub: d.chats.waitingForReply ? `longest ${formatWait(d.chats.longestWaitMinutes)} · ${d.chats.unassigned} not taken` : "all answered",
      cls: d.chats.longestWaitMinutes > 120 ? "warning" : "",
    },
    { label: "New leads today", value: d.leads.today, sub: `${d.leads.month} this month · ${d.leads.wonMonth} won`, cls: "info", route: "leads.html" },
    { label: "Open pipeline", value: money(d.pipeline.valuePaise), sub: `${d.pipeline.open} open leads`, cls: "success", route: "Deals.html" },
    { label: "Quotes waiting 3+ days", value: d.quotations.waitingThreeDays, sub: "sent, no answer yet", cls: d.quotations.waitingThreeDays ? "warning" : "", route: "leads.html" },
    { label: "Collected this month", value: money(d.payments.collectedMonthPaise), sub: "payments received", cls: "success", route: "Reports & Analytics.html" },
    { label: "Due now", value: money(d.payments.duePaise), sub: `${d.payments.dueOrders} order${d.payments.dueOrders === 1 ? "" : "s"}`, cls: d.payments.duePaise ? "warning" : "", route: "Orders.html?tab=dues" },
    { label: "Tasks due today", value: d.tasks.dueToday, sub: d.tasks.overdue ? `${d.tasks.overdue} overdue` : "none overdue", cls: d.tasks.overdue ? "warning" : "", route: "Tasks.html" },
  ];
  document.getElementById("kpiGrid").innerHTML = cards
    .map((c) => `
      <a href="${escapeHtml(c.route)}" class="stat-card stat-card-link ${c.cls}" aria-label="Open ${escapeHtml(c.label)}">
        <div class="label">${escapeHtml(c.label)}</div>
        <div class="value">${escapeHtml(String(c.value))}</div>
        <div class="label" style="text-transform:none;letter-spacing:0;margin-top:4px;font-weight:500">${escapeHtml(c.sub)}${d.scope === "own" ? " · yours" : ""}</div>
      </a>`)
    .join("");
}

function renderKpis() {
  const customers = getCustomers();
  const leads = getLeads();
  const deals = readDeals();
  const tasks = readTasks();
  const events = readEvents();
  const agents = getAgents();
  const products = getProducts();

  const today = todayStr();
  const openDeals = deals.filter(
    (d) => d.stage !== "Won" && d.stage !== "Lost",
  );
  const pipelineValue = openDeals.reduce((s, d) => s + Number(d.value || 0), 0);
  const tasksDueToday = tasks.filter(
    (t) => t.dueDate === today && t.status !== "Done",
  );
  const overdueTasks = tasks.filter(
    (t) => t.dueDate && t.dueDate < today && t.status !== "Done",
  );
  const upcomingEvents = events.filter((e) => e.date >= today);

  const cards = [
    { label: "Total Customers", value: customers.length, cls: "", route: "customers.html" },
    { label: "Total Leads", value: leads.length, cls: "info", route: "leads.html" },
    {
      label: "Open Pipeline",
      value: `${openDeals.length} · ${formatCurrency(pipelineValue)}`,
      cls: "success",
      route: "Deals.html",
    },
    {
      label: "Tasks Due Today",
      value: tasksDueToday.length,
      cls: overdueTasks.length ? "warning" : "",
      route: "Tasks.html",
    },
    { label: "Upcoming Events", value: upcomingEvents.length, cls: "info", route: "Calendar.html" },
    { label: "Total Products", value: products.length, cls: "", route: "Products.html" },
    { label: "Team Agents", value: agents.length, cls: "", route: "accounts.html" },
  ];

  document.getElementById("kpiGrid").innerHTML = cards
    .map((c) => {
      const cardContent = `
        <div class="label">${c.label}</div>
        <div class="value">${c.value}</div>`;

      if (c.route) {
        return `
          <a href="${c.route}" class="stat-card stat-card-link ${c.cls}" aria-label="Open ${c.label}">
            ${cardContent}
          </a>`;
      }

      return `
        <div class="stat-card ${c.cls}">
          ${cardContent}
        </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Pipeline by stage
// ---------------------------------------------------------------
function renderPipeline() {
  const deals = readDeals();
  const el = document.getElementById("pipelineBars");

  if (!deals.length) {
    el.innerHTML = `<div class="pipeline-empty"><i class="fa-solid fa-handshake"></i>No deals yet. Add one from the Deals page.</div>`;
    return;
  }

  const stages = LEAD_STAGES;
  const maxValue = Math.max(
    ...stages.map((s) =>
      deals
        .filter((d) => d.stage === s)
        .reduce((sum, d) => sum + Number(d.value || 0), 0),
    ),
    1,
  );

  el.innerHTML = stages
    .map((stage) => {
      const stageDeals = deals.filter((d) => d.stage === stage);
      const total = stageDeals.reduce((s, d) => s + Number(d.value || 0), 0);
      const p = Math.max(4, Math.round((total / maxValue) * 100));
      return `
        <div class="pipeline-row">
          <div class="stage-label">${stage}</div>
          <div class="stage-track">
            <div class="stage-fill" style="width:${p}%;background:${STAGE_DOT[stage]}"></div>
          </div>
          <div class="stage-meta"><strong>${stageDeals.length}</strong> deal${stageDeals.length === 1 ? "" : "s"} · ${formatCurrency(total)}</div>
        </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Recent leads
// ---------------------------------------------------------------
function renderRecentLeads() {
  const leads = getLeads();
  const products = getProducts();
  const container = document.getElementById("recentLeadsTable");
  const recent = leads.slice(0, 5);

  if (!recent.length) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No leads yet. Add one from the Leads page.</p></div>`;
    return;
  }

  const productName = (id) => {
    if (!id) return "—";
    const p = products.find((pr) => pr.id === id);
    return p ? p.name : "—";
  };

  container.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Company</th><th>Product</th><th>Status</th><th>Value</th></tr></thead>
      <tbody>
        ${recent
          .map(
            (l) => `
          <tr>
            <td>${escapeHtml(l.name)}</td>
            <td>${escapeHtml(l.company || "—")}</td>
            <td>${escapeHtml(productName(l.product))}</td>
            <td>${statusBadge(l.status)}</td>
            <td>${l.value ? formatCurrency(l.value) : "—"}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

// ---------------------------------------------------------------
// Active campaigns (Marketing module)
// ---------------------------------------------------------------
function renderCampaigns() {
  const campaigns = readCampaigns()
    .filter((c) => c.status === "Active" || c.status === "Scheduled")
    .slice(0, 5);
  const el = document.getElementById("campaignsList");

  if (!campaigns.length) {
    el.innerHTML = `<div class="mini-empty"><i class="fa-solid fa-bullhorn"></i>No active campaigns. Create one from the Marketing page.</div>`;
    return;
  }

  el.innerHTML = campaigns
    .map(
      (c) => `
      <div class="mini-row" data-nav="./Marketing.html">
        <span class="mini-icon brand"><i class="fa-solid fa-bullhorn"></i></span>
        <div class="info">
          <div class="name">${escapeHtml(c.name)}</div>
          <div class="sub">${escapeHtml(c.type || "Campaign")} · ${c.budget ? formatCurrency(c.budget) : "No budget set"}</div>
        </div>
        <div class="mini-right"><span class="badge ${CAMPAIGN_STATUS_TAG[c.status] || "badge-neutral"}">${c.status}</span></div>
      </div>`,
    )
    .join("");

  attachNav(el);
}

// ---------------------------------------------------------------
// Today's tasks
// ---------------------------------------------------------------
function renderTodayTasks() {
  const today = todayStr();
  const tasks = readTasks()
    .filter(
      (t) =>
        t.status !== "Done" &&
        (t.dueDate === today || (t.dueDate && t.dueDate < today)),
    )
    .sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1))
    .slice(0, 6);
  const el = document.getElementById("todayTasksList");

  if (!tasks.length) {
    el.innerHTML = `<div class="mini-empty"><i class="fa-solid fa-circle-check"></i>Nothing due today. You're all caught up.</div>`;
    return;
  }

  el.innerHTML = tasks
    .map((t) => {
      const overdue = t.dueDate < today;
      return `
      <div class="mini-row" data-nav="./Tasks.html">
        <span class="mini-icon ${overdue ? "warning" : "info"}"><i class="fa-solid fa-list-check"></i></span>
        <div class="info">
          <div class="name">${escapeHtml(t.title)}</div>
          <div class="sub">${escapeHtml(t.assignee || "Unassigned")} · ${t.priority} priority</div>
        </div>
        <div class="mini-right"><span class="mini-tag" style="color:${overdue ? "var(--danger)" : "var(--text-faint)"}">${overdue ? "Overdue" : "Today"}</span></div>
      </div>`;
    })
    .join("");

  attachNav(el);
}

// ---------------------------------------------------------------
// Upcoming events
// ---------------------------------------------------------------
function renderUpcomingEvents() {
  const today = todayStr();
  const events = readEvents()
    .filter((e) => e.date >= today)
    .sort((a, b) => (a.date > b.date ? 1 : -1))
    .slice(0, 6);
  const el = document.getElementById("upcomingEventsList");

  if (!events.length) {
    el.innerHTML = `<div class="mini-empty"><i class="fa-solid fa-calendar-days"></i>Nothing scheduled. Add an event from the Calendar page.</div>`;
    return;
  }

  el.innerHTML = events
    .map((e) => {
      const dt = new Date(e.date + "T00:00:00");
      const label = dt.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
      });
      return `
      <div class="mini-row" data-nav="./Calendar.html">
        <span class="mini-icon info"><i class="fa-solid fa-calendar-day"></i></span>
        <div class="info">
          <div class="name">${escapeHtml(e.title)}</div>
          <div class="sub">${escapeHtml(e.type)}${e.assignee ? " · " + escapeHtml(e.assignee) : ""}</div>
        </div>
        <div class="mini-right"><span class="mini-tag" style="color:var(--text-faint)">${label}</span></div>
      </div>`;
    })
    .join("");

  attachNav(el);
}

// ---------------------------------------------------------------
// Products snapshot
// ---------------------------------------------------------------
function renderProductsList() {
  const products = getProducts().slice(0, 6);
  const leads = getLeads();
  const el = document.getElementById("productsList");

  if (!products.length) {
    el.innerHTML = `<div class="mini-empty"><i class="fa-solid fa-box-open"></i>No products yet. Add one from the Leads page or Products page.</div>`;
    return;
  }

  el.innerHTML = products
    .map((p) => {
      const count = leads.filter((l) => l.product === p.id).length;
      const qty =
        p.quantity === "" || p.quantity == null ? null : Number(p.quantity);
      const qtyLabel = qty === null ? "" : ` · Qty: ${qty}`;
      return `
      <div class="mini-row" data-nav="./Products.html">
        <span class="mini-icon brand"><i class="fa-solid fa-box-open"></i></span>
        <div class="info">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="sub">${escapeHtml(p.category || "Product")}${p.price ? " · " + formatCurrency(p.price) : ""}${qtyLabel} · ${count} lead${count === 1 ? "" : "s"}</div>
        </div>
      </div>`;
    })
    .join("");

  attachNav(el);
}

// ---------------------------------------------------------------
// Team workload
// ---------------------------------------------------------------
function renderTeamWorkload() {
  const agents = getAgents();
  const deals = readDeals();
  const tasks = readTasks();
  const el = document.getElementById("teamWorkloadList");

  if (!agents.length) {
    el.innerHTML = `<div class="mini-empty"><i class="fa-solid fa-user-group"></i>No agents yet. Add one from Account Champions.</div>`;
    return;
  }

  const withLoad = agents.map((a) => {
    const openDeals = deals.filter(
      (d) => d.owner === a.name && d.stage !== "Won" && d.stage !== "Lost",
    ).length;
    const openTasks = tasks.filter(
      (t) => t.assignee === a.name && t.status !== "Done",
    ).length;
    return { ...a, load: openDeals + openTasks };
  });
  const maxLoad = Math.max(...withLoad.map((a) => a.load), 1);

  el.innerHTML = withLoad
    .sort((a, b) => b.load - a.load)
    .slice(0, 6)
    .map(
      (a) => `
      <div class="mini-row">
        <span class="team-avatar">${initials(a.name)}</span>
        <div class="info">
          <div class="name">${escapeHtml(a.name)}</div>
          <div class="sub">${escapeHtml(a.role || "Agent")}</div>
          <div class="team-bar-track"><div class="team-bar-fill" style="width:${Math.max(6, Math.round((a.load / maxLoad) * 100))}%"></div></div>
        </div>
        <div class="mini-right"><span class="mini-tag" style="color:var(--brand-darker)">${a.load}</span></div>
      </div>`,
    )
    .join("");
}

function attachNav(container) {
  container.querySelectorAll("[data-nav]").forEach((row) =>
    row.addEventListener("click", () => {
      window.location.href = row.dataset.nav;
    }),
  );
}

// ---------------------------------------------------------------
// Full render
// ---------------------------------------------------------------
function renderDashboard() {
  renderHeader();
  renderKpis();
  renderServerKpis();
  renderPipeline();
  renderRecentLeads();
  renderCampaigns();
  renderTodayTasks();
  renderUpcomingEvents();
  renderProductsList();
  renderTeamWorkload();
}

crmReady(["leads", "contacts", "products", "members", "tasks", "events", "campaigns"], renderDashboard);
initQuickActions();