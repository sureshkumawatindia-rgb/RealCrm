/**
 * my-performance.js — My performance (D61): every member sees their own work for a period —
 * chats answered and resolved, reply times, leads, quotations, orders, money collected, tasks and
 * tickets (GET /reports/me). Owners and admins see everyone on Team live and Reports.
 */
(function myPerformance() {
  const $ = (id) => document.getElementById(id);
  const IST_MS = 330 * 60 * 1000;

  const indiaDay = (addDays = 0) => {
    const india = new Date(Date.now() + IST_MS);
    india.setUTCDate(india.getUTCDate() + addDays);
    return india.toISOString().slice(0, 10);
  };
  function rangeOf(period) {
    const to = indiaDay(0);
    if (period === "today") return { from: to, to };
    if (period === "this-month") return { from: `${to.slice(0, 8)}01`, to };
    return { from: indiaDay(1 - Number(period)), to };
  }
  const duration = (seconds) => crmDuration(seconds);
  const rupees = (paise) => `₹${Math.round(Number(paise || 0) / 100).toLocaleString("en-IN")}`;
  const pct = (value) => `${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
  const kpi = (label, value, sub = "", cls = "") => `<div class="stat-card ${cls}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="report-note">${escapeHtml(sub)}</div></div>`;

  function render(me) {
    if (!me) {
      $("perfBody").innerHTML = `<div class="perf-empty">${escapeHtml(t("myperf.nothing-to-show"))}</div>`;
      return;
    }
    $("perfBody").innerHTML = `
      <div class="perf-section"><i class="fa-brands fa-whatsapp"></i> WhatsApp</div>
      <div class="stat-grid">
        ${kpi(t("myperf.chats-answered"), me.chatsHandled, t(me.messagesSent === 1 ? "myperf.message-sent-one" : "myperf.message-sent-many", { n: me.messagesSent }))}
        ${kpi(t("sla.box.reply"), duration(me.firstResponseMedianSeconds), t("myperf.median-new-chats"))}
        ${kpi(t("myperf.reply-time"), duration(me.responseMedianSeconds), me.replies ? t(me.replies === 1 ? "myperf.median-of-one" : "myperf.median-of-many", { n: me.replies }) : t("myperf.no-replies-yet"))}
        ${kpi(t("myperf.chats-resolved"), me.chatsResolved, me.chatsResolved ? t("myperf.to-resolve", { v: pct(me.resolutionRatePct), v2: duration(me.resolutionMedianSeconds) }) : t("myperf.chats-you-closed"), "success")}
        ${kpi(t("wa.csat.label"), me.csatAnswers ? t("myperf.good", { v: pct(me.csatScorePct) }) : "—", me.csatAnswers ? t(me.csatAnswers === 1 ? "teamlive.answer-bad-one" : "teamlive.answer-bad-many", { n: me.csatAnswers, bad: me.csatBad }) : t("myperf.no-answers-yet"))}
      </div>
      <div class="perf-section"><i class="fa-solid fa-bullseye"></i> ${escapeHtml(t("myperf.leads-and-sales"))}</div>
      <div class="stat-grid">
        ${kpi(t("gs.kind.leads"), me.leadsCreated)}
        ${kpi(crmLabel("stage", "Won"), me.won, me.won || me.lost ? t("myperf.win-rate", { v: pct(me.winRatePct) }) : "")}
        ${kpi(t("nav.quotations"), me.quotationsSent, t("myperf.accepted", { n: me.quotationsAccepted }))}
        ${kpi(t("nav.orders"), me.orders, rupees(me.orderValuePaise))}
        ${kpi(t("reports.collected"), rupees(me.collectedPaise), t("dash.kpi.collectedSub"), "success")}
      </div>
      <div class="perf-section"><i class="fa-solid fa-list-check"></i> ${escapeHtml(t("myperf.tasks-and-support"))}</div>
      <div class="stat-grid">
        ${kpi(t("myperf.tasks-done"), me.tasksDone)}
        ${kpi(t("myperf.tickets-resolved"), me.ticketsResolved)}
      </div>`;
  }

  async function load() {
    const period = $("perfPeriod").value;
    try {
      const { from, to } = rangeOf(period);
      render((await crmApi(`/reports/me?from=${from}&to=${to}`)).me);
      setPreference("myPerformancePeriod", period);
    } catch (error) {
      $("perfBody").innerHTML = `<div class="perf-empty">${escapeHtml(apiErrorMessage(error, t("myperf.couldn-t-load-your-figures")))}</div>`;
    }
  }

  $("perfPeriod").value = getPreference("myPerformancePeriod", "30");
  $("perfPeriod").addEventListener("change", load);
  load();
})();
