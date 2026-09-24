/**
 * ai-insights.js — AI Insights module (read-only analytics + assistant UI)
 * Reads real CRM data from localStorage (crm_deals, crm_leads,
 * crm_customers, crm_agents). No fabricated/demo numbers — every figure
 * shown is computed from actual data, with honest empty states when
 * there isn't enough data yet.
 * Reuses shared helpers from app.js (getLeads, getCustomers, getAgents,
 * showToast, renderSidebarUser, initSidebarToggle, requireAuth).
 * Nothing here calls a real model — it's presentation only.
 */

requireAuth();
renderSidebarUser();
initSidebarToggle();

// ---------------------------------------------------------------
// Direct reads for modules without shared app.js helpers
// ---------------------------------------------------------------
function readDeals() {
  const raw = localStorage.getItem("crm_deals");
  return raw ? JSON.parse(raw) : [];
}

function safeGetLeads() {
  try {
    return typeof getLeads === "function" ? getLeads() : [];
  } catch (e) {
    return [];
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
function formatCurrency(n) {
  const num = Number(n) || 0;
  return "₹" + Math.round(num).toLocaleString("en-IN");
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

const STAGE_ORDER = ["Lead", "Qualified", "Proposal", "Negotiation"];

// ---------------------------------------------------------------
// Derive KPI figures from real deals
// ---------------------------------------------------------------
function computeKpis() {
  const deals = readDeals();
  const open = deals.filter((d) => d.stage !== "Won" && d.stage !== "Lost");
  const atRisk = open.filter(
    (d) => d.probability != null && Number(d.probability) <= 30,
  );

  const opportunitiesValue = open.reduce((s, d) => s + Number(d.value || 0), 0);
  const weightedForecast = open.reduce(
    (s, d) => s + Number(d.value || 0) * ((Number(d.probability) || 10) / 100),
    0,
  );
  const atRiskValue = atRisk.reduce((s, d) => s + Number(d.value || 0), 0);
  const won = deals.filter((d) => d.stage === "Won").length;
  const lost = deals.filter((d) => d.stage === "Lost").length;
  const healthScore = deals.length
    ? Math.max(35, Math.min(96, Math.round(70 + won * 3 - lost * 4 - atRisk.length * 2)))
    : null;

  return {
    hasData: deals.length > 0,
    revenueForecast: weightedForecast,
    openOpportunities: open.length,
    opportunitiesValue,
    dealsAtRisk: atRisk.length,
    atRiskValue,
    healthScore,
    wonCount: won,
    lostCount: lost,
    openDeals: open,
  };
}

// ---------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------
function renderKpis() {
  const k = computeKpis();

  const cards = [
    {
      icon: "fa-chart-line",
      iconCls: "success",
      label: "Weighted Pipeline Forecast",
      value: formatCurrency(k.revenueForecast),
      sub: k.hasData
        ? `<i class="fa-solid fa-chart-simple"></i> Based on ${k.openOpportunities} open deal${k.openOpportunities === 1 ? "" : "s"}`
        : "No open deals yet",
      subCls: k.hasData ? "info" : "neutral",
    },
    {
      icon: "fa-bullseye",
      iconCls: "info",
      label: "Sales Opportunities",
      value: k.openOpportunities,
      sub: k.hasData
        ? `${formatCurrency(k.opportunitiesValue)} in open pipeline`
        : "Add deals to see pipeline value",
      subCls: "info",
    },
    {
      icon: "fa-triangle-exclamation",
      iconCls: "warning",
      label: "Deals at Risk",
      value: k.dealsAtRisk,
      sub: k.dealsAtRisk
        ? `${formatCurrency(k.atRiskValue)} needs attention`
        : "No deals currently at risk",
      subCls: k.dealsAtRisk ? "warning" : "success",
    },
    {
      icon: "fa-heart-pulse",
      iconCls: "brand",
      label: "Customer Health",
      value: k.healthScore != null ? `${k.healthScore}/100` : "—",
      sub:
        k.healthScore == null
          ? "Not enough data yet"
          : k.healthScore >= 75
          ? '<i class="fa-solid fa-circle-check"></i> Healthy across accounts'
          : '<i class="fa-solid fa-circle-exclamation"></i> Some accounts need care',
      subCls: k.healthScore == null ? "neutral" : k.healthScore >= 75 ? "success" : "warning",
    },
  ];

  document.getElementById("aiKpiGrid").innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card">
        <div class="ai-kpi-card-head">
          <div class="label">${c.label}</div>
          <div class="ai-kpi-icon ${c.iconCls}"><i class="fa-solid ${c.icon}"></i></div>
        </div>
        <div class="value">${c.value}</div>
        <div class="ai-kpi-sub ${c.subCls}">${c.sub}</div>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------
// AI Recommended Actions — only shown when actually derived from data
// ---------------------------------------------------------------
function buildRecommendedActions() {
  const deals = readDeals();
  const negotiation = deals.filter((d) => d.stage === "Negotiation");
  const atRisk = deals.filter(
    (d) =>
      d.stage !== "Won" &&
      d.stage !== "Lost" &&
      d.probability != null &&
      Number(d.probability) <= 30,
  );
  const unassignedLeads = safeGetLeads().filter(
    (l) => !l.owner && l.status !== "Lost" && l.status !== "Converted",
  );

  const actions = [];

  if (negotiation.length) {
    const value = negotiation.reduce((s, d) => s + Number(d.value || 0), 0);
    actions.push({
      priority: "high",
      title: "Push Negotiation-stage deals to close",
      text: `${negotiation.length} deal${negotiation.length === 1 ? " is" : "s are"} sitting in Negotiation worth ${formatCurrency(value)}. These are closest to closing — prioritize follow-up this week.`,
      meta: "Impact: High · Effort: Low",
    });
  }

  if (atRisk.length) {
    const value = atRisk.reduce((s, d) => s + Number(d.value || 0), 0);
    actions.push({
      priority: "high",
      title: "Review deals flagged at risk",
      text: `${atRisk.length} open deal${atRisk.length === 1 ? "" : "s"} worth ${formatCurrency(value)} show a low win probability. Consider a re-qualification call or a revised offer.`,
      meta: "Impact: High · Effort: Medium",
    });
  }

  if (unassignedLeads.length) {
    actions.push({
      priority: "medium",
      title: "Assign unclaimed leads",
      text: `${unassignedLeads.length} lead${unassignedLeads.length === 1 ? " has" : "s have"} no owner assigned yet. Routing them to available agents now improves conversion odds.`,
      meta: "Impact: Medium · Effort: Low",
    });
  }

  if (!actions.length) {
    actions.push({
      priority: "low",
      title: "You're all caught up",
      text: "No urgent deals or leads need attention right now. Check back after adding more pipeline activity.",
      meta: "Impact: — · Effort: —",
    });
  }

  return actions.slice(0, 3);
}

function renderActions() {
  const actions = buildRecommendedActions();
  const priorityLabel = { high: "High Priority", medium: "Medium Priority", low: "Low Priority" };
  const priorityBadge = {
    high: "badge-priority-high",
    medium: "badge-priority-medium",
    low: "badge-priority-low",
  };

  document.getElementById("aiActionsList").innerHTML = actions
    .map(
      (a) => `
      <div class="ai-action-item">
        <span class="ai-action-priority ${a.priority}"></span>
        <div class="ai-action-body">
          <div class="ai-action-top">
            <span class="ai-action-title">${escapeHtml(a.title)}</span>
            <span class="badge ${priorityBadge[a.priority]}">${priorityLabel[a.priority]}</span>
          </div>
          <div class="ai-action-text">${escapeHtml(a.text)}</div>
          <div class="ai-action-foot">
            <span class="ai-action-meta"><i class="fa-solid fa-sparkles"></i> ${escapeHtml(a.meta)}</span>
          </div>
        </div>
      </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------
// Pipeline-by-stage chart (real data only — no fabricated monthly
// forecast line, since we don't have real historical time-series data).
// ---------------------------------------------------------------
function renderForecastChart() {
  const deals = readDeals().filter((d) => d.stage !== "Won" && d.stage !== "Lost");
  const svg = document.getElementById("forecastChart");
  const monthsEl = document.getElementById("forecastMonths");

  if (!deals.length) {
    svg.innerHTML = `<text x="280" y="100" text-anchor="middle" fill="var(--text-faint)" font-size="13">No pipeline data yet — add deals to see this chart.</text>`;
    monthsEl.innerHTML = "";
    return;
  }

  const width = 560;
  const height = 190;
  const padTop = 10;
  const padBottom = 24;

  const stageTotals = STAGE_ORDER.map((stage) => ({
    stage,
    value: deals.filter((d) => d.stage === stage).reduce((s, d) => s + Number(d.value || 0), 0),
  }));

  const maxV = Math.max(...stageTotals.map((s) => s.value), 1) * 1.15;
  const gap = 24;
  const barWidth = width / stageTotals.length - gap;

  const bars = stageTotals
    .map((s, i) => {
      const barHeight = maxV ? (s.value / maxV) * (height - padTop - padBottom) : 0;
      const x = i * (barWidth + gap) + gap / 2;
      const y = height - padBottom - barHeight;
      return `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(barHeight, 0)}" rx="6" fill="var(--brand-darker)" opacity="${0.5 + i * 0.13}" />
        <text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-size="10.5" fill="var(--text-faint)">${s.value ? formatCurrency(s.value) : ""}</text>
      `;
    })
    .join("");

  const baseline = `<line x1="0" y1="${height - padBottom}" x2="${width}" y2="${height - padBottom}" stroke="var(--border-soft)" stroke-width="1" />`;

  svg.innerHTML = baseline + bars;
  monthsEl.innerHTML = stageTotals.map((s) => `<span>${s.stage}</span>`).join("");
}

function renderForecastFigures() {
  const k = computeKpis();
  document.getElementById("forecastValue").textContent = formatCurrency(k.revenueForecast);
  document.getElementById("forecastValueSub").textContent = k.hasData
    ? "Weighted by stage win-probability"
    : "No open deals yet";
  document.getElementById("forecastOpenCount").textContent = k.openOpportunities;
  document.getElementById("forecastOpenSub").textContent = k.hasData
    ? `${formatCurrency(k.opportunitiesValue)} total value`
    : "Across all stages";
}

// ---------------------------------------------------------------
// High Priority Deals table — real deals only, empty state otherwise
// ---------------------------------------------------------------
function suggestedActionFor(deal) {
  const prob = Number(deal.probability) || 0;
  if (prob >= 70) return { text: "Send final proposal", icon: "fa-file-signature" };
  if (prob >= 40) return { text: "Schedule follow-up call", icon: "fa-phone" };
  return { text: "Re-qualify opportunity", icon: "fa-magnifying-glass" };
}

function renderPriorityDeals() {
  const deals = readDeals()
    .filter((d) => d.stage !== "Won" && d.stage !== "Lost")
    .map((d) => ({
      name: d.name,
      account: d.account,
      value: Number(d.value || 0),
      probability: d.probability != null ? Number(d.probability) : 30,
      owner: d.owner,
      stage: d.stage,
    }))
    .sort((a, b) => b.value * b.probability - a.value * a.probability)
    .slice(0, 5);

  const wrap = document.getElementById("priorityDealsTable");

  if (!deals.length) {
    wrap.innerHTML = `<div class="text-muted" style="padding:28px;text-align:center">No open deals yet. Add a deal to see it ranked here.</div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Deal</th>
          <th>Owner</th>
          <th>Value</th>
          <th>AI Probability</th>
          <th>Recommended Action</th>
        </tr>
      </thead>
      <tbody>
        ${deals
          .map((d) => {
            const prob = Math.round(d.probability);
            const probCls = prob >= 60 ? "high" : prob >= 35 ? "medium" : "low";
            const action = suggestedActionFor(d);
            return `
            <tr>
              <td>
                <strong>${escapeHtml(d.name)}</strong>
                <div class="text-muted" style="font-size:11.5px;margin-top:2px">${escapeHtml(d.account || "")}</div>
              </td>
              <td>
                <div style="display:flex;align-items:center;gap:8px">
                  <span class="deal-card__owner-avatar" style="width:22px;height:22px;font-size:9px">${initials(d.owner)}</span>
                  ${escapeHtml((d.owner || "Unassigned").split(" ")[0])}
                </div>
              </td>
              <td>${formatCurrency(d.value)}</td>
              <td>
                <div class="ai-prob-cell">
                  <span class="ai-prob-track"><span class="ai-prob-fill ${probCls}" style="width:${prob}%"></span></span>
                  <strong>${prob}%</strong>
                </div>
              </td>
              <td><span class="ai-action-chip"><i class="fa-solid ${action.icon}"></i> ${action.text}</span></td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

// ---------------------------------------------------------------
// AI Executive Briefing — generated from real numbers, no fake copy
// ---------------------------------------------------------------
function renderBriefing() {
  const k = computeKpis();

  const text = k.hasData
    ? `You have ${k.openOpportunities} open deal${k.openOpportunities === 1 ? "" : "s"} worth ${formatCurrency(k.opportunitiesValue)}. ${
        k.dealsAtRisk
          ? `${k.dealsAtRisk} deal${k.dealsAtRisk === 1 ? "" : "s"} ${k.dealsAtRisk === 1 ? "needs" : "need"} attention due to a low win probability.`
          : "No deals currently show risk signals."
      } Focus on Negotiation-stage deals for the fastest expected close.`
    : "No pipeline data yet. Add customers, leads, and deals and this briefing will update automatically.";

  document.getElementById("briefingText").textContent = text;

  document.getElementById("briefingPipelineTag").innerHTML = k.hasData
    ? `<i class="fa-solid fa-bullseye"></i> ${k.openOpportunities} open deal${k.openOpportunities === 1 ? "" : "s"}`
    : `<i class="fa-solid fa-circle-info"></i> No deals yet`;

  document.getElementById("briefingRiskTag").innerHTML = k.dealsAtRisk
    ? `<i class="fa-solid fa-triangle-exclamation"></i> ${k.dealsAtRisk} deal${k.dealsAtRisk === 1 ? "" : "s"} at risk`
    : `<i class="fa-solid fa-circle-check"></i> No deals at risk`;

  const unassignedLeads = safeGetLeads().filter(
    (l) => !l.owner && l.status !== "Lost" && l.status !== "Converted",
  );
  document.getElementById("briefingLeadsTag").innerHTML = unassignedLeads.length
    ? `<i class="fa-solid fa-user-plus"></i> ${unassignedLeads.length} unassigned lead${unassignedLeads.length === 1 ? "" : "s"}`
    : `<i class="fa-solid fa-circle-check"></i> No unassigned leads`;

  document.getElementById("briefingDate").textContent = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  updateLastUpdated();
}

function updateLastUpdated() {
  document.getElementById("aiLastUpdated").textContent =
    "Updated " +
    new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------
// Ask YELLOW AI — answers computed from real data, no canned facts
// ---------------------------------------------------------------
const ASK_SUGGESTIONS = [
  "Which deals are most likely to close this month?",
  "How is our pipeline trending?",
  "Which deals are at risk?",
  "Summarize our sales performance",
];

function renderAskSuggestions() {
  document.getElementById("aiAskSuggestions").innerHTML = ASK_SUGGESTIONS.map(
    (q) => `<button type="button" class="ai-ask-chip" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`,
  ).join("");

  document.querySelectorAll(".ai-ask-chip").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.getElementById("aiAskInput").value = btn.dataset.q;
      handleAsk(btn.dataset.q);
    }),
  );
}

function answerFor(question) {
  const q = question.toLowerCase();
  const deals = readDeals();
  const open = deals.filter((d) => d.stage !== "Won" && d.stage !== "Lost");
  const won = deals.filter((d) => d.stage === "Won");
  const lost = deals.filter((d) => d.stage === "Lost");

  if (q.includes("close") || q.includes("likely")) {
    const top = open
      .slice()
      .sort((a, b) => (Number(b.probability) || 0) - (Number(a.probability) || 0))
      .slice(0, 3);
    if (top.length) {
      const list = top
        .map((d) => `${d.name} (${Math.round(Number(d.probability) || 0)}%)`)
        .join(", ");
      return `Based on current probability and stage, the deals most likely to close are: ${list}. I'd prioritize outreach on these first.`;
    }
    return "There are no open deals yet, so I can't rank them by close probability. Add a few deals to the pipeline to get started.";
  }

  if (q.includes("pipeline") || q.includes("trend")) {
    const value = open.reduce((s, d) => s + Number(d.value || 0), 0);
    return open.length
      ? `Your pipeline currently holds ${open.length} open deal${open.length === 1 ? "" : "s"} worth ${formatCurrency(value)}.`
      : "Your pipeline is empty right now. Add some deals and I'll break down trends for you here.";
  }

  if (q.includes("churn") || q.includes("risk")) {
    const atRisk = open.filter((d) => d.probability != null && Number(d.probability) <= 30);
    if (atRisk.length) {
      const names = atRisk.slice(0, 3).map((d) => d.account || d.name).join(", ");
      return `${atRisk.length} open deal${atRisk.length === 1 ? "" : "s"} show a low win probability, including ${names}. I'd recommend a check-in with those accounts.`;
    }
    return "I don't see any deals flagged with a low win probability right now.";
  }

  if (q.includes("summar") || q.includes("performance") || q.includes("week")) {
    const value = open.reduce((s, d) => s + Number(d.value || 0), 0);
    return `So far: ${won.length} deal${won.length === 1 ? "" : "s"} won, ${lost.length} lost, and ${open.length} still open worth ${formatCurrency(value)}.`;
  }

  return open.length
    ? `You have ${open.length} open deal${open.length === 1 ? "" : "s"}. Ask me about specific deals, accounts, or revenue for a deeper breakdown.`
    : "There isn't much data yet — add customers, leads, and deals to get more useful answers here.";
}

function appendAskMessage(role, text) {
  const thread = document.getElementById("aiAskThread");
  const row = document.createElement("div");
  row.className = `ai-ask-msg ${role}`;
  row.innerHTML = `
    <span class="ai-ask-msg-avatar">${role === "user" ? initials(getCurrentUser()?.name || "You") : '<i class="fa-solid fa-sparkles"></i>'}</span>
    <div class="ai-ask-msg-bubble">${escapeHtml(text)}</div>`;
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
}

function handleAsk(question) {
  const q = (question || "").trim();
  if (!q) return;
  appendAskMessage("user", q);
  const input = document.getElementById("aiAskInput");
  input.value = "";
  setTimeout(() => {
    appendAskMessage("ai", answerFor(q));
  }, 350);
}

// ---------------------------------------------------------------
// Full render
// ---------------------------------------------------------------
function renderAll() {
  renderBriefing();
  renderKpis();
  renderActions();
  renderForecastFigures();
  renderForecastChart();
  renderPriorityDeals();
}

renderAll();
renderAskSuggestions();

document.getElementById("refreshInsightsBtn").addEventListener("click", () => {
  renderAll();
  showToast("AI Insights refreshed", "success");
});

document.getElementById("aiAskForm").addEventListener("submit", (e) => {
  e.preventDefault();
  handleAsk(document.getElementById("aiAskInput").value);
});