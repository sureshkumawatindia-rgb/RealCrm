/**
 * reports.js — Reports & Analytics module
 * Read-only aggregation across every module's localStorage keys.
 * Reuses shared helpers from app.js (getCustomers, getLeads, getAgents,
 * getProducts, getAccounts, showToast, renderSidebarUser, initSidebarToggle,
 * requireAuth). Deals / Tasks / Events / Campaigns / Tickets don't have
 * shared helpers, so they're read directly from localStorage here.
 */

requireAuth();
renderSidebarUser();
initSidebarToggle();

const STAGES = ["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"];
const STAGE_DOT = {
  Lead: "var(--info)",
  Qualified: "var(--brand-darker)",
  Proposal: "var(--warning)",
  Negotiation: "#7c3aed",
  Won: "var(--success)",
  Lost: "var(--danger)",
};
const TICKET_STATUSES = [
  "Open",
  "In Progress",
  "Waiting on Customer",
  "Resolved",
  "Closed",
];
const TICKET_STATUS_COLOR = {
  Open: "var(--info)",
  "In Progress": "var(--brand-darker)",
  "Waiting on Customer": "var(--warning)",
  Resolved: "var(--success)",
  Closed: "var(--text-faint)",
};
const TICKET_PRIORITIES = ["Low", "Medium", "High", "Urgent"];

let activeTab = "overview";

// ---------------------------------------------------------------
// Direct localStorage reads for modules without shared helpers
// ---------------------------------------------------------------
function readDeals() {
  const raw = localStorage.getItem("crm_deals");
  return raw ? JSON.parse(raw) : [];
}
function readTasks() {
  const raw = localStorage.getItem("crm_tasks");
  return raw ? JSON.parse(raw) : [];
}
function readEvents() {
  const raw = localStorage.getItem("crm_calendar_events");
  return raw ? JSON.parse(raw) : [];
}
function readCampaigns() {
  const raw = localStorage.getItem("crm_campaigns");
  return raw ? JSON.parse(raw) : [];
}
function readTickets() {
  const raw = localStorage.getItem("crm_tickets");
  return raw ? JSON.parse(raw) : [];
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
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
function daysAgoStr(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function currentRangeDays() {
  const v = document.getElementById("filterRange").value;
  return v === "all" ? null : parseInt(v, 10);
}
function inRange(dateStr) {
  const days = currentRangeDays();
  if (!dateStr) return false;
  if (days === null) return true;
  return dateStr.slice(0, 10) >= daysAgoStr(days);
}
function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

// ---------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------
function renderKpis() {
  const deals = readDeals();
  const leads = getLeads();
  const customers = getCustomers();
  const tickets = readTickets();

  const wonInRange = deals.filter(
    (d) => d.stage === "Won" && inRange(d.closeDate || d.createdAt),
  );
  const totalRevenue = wonInRange.reduce((s, d) => s + Number(d.value || 0), 0);
  const avgDealSize = wonInRange.length
    ? totalRevenue / wonInRange.length
    : 0;

  const openDeals = deals.filter((d) => d.stage !== "Won" && d.stage !== "Lost");
  const openPipeline = openDeals.reduce((s, d) => s + Number(d.value || 0), 0);

  const leadsInRange = leads.filter((l) => inRange(l.createdAt));
  const wonLeadsInRange = leadsInRange.filter((l) => l.status === "Won");
  const conversionRate = pct(wonLeadsInRange.length, leadsInRange.length);

  const newCustomers = customers.filter((c) => inRange(c.createdAt)).length;

  const ticketsInRange = tickets.filter((t) => inRange(t.createdAt));
  const resolvedInRange = ticketsInRange.filter(
    (t) => t.status === "Resolved" || t.status === "Closed",
  );
  const resolutionRate = pct(resolvedInRange.length, ticketsInRange.length);

  const cards = [
    { label: "Revenue Won", value: formatCurrency(totalRevenue), cls: "success" },
    {
      label: "Open Pipeline",
      value: `${openDeals.length} · ${formatCurrency(openPipeline)}`,
      cls: "info",
    },
    { label: "Lead Conversion", value: `${conversionRate}%`, cls: "" },
    { label: "Avg Deal Size", value: formatCurrency(avgDealSize), cls: "" },
    { label: "New Customers", value: newCustomers, cls: "info" },
    {
      label: "Ticket Resolution",
      value: `${resolutionRate}%`,
      cls: resolutionRate < 50 ? "warning" : "success",
    },
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
// Revenue trend (last 6 months, Won deals by closeDate)
// ---------------------------------------------------------------
function renderRevenueTrend() {
  const deals = readDeals().filter((d) => d.stage === "Won" && d.closeDate);
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: d.toLocaleDateString("en-IN", { month: "short" }), value: 0 });
  }
  deals.forEach((d) => {
    const key = d.closeDate.slice(0, 7);
    const m = months.find((mo) => mo.key === key);
    if (m) m.value += Number(d.value || 0);
  });

  const el = document.getElementById("revenueTrend");
  const max = Math.max(...months.map((m) => m.value), 1);

  if (!deals.length) {
    el.innerHTML = `<div class="report-empty" style="width:100%"><i class="fa-solid fa-chart-column"></i>No won deals yet.</div>`;
    return;
  }

  el.innerHTML = months
    .map(
      (m) => `
      <div class="trend-bar-col">
        <div class="trend-value">${m.value ? formatCurrency(m.value) : ""}</div>
        <div class="trend-bar" style="height:${Math.max(4, Math.round((m.value / max) * 100))}%"></div>
        <div class="trend-month">${m.label}</div>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------
// Pipeline by stage (shared renderer, targets any container id)
// ---------------------------------------------------------------
function renderPipelineBars(containerId) {
  const deals = readDeals();
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!deals.length) {
    el.innerHTML = `<div class="report-empty"><i class="fa-solid fa-handshake"></i>No deals yet.</div>`;
    return;
  }

  const maxValue = Math.max(
    ...STAGES.map((s) =>
      deals
        .filter((d) => d.stage === s)
        .reduce((sum, d) => sum + Number(d.value || 0), 0),
    ),
    1,
  );

  el.innerHTML = STAGES.map((stage) => {
    const stageDeals = deals.filter((d) => d.stage === stage);
    const total = stageDeals.reduce((s, d) => s + Number(d.value || 0), 0);
    const p = Math.max(4, Math.round((total / maxValue) * 100));
    return `
      <div class="pipeline-row">
        <div class="stage-label">${stage}</div>
        <div class="stage-track"><div class="stage-fill" style="width:${p}%;background:${STAGE_DOT[stage]}"></div></div>
        <div class="stage-meta"><strong>${stageDeals.length}</strong> deal${stageDeals.length === 1 ? "" : "s"} · ${formatCurrency(total)}</div>
      </div>`;
  }).join("");
}

// ---------------------------------------------------------------
// Win / Loss donut (shared renderer)
// ---------------------------------------------------------------
function renderWinLossDonut(containerId) {
  const deals = readDeals();
  const won = deals.filter((d) => d.stage === "Won").length;
  const lost = deals.filter((d) => d.stage === "Lost").length;
  const total = won + lost;
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!total) {
    el.innerHTML = `<div class="report-empty"><i class="fa-solid fa-scale-balanced"></i>No closed deals yet.</div>`;
    return;
  }

  const wonPct = Math.round((won / total) * 100);
  const gradient = `conic-gradient(var(--success) 0% ${wonPct}%, var(--danger) ${wonPct}% 100%)`;

  el.innerHTML = `
    <div class="donut-chart" style="background:${gradient}">
      <div class="donut-center"><span class="num">${wonPct}%</span><span class="lbl">Win Rate</span></div>
    </div>
    <div class="donut-legend">
      <div class="donut-legend-row"><span class="swatch" style="background:var(--success)"></span>Won<strong>${won}</strong></div>
      <div class="donut-legend-row"><span class="swatch" style="background:var(--danger)"></span>Lost<strong>${lost}</strong></div>
    </div>`;
}

// ---------------------------------------------------------------
// Lead funnel (shared renderer)
// ---------------------------------------------------------------
function renderLeadFunnel(containerId) {
  const leads = getLeads();
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!leads.length) {
    el.innerHTML = `<div class="report-empty"><i class="fa-solid fa-filter"></i>No leads yet.</div>`;
    return;
  }

  const stages = [
    { key: "New", label: "New" },
    { key: "In Progress", label: "In Progress" },
    { key: "Won", label: "Won" },
    { key: "Lost", label: "Lost" },
  ];
  const total = leads.length;
  const max = total;

  el.innerHTML = stages
    .map((s) => {
      const count = leads.filter((l) => l.status === s.key).length;
      const width = Math.max(6, Math.round((count / max) * 100));
      return `
      <div class="funnel-row">
        <div class="funnel-top"><span>${s.label}</span><strong>${count} · ${pct(count, total)}%</strong></div>
        <div class="funnel-bar-track"><div class="funnel-bar-fill" style="width:${width}%"></div></div>
      </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------
// Leads by product interest
// ---------------------------------------------------------------
function renderLeadsByProduct() {
  const leads = getLeads();
  const products = getProducts();
  const el = document.getElementById("leadsByProduct");

  const counted = products
    .map((p) => ({
      name: p.name,
      count: leads.filter((l) => l.product === p.id).length,
    }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  if (!counted.length) {
    el.innerHTML = `<div class="bar-list-empty"><i class="fa-solid fa-box-open"></i>No leads linked to products yet.</div>`;
    return;
  }

  const max = Math.max(...counted.map((c) => c.count), 1);
  el.innerHTML = counted
    .map(
      (c) => `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(c.name)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(6, Math.round((c.count / max) * 100))}%"></div></div>
        <div class="bar-meta">${c.count}</div>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------
// Campaign performance table
// ---------------------------------------------------------------
function renderCampaignPerf() {
  const campaigns = readCampaigns();
  const el = document.getElementById("campaignPerfTable");

  if (!campaigns.length) {
    el.innerHTML = `<div class="empty-state"><i class="fa-solid fa-bullhorn"></i><p>No campaigns yet.</p></div>`;
    return;
  }

  el.innerHTML = `
    <table>
      <thead><tr><th>Campaign</th><th>Type</th><th>Status</th><th>Budget</th><th>Leads</th><th>Cost / Lead</th></tr></thead>
      <tbody>
        ${campaigns
          .map((c) => {
            const budget = Number(c.budget || 0);
            const leadsGen = Number(c.leadsGenerated || 0);
            const cpl = leadsGen ? formatCurrency(budget / leadsGen) : "—";
            return `
          <tr>
            <td><strong>${escapeHtml(c.name)}</strong></td>
            <td>${escapeHtml(c.type || "—")}</td>
            <td>${escapeHtml(c.status || "—")}</td>
            <td>${formatCurrency(budget)}</td>
            <td>${leadsGen}</td>
            <td>${cpl}</td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

// ---------------------------------------------------------------
// Deals by owner (Sales tab)
// ---------------------------------------------------------------
function renderDealsByOwner() {
  const deals = readDeals();
  const agents = getAgents();
  const el = document.getElementById("dealsByOwnerTable");

  const names = agents.length
    ? agents.map((a) => a.name)
    : [...new Set(deals.map((d) => d.owner).filter(Boolean))];

  if (!names.length) {
    el.innerHTML = `<div class="empty-state"><i class="fa-solid fa-user-group"></i><p>No agents yet.</p></div>`;
    return;
  }

  const rows = names
    .map((name) => {
      const ownerDeals = deals.filter((d) => d.owner === name);
      const won = ownerDeals.filter((d) => d.stage === "Won");
      const open = ownerDeals.filter(
        (d) => d.stage !== "Won" && d.stage !== "Lost",
      );
      const revenue = won.reduce((s, d) => s + Number(d.value || 0), 0);
      return { name, total: ownerDeals.length, won: won.length, open: open.length, revenue };
    })
    .sort((a, b) => b.revenue - a.revenue);

  el.innerHTML = `
    <table>
      <thead><tr><th>Owner</th><th>Total Deals</th><th>Open</th><th>Won</th><th>Revenue</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr>
            <td>
              <div class="leaderboard-agent">
                <span class="avatar">${initials(r.name)}</span>
                ${escapeHtml(r.name)}
              </div>
            </td>
            <td>${r.total}</td>
            <td>${r.open}</td>
            <td>${r.won}</td>
            <td>${formatCurrency(r.revenue)}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

// ---------------------------------------------------------------
// Team leaderboard
// ---------------------------------------------------------------
function renderLeaderboard() {
  const agents = getAgents();
  const deals = readDeals();
  const tasks = readTasks();
  const tickets = readTickets();
  const el = document.getElementById("leaderboardTable");

  if (!agents.length) {
    el.innerHTML = `<div class="empty-state"><i class="fa-solid fa-user-group"></i><p>No agents yet. Add one from Account Champions.</p></div>`;
    return;
  }

  const rows = agents
    .map((a) => {
      const dealsWon = deals.filter(
        (d) => d.owner === a.name && d.stage === "Won",
      );
      const revenue = dealsWon.reduce((s, d) => s + Number(d.value || 0), 0);
      const tasksCompleted = tasks.filter(
        (t) => t.assignee === a.name && t.status === "Done",
      ).length;
      const ticketsResolved = tickets.filter(
        (t) =>
          t.assignee === a.name &&
          (t.status === "Resolved" || t.status === "Closed"),
      ).length;
      const score = dealsWon.length * 3 + tasksCompleted + ticketsResolved;
      return {
        name: a.name,
        role: a.role || "Agent",
        dealsWon: dealsWon.length,
        revenue,
        tasksCompleted,
        ticketsResolved,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);

  el.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Agent</th>
          <th>Deals Won</th>
          <th>Revenue</th>
          <th>Tasks Done</th>
          <th>Tickets Resolved</th>
          <th>Score</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r, i) => `
          <tr>
            <td><span class="rank-badge ${i === 0 ? "top" : ""}">${i + 1}</span></td>
            <td>
              <div class="leaderboard-agent">
                <span class="avatar">${initials(r.name)}</span>
                <div>
                  <div>${escapeHtml(r.name)}</div>
                  <div class="text-muted" style="font-size:11px">${escapeHtml(r.role)}</div>
                </div>
              </div>
            </td>
            <td>${r.dealsWon}</td>
            <td>${formatCurrency(r.revenue)}</td>
            <td>${r.tasksCompleted}</td>
            <td>${r.ticketsResolved}</td>
            <td><strong>${r.score}</strong></td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

// ---------------------------------------------------------------
// Support tab
// ---------------------------------------------------------------
function renderTicketStatusDonut() {
  const tickets = readTickets();
  const el = document.getElementById("ticketStatusDonut");

  if (!tickets.length) {
    el.innerHTML = `<div class="report-empty"><i class="fa-solid fa-headset"></i>No tickets yet.</div>`;
    return;
  }

  const total = tickets.length;
  let acc = 0;
  const segments = TICKET_STATUSES.map((status) => {
    const count = tickets.filter((t) => t.status === status).length;
    const start = acc;
    acc += (count / total) * 100;
    return { status, count, start, end: acc };
  });

  const gradient = segments
    .filter((s) => s.count > 0)
    .map((s) => `${TICKET_STATUS_COLOR[s.status]} ${s.start}% ${s.end}%`)
    .join(", ");

  el.innerHTML = `
    <div class="donut-chart" style="background:conic-gradient(${gradient})">
      <div class="donut-center"><span class="num">${total}</span><span class="lbl">Tickets</span></div>
    </div>
    <div class="donut-legend">
      ${segments
        .map(
          (s) => `
        <div class="donut-legend-row"><span class="swatch" style="background:${TICKET_STATUS_COLOR[s.status]}"></span>${s.status}<strong>${s.count}</strong></div>`,
        )
        .join("")}
    </div>`;
}

function renderTicketPriorityBars() {
  const tickets = readTickets();
  const el = document.getElementById("ticketPriorityBars");

  if (!tickets.length) {
    el.innerHTML = `<div class="bar-list-empty"><i class="fa-solid fa-headset"></i>No tickets yet.</div>`;
    return;
  }

  const max = Math.max(
    ...TICKET_PRIORITIES.map(
      (p) => tickets.filter((t) => t.priority === p).length,
    ),
    1,
  );

  el.innerHTML = TICKET_PRIORITIES.map((p) => {
    const count = tickets.filter((t) => t.priority === p).length;
    return `
      <div class="bar-row">
        <div class="bar-label">${p}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(6, Math.round((count / max) * 100))}%"></div></div>
        <div class="bar-meta">${count}</div>
      </div>`;
  }).join("");
}

function renderSupportSnapshot() {
  const tickets = readTickets();
  const today = todayStr();
  const el = document.getElementById("supportSnapshot");

  const overdue = tickets.filter(
    (t) =>
      t.dueDate &&
      t.dueDate < today &&
      t.status !== "Resolved" &&
      t.status !== "Closed",
  ).length;
  const open = tickets.filter((t) =>
    ["Open", "In Progress", "Waiting on Customer"].includes(t.status),
  ).length;
  const resolved = tickets.filter(
    (t) => t.status === "Resolved" || t.status === "Closed",
  ).length;
  const urgent = tickets.filter(
    (t) => t.priority === "Urgent" && t.status !== "Closed",
  ).length;

  const rows = [
    { icon: "fa-inbox", cls: "info", name: "Open Tickets", sub: "Across all agents", value: open },
    { icon: "fa-triangle-exclamation", cls: "warning", name: "Overdue", sub: "Past due date, unresolved", value: overdue },
    { icon: "fa-bolt", cls: "warning", name: "Urgent & Open", sub: "Needs immediate attention", value: urgent },
    { icon: "fa-circle-check", cls: "success", name: "Resolved / Closed", sub: "All time", value: resolved },
  ];

  el.innerHTML = rows
    .map(
      (r) => `
      <div class="mini-row">
        <span class="mini-icon ${r.cls}"><i class="fa-solid ${r.icon}"></i></span>
        <div class="info">
          <div class="name">${r.name}</div>
          <div class="sub">${r.sub}</div>
        </div>
        <div class="mini-right"><span class="mini-tag" style="color:var(--text)">${r.value}</span></div>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------
// Export CSV
// ---------------------------------------------------------------
function exportCsv() {
  const deals = readDeals();
  const leads = getLeads();
  const tickets = readTickets();
  const wonInRange = deals.filter(
    (d) => d.stage === "Won" && inRange(d.closeDate || d.createdAt),
  );
  const totalRevenue = wonInRange.reduce((s, d) => s + Number(d.value || 0), 0);
  const openDeals = deals.filter((d) => d.stage !== "Won" && d.stage !== "Lost");
  const openPipeline = openDeals.reduce((s, d) => s + Number(d.value || 0), 0);
  const leadsInRange = leads.filter((l) => inRange(l.createdAt));
  const wonLeadsInRange = leadsInRange.filter((l) => l.status === "Won");
  const ticketsInRange = tickets.filter((t) => inRange(t.createdAt));
  const resolvedInRange = ticketsInRange.filter(
    (t) => t.status === "Resolved" || t.status === "Closed",
  );

  const rangeLabel =
    document.getElementById("filterRange").selectedOptions[0].textContent;

  const rows = [
    ["Metric", "Value", "Range"],
    ["Revenue Won", totalRevenue, rangeLabel],
    ["Open Pipeline Deals", openDeals.length, "Current"],
    ["Open Pipeline Value", openPipeline, "Current"],
    ["Leads in Range", leadsInRange.length, rangeLabel],
    ["Leads Won in Range", wonLeadsInRange.length, rangeLabel],
    [
      "Lead Conversion Rate (%)",
      pct(wonLeadsInRange.length, leadsInRange.length),
      rangeLabel,
    ],
    ["Tickets in Range", ticketsInRange.length, rangeLabel],
    ["Tickets Resolved in Range", resolvedInRange.length, rangeLabel],
  ];

  const csv = rows.map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `crm-report-${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Report exported", "success");
}

// ---------------------------------------------------------------
// Full render
// ---------------------------------------------------------------
function renderAll() {
  renderKpis();
  if (activeTab === "overview") {
    renderRevenueTrend();
    renderWinLossDonut("winLossDonut");
    renderPipelineBars("pipelineBarsOverview");
    renderLeadFunnel("leadFunnelOverview");
  } else if (activeTab === "sales") {
    renderPipelineBars("pipelineBarsSales");
    renderWinLossDonut("winLossDonutSales");
    renderDealsByOwner();
  } else if (activeTab === "leads") {
    renderLeadFunnel("leadFunnel");
    renderLeadsByProduct();
    renderCampaignPerf();
  } else if (activeTab === "team") {
    renderLeaderboard();
  } else if (activeTab === "support") {
    renderTicketStatusDonut();
    renderTicketPriorityBars();
    renderSupportSnapshot();
  }
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  renderAll();

  document.querySelectorAll(".report-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll(".report-tab")
        .forEach((t) => t.classList.remove("active"));
      document
        .querySelectorAll(".report-panel")
        .forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document
        .querySelector(`.report-panel[data-panel="${tab.dataset.tab}"]`)
        .classList.add("active");
      activeTab = tab.dataset.tab;
      renderAll();
    });
  });

  document
    .getElementById("filterRange")
    .addEventListener("change", renderAll);
  document.getElementById("exportBtn").addEventListener("click", exportCsv);
  document.getElementById("printBtn").addEventListener("click", () => window.print());
});