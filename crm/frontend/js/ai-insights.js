/**
 * ai-insights.js — AI Insights (Phase 9: on the server's numbers)
 * Everything comes from GET /reports/insights, counted on the server from all records: the open
 * pipeline and its weighted forecast (stage probability), leads that need attention (no activity
 * for 14 days, or a quotation waiting 7), leads in Negotiation, leads without an owner, chats
 * waiting 2 hours or more, money due for more than 30 days, the win rate and reply time of the
 * last 90 days, and the leads worth most (value × probability) with a next step.
 * D81: each of those leads also has a win chance learned from the company's own closed leads (with
 * how many similar ones were won, or "not enough history"), and a next step from its own facts.
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
  const count = (n, key) => t(`${key}.${n === 1 ? "one" : "many"}`, { n }); // "1 lead", "2 leads"
  const initials = (name) => String(name || "?").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
  const duration = (seconds) => crmDuration(seconds, "");

  // --- KPI cards ----------------------------------------------------------------------------
  function renderKpis() {
    const p = data.pipeline;
    const l90 = data.last90Days;
    const cards = [
      {
        icon: "fa-chart-line", iconCls: "success", label: t("aiin.weighted-pipeline-forecast"), value: rupees(p.weightedPaise),
        sub: p.open ? `<i class="fa-solid fa-chart-simple"></i> ${escapeHtml(t("aiin.kpi.forecastFrom", { leads: count(p.open, "aiin.n.openLead") }))}` : t("aiin.noOpenYet"), subCls: p.open ? "info" : "neutral",
      },
      { icon: "fa-bullseye", iconCls: "info", label: t("aiin.open-opportunities"), value: p.open, sub: p.open ? t("aiin.in-the-open-pipeline", { v: rupees(p.valuePaise) }) : t("aiin.add-leads-to-see-the-pipeline"), subCls: "info" },
      {
        icon: "fa-triangle-exclamation", iconCls: "warning", label: t("aiin.need-attention"), value: data.atRisk.count,
        sub: data.atRisk.count ? t("aiin.idle-14-days-or-a-quote", { v: rupees(data.atRisk.valuePaise) }) : t("aiin.noIdle"), subCls: data.atRisk.count ? "warning" : "success",
      },
      {
        icon: "fa-trophy", iconCls: "brand", label: t("aiin.win-rate-last-90-days"), value: l90.won + l90.lost ? `${l90.winRatePct}%` : "—",
        sub: l90.won + l90.lost ? t("aiin.won-lost-collected", { won: l90.won, lost: l90.lost, v: rupees(l90.collectedPaise) }) : t("aiin.no-lead-won-or-lost-yet"),
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
        priority: "high", title: t("aiin.answer-the-customers-who-are-waiting"),
        text: t(data.slowChats.length === 1 ? "aiin.act.chats.one" : "aiin.act.chats.many", { n: data.slowChats.length, customer: oldest.customer || t("aiin.aCustomer"), hours: oldest.waitingHours, who: oldest.assignee ? `, ${oldest.assignee}` : t("aiin.notTaken") }),
        meta: t("aiin.impact-high-effort-low"), link: "Inbox.html",
      });
    }
    if (data.negotiation.count) {
      actions.push({
        priority: "high", title: t("aiin.act.negotiation", { stage: crmLabel("stage", "Negotiation") }),
        text: t(data.negotiation.count === 1 ? "aiin.act.negotiationText.one" : "aiin.act.negotiationText.many", { n: data.negotiation.count, value: rupees(data.negotiation.valuePaise), stage: crmLabel("stage", "Negotiation") }),
        meta: t("aiin.impact-high-effort-low"), link: "Deals.html",
      });
    }
    if (data.atRisk.count) {
      actions.push({
        priority: "high", title: t("aiin.wake-up-idle-leads"),
        text: t(data.atRisk.count === 1 ? "aiin.act.idle.one" : "aiin.act.idle.many", { n: data.atRisk.count, value: rupees(data.atRisk.valuePaise) }),
        meta: t("aiin.impact-high-effort-medium"), link: "leads.html",
      });
    }
    if (data.dues.over30Paise) {
      actions.push({
        priority: "medium", title: t("aiin.collect-money-due-for-over-a"),
        text: t("aiin.act.dues", { over30: rupees(data.dues.over30Paise), due: rupees(data.dues.duePaise), list: t("orders.tab.dues") }),
        meta: t("aiin.impact-medium-effort-low"), link: "Orders.html?tab=dues",
      });
    }
    if (data.unassignedLeads) {
      actions.push({
        priority: "medium", title: t("aiin.give-unowned-leads-to-someone"),
        text: t(data.unassignedLeads === 1 ? "aiin.act.unowned.one" : "aiin.act.unowned.many", { n: data.unassignedLeads }),
        meta: t("aiin.impact-medium-effort-low"), link: "leads.html",
      });
    }
    if (!actions.length) {
      actions.push({ priority: "low", title: t("aiin.you-re-all-caught-up"), text: t("aiin.no-chat-is-waiting-no-lead"), meta: t("aiin.impact-effort") });
    }
    return actions.slice(0, 4);
  }

  function renderActions() {
    const label = { high: t("aiin.high-priority"), medium: t("aiin.medium-priority"), low: t("aiin.low-priority") };
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
            ${a.link ? `<a class="ai-action-meta" href="${escapeHtml(a.link)}">${escapeHtml(t("dash.open"))} <i class="fa-solid fa-arrow-right"></i></a>` : ""}
          </div>
        </div>
      </div>`)
      .join("");
  }

  // --- the pipeline by stage ----------------------------------------------------------------
  function renderForecast() {
    const p = data.pipeline;
    $("forecastValue").textContent = rupees(p.weightedPaise);
    $("forecastValueSub").textContent = p.open ? t("aiin.weighted-by-stage-probability") : t("aiin.no-open-leads-yet");
    $("forecastOpenCount").textContent = p.open;
    $("forecastOpenSub").textContent = p.open ? t("aiin.total-value", { v: rupees(p.valuePaise) }) : t("aiin.across-all-stages");
    const svg = $("forecastChart");
    if (!p.open) {
      svg.innerHTML = `<text x="280" y="100" text-anchor="middle" fill="var(--text-faint)" font-size="13">${escapeHtml(t("aiin.chartEmpty"))}</text>`;
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
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(h, 0)}" rx="6" fill="var(--brand-darker)" opacity="${0.5 + i * 0.13}"><title>${escapeHtml(t(s.count === 1 ? "aiin.bar.one" : "aiin.bar.many", { stage: crmLabel("stage", s.stage), n: s.count, value: rupees(s.valuePaise) }))}</title></rect>
        <text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-size="10.5" fill="var(--text-faint)">${s.valuePaise ? escapeHtml(rupees(s.valuePaise)) : s.count ? escapeHtml(count(s.count, "aiin.n.lead")) : ""}</text>`;
    }).join("");
    svg.innerHTML = `<line x1="0" y1="${height - padBottom}" x2="${width}" y2="${height - padBottom}" stroke="var(--border-soft)" stroke-width="1" />${bars}`;
    $("forecastMonths").innerHTML = stages.map((s) => `<span>${escapeHtml(crmLabel("stage", s.stage))} (${s.count})</span>`).join("");
  }

  // --- the leads worth most -----------------------------------------------------------------
  function renderPriority() {
    const rows = data.priority;
    if (!rows.length) {
      $("priorityDealsTable").innerHTML = `<div class="text-muted" style="padding:28px;text-align:center">${escapeHtml(t("aiin.priorityEmpty"))}</div>`;
      return;
    }
    $("priorityDealsTable").innerHTML = `
      <table>
        <thead><tr><th>${escapeHtml(t("dash.add.lead"))}</th><th>${escapeHtml(t("leads.col.owner"))}</th><th>${escapeHtml(t("board.field.lead.value"))}</th><th>${escapeHtml(t("ins.win.head"))}</th><th>${escapeHtml(t("aiin.next-step"))}</th></tr></thead>
        <tbody>${rows.map((r) => {
          const pct = r.win?.enough ? r.win.pct : r.probability;
          const cls = pct >= 60 ? "high" : pct >= 35 ? "medium" : "low";
          return `<tr>
            <td><strong>${escapeHtml(r.customer || r.title)}</strong><div class="text-muted" style="font-size:11.5px;margin-top:2px">${escapeHtml([r.company, r.title, crmLabel("stage", r.stage), r.idleDays >= 7 ? t("aiin.idleDays", { n: r.idleDays }) : ""].filter(Boolean).join(" · "))}</div></td>
            <td><div style="display:flex;align-items:center;gap:8px"><span class="deal-card__owner-avatar" style="width:22px;height:22px;font-size:9px">${escapeHtml(initials(r.owner))}</span>${escapeHtml(r.owner ? r.owner.split(" ")[0] : t("pipe.noOwner"))}</div></td>
            <td>${r.valuePaise ? rupees(r.valuePaise) : "—"}</td>
            <td><div class="ai-prob-cell${r.win?.enough ? "" : " ai-prob-stage"}"><span class="ai-prob-track"><span class="ai-prob-fill ${cls}" style="width:${pct}%"></span></span><strong>${pct}%</strong></div>${winWhy(r)}</td>
            <td><span class="ai-action-chip"><i class="fa-solid fa-arrow-right"></i> ${escapeHtml(nextActionText(r))}</span></td>
          </tr>`;
        }).join("")}</tbody>
      </table>
      ${data.winModel ? `<p class="ai-win-note">${escapeHtml(t("ins.win.note", { won: data.winModel.won, closed: data.winModel.closed, min: data.winModel.minSimilar }))}</p>` : ""}`;
  }

  // Why this win chance (D81): how many similar closed leads were won, or why there is no number yet.
  function winWhy(r) {
    if (!r.win) return "";
    const text = r.win.enough
      ? t("ins.win.similar", { won: r.win.won, n: r.win.similar, by: t(`ins.win.by.${r.win.by.join("_")}`) })
      : t("ins.win.notEnough", { pct: r.probability, n: r.win.similar, needed: r.win.needed });
    return `<div class="ai-win-why">${escapeHtml(text)}</div>`;
  }

  // The next step from the lead's own facts (D81), in the page's language.
  const STAGE_KEYS = { New: "new", Contacted: "contacted", "Quote Sent": "quote_sent", Negotiation: "negotiation" };
  function nextActionText(r) {
    const a = r.nextAction;
    if (!a) return r.nextStep;
    if (a.code === "follow_up_due") return t(a.days ? "ins.next.follow_up_due" : "ins.next.follow_up_today", { days: a.days });
    if (a.code === "stage") return STAGE_KEYS[a.stage] ? t(`ins.next.stage.${STAGE_KEYS[a.stage]}`) : r.nextStep;
    return t(`ins.next.${a.code}`, { days: a.days });
  }

  // --- the briefing -------------------------------------------------------------------------------
  function renderBriefing() {
    const p = data.pipeline;
    const l90 = data.last90Days;
    const parts = [];
    if (p.open) parts.push(t("aiin.brief.open", { leads: count(p.open, "aiin.n.openLead"), value: rupees(p.valuePaise), weighted: rupees(p.weightedPaise) }));
    else parts.push(t("aiin.there-are-no-open-leads-yet"));
    if (data.atRisk.count) parts.push(t(data.atRisk.count === 1 ? "aiin.brief.nudge.one" : "aiin.brief.nudge.many", { n: data.atRisk.count }));
    if (data.slowChats.length) parts.push(t(data.slowChats.length === 1 ? "aiin.brief.waiting.one" : "aiin.brief.waiting.many", { n: data.slowChats.length }));
    if (l90.won + l90.lost) parts.push(t("aiin.brief.won", { won: l90.won, closed: l90.won + l90.lost, pct: l90.winRatePct, reply: l90.responseMedianSeconds != null ? t("aiin.brief.reply", { time: duration(l90.responseMedianSeconds) }) : "" }));
    if (data.dues.duePaise) parts.push(t("aiin.is-due-from-customers", { v: rupees(data.dues.duePaise) }));
    $("briefingText").textContent = parts.join(" ");
    $("briefingPipelineTag").innerHTML = p.open ? `<i class="fa-solid fa-bullseye"></i> ${escapeHtml(count(p.open, "aiin.n.openLead"))}` : `<i class="fa-solid fa-circle-info"></i> ${escapeHtml(t("aiin.tag.noOpen"))}`;
    $("briefingRiskTag").innerHTML = data.atRisk.count ? `<i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(t(data.atRisk.count === 1 ? "aiin.tag.attention.one" : "aiin.tag.attention.many", { n: data.atRisk.count }))}` : `<i class="fa-solid fa-circle-check"></i> ${escapeHtml(t("aiin.noIdle"))}`;
    $("briefingLeadsTag").innerHTML = data.unassignedLeads ? `<i class="fa-solid fa-user-plus"></i> ${escapeHtml(count(data.unassignedLeads, "aiin.n.unownedLead"))}` : `<i class="fa-solid fa-circle-check"></i> ${escapeHtml(t("aiin.tag.allOwned"))}`;
    $("briefingDate").textContent = new Date().toLocaleDateString(crmI18n.locale(), { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
    $("aiLastUpdated").textContent = t("teamlive.updated", { v: new Date(data.generatedAt).toLocaleTimeString(crmI18n.locale(), { hour: "2-digit", minute: "2-digit" }) });
  }

  // --- "Ask": answers from the same numbers -----------------------------------------------------
  // What it answers: each topic's suggestion (the key of its text) and the words that ask for it in
  // English, Hindi and Hinglish (D116). A suggestion chip names its topic itself.
  const TOPICS = [
    { id: "close", key: "aiin.q.close", words: /close|likely|best|top|priority|pakki|sabse|पक्की|सबसे|जीत/ },
    { id: "attention", key: "aiin.q.attention", words: /risk|attention|idle|stuck|dhyan|ruki|atki|ध्यान|रुकी|अटकी|खतरा/ },
    { id: "waiting", key: "aiin.q.waiting", words: /wait|reply|chat|whatsapp|respon|jawab|intezar|intazar|इंतजार|जवाब|चैट/ },
    { id: "due", key: "aiin.q.due", words: /due|money|payment|collect|owe|paisa|paise|baki|baaki|bakaya|udhar|बाकी|बकाया|पैसा|पैसे|भुगतान|वसूल|उधार/ },
    { id: "summary", key: "aiin.q.summary", words: /summar|perform|sales|pipeline|week|month|bikri|saransh|सारांश|बिक्री|सेल्स|हफ्त|महीन/ },
  ];
  // A typed question's words, small and without the nukta dot (ज़ is ज), for TOPICS.
  const plain = (text) => text.normalize("NFD").replace(/\u093C/g, "").toLowerCase();
  function answerFor(question, topic = TOPICS.find((x) => x.words.test(plain(question)))?.id) {
    if (!data) return t("aiin.ask.loading");
    const p = data.pipeline;
    if (topic === "close") {
      const top = data.priority.filter((r) => r.valuePaise || r.probability >= 50).slice(0, 3);
      return top.length
        ? t("aiin.ask.top", { leads: top.map((r) => `${r.customer || r.title} (${crmLabel("stage", r.stage)}${r.valuePaise ? `, ${rupees(r.valuePaise)}` : ""})`).join("; "), steps: top.map((r) => nextActionText(r).toLowerCase()).join("; ") })
        : t("aiin.no-open-lead-stands-out-yet");
    }
    if (topic === "attention") {
      return data.atRisk.count
        ? t(data.atRisk.count === 1 ? "aiin.ask.attention.one" : "aiin.ask.attention.many", { n: data.atRisk.count, leads: data.atRisk.items.slice(0, 3).map((r) => t("aiin.ask.idleLead", { name: r.customer || r.title, days: r.idleDays, stage: crmLabel("stage", r.stage) })).join("; ") })
        : t("aiin.no-open-lead-has-been-idle");
    }
    if (topic === "waiting") {
      return data.slowChats.length
        ? t(data.slowChats.length === 1 ? "aiin.ask.waiting.one" : "aiin.ask.waiting.many", { n: data.slowChats.length, chats: data.slowChats.slice(0, 5).map((c) => `${c.customer || t("aiin.aCustomer")} (${t("aiin.hours", { n: c.waitingHours })}${c.assignee ? `, ${c.assignee}` : ""})`).join("; "), median: data.last90Days.responseMedianSeconds != null ? t("aiin.ask.median", { time: duration(data.last90Days.responseMedianSeconds) }) : "" })
        : t("aiin.nobody-has-been-waiting-2-hours");
    }
    if (topic === "due") {
      return data.dues.duePaise
        ? t("aiin.ask.due", { value: rupees(data.dues.duePaise), orders: count(data.dues.orders, "aiin.n.order"), over30: rupees(data.dues.over30Paise), collected: rupees(data.last90Days.collectedPaise) })
        : t("aiin.ask.nothingDue", { collected: rupees(data.last90Days.collectedPaise) });
    }
    if (topic === "summary") {
      const l90 = data.last90Days;
      return t("aiin.ask.summary", { leads: count(p.open, "aiin.n.lead"), value: rupees(p.valuePaise), weighted: rupees(p.weightedPaise), won: l90.won, lost: l90.lost, pct: l90.won + l90.lost ? ` (${l90.winRatePct}%)` : "", collected: rupees(l90.collectedPaise) });
    }
    return t(p.open === 1 ? "aiin.ask.help.one" : "aiin.ask.help.many", { leads: count(p.open, "aiin.n.openLead") });
  }
  function appendMessage(role, text) {
    const thread = $("aiAskThread");
    const row = document.createElement("div");
    row.className = `ai-ask-msg ${role}`;
    row.innerHTML = `<span class="ai-ask-msg-avatar">${role === "user" ? escapeHtml(initials(getCurrentUser()?.name || t("set2.you"))) : '<i class="fa-solid fa-sparkles"></i>'}</span><div class="ai-ask-msg-bubble">${escapeHtml(text)}</div>`;
    thread.appendChild(row);
    thread.scrollTop = thread.scrollHeight;
  }
  function ask(question, topic) {
    const q = String(question || "").trim();
    if (!q) return;
    appendMessage("user", q);
    $("aiAskInput").value = "";
    setTimeout(() => appendMessage("ai", answerFor(q, topic)), 250);
  }
  crmI18n.ready.then(() => {
    $("aiAskSuggestions").innerHTML = TOPICS.map((topic) => `<button type="button" class="ai-ask-chip" data-topic="${topic.id}">${escapeHtml(t(topic.key))}</button>`).join("");
  });
  $("aiAskSuggestions").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-topic]");
    if (chip) ask(chip.textContent, chip.dataset.topic);
  });
  $("aiAskForm").addEventListener("submit", (e) => {
    e.preventDefault();
    ask($("aiAskInput").value);
  });

  // --- loading -----------------------------------------------------------------------------------
  async function load({ toast = false } = {}) {
    try {
      [data] = await Promise.all([crmApi("/reports/insights"), crmI18n.ready]); // the win chance texts (D81)
    } catch (error) {
      $("briefingText").textContent = apiErrorMessage(error, t("aiin.couldn-t-load-the-insights"));
      return;
    }
    renderBriefing();
    renderKpis();
    renderActions();
    renderForecast();
    renderPriority();
    if (toast) showToast(t("aiin.ai-insights-refreshed"), "success");
  }
  $("refreshInsightsBtn").addEventListener("click", () => load({ toast: true }));
  load();
})();
