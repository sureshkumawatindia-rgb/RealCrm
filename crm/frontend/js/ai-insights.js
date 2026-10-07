/**
 * ai-insights.js — AI Insights (Phase 9: on the server's numbers)
 * Everything comes from GET /reports/insights, counted on the server from all records: the open
 * pipeline and its weighted forecast (stage probability), leads that need attention (no activity
 * for 14 days, or a quotation waiting 7), leads in Negotiation, leads without an owner, chats
 * waiting 2 hours or more, money due for more than 30 days, the win rate and reply time of the
 * last 90 days, and the leads worth most (value × probability) with a next step.
 * The "Ask" box answers from the same numbers; it does not call a language model (an optional
 * Claude assistant comes with Phase 10). Agents see their own figures. One IIFE: no globals.
 */
(function aiInsightsPage() {
  requireAuth();
  renderSidebarUser();
  initSidebarToggle();

  const $ = (id) => document.getElementById(id);
  let data = null;

  const rupees = (paise) => `₹${Math.round(Number(paise || 0) / 100).toLocaleString("en-IN")}`;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const initials = (name) => String(name || "?").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
  function duration(seconds) {
    if (seconds == null) return "";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }

  // --- KPI cards ----------------------------------------------------------------------------
  function renderKpis() {
    const p = data.pipeline;
    const l90 = data.last90Days;
    const cards = [
      {
        icon: "fa-chart-line", iconCls: "success", label: "Weighted pipeline forecast", value: rupees(p.weightedPaise),
        sub: p.open ? `<i class="fa-solid fa-chart-simple"></i> From ${plural(p.open, "open lead")} × stage probability` : "No open leads yet", subCls: p.open ? "info" : "neutral",
      },
      { icon: "fa-bullseye", iconCls: "info", label: "Open opportunities", value: p.open, sub: p.open ? `${rupees(p.valuePaise)} in the open pipeline` : "Add leads to see the pipeline", subCls: "info" },
      {
        icon: "fa-triangle-exclamation", iconCls: "warning", label: "Need attention", value: data.atRisk.count,
        sub: data.atRisk.count ? `${rupees(data.atRisk.valuePaise)} idle 14 days or a quote waiting 7` : "No idle leads", subCls: data.atRisk.count ? "warning" : "success",
      },
      {
        icon: "fa-trophy", iconCls: "brand", label: "Win rate, last 90 days", value: l90.won + l90.lost ? `${l90.winRatePct}%` : "—",
        sub: l90.won + l90.lost ? `${l90.won} won, ${l90.lost} lost · ${rupees(l90.collectedPaise)} collected` : "No lead won or lost yet",
        subCls: l90.won + l90.lost ? (l90.winRatePct >= 30 ? "success" : "warning") : "neutral",
      },
    ];
    $("aiKpiGrid").innerHTML = cards
      .map((c) => `
      <div class="stat-card">
        <div class="ai-kpi-card-head">
          <div class="label">${escapeHtml(c.label)}</div>
          <div class="ai-kpi-icon ${c.iconCls}"><i class="fa-solid ${c.icon}"></i></div>
        </div>
        <div class="value">${escapeHtml(String(c.value))}</div>
        <div class="ai-kpi-sub ${c.subCls}">${c.sub}</div>
      </div>`)
      .join("");
  }

  // --- recommended actions ---------------------------------------------------------------------
  function buildActions() {
    const actions = [];
    if (data.slowChats.length) {
      const oldest = data.slowChats[0];
      actions.push({
        priority: "high", title: "Answer the customers who are waiting",
        text: `${plural(data.slowChats.length, "chat")} ${data.slowChats.length === 1 ? "has" : "have"} waited 2 hours or more for a reply — the longest is ${oldest.customer || "a customer"} (${oldest.waitingHours} h${oldest.assignee ? `, ${oldest.assignee}` : ", not taken yet"}).`,
        meta: "Impact: High · Effort: Low", link: "Inbox.html",
      });
    }
    if (data.negotiation.count) {
      actions.push({
        priority: "high", title: "Close the leads in Negotiation",
        text: `${plural(data.negotiation.count, "lead")} worth ${rupees(data.negotiation.valuePaise)} ${data.negotiation.count === 1 ? "is" : "are"} in Negotiation. Send a payment link or the final quotation this week.`,
        meta: "Impact: High · Effort: Low", link: "Deals.html",
      });
    }
    if (data.atRisk.count) {
      actions.push({
        priority: "high", title: "Wake up idle leads",
        text: `${plural(data.atRisk.count, "open lead")} worth ${rupees(data.atRisk.valuePaise)} had no activity for 14 days or wait 7 days on a quotation. Call them or send a follow-up template.`,
        meta: "Impact: High · Effort: Medium", link: "leads.html",
      });
    }
    if (data.dues.over30Paise) {
      actions.push({
        priority: "medium", title: "Collect money due for over a month",
        text: `${rupees(data.dues.over30Paise)} has been due for more than 30 days (of ${rupees(data.dues.duePaise)} due in all). Send payment links from the Payment due list.`,
        meta: "Impact: Medium · Effort: Low", link: "Orders.html?tab=dues",
      });
    }
    if (data.unassignedLeads) {
      actions.push({
        priority: "medium", title: "Give unowned leads to someone",
        text: `${plural(data.unassignedLeads, "open lead")} ${data.unassignedLeads === 1 ? "has" : "have"} no owner. Assignment rules (Settings → Lead rules) can do this by themselves.`,
        meta: "Impact: Medium · Effort: Low", link: "leads.html",
      });
    }
    if (!actions.length) {
      actions.push({ priority: "low", title: "You're all caught up", text: "No chat is waiting, no lead is idle and nothing is long overdue. Check back after more activity.", meta: "Impact: — · Effort: —" });
    }
    return actions.slice(0, 4);
  }

  function renderActions() {
    const label = { high: "High priority", medium: "Medium priority", low: "Low priority" };
    const badge = { high: "badge-priority-high", medium: "badge-priority-medium", low: "badge-priority-low" };
    $("aiActionsList").innerHTML = buildActions()
      .map((a) => `
      <div class="ai-action-item">
        <span class="ai-action-priority ${a.priority}"></span>
        <div class="ai-action-body">
          <div class="ai-action-top">
            <span class="ai-action-title">${escapeHtml(a.title)}</span>
            <span class="badge ${badge[a.priority]}">${label[a.priority]}</span>
          </div>
          <div class="ai-action-text">${escapeHtml(a.text)}</div>
          <div class="ai-action-foot">
            <span class="ai-action-meta"><i class="fa-solid fa-sparkles"></i> ${escapeHtml(a.meta)}</span>
            ${a.link ? `<a class="ai-action-meta" href="${escapeHtml(a.link)}">Open <i class="fa-solid fa-arrow-right"></i></a>` : ""}
          </div>
        </div>
      </div>`)
      .join("");
  }

  // --- the pipeline by stage ----------------------------------------------------------------
  function renderForecast() {
    const p = data.pipeline;
    $("forecastValue").textContent = rupees(p.weightedPaise);
    $("forecastValueSub").textContent = p.open ? "Weighted by stage probability" : "No open leads yet";
    $("forecastOpenCount").textContent = p.open;
    $("forecastOpenSub").textContent = p.open ? `${rupees(p.valuePaise)} total value` : "Across all stages";
    const svg = $("forecastChart");
    if (!p.open) {
      svg.innerHTML = '<text x="280" y="100" text-anchor="middle" fill="var(--text-faint)" font-size="13">No open leads yet — add some to see this chart.</text>';
      $("forecastMonths").innerHTML = "";
      return;
    }
    const width = 560;
    const height = 190;
    const padTop = 14;
    const padBottom = 24;
    const stages = p.byStage;
    const max = Math.max(...stages.map((s) => s.valuePaise), 1) * 1.15;
    const gap = 24;
    const barWidth = width / stages.length - gap;
    const bars = stages.map((s, i) => {
      const h = (s.valuePaise / max) * (height - padTop - padBottom);
      const x = i * (barWidth + gap) + gap / 2;
      const y = height - padBottom - h;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(h, 0)}" rx="6" fill="var(--brand-darker)" opacity="${0.5 + i * 0.13}"><title>${escapeHtml(`${s.stage}: ${s.count} leads, ${rupees(s.valuePaise)}`)}</title></rect>
        <text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-size="10.5" fill="var(--text-faint)">${s.valuePaise ? escapeHtml(rupees(s.valuePaise)) : s.count ? `${s.count} lead${s.count === 1 ? "" : "s"}` : ""}</text>`;
    }).join("");
    svg.innerHTML = `<line x1="0" y1="${height - padBottom}" x2="${width}" y2="${height - padBottom}" stroke="var(--border-soft)" stroke-width="1" />${bars}`;
    $("forecastMonths").innerHTML = stages.map((s) => `<span>${escapeHtml(s.stage)} (${s.count})</span>`).join("");
  }

  // --- the leads worth most -----------------------------------------------------------------
  function renderPriority() {
    const rows = data.priority;
    if (!rows.length) {
      $("priorityDealsTable").innerHTML = '<div class="text-muted" style="padding:28px;text-align:center">No open leads yet. New enquiries show up here ranked by value and stage.</div>';
      return;
    }
    $("priorityDealsTable").innerHTML = `
      <table>
        <thead><tr><th>Lead</th><th>Owner</th><th>Value</th><th>Stage probability</th><th>Next step</th></tr></thead>
        <tbody>${rows.map((r) => {
          const cls = r.probability >= 60 ? "high" : r.probability >= 35 ? "medium" : "low";
          return `<tr>
            <td><strong>${escapeHtml(r.customer || r.title)}</strong><div class="text-muted" style="font-size:11.5px;margin-top:2px">${escapeHtml([r.company, r.title, r.stage, r.idleDays >= 7 ? `idle ${r.idleDays} days` : ""].filter(Boolean).join(" · "))}</div></td>
            <td><div style="display:flex;align-items:center;gap:8px"><span class="deal-card__owner-avatar" style="width:22px;height:22px;font-size:9px">${escapeHtml(initials(r.owner))}</span>${escapeHtml(r.owner ? r.owner.split(" ")[0] : "Nobody yet")}</div></td>
            <td>${r.valuePaise ? rupees(r.valuePaise) : "—"}</td>
            <td><div class="ai-prob-cell"><span class="ai-prob-track"><span class="ai-prob-fill ${cls}" style="width:${r.probability}%"></span></span><strong>${r.probability}%</strong></div></td>
            <td><span class="ai-action-chip"><i class="fa-solid fa-arrow-right"></i> ${escapeHtml(r.nextStep)}</span></td>
          </tr>`;
        }).join("")}</tbody>
      </table>`;
  }

  // --- the briefing -------------------------------------------------------------------------------
  function renderBriefing() {
    const p = data.pipeline;
    const l90 = data.last90Days;
    const parts = [];
    if (p.open) parts.push(`You have ${plural(p.open, "open lead")} worth ${rupees(p.valuePaise)}; weighted by stage that is ${rupees(p.weightedPaise)}.`);
    else parts.push("There are no open leads yet: new WhatsApp enquiries and lead sources will fill this in.");
    if (data.atRisk.count) parts.push(`${plural(data.atRisk.count, "lead")} ${data.atRisk.count === 1 ? "needs" : "need"} a nudge.`);
    if (data.slowChats.length) parts.push(`${plural(data.slowChats.length, "customer")} ${data.slowChats.length === 1 ? "is" : "are"} waiting for a reply.`);
    if (l90.won + l90.lost) parts.push(`In the last 90 days you won ${l90.won} of ${l90.won + l90.lost} closed leads (${l90.winRatePct}%)${l90.responseMedianSeconds != null ? ` and replied on WhatsApp in ${duration(l90.responseMedianSeconds)} (median)` : ""}.`);
    if (data.dues.duePaise) parts.push(`${rupees(data.dues.duePaise)} is due from customers.`);
    $("briefingText").textContent = parts.join(" ");
    $("briefingPipelineTag").innerHTML = p.open ? `<i class="fa-solid fa-bullseye"></i> ${escapeHtml(plural(p.open, "open lead"))}` : '<i class="fa-solid fa-circle-info"></i> No open leads';
    $("briefingRiskTag").innerHTML = data.atRisk.count ? `<i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(plural(data.atRisk.count, "lead"))} need attention` : '<i class="fa-solid fa-circle-check"></i> No idle leads';
    $("briefingLeadsTag").innerHTML = data.unassignedLeads ? `<i class="fa-solid fa-user-plus"></i> ${escapeHtml(plural(data.unassignedLeads, "unowned lead"))}` : '<i class="fa-solid fa-circle-check"></i> Every lead has an owner';
    $("briefingDate").textContent = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
    $("aiLastUpdated").textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
  }

  // --- "Ask": answers from the same numbers -----------------------------------------------------
  const SUGGESTIONS = ["Which leads are most likely to close?", "Which leads need attention?", "Who is waiting for a reply?", "How much money is due?", "Summarize our sales"];
  function answerFor(question) {
    const q = question.toLowerCase();
    if (!data) return "The numbers are still loading. Ask again in a moment.";
    const p = data.pipeline;
    if (/close|likely|best|top|priority/.test(q)) {
      const top = data.priority.filter((r) => r.valuePaise || r.probability >= 50).slice(0, 3);
      return top.length
        ? `The leads worth most right now: ${top.map((r) => `${r.customer || r.title} (${r.stage}${r.valuePaise ? `, ${rupees(r.valuePaise)}` : ""})`).join("; ")}. Next steps: ${top.map((r) => r.nextStep.toLowerCase()).join("; ")}.`
        : "No open lead stands out yet — add values to leads or send quotations so they can be ranked.";
    }
    if (/risk|attention|idle|stuck/.test(q)) {
      return data.atRisk.count
        ? `${plural(data.atRisk.count, "lead")} need attention: ${data.atRisk.items.slice(0, 3).map((r) => `${r.customer || r.title} (idle ${r.idleDays} days, ${r.stage})`).join("; ")}.`
        : "No open lead has been idle for 14 days, and no quotation has waited 7 days.";
    }
    if (/wait|reply|chat|whatsapp|respon/.test(q)) {
      return data.slowChats.length
        ? `${plural(data.slowChats.length, "customer")} waiting 2 hours or more: ${data.slowChats.slice(0, 5).map((c) => `${c.customer || "a customer"} (${c.waitingHours} h${c.assignee ? `, ${c.assignee}` : ""})`).join("; ")}.${data.last90Days.responseMedianSeconds != null ? ` Your median reply time over 90 days is ${duration(data.last90Days.responseMedianSeconds)}.` : ""}`
        : "Nobody has been waiting 2 hours or more for a reply.";
    }
    if (/due|money|payment|collect|owe/.test(q)) {
      return data.dues.duePaise
        ? `${rupees(data.dues.duePaise)} is due on ${plural(data.dues.orders, "order")}, ${rupees(data.dues.over30Paise)} of it for more than 30 days. In the last 90 days ${rupees(data.last90Days.collectedPaise)} came in.`
        : `Nothing is due right now. In the last 90 days ${rupees(data.last90Days.collectedPaise)} came in.`;
    }
    if (/summar|perform|sales|pipeline|week|month/.test(q)) {
      const l90 = data.last90Days;
      return `Open: ${plural(p.open, "lead")} worth ${rupees(p.valuePaise)} (weighted ${rupees(p.weightedPaise)}). Last 90 days: ${l90.won} won, ${l90.lost} lost${l90.won + l90.lost ? ` (${l90.winRatePct}%)` : ""}, ${rupees(l90.collectedPaise)} collected.`;
    }
    return `I can answer about the leads most likely to close, leads that need attention, customers waiting for a reply, money due, or a sales summary. Right now there ${p.open === 1 ? "is" : "are"} ${plural(p.open, "open lead")}.`;
  }
  function appendMessage(role, text) {
    const thread = $("aiAskThread");
    const row = document.createElement("div");
    row.className = `ai-ask-msg ${role}`;
    row.innerHTML = `<span class="ai-ask-msg-avatar">${role === "user" ? escapeHtml(initials(getCurrentUser()?.name || "You")) : '<i class="fa-solid fa-sparkles"></i>'}</span><div class="ai-ask-msg-bubble">${escapeHtml(text)}</div>`;
    thread.appendChild(row);
    thread.scrollTop = thread.scrollHeight;
  }
  function ask(question) {
    const q = String(question || "").trim();
    if (!q) return;
    appendMessage("user", q);
    $("aiAskInput").value = "";
    setTimeout(() => appendMessage("ai", answerFor(q)), 250);
  }
  $("aiAskSuggestions").innerHTML = SUGGESTIONS.map((q) => `<button type="button" class="ai-ask-chip" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("");
  $("aiAskSuggestions").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-q]");
    if (chip) ask(chip.dataset.q);
  });
  $("aiAskForm").addEventListener("submit", (e) => {
    e.preventDefault();
    ask($("aiAskInput").value);
  });

  // --- loading -----------------------------------------------------------------------------------
  async function load({ toast = false } = {}) {
    try {
      data = await crmApi("/reports/insights");
    } catch (error) {
      $("briefingText").textContent = apiErrorMessage(error, "Couldn't load the insights.");
      return;
    }
    renderBriefing();
    renderKpis();
    renderActions();
    renderForecast();
    renderPriority();
    if (toast) showToast("AI Insights refreshed", "success");
  }
  $("refreshInsightsBtn").addEventListener("click", () => load({ toast: true }));
  load();
})();
