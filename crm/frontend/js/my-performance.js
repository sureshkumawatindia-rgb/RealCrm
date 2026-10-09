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
  function duration(seconds) {
    if (seconds == null) return "—";
    if (seconds < 60) return `${Math.round(seconds)} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return hours < 48 ? `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${Math.round(hours / 24)} days`;
  }
  const rupees = (paise) => `₹${Math.round(Number(paise || 0) / 100).toLocaleString("en-IN")}`;
  const pct = (value) => `${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
  const kpi = (label, value, sub = "", cls = "") => `<div class="stat-card ${cls}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="report-note">${escapeHtml(sub)}</div></div>`;

  function render(me) {
    if (!me) {
      $("perfBody").innerHTML = '<div class="perf-empty">Nothing to show for this period yet.</div>';
      return;
    }
    $("perfBody").innerHTML = `
      <div class="perf-section"><i class="fa-brands fa-whatsapp"></i> WhatsApp</div>
      <div class="stat-grid">
        ${kpi("Chats answered", me.chatsHandled, `${me.messagesSent} ${me.messagesSent === 1 ? "message" : "messages"} sent`)}
        ${kpi("First reply", duration(me.firstResponseMedianSeconds), "median, new chats")}
        ${kpi("Reply time", duration(me.responseMedianSeconds), me.replies ? `median of ${me.replies} ${me.replies === 1 ? "reply" : "replies"}` : "no replies yet")}
        ${kpi("Chats resolved", me.chatsResolved, me.chatsResolved ? `${pct(me.resolutionRatePct)} · ${duration(me.resolutionMedianSeconds)} to resolve` : "chats you closed", "success")}
      </div>
      <div class="perf-section"><i class="fa-solid fa-bullseye"></i> Leads and sales</div>
      <div class="stat-grid">
        ${kpi("New leads", me.leadsCreated)}
        ${kpi("Won", me.won, me.won || me.lost ? `win rate ${pct(me.winRatePct)}` : "")}
        ${kpi("Quotations", me.quotationsSent, `${me.quotationsAccepted} accepted`)}
        ${kpi("Orders", me.orders, rupees(me.orderValuePaise))}
        ${kpi("Collected", rupees(me.collectedPaise), "payments received", "success")}
      </div>
      <div class="perf-section"><i class="fa-solid fa-list-check"></i> Tasks and support</div>
      <div class="stat-grid">
        ${kpi("Tasks done", me.tasksDone)}
        ${kpi("Tickets resolved", me.ticketsResolved)}
      </div>`;
  }

  async function load() {
    const period = $("perfPeriod").value;
    try {
      const { from, to } = rangeOf(period);
      render((await crmApi(`/reports/me?from=${from}&to=${to}`)).me);
      setPreference("myPerformancePeriod", period);
    } catch (error) {
      $("perfBody").innerHTML = `<div class="perf-empty">${escapeHtml(apiErrorMessage(error, "Couldn't load your figures."))}</div>`;
    }
  }

  $("perfPeriod").value = getPreference("myPerformancePeriod", "30");
  $("perfPeriod").addEventListener("change", load);
  load();
})();
