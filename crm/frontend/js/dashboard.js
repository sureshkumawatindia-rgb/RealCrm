/**
 * dashboard.js — Overview dashboard
 * Reads across every module's server data (through app.js) and renders a single
 * at-a-glance view. Reuses shared helpers from app.js (getAgents, getProducts,
 * showToast, renderSidebarUser, initSidebarToggle, requireAuth); the read*
 * functions below wrap the getters for tasks, events and campaigns. Leads and
 * customers are counted by the server (D115): the page does not load them all.
 */

requireAuth();
renderSidebarUser();
initSidebarToggle();

const STAGE_DOT = {
  New: "var(--info)",
  Contacted: "var(--brand-darker)",
  "Quote Sent": "var(--warning)",
  Negotiation: "var(--violet)",
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
  return "₹" + num.toLocaleString(crmI18n.locale());
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
  return `<span class="badge ${map[status] || "badge-neutral"}">${escapeHtml(crmLabel("stage", status))}</span>`;
}

// ---------------------------------------------------------------
// Page-local names for the shared getters
// ---------------------------------------------------------------
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
  // A phone's top bar has room for a short greeting only.
  const narrow = window.matchMedia("(max-width: 600px)").matches;
  document.getElementById("greetingHeading").textContent = firstName
    ? t(narrow ? "dash.hi" : "dash.welcome", { name: firstName })
    : t("dash.title");
  document.getElementById("topbarDate").textContent =
    new Date().toLocaleDateString(crmI18n.locale(), {
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
  if (minutes < 60) return t("dash.wait.minutes", { n: minutes });
  if (minutes < 48 * 60) return t("dash.wait.hours", { n: Math.floor(minutes / 60) });
  return t("dash.wait.days", { n: Math.round(minutes / 1440) });
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
      label: t("dash.kpi.chats"), value: d.chats.waitingForReply, route: "Inbox.html",
      sub: d.chats.waitingForReply ? t("dash.kpi.chatsSub", { wait: formatWait(d.chats.longestWaitMinutes), n: d.chats.unassigned }) : t("dash.kpi.allAnswered"),
      cls: d.chats.longestWaitMinutes > 120 ? "warning" : "",
    },
    { label: t("dash.kpi.leadsToday"), value: d.leads.today, sub: t("dash.kpi.leadsSub", { month: d.leads.month, won: d.leads.wonMonth }), cls: "info", route: "leads.html" },
    { label: t("dash.kpi.pipeline"), value: money(d.pipeline.valuePaise), sub: t("dash.kpi.pipelineSub", { n: d.pipeline.open }), cls: "success", route: "Deals.html" },
    { label: t("dash.kpi.quotes"), value: d.quotations.waitingThreeDays, sub: t("dash.kpi.quotesSub"), cls: d.quotations.waitingThreeDays ? "warning" : "", route: "leads.html" },
    { label: t("dash.kpi.collected"), value: money(d.payments.collectedMonthPaise), sub: t("dash.kpi.collectedSub"), cls: "success", route: "Reports & Analytics.html" },
    { label: t("dash.kpi.due"), value: money(d.payments.duePaise), sub: t(d.payments.dueOrders === 1 ? "dash.orderOne" : "dash.orderMany", { n: d.payments.dueOrders }), cls: d.payments.duePaise ? "warning" : "", route: "Orders.html?tab=dues" },
    { label: t("dash.kpi.tasks"), value: d.tasks.dueToday, sub: d.tasks.overdue ? t("dash.kpi.overdue", { n: d.tasks.overdue }) : t("dash.kpi.noneOverdue"), cls: d.tasks.overdue ? "warning" : "", route: "Tasks.html" },
  ];
  document.getElementById("kpiGrid").innerHTML = cards
    .map((c) => `
      <a href="${escapeHtml(c.route)}" class="stat-card stat-card-link ${c.cls}" aria-label="${escapeHtml(t("dash.kpi.openLabel", { name: c.label }))}">
        <div class="label">${escapeHtml(c.label)}</div>
        <div class="value">${escapeHtml(String(c.value))}</div>
        <div class="label" style="text-transform:none;letter-spacing:0;margin-top:4px;font-weight:500">${escapeHtml(c.sub)}${d.scope === "own" ? escapeHtml(t("dash.kpi.yours")) : ""}</div>
      </a>`)
    .join("");
}

// Phase 3 (D115): the leads' numbers counted by the server over every lead, the five newest
// leads and how many customers — instead of loading every lead and contact into the page.
const dashLeads = { summary: null, recent: [], customers: 0 };
async function loadLeadNumbers() {
  const [summary, recent, customers] = await Promise.all([
    crmLeadSummary().catch(() => null),
    crmRequest("/leads?limit=5").catch(() => ({ data: [] })),
    crmRequest("/contacts?lifecycle=customer&limit=1").catch(() => ({ pagination: { total: 0 } })),
  ]);
  dashLeads.summary = summary;
  dashLeads.recent = (recent.data || []).map(toLegacyLead);
  dashLeads.customers = customers.pagination?.total || 0;
}
const leadNumbers = loadLeadNumbers();

function renderKpis() {
  const summary = dashLeads.summary;
  const tasks = readTasks();
  const events = readEvents();
  const agents = getAgents();
  const products = getProducts();

  const today = todayStr();
  const openCount = summary?.open.count || 0;
  const pipelineValue = (summary?.open.valuePaise || 0) / 100;
  const tasksDueToday = tasks.filter(
    (t) => t.dueDate === today && t.status !== "Done",
  );
  const overdueTasks = tasks.filter(
    (t) => t.dueDate && t.dueDate < today && t.status !== "Done",
  );
  const upcomingEvents = events.filter((e) => e.date >= today);

  const cards = [
    { label: t("dash.kpi.customers"), value: dashLeads.customers, cls: "", route: "customers.html" },
    { label: t("dash.kpi.leads"), value: summary?.total || 0, cls: "info", route: "leads.html" },
    {
      label: t("dash.kpi.pipeline"),
      value: `${openCount} · ${formatCurrency(pipelineValue)}`,
      cls: "success",
      route: "Deals.html",
    },
    {
      label: t("dash.kpi.tasks"),
      value: tasksDueToday.length,
      cls: overdueTasks.length ? "warning" : "",
      route: "Tasks.html",
    },
    { label: t("dash.events"), value: upcomingEvents.length, cls: "info", route: "Calendar.html" },
    { label: t("dash.kpi.products"), value: products.length, cls: "", route: "Products.html" },
    { label: t("dash.kpi.agents"), value: agents.length, cls: "", route: "accounts.html" },
  ];

  document.getElementById("kpiGrid").innerHTML = cards
    .map((c) => {
      const cardContent = `
        <div class="label">${escapeHtml(c.label)}</div>
        <div class="value">${escapeHtml(String(c.value))}</div>`;

      if (c.route) {
        return `
          <a href="${c.route}" class="stat-card stat-card-link ${c.cls}" aria-label="${escapeHtml(t("dash.kpi.openLabel", { name: c.label }))}">
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
  const byStage = new Map((dashLeads.summary?.stages || []).map((row) => [row.stage, row]));
  const el = document.getElementById("pipelineBars");

  if (!dashLeads.summary?.total) {
    el.innerHTML = `<div class="pipeline-empty"><i class="fa-solid fa-handshake"></i>${escapeHtml(t("dash.empty.deals"))}</div>`;
    return;
  }

  const stages = LEAD_STAGES;
  const valueOf = (stage) => (byStage.get(stage)?.valuePaise || 0) / 100;
  const maxValue = Math.max(...stages.map(valueOf), 1);

  el.innerHTML = stages
    .map((stage) => {
      const count = byStage.get(stage)?.count || 0;
      const total = valueOf(stage);
      const p = Math.max(4, Math.round((total / maxValue) * 100));
      return `
        <div class="pipeline-row">
          <div class="stage-label">${escapeHtml(crmLabel("stage", stage))}</div>
          <div class="stage-track">
            <div class="stage-fill" style="width:${p}%;background:${STAGE_DOT[stage]}"></div>
          </div>
          <div class="stage-meta">${escapeHtml(t(count === 1 ? "dash.dealOne" : "dash.dealMany", { n: count }))} · ${formatCurrency(total)}</div>
        </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Recent leads
// ---------------------------------------------------------------
function renderRecentLeads() {
  const products = getProducts();
  const container = document.getElementById("recentLeadsTable");
  const recent = dashLeads.recent;

  if (!recent.length) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>${escapeHtml(t("dash.empty.leads"))}</p></div>`;
    return;
  }

  const productName = (id) => {
    if (!id) return "—";
    const p = products.find((pr) => pr.id === id);
    return p ? p.name : "—";
  };

  container.innerHTML = `
    <table>
      <thead><tr><th>${escapeHtml(t("col.name"))}</th><th>${escapeHtml(t("col.company"))}</th><th>${escapeHtml(t("col.product"))}</th><th>${escapeHtml(t("col.status"))}</th><th>${escapeHtml(t("col.value"))}</th></tr></thead>
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
    el.innerHTML = `<div class="mini-empty"><i class="fa-solid fa-bullhorn"></i>${escapeHtml(t("dash.empty.campaigns"))}</div>`;
    return;
  }

  el.innerHTML = campaigns
    .map(
      (c) => `
      <div class="mini-row" data-nav="./Marketing.html">
        <span class="mini-icon brand"><i class="fa-solid fa-bullhorn"></i></span>
        <div class="info">
          <div class="name">${escapeHtml(c.name)}</div>
          <div class="sub">${escapeHtml(c.type || t("dash.campaign"))} · ${c.budget ? formatCurrency(c.budget) : escapeHtml(t("dash.noBudget"))}</div>
        </div>
        <div class="mini-right"><span class="badge ${CAMPAIGN_STATUS_TAG[c.status] || "badge-neutral"}">${escapeHtml(crmLabel("campaign", c.status))}</span></div>
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
    el.innerHTML = `<div class="mini-empty"><i class="fa-solid fa-circle-check"></i>${escapeHtml(t("dash.empty.tasks"))}</div>`;
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
          <div class="sub">${escapeHtml(t.assignee || crmI18n.t("dash.unassigned"))} · ${escapeHtml(crmI18n.t("dash.priority", { p: crmLabel("priority", t.priority) }))}</div>
        </div>
        <div class="mini-right"><span class="mini-tag" style="color:${overdue ? "var(--danger)" : "var(--text-faint)"}">${escapeHtml(crmI18n.t(overdue ? "dash.overdue" : "dash.today"))}</span></div>
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
    el.innerHTML = `<div class="mini-empty"><i class="fa-solid fa-calendar-days"></i>${escapeHtml(t("dash.empty.events"))}</div>`;
    return;
  }

  el.innerHTML = events
    .map((e) => {
      const dt = new Date(e.date + "T00:00:00");
      const label = dt.toLocaleDateString(crmI18n.locale(), {
        day: "2-digit",
        month: "short",
      });
      return `
      <div class="mini-row" data-nav="./Calendar.html">
        <span class="mini-icon info"><i class="fa-solid fa-calendar-day"></i></span>
        <div class="info">
          <div class="name">${escapeHtml(e.title)}</div>
          <div class="sub">${escapeHtml(crmLabel("event", e.type))}${e.assignee ? " · " + escapeHtml(e.assignee) : ""}</div>
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
  const leadCounts = new Map((dashLeads.summary?.products || []).map((row) => [String(row.productId), row.count]));
  const el = document.getElementById("productsList");

  if (!products.length) {
    el.innerHTML = `<div class="mini-empty"><i class="fa-solid fa-box-open"></i>${escapeHtml(t("dash.empty.products"))}</div>`;
    return;
  }

  el.innerHTML = products
    .map((p) => {
      const count = leadCounts.get(String(p.id)) || 0;
      const qty =
        p.quantity === "" || p.quantity == null ? null : Number(p.quantity);
      const qtyLabel = qty === null ? "" : ` · ${t("dash.qty", { n: qty })}`;
      return `
      <div class="mini-row" data-nav="./Products.html">
        <span class="mini-icon brand"><i class="fa-solid fa-box-open"></i></span>
        <div class="info">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="sub">${escapeHtml(p.category || t("dash.product"))}${p.price ? " · " + formatCurrency(p.price) : ""}${escapeHtml(qtyLabel)} · ${escapeHtml(t(count === 1 ? "dash.leadOne" : "dash.leadMany", { n: count }))}</div>
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
  const openByOwner = new Map((dashLeads.summary?.owners || []).map((row) => [String(row.ownerId), row.count]));
  const tasks = readTasks();
  const el = document.getElementById("teamWorkloadList");

  if (!agents.length) {
    el.innerHTML = `<div class="mini-empty"><i class="fa-solid fa-user-group"></i>${escapeHtml(t("dash.empty.agents"))}</div>`;
    return;
  }

  const withLoad = agents.map((a) => {
    const openDeals = openByOwner.get(String(a.id)) || 0;
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
          <div class="sub">${escapeHtml(crmLabel("role", a.role || "Agent"))}</div>
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
// "Get your CRM ready" (owners and admins, D117): the first steps for a new company. The server
// ticks each step from the company's real data (GET /organization/getting-started). Hidden for
// this person on every device; Settings → Your profile brings it back (dashboard.html?setup=1).
// Once every step is done it says so, until closed.
// ---------------------------------------------------------------
const SETUP_LINKS = {
  business: "Settings.html?tab=company",
  whatsapp: "connect-whatsapp.html?add=1",
  products: "Products.html",
  leads: "leads.html?import=1",
  team: "invite-team.html",
  quote: "Quotations.html?new=1",
};
const setGettingStartedHidden = (hidden) => crmApi("/organization/getting-started", jsonRequest("PATCH", { hidden }));

async function gettingStartedState() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("setup") === "1") {
    params.delete("setup");
    const rest = params.toString();
    history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    return setGettingStartedHidden(false);
  }
  // Hidden in this browser before D117: hidden on the account from now on.
  if (getPreference("setupChecklistHidden", false)) {
    setPreference("setupChecklistHidden", false);
    return setGettingStartedHidden(true);
  }
  return crmApi("/organization/getting-started");
}

async function renderSetupChecklist() {
  if (!isOrgManager()) return;
  let state;
  try {
    state = await gettingStartedState();
  } catch {
    return; // the list is never in the way of the dashboard
  }
  document.getElementById("setupCard")?.remove();
  if (state.hidden) return;
  const card = document.createElement("section");
  card.className = "panel setup-card";
  card.id = "setupCard";
  const close = async (message) => {
    card.remove();
    try {
      await setGettingStartedHidden(true);
      if (message) showToast(message, "info");
    } catch (error) {
      showToast(apiErrorMessage(error, t("gs.failed")), "error");
    }
  };
  if (state.done === state.total) {
    card.classList.add("setup-card--done");
    card.innerHTML = `
      <div class="setup-head">
        <div>
          <h3>${escapeHtml(t("dash.setup.allDone.title"))}</h3>
          <p>${escapeHtml(t("dash.setup.allDone.text"))}</p>
        </div>
        <button class="btn btn-outline" type="button" id="setupHide">${escapeHtml(t("common.close"))}</button>
      </div>`;
    card.querySelector("#setupHide").addEventListener("click", () => close());
    document.querySelector(".page")?.prepend(card);
    return;
  }
  const steps = state.steps.map((step) => ({ ...step, title: t(`dash.setup.${step.key}.title`), text: t(`dash.setup.${step.key}.text`), action: t(`dash.setup.${step.key}.action`) }));
  const doneCount = state.done;
  // On phones only the next step shows, with "Show all steps" (dashboard.css, R3).
  const next = steps.find((step) => !step.done);
  // The ready settings open their box here; every other step goes to its page.
  const actionOf = (step) => (step.key === "kit"
    ? `<button class="btn btn-outline" type="button" data-kit-open>${escapeHtml(step.action)}</button>`
    : `<a class="btn btn-outline" href="${escapeHtml(SETUP_LINKS[step.key])}">${escapeHtml(step.action)}</a>`);
  card.innerHTML = `
    <div class="setup-head">
      <div>
        <h3>${escapeHtml(t("dash.setup.title"))}</h3>
        <p>${escapeHtml(t("dash.setup.progress", { done: doneCount, total: steps.length }))}</p>
      </div>
      <button class="icon-btn" type="button" id="setupHide" aria-label="${escapeHtml(t("dash.setup.hide"))}" title="${escapeHtml(t("dash.setup.hide"))}"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="setup-progress" aria-hidden="true"><span style="width: ${Math.round((doneCount / steps.length) * 100)}%"></span></div>
    <ol class="setup-steps">
      ${steps
        .map(
          (step) => `
        <li class="${step.done ? "done" : ""}${step === next ? " next" : ""}">
          <i class="fa-solid ${step.done ? "fa-circle-check" : "fa-circle"}" aria-hidden="true"></i>
          <div class="setup-step-text">
            <strong>${escapeHtml(step.title)}</strong>
            <span>${escapeHtml(step.text)}</span>
          </div>
          ${step.done ? `<span class="setup-done">${escapeHtml(t("dash.setup.done"))}</span>` : actionOf(step)}
        </li>`,
        )
        .join("")}
    </ol>
    <button class="setup-toggle" type="button" id="setupToggle" aria-expanded="false">${escapeHtml(t("dash.setup.showAll", { n: steps.length }))}</button>`;
  card.querySelector("#setupToggle").addEventListener("click", (event) => {
    const all = card.classList.toggle("show-all");
    event.currentTarget.setAttribute("aria-expanded", String(all));
    event.currentTarget.textContent = all ? t("dash.setup.showNext") : t("dash.setup.showAll", { n: steps.length });
  });
  card.querySelector("#setupHide").addEventListener("click", () => close(t("dash.setup.hidden")));
  card.querySelector("[data-kit-open]")?.addEventListener("click", (event) => kitBox.open(event.currentTarget));
  document.querySelector(".page")?.prepend(card);
}

// ---------------------------------------------------------------
// Ready settings for the business (D117): a trader's or a manufacturer's sales stages, quick
// replies and quotation terms, in the person's language. The server fills only what the company
// has not set itself; the box shows what stays.
// ---------------------------------------------------------------
const kitBox = (() => {
  const $ = (id) => document.getElementById(id);
  const ICONS = { trader: "fa-store", manufacturer: "fa-industry" };
  let data = null;
  let chosen = null;
  let opener = null; // focus goes back to it when the box closes

  function preview() {
    const kit = data.kits.find((one) => one.id === chosen);
    $("kitApply").disabled = !kit;
    if (!kit) {
      $("kitPreview").innerHTML = "";
      return;
    }
    const stays = (part) => (data.keeps[part] ? ` <span class="badge badge-neutral">${escapeHtml(t("kit.yoursStay"))}</span>` : "");
    $("kitPreview").innerHTML = `
      <section class="kit-part">
        <h4>${escapeHtml(t("kit.stages"))}${stays("stages")}</h4>
        ${data.keeps.stages ? `<p class="sub">${escapeHtml(t("kit.stagesKept"))}</p>` : ""}
        <ol class="kit-stages">${kit.stages.map((name) => `<li>${escapeHtml(name)}</li>`).join("")}<li class="kit-stage-end">${escapeHtml(crmLabel("stage", "Won"))} / ${escapeHtml(crmLabel("stage", "Lost"))}</li></ol>
      </section>
      <section class="kit-part">
        <h4>${escapeHtml(t("kit.replies"))}</h4>
        <ul class="kit-replies">${kit.quickReplies.map((reply) => `<li><code translate="no">/${escapeHtml(reply.shortcut)}</code> <span>${escapeHtml(reply.title)}</span>${reply.exists ? ` <span class="badge badge-neutral">${escapeHtml(t("kit.haveIt"))}</span>` : ""}</li>`).join("")}</ul>
        <p class="sub">${escapeHtml(t("kit.repliesHint"))}</p>
      </section>
      <section class="kit-part">
        <h4>${escapeHtml(t("kit.terms"))}${stays("terms")}</h4>
        ${data.keeps.terms ? `<p class="sub">${escapeHtml(t("kit.termsKept"))}</p>` : `<pre class="kit-terms">${escapeHtml(kit.terms)}</pre><p class="sub">${escapeHtml(t("kit.validity", { n: kit.validityDays }))}</p>`}
      </section>`;
  }

  function render() {
    $("kitChoices").innerHTML = data.kits.map((kit) => `
      <label class="kit-choice">
        <input type="radio" name="kitChoice" value="${escapeHtml(kit.id)}" ${kit.id === chosen ? "checked" : ""} />
        <i class="fa-solid ${ICONS[kit.id] || "fa-briefcase"}" aria-hidden="true"></i>
        <span><strong>${escapeHtml(kit.name)}</strong><small>${escapeHtml(kit.about)}</small></span>
      </label>`).join("");
    preview();
  }

  async function open(from) {
    opener = from || null;
    $("kitOverlay").classList.add("open");
    $("kitApply").disabled = true;
    $("kitPreview").innerHTML = "";
    $("kitChoices").innerHTML = `<p class="sub">${escapeHtml(t("bulkbar.loading"))}</p>`;
    try {
      data = await crmApi(`/organization/business-kits?language=${encodeURIComponent(crmI18n.language())}`);
      chosen = data.current;
      render();
      ($("kitChoices").querySelector("input:checked") || $("kitChoices").querySelector("input"))?.focus();
    } catch (error) {
      $("kitChoices").innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, t("kit.loadFailed")))}</p>`;
    }
  }
  const close = () => {
    $("kitOverlay").classList.remove("open");
    if (opener?.isConnected) opener.focus();
  };

  // "Ready settings added: sales stages set, 6 quick replies added, quotation terms set."
  function summary(result) {
    const parts = [
      t(result.stages === "set" ? "kit.done.stagesSet" : "kit.done.stagesKept"),
      t(result.quickReplies.added === 1 ? "kit.done.replies.one" : "kit.done.replies.many", { n: result.quickReplies.added }),
      t(result.terms === "set" ? "kit.done.termsSet" : "kit.done.termsKept"),
    ];
    return t("kit.done", { list: parts.join(", ") });
  }

  async function apply() {
    $("kitApply").disabled = true;
    try {
      const result = await crmApi("/organization/business-kit", jsonRequest("POST", { kit: chosen, language: data.language }));
      close();
      showToast(summary(result), "success");
      // The step is done now: the keyboard goes on to the next one.
      await renderSetupChecklist();
      document.querySelector("#setupCard li.next .btn, #setupCard #setupHide")?.focus();
    } catch (error) {
      showToast(apiErrorMessage(error, t("kit.applyFailed")), "error");
      $("kitApply").disabled = false;
    }
  }

  if ($("kitOverlay")) {
    $("kitChoices").addEventListener("change", (event) => {
      if (event.target.name !== "kitChoice") return;
      chosen = event.target.value;
      preview();
    });
    $("kitApply").addEventListener("click", apply);
    $("kitClose").addEventListener("click", close);
    $("kitCancel").addEventListener("click", close);
    $("kitOverlay").addEventListener("click", (event) => {
      if (event.target.id === "kitOverlay") close();
    });
  }
  return { open };
})();

// ---------------------------------------------------------------
// Full render
// ---------------------------------------------------------------
function renderDashboard() {
  renderSetupChecklist();
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

crmReady(["products", "members", "tasks", "events", "campaigns"], async () => {
  await leadNumbers;
  renderDashboard();
});
initQuickActions();