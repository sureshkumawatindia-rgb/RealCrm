/**
 * reports.js — Reports & Analytics (Phase 9: on the server's numbers)
 * Every figure is for the chosen period (calendar days in India) unless the panel says "now".
 * The KPI row and the tabs come from /reports/* (counted on the server from all records):
 * Overview (trend, won/lost, lead funnel, open pipeline), Sales (quotations), Leads & Marketing
 * (sources, broadcasts; products and campaigns from the loaded records), WhatsApp & Team (agent
 * performance with reply times), Payments, Support (tickets from the loaded records).
 * "Export CSV" downloads the open tab's report from /reports/export. One IIFE: no globals.
 */
(function reportsPage() {
  requireAuth();
  renderSidebarUser();
  initSidebarToggle();

  const $ = (id) => document.getElementById(id);
  const STAGE_COLOR = { New: "var(--info)", Contacted: "var(--brand-darker)", "Quote Sent": "var(--warning)", Negotiation: "#7c3aed", Won: "var(--success)", Lost: "var(--danger)" };
  const TICKET_STATUSES = ["Open", "In Progress", "Waiting on Customer", "Resolved", "Closed"];
  const TICKET_COLOR = { Open: "var(--info)", "In Progress": "var(--brand-darker)", "Waiting on Customer": "var(--warning)", Resolved: "var(--success)", Closed: "var(--text-faint)" };
  const TICKET_PRIORITIES = ["Low", "Medium", "High", "Urgent"];
  const EXPORT_TYPE = { overview: "trend", sales: "quotations", leads: "sources", team: "agents", payments: "payments", support: "overview" };

  const state = { tab: "overview", range: null, series: "collectedPaise", data: {}, seq: 0 };

  // --- formatting ----------------------------------------------------------------------------
  const rupees = (paise) => `₹${Math.round(Number(paise || 0) / 100).toLocaleString("en-IN")}`;
  const pctText = (value) => `${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
  function duration(seconds) {
    if (seconds == null) return "—";
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
    return `${Math.round(hours / 24)} days`;
  }
  const initials = (name) => String(name || "?").replace(/^=/, "").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
  const empty = (icon, text) => `<div class="report-empty"><i class="fa-solid ${icon}"></i>${escapeHtml(text)}</div>`;
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

  // --- the period (days in India) ----------------------------------------------------------
  const indiaToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  function shift(day, days) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function rangeFor(value) {
    const today = indiaToday();
    if (value === "today") return { from: today, to: today };
    if (value === "this-month") return { from: `${today.slice(0, 7)}-01`, to: today };
    if (value === "last-month") {
      const firstThis = `${today.slice(0, 7)}-01`;
      const lastPrev = shift(firstThis, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev };
    }
    if (value === "this-fy") {
      const year = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
      return { from: `${year}-04-01`, to: today };
    }
    if (value === "custom") {
      const from = $("rangeFrom").value || shift(today, -29);
      const to = $("rangeTo").value || today;
      return from <= to ? { from, to } : { from: to, to: from };
    }
    const days = Number(value) || 30;
    return { from: shift(today, -(days - 1)), to: today };
  }
  const query = () => `from=${state.range.from}&to=${state.range.to}`;
  const niceDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  function bucketLabel(bucket, unit) {
    if (unit === "month") return new Date(`${bucket}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
    return new Date(`${bucket}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  }

  // --- loading --------------------------------------------------------------------------------
  const NEEDS = {
    overview: ["overview", "trend", "sources"], sales: ["overview", "quotations"], leads: ["overview", "sources", ...(isOrgManager() ? ["broadcasts"] : [])],
    team: ["overview", "agents"], payments: ["overview", "payments"], support: ["overview"],
  };
  async function load() {
    const seq = ++state.seq;
    const key = query();
    const missing = NEEDS[state.tab].filter((name) => state.data[name]?.key !== key);
    if (missing.length) {
      try {
        const results = await Promise.all(missing.map((name) => crmApi(`/reports/${name}?${key}`)));
        missing.forEach((name, i) => { state.data[name] = { key, value: results[i] }; });
      } catch (error) {
        if (seq !== state.seq) return;
        $("kpiGrid").innerHTML = "";
        showToast(apiErrorMessage(error, "Couldn't load the report."), "error");
        return;
      }
    }
    if (seq !== state.seq) return;
    render();
  }
  const got = (name) => state.data[name]?.value;

  // --- KPI row ----------------------------------------------------------------------------------
  function renderKpis() {
    const o = got("overview");
    if (!o) return;
    const cards = [
      ["Collected", rupees(o.payments.collectedPaise), `${o.payments.count} payment${o.payments.count === 1 ? "" : "s"}`, "success"],
      ["Orders", rupees(o.orders.valuePaise), `${o.orders.count} order${o.orders.count === 1 ? "" : "s"}`, "info"],
      ["New leads", o.leads.created, `${o.customers.new} new customer${o.customers.new === 1 ? "" : "s"}`, ""],
      ["Won", o.leads.won, `win rate ${pctText(o.leads.winRatePct)} (${o.leads.lost} lost)`, "success"],
      ["Quotations", o.quotations.sent, `${o.quotations.accepted} accepted`, ""],
      ["First reply", duration(o.whatsapp.firstResponseMedianSeconds), `median · all replies ${duration(o.whatsapp.responseMedianSeconds)}`, ""],
      ["Open pipeline", rupees(o.pipeline.valuePaise), `${o.pipeline.open} open leads · now`, "info"],
      ["Due now", rupees(o.dues.duePaise), `${o.dues.orders} order${o.dues.orders === 1 ? "" : "s"}`, o.dues.duePaise ? "warning" : ""],
    ];
    $("kpiGrid").innerHTML = cards
      .map(([label, value, sub, cls]) => `<div class="stat-card ${cls}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="report-note">${escapeHtml(sub)}</div></div>`)
      .join("");
    $("rangeLabel").textContent = `${niceDay(o.range.from)} – ${niceDay(o.range.to)} (${o.range.days} day${o.range.days === 1 ? "" : "s"}, India time)${o.scope === "own" ? " · your own figures" : ""}`;
  }

  // --- charts ---------------------------------------------------------------------------------
  function barChart(el, rows, valueOf, labelOf, formatter) {
    const max = Math.max(...rows.map(valueOf), 1);
    const dense = rows.length > 14;
    const every = dense ? Math.ceil(rows.length / 8) : 1;
    el.classList.toggle("dense", dense);
    el.innerHTML = rows
      .map((row, i) => {
        const value = valueOf(row);
        const label = labelOf(row);
        return `<div class="trend-bar-col ${i % every === 0 || i === rows.length - 1 ? "labelled" : ""}" title="${escapeHtml(`${label}: ${formatter(value)}`)}">
          <div class="trend-value">${value ? escapeHtml(formatter(value)) : ""}</div>
          <div class="trend-bar" style="height:${value ? Math.max(4, Math.round((value / max) * 100)) : 2}%"></div>
          <div class="trend-month">${escapeHtml(label)}</div>
        </div>`;
      })
      .join("");
  }
  function donut(el, segments, centre, centreLabel) {
    const total = segments.reduce((s, x) => s + x.count, 0);
    if (!total) return false;
    let acc = 0;
    const gradient = segments.filter((s) => s.count).map((s) => {
      const start = acc;
      acc += (s.count / total) * 100;
      return `${s.color} ${start}% ${acc}%`;
    }).join(", ");
    el.innerHTML = `
      <div class="donut-chart" style="background:conic-gradient(${gradient})"><div class="donut-center"><span class="num">${escapeHtml(String(centre))}</span><span class="lbl">${escapeHtml(centreLabel)}</span></div></div>
      <div class="donut-legend">${segments.map((s) => `<div class="donut-legend-row"><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}<strong>${s.count}</strong></div>`).join("")}</div>`;
    return true;
  }
  function funnel(el, steps) {
    const top = Math.max(steps[0]?.count || 0, 1);
    el.innerHTML = steps.map((s) => `
      <div class="funnel-row">
        <div class="funnel-top"><span>${escapeHtml(s.label)}</span><strong>${s.count}${s.note ? ` · ${escapeHtml(s.note)}` : ""}</strong></div>
        <div class="funnel-bar-track"><div class="funnel-bar-fill" style="width:${Math.max(4, Math.round((s.count / top) * 100))}%"></div></div>
      </div>`).join("");
  }
  function bars(el, rows, emptyText, icon = "fa-chart-simple") {
    if (!rows.length) {
      el.innerHTML = `<div class="bar-list-empty"><i class="fa-solid ${icon}"></i>${escapeHtml(emptyText)}</div>`;
      return;
    }
    const max = Math.max(...rows.map((r) => r.value), 1);
    el.innerHTML = rows.map((r) => `
      <div class="bar-row">
        <div class="bar-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(6, Math.round((r.value / max) * 100))}%"></div></div>
        <div class="bar-meta" style="width:${r.metaWidth || 44}px">${escapeHtml(r.meta ?? String(r.value))}</div>
      </div>`).join("");
  }
  const table = (head, rows) => `<table><thead><tr>${head.map(([label, num]) => `<th${num ? ' class="num"' : ""}>${label}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
  const cell = (value, sub = "", num = true) => `<td${num ? ' class="num"' : ""}>${value}${sub ? `<span class="sub">${sub}</span>` : ""}</td>`;

  // --- Overview -------------------------------------------------------------------------------
  function renderOverview() {
    const o = got("overview");
    const t = got("trend");
    const s = got("sources");
    if (!o || !t || !s) return;
    const money = state.series.endsWith("Paise");
    if (!t.items.some((r) => r[state.series])) {
      $("trendChart").classList.remove("dense");
      $("trendChart").innerHTML = empty("fa-chart-column", "Nothing in this period yet.");
    } else {
      barChart($("trendChart"), t.items, (r) => r[state.series], (r) => bucketLabel(r.bucket, t.range.unit), (v) => (money ? rupees(v) : String(v)));
    }
    if (!donut($("winLossDonut"), [{ label: "Won", count: o.leads.won, color: "var(--success)" }, { label: "Lost", count: o.leads.lost, color: "var(--danger)" }], pctText(o.leads.winRatePct), "Win rate")) {
      $("winLossDonut").innerHTML = empty("fa-scale-balanced", "No lead was won or lost in this period.");
    }
    const f = s.items.reduce((acc, r) => ({ created: acc.created + r.funnel.created, contacted: acc.contacted + r.funnel.contacted, quoted: acc.quoted + r.funnel.quoted, won: acc.won + r.funnel.won }), { created: 0, contacted: 0, quoted: 0, won: 0 });
    if (!f.created) $("leadFunnel").innerHTML = empty("fa-filter", "No new leads in this period.");
    else funnel($("leadFunnel"), [
      { label: "New leads", count: f.created },
      { label: "Contacted or further", count: f.contacted, note: `${pct(f.contacted, f.created)}%` },
      { label: "Quotation sent or further", count: f.quoted, note: `${pct(f.quoted, f.created)}%` },
      { label: "Won", count: f.won, note: `${pct(f.won, f.created)}%` },
    ]);
    const stages = o.pipeline.byStage || [];
    if (!o.pipeline.open) {
      $("pipelineBars").innerHTML = empty("fa-handshake", "No open leads right now.");
    } else {
      const max = Math.max(...stages.map((x) => x.count), 1);
      $("pipelineBars").innerHTML = stages.map((x) => `
        <div class="pipeline-row">
          <div class="stage-label">${escapeHtml(x.stage)}</div>
          <div class="stage-track"><div class="stage-fill" style="width:${Math.max(4, Math.round((x.count / max) * 100))}%;background:${STAGE_COLOR[x.stage]}"></div></div>
          <div class="stage-meta"><strong>${x.count}</strong> lead${x.count === 1 ? "" : "s"} · ${rupees(x.valuePaise)}</div>
        </div>`).join("");
    }
  }

  // --- Sales ----------------------------------------------------------------------------------
  function renderSales() {
    const q = got("quotations");
    if (!q) return;
    const t = q.totals;
    if (!t.sent) {
      $("quoteFunnel").innerHTML = empty("fa-file-invoice", "No quotation was sent in this period.");
    } else {
      funnel($("quoteFunnel"), [
        { label: `Sent · ${rupees(t.sentValuePaise)}`, count: t.sent },
        { label: "Opened by the customer", count: t.viewed, note: pctText(t.viewedPct) },
        { label: `Accepted · ${rupees(t.acceptedValuePaise)}`, count: t.accepted, note: `win rate ${pctText(t.winRatePct)}` },
        { label: "Rejected", count: t.rejected },
        { label: "Expired", count: t.expired },
        { label: "Still waiting", count: t.open },
      ]);
      if (t.averageDaysToAccept != null) $("quoteFunnel").insertAdjacentHTML("beforeend", `<p class="report-note">Accepted on average ${t.averageDaysToAccept} day${t.averageDaysToAccept === 1 ? "" : "s"} after sending.</p>`);
    }
    bars($("rejectReasons"), q.rejectionReasons.map((r) => ({ label: r.reason, value: r.count })), "No quotation was rejected in this period.", "fa-circle-xmark");
    $("quoteOwnerTable").innerHTML = q.byOwner.length
      ? table([["Owner"], ["Sent", 1], ["Opened", 1], ["Accepted", 1], ["Rejected", 1], ["Win rate", 1], ["Value accepted", 1]],
        q.byOwner.map((r) => `<tr><td>${escapeHtml(r.name)}</td>${cell(r.sent)}${cell(r.viewed)}${cell(r.accepted)}${cell(r.rejected)}${cell(pctText(r.winRatePct))}${cell(rupees(r.acceptedValuePaise))}</tr>`))
      : `<div class="empty-state"><i class="fa-solid fa-file-invoice"></i><p>No quotations in this period.</p></div>`;
  }

  // --- Leads & Marketing ----------------------------------------------------------------------
  const inPeriod = (iso) => {
    if (!iso) return false;
    const day = new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);
    return day >= state.range.from && day <= state.range.to;
  };
  function renderLeads() {
    const s = got("sources");
    if (!s) return;
    $("sourceTable").innerHTML = s.items.length
      ? table([["Source"], ["Enquiries", 1], ["Leads", 1], ["Contacted", 1], ["Quoted", 1], ["Won", 1], ["Lost", 1], ["Conversion", 1]],
        [...s.items.map((r) => `<tr><td><strong>${escapeHtml(r.source)}</strong></td>${cell(r.enquiries || "—", r.repeatEnquiries ? `${r.repeatEnquiries} repeat` : "")}${cell(r.leads)}${cell(r.funnel.contacted)}${cell(r.funnel.quoted)}${cell(r.funnel.won)}${cell(r.byStage.Lost)}${cell(pctText(r.conversionPct))}</tr>`),
          `<tr><td><strong>Total</strong></td>${cell(s.totals.enquiries || "—")}${cell(s.totals.leads)}${cell("")}${cell("")}${cell(s.totals.won)}${cell("")}${cell(pctText(s.totals.conversionPct))}</tr>`])
      : `<div class="empty-state"><i class="fa-solid fa-bullseye"></i><p>No new leads in this period.</p></div>`;

    const leads = getLeads().filter((l) => inPeriod(l.createdAt));
    const products = getProducts();
    const counted = products.map((p) => ({ label: p.name, value: leads.filter((l) => l.product === p.id).length })).filter((p) => p.value).sort((a, b) => b.value - a.value).slice(0, 8);
    bars($("leadsByProduct"), counted, "No lead of this period names a product.", "fa-box-open");

    const campaigns = getCampaigns().filter((c) => (!c.startDate || c.startDate <= state.range.to) && (!c.endDate || c.endDate >= state.range.from));
    $("campaignPerfTable").innerHTML = campaigns.length
      ? table([["Campaign"], ["Status"], ["Budget", 1], ["Leads", 1], ["Cost / lead", 1]], campaigns.map((c) => {
        const budget = Number(c.budget || 0);
        const leadsGen = Number(c.leadsGenerated || 0);
        return `<tr><td><strong>${escapeHtml(c.name)}</strong><span class="sub">${escapeHtml(c.type || "")}</span></td><td>${escapeHtml(c.status || "—")}</td>${cell(`₹${budget.toLocaleString("en-IN")}`)}${cell(leadsGen)}${cell(leadsGen ? `₹${Math.round(budget / leadsGen).toLocaleString("en-IN")}` : "—")}</tr>`;
      }))
      : `<div class="empty-state"><i class="fa-solid fa-bullhorn"></i><p>No campaign ran in this period.</p></div>`;

    $("broadcastPanel").hidden = !isOrgManager();
    const b = got("broadcasts");
    if (b) {
      $("broadcastTable").innerHTML = b.items.length
        ? table([["Broadcast"], ["Recipients", 1], ["Sent", 1], ["Delivered", 1], ["Read", 1], ["Replied", 1], ["Failed", 1]],
          [...b.items.map((x) => `<tr><td><a href="Marketing.html?broadcast=${encodeURIComponent(x.id)}">${escapeHtml(x.name)}</a><span class="sub">${escapeHtml(x.templateName || "")}${x.startedAt ? ` · ${escapeHtml(niceDay(new Date(new Date(x.startedAt).getTime() + 330 * 60000).toISOString().slice(0, 10)))}` : ""}</span></td>${cell(x.total)}${cell(x.sent)}${cell(x.delivered, pctText(x.deliveredPct))}${cell(x.read, pctText(x.readPct))}${cell(x.replied, pctText(x.repliedPct))}${cell(x.failed)}</tr>`),
            `<tr><td><strong>Total</strong></td>${cell(b.totals.total)}${cell(b.totals.sent)}${cell(b.totals.delivered, pctText(b.totals.deliveredPct))}${cell(b.totals.read, pctText(b.totals.readPct))}${cell(b.totals.replied, pctText(b.totals.repliedPct))}${cell(b.totals.failed)}</tr>`])
        : `<div class="empty-state"><i class="fa-brands fa-whatsapp"></i><p>No broadcast started in this period.</p></div>`;
    }
  }

  // --- WhatsApp & Team ------------------------------------------------------------------------
  function renderTeam() {
    const a = got("agents");
    if (!a) return;
    const t = a.team;
    const kpi = (label, value, sub) => `<div class="stat-card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="report-note">${escapeHtml(sub)}</div></div>`;
    $("teamKpis").innerHTML = [
      kpi("First reply", duration(t.firstResponseMedianSeconds), "median, new chats"),
      kpi("Reply time", duration(t.responseMedianSeconds), `median · average ${duration(t.responseAverageSeconds)}`),
      kpi("Chats answered", t.chatsHandled, `${t.replies} replies`),
      kpi("Collected", rupees(t.collectedPaise), `${t.won} won`),
    ].join("");
    $("agentTable").innerHTML = a.items.length
      ? table([["#"], ["Agent"], ["Chats", 1], ["First reply", 1], ["Reply time", 1], ["Open leads", 1], ["New leads", 1], ["Won", 1], ["Quotes", 1], ["Orders", 1], ["Collected", 1], ["Tasks", 1], ["Tickets", 1]],
        a.items.map((r, i) => {
          const open = ["New", "Contacted", "Quote Sent", "Negotiation"].reduce((s, stage) => s + (r.leadsByStage[stage] || 0), 0);
          return `<tr>
            <td><span class="rank-badge ${i === 0 && (r.collectedPaise || r.won) ? "top" : ""}">${i + 1}</span></td>
            <td><div class="leaderboard-agent"><span class="avatar">${escapeHtml(initials(r.name))}</span><div>${escapeHtml(r.name)}<span class="sub">${escapeHtml(r.role || "")}${r.active ? "" : " · no longer in the team"}</span></div></div></td>
            ${cell(r.chatsHandled, `${r.messagesSent} messages`)}${cell(duration(r.firstResponseMedianSeconds))}${cell(duration(r.responseMedianSeconds), r.replies ? `avg ${duration(r.responseAverageSeconds)}` : "")}
            ${cell(open, Object.entries(r.leadsByStage).filter(([stage, n]) => n && stage !== "Won" && stage !== "Lost").map(([stage, n]) => `${n} ${stage}`).join(", "))}
            ${cell(r.leadsCreated)}${cell(r.won, r.won || r.lost ? `win rate ${pctText(r.winRatePct)}` : "")}${cell(`${r.quotationsAccepted}/${r.quotationsSent}`, "won / sent")}
            ${cell(rupees(r.orderValuePaise), `${r.orders} order${r.orders === 1 ? "" : "s"}`)}${cell(rupees(r.collectedPaise))}${cell(r.tasksDone)}${cell(r.ticketsResolved)}
          </tr>`;
        }))
      : `<div class="empty-state"><i class="fa-solid fa-user-group"></i><p>No team members yet.</p></div>`;
    if (a.truncated) $("agentTable").insertAdjacentHTML("beforeend", '<p class="report-note" style="padding:0 16px 12px">Very many messages in this period: reply times use the first 100,000.</p>');
  }

  // --- Payments -------------------------------------------------------------------------------
  function renderPayments() {
    const p = got("payments");
    if (!p) return;
    $("payTrendNote").textContent = `${rupees(p.collected.amountPaise)} in ${p.collected.count} payment${p.collected.count === 1 ? "" : "s"}`;
    if (!p.collected.count) {
      $("payTrend").classList.remove("dense");
      $("payTrend").innerHTML = empty("fa-indian-rupee-sign", "No payment came in during this period.");
    } else {
      barChart($("payTrend"), p.trend, (r) => r.amountPaise, (r) => bucketLabel(r.bucket, p.range.unit), rupees);
    }
    bars($("payByWay"), p.byWay.map((r) => ({ label: r.name, value: r.amountPaise, meta: rupees(r.amountPaise), metaWidth: 96 })), "No payments in this period.", "fa-wallet");
    const row = (icon, cls, name, sub, value) => `<div class="mini-row"><span class="mini-icon ${cls}"><i class="fa-solid ${icon}"></i></span><div class="info"><div class="name">${escapeHtml(name)}</div><div class="sub">${escapeHtml(sub)}</div></div><div class="mini-right">${escapeHtml(String(value))}</div></div>`;
    $("payStats").innerHTML = [
      row("fa-link", "info", "Payment links made", "in this period", p.links.made),
      row("fa-circle-check", "success", "Payment links paid", p.links.averageHoursToPay != null ? `paid on average ${p.links.averageHoursToPay} h after they were made` : "in this period", p.links.paid),
      row("fa-truck-fast", "", "Orders paid in full", p.averageDaysToCollect != null ? `on average ${p.averageDaysToCollect} days after the order` : "in this period", p.ordersPaidInFull),
    ].join("");
    const buckets = Object.entries(p.dues.buckets);
    const max = Math.max(...buckets.map(([, b]) => b.duePaise), 1);
    $("payDues").innerHTML = p.dues.count
      ? buckets.map(([name, b]) => `
        <div class="pipeline-row">
          <div class="stage-label">${escapeHtml(name)} days</div>
          <div class="stage-track"><div class="stage-fill" style="width:${b.duePaise ? Math.max(4, Math.round((b.duePaise / max) * 100)) : 0}%;background:${name === "0-7" ? "var(--info)" : name === "8-30" ? "var(--warning)" : "var(--danger)"}"></div></div>
          <div class="stage-meta"><strong>${rupees(b.duePaise)}</strong> · ${b.count} order${b.count === 1 ? "" : "s"}</div>
        </div>`).join("") + `<p class="report-note">Total due ${rupees(p.dues.duePaise)}. <a href="Orders.html?tab=dues">Open the list</a></p>`
      : empty("fa-circle-check", "Nothing is due: every order is paid.");
  }

  // --- Support (from the loaded tickets) --------------------------------------------------
  function renderSupport() {
    const tickets = getTickets();
    const opened = tickets.filter((t) => inPeriod(t.createdAt));
    if (!donut($("ticketStatusDonut"), TICKET_STATUSES.map((status) => ({ label: status, count: opened.filter((t) => t.status === status).length, color: TICKET_COLOR[status] })), opened.length, "Tickets")) {
      $("ticketStatusDonut").innerHTML = empty("fa-headset", "No ticket was opened in this period.");
    }
    bars($("ticketPriorityBars"), TICKET_PRIORITIES.map((priority) => ({ label: priority, value: opened.filter((t) => t.priority === priority).length })).filter((r) => r.value), "No ticket was opened in this period.", "fa-headset");
    const today = indiaToday();
    const isClosed = (t) => t.status === "Resolved" || t.status === "Closed";
    const o = got("overview");
    const rows = [
      ["fa-inbox", "info", "Open tickets", "across the team", tickets.filter((t) => !isClosed(t)).length],
      ["fa-triangle-exclamation", "warning", "Overdue", "past their due date, not resolved", tickets.filter((t) => t.dueDate && t.dueDate < today && !isClosed(t)).length],
      ["fa-bolt", "warning", "Urgent and open", "need attention now", tickets.filter((t) => t.priority === "Urgent" && !isClosed(t)).length],
      ["fa-circle-check", "success", "Resolved in the period", "", o ? o.tickets.resolved : "—"],
    ];
    $("supportSnapshot").innerHTML = rows.map(([icon, cls, name, sub, value]) => `<div class="mini-row"><span class="mini-icon ${cls}"><i class="fa-solid ${icon}"></i></span><div class="info"><div class="name">${escapeHtml(name)}</div><div class="sub">${escapeHtml(sub)}</div></div><div class="mini-right">${escapeHtml(String(value))}</div></div>`).join("");
  }

  function render() {
    renderKpis();
    ({ overview: renderOverview, sales: renderSales, leads: renderLeads, team: renderTeam, payments: renderPayments, support: renderSupport })[state.tab]();
  }

  // --- controls -------------------------------------------------------------------------------
  function applyRange() {
    const value = $("filterRange").value;
    $("customRange").hidden = value !== "custom";
    state.range = rangeFor(value);
    if (value === "custom") {
      $("rangeFrom").value = state.range.from;
      $("rangeTo").value = state.range.to;
    }
    setPreference("reportsRange", value);
    load();
  }
  $("filterRange").addEventListener("change", applyRange);
  $("rangeFrom").addEventListener("change", applyRange);
  $("rangeTo").addEventListener("change", applyRange);
  $("reportTabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".report-tab");
    if (!tab) return;
    document.querySelectorAll(".report-tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".report-panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === tab.dataset.tab));
    state.tab = tab.dataset.tab;
    load();
  });
  $("trendChips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-series]");
    if (!chip) return;
    state.series = chip.dataset.series;
    document.querySelectorAll("#trendChips [data-series]").forEach((c) => c.classList.toggle("active", c === chip));
    renderOverview();
  });
  $("exportBtn").addEventListener("click", async () => {
    const type = EXPORT_TYPE[state.tab];
    try {
      await crmDownload(`/reports/export?type=${type}&${query()}`, `report-${type}-${state.range.from}-to-${state.range.to}.csv`);
      showToast("Report downloaded.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't export the report."), "error");
    }
  });
  $("printBtn").addEventListener("click", () => window.print());

  const remembered = getPreference("reportsRange", "30");
  if ([...$("filterRange").options].some((o) => o.value === remembered && remembered !== "custom")) $("filterRange").value = remembered;
  crmReady(["leads", "products", "tickets", "campaigns"], applyRange);
})();
