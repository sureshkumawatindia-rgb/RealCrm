/**
 * reports.js — Reports & Analytics (Phase 9: on the server's numbers)
 * Every figure is for the chosen period (calendar days in India) unless the panel says "now".
 * The KPI row and the tabs come from /reports/* (counted on the server from all records):
 * Overview (trend, won/lost, lead funnel, open pipeline), Sales (quotations), Leads & Marketing
 * (sources, broadcasts; products and campaigns from the loaded records), WhatsApp & Team (agent
 * performance with reply times), Payments, Support (tickets from the loaded records; the SLA from
 * /reports/sla, D107).
 * "Export CSV" (and "Export Excel", D82) downloads the open tab's report from /reports/export. One IIFE: no globals.
 */
(function reportsPage() {
  requireAuth();
  renderSidebarUser();
  initSidebarToggle();

  const $ = (id) => document.getElementById(id);
  const STAGE_COLOR = { New: "var(--info)", Contacted: "var(--brand-darker)", "Quote Sent": "var(--warning)", Negotiation: "var(--violet)", Won: "var(--success)", Lost: "var(--danger)" };
  const TICKET_STATUSES = ["Open", "In Progress", "Waiting on Customer", "Resolved", "Closed"];
  const TICKET_COLOR = { Open: "var(--info)", "In Progress": "var(--brand-darker)", "Waiting on Customer": "var(--warning)", Resolved: "var(--success)", Closed: "var(--text-faint)" };
  const TICKET_PRIORITIES = ["Low", "Medium", "High", "Urgent"];
  const EXPORT_TYPE = { overview: "trend", sales: "quotations", leads: "sources", team: "agents", payments: "payments", support: "overview" };

  const state = { tab: "overview", range: null, series: "collectedPaise", data: {}, seq: 0 };

  // --- formatting ----------------------------------------------------------------------------
  const rupees = (paise) => `₹${Math.round(Number(paise || 0) / 100).toLocaleString("en-IN")}`;
  const pctText = (value) => `${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
  const duration = (seconds) => crmDuration(seconds);
  // "3 payments" in the person's language: <key>.one or <key>.many with {n} (D116).
  const count = (n, key) => crmI18n.t(`${key}.${n === 1 ? "one" : "many"}`, { n });
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
    team: ["overview", "agents"], payments: ["overview", "payments"], support: ["overview", "sla"],
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
        showToast(apiErrorMessage(error, t("rep.couldn-t-load-the-report")), "error");
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
      [t("reports.collected"), rupees(o.payments.collectedPaise), count(o.payments.count, "rep.n.payment"), "success"],
      [t("nav.orders"), rupees(o.orders.valuePaise), count(o.orders.count, "rep.n.order"), "info"],
      [t("gs.kind.leads"), o.leads.created, count(o.customers.new, "rep.n.newCustomer"), ""],
      [crmLabel("stage", "Won"), o.leads.won, t("rep.win-rate-lost", { v: pctText(o.leads.winRatePct), lost: o.leads.lost }), "success"],
      [t("nav.quotations"), o.quotations.sent, t("myperf.accepted", { n: o.quotations.accepted }), ""],
      [t("sla.box.reply"), duration(o.whatsapp.firstResponseMedianSeconds), t("rep.median-all-replies", { v: duration(o.whatsapp.responseMedianSeconds) }), ""],
      [t("dash.kpi.pipeline"), rupees(o.pipeline.valuePaise), t("rep.open-leads-now", { open: o.pipeline.open }), "info"],
      [t("dash.kpi.due"), rupees(o.dues.duePaise), count(o.dues.orders, "rep.n.order"), o.dues.duePaise ? "warning" : ""],
    ];
    $("kpiGrid").innerHTML = cards
      .map(([label, value, sub, cls]) => `<div class="stat-card ${cls}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="report-note">${escapeHtml(sub)}</div></div>`)
      .join("");
    $("rangeLabel").textContent = `${niceDay(o.range.from)} – ${niceDay(o.range.to)} (${count(o.range.days, "rep.n.dayIndia")})${o.scope === "own" ? t("rep.your-own-figures") : ""}`;
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
  // Two amounts per period side by side: invoiced (D101) and collected.
  function pairChart(el, rows, labelOf, formatter) {
    const max = Math.max(...rows.flatMap((r) => [r.invoicedPaise, r.amountPaise]), 1);
    const dense = rows.length > 14;
    const every = dense ? Math.ceil(rows.length / 8) : 1;
    const height = (value) => (value > 0 ? Math.max(4, Math.round((value / max) * 100)) : 2);
    el.classList.toggle("dense", dense);
    el.innerHTML = rows
      .map((row, i) => {
        const label = labelOf(row);
        return `<div class="trend-bar-col ${i % every === 0 || i === rows.length - 1 ? "labelled" : ""}" title="${escapeHtml(t("rep.invoiced-collected", { label, v: formatter(row.invoicedPaise), v2: formatter(row.amountPaise) }))}">
          <div class="trend-pair"><div class="trend-bar" style="height:${height(row.invoicedPaise)}%"></div><div class="trend-bar alt" style="height:${height(row.amountPaise)}%"></div></div>
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
      $("trendChart").innerHTML = empty("fa-chart-column", crmI18n.t("rep.nothing-in-this-period-yet"));
    } else {
      barChart($("trendChart"), t.items, (r) => r[state.series], (r) => bucketLabel(r.bucket, t.range.unit), (v) => (money ? rupees(v) : String(v)));
    }
    if (!donut($("winLossDonut"), [{ label: crmLabel("stage", "Won"), count: o.leads.won, color: "var(--success)" }, { label: crmLabel("stage", "Lost"), count: o.leads.lost, color: "var(--danger)" }], pctText(o.leads.winRatePct), crmI18n.t("rep.win-rate"))) {
      $("winLossDonut").innerHTML = empty("fa-scale-balanced", crmI18n.t("rep.no-lead-was-won-or-lost"));
    }
    const f = s.items.reduce((acc, r) => ({ created: acc.created + r.funnel.created, contacted: acc.contacted + r.funnel.contacted, quoted: acc.quoted + r.funnel.quoted, won: acc.won + r.funnel.won }), { created: 0, contacted: 0, quoted: 0, won: 0 });
    if (!f.created) $("leadFunnel").innerHTML = empty("fa-filter", crmI18n.t("rep.at.empty"));
    else funnel($("leadFunnel"), [
      { label: crmI18n.t("gs.kind.leads"), count: f.created },
      { label: crmI18n.t("rep.contacted-or-further"), count: f.contacted, note: `${pct(f.contacted, f.created)}%` },
      { label: crmI18n.t("rep.quotation-sent-or-further"), count: f.quoted, note: `${pct(f.quoted, f.created)}%` },
      { label: crmLabel("stage", "Won"), count: f.won, note: `${pct(f.won, f.created)}%` },
    ]);
    const stages = o.pipeline.byStage || [];
    if (!o.pipeline.open) {
      $("pipelineBars").innerHTML = empty("fa-handshake", crmI18n.t("rep.no-open-leads-right-now"));
    } else {
      const max = Math.max(...stages.map((x) => x.count), 1);
      $("pipelineBars").innerHTML = stages.map((x) => `
        <div class="pipeline-row">
          <div class="stage-label">${escapeHtml(x.stage)}</div>
          <div class="stage-track"><div class="stage-fill" style="width:${Math.max(4, Math.round((x.count / max) * 100))}%;background:${STAGE_COLOR[x.stage]}"></div></div>
          <div class="stage-meta"><strong>${x.count}</strong> ${escapeHtml(crmI18n.t(x.count === 1 ? "rep.leadWord.one" : "rep.leadWord.many"))} · ${rupees(x.valuePaise)}</div>
        </div>`).join("");
    }
  }

  // --- Sales ----------------------------------------------------------------------------------
  function renderSales() {
    const q = got("quotations");
    if (!q) return;
    const t = q.totals;
    if (!t.sent) {
      $("quoteFunnel").innerHTML = empty("fa-file-invoice", crmI18n.t("rep.no-quotation-was-sent-in-this"));
    } else {
      funnel($("quoteFunnel"), [
        { label: crmI18n.t("rep.sent", { v: rupees(t.sentValuePaise) }), count: t.sent },
        { label: crmI18n.t("quotes.openedByCustomer"), count: t.viewed, note: pctText(t.viewedPct) },
        { label: crmI18n.t("rep.accepted", { v: rupees(t.acceptedValuePaise) }), count: t.accepted, note: crmI18n.t("rep.win-rate-2", { v: pctText(t.winRatePct) }) },
        { label: "Rejected", count: t.rejected },
        { label: "Expired", count: t.expired },
        { label: crmI18n.t("rep.still-waiting"), count: t.open },
      ]);
      if (t.averageDaysToAccept != null) $("quoteFunnel").insertAdjacentHTML("beforeend", `<p class="report-note">${escapeHtml(count(t.averageDaysToAccept, "rep.n.acceptedAfter"))}</p>`);
    }
    bars($("rejectReasons"), q.rejectionReasons.map((r) => ({ label: r.reason, value: r.count })), crmI18n.t("rep.no-quotation-was-rejected-in-this"), "fa-circle-xmark");
    $("quoteOwnerTable").innerHTML = q.byOwner.length
      ? table([[crmI18n.t("leads.col.owner")], [crmI18n.t("rep.col.sent"), 1], [crmI18n.t("rep.opened"), 1], [crmI18n.t("rep.col.accepted"), 1], [crmI18n.t("rep.col.rejected"), 1], [crmI18n.t("rep.win-rate"), 1], [crmI18n.t("rep.value-accepted"), 1]],
        q.byOwner.map((r) => `<tr><td>${escapeHtml(r.name)}</td>${cell(r.sent)}${cell(r.viewed)}${cell(r.accepted)}${cell(r.rejected)}${cell(pctText(r.winRatePct))}${cell(rupees(r.acceptedValuePaise))}</tr>`))
      : `<div class="empty-state"><i class="fa-solid fa-file-invoice"></i><p>${escapeHtml(crmI18n.t("rep.no-quotations-in-this-period"))}</p></div>`;
  }

  // --- Leads & Marketing ----------------------------------------------------------------------
  const inPeriod = (iso) => {
    if (!iso) return false;
    const day = new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);
    return day >= state.range.from && day <= state.range.to;
  };
  // Channels and campaigns that win (D79): its own query (group and touch), cached per choice.
  const attr = { by: "channel", touch: "first", key: "", data: null, seq: 0 };
  const channelName = (channel) => t(`rep.ch.${channel}`);
  function renderAttribution() {
    const d = attr.data;
    if (!d) return;
    // By campaign or by ad (D102: a Click-to-WhatsApp ad's headline, a Lead Ads ad's name): with its channel.
    const grouped = { campaign: ["rep.at.byCampaign", "rep.at.noCampaign"], ad: ["rep.at.byAd", "rep.at.noAd"] }[d.by];
    const name = (r) => (grouped
      ? `<strong>${escapeHtml(r.key || t(grouped[1]))}</strong><span class="sub">${escapeHtml(channelName(r.channel))}</span>`
      : `<strong>${escapeHtml(channelName(r.key))}</strong>`);
    $("attrTable").innerHTML = d.items.length
      ? table([[escapeHtml(t(grouped ? grouped[0] : "rep.at.byChannel"))], [escapeHtml(t("rep.at.leads")), 1], [escapeHtml(t("rep.at.won")), 1], [escapeHtml(t("rep.at.wonValue")), 1], [escapeHtml(t("rep.at.conversion")), 1]],
        [...d.items.map((r) => `<tr><td>${name(r)}</td>${cell(r.leads)}${cell(r.won)}${cell(rupees(r.wonValuePaise))}${cell(pctText(r.conversionPct))}</tr>`),
          `<tr><td><strong>${escapeHtml(t("rep.at.total"))}</strong></td>${cell(d.totals.leads)}${cell(d.totals.won)}${cell(rupees(d.totals.wonValuePaise))}${cell(pctText(d.totals.conversionPct))}</tr>`])
      : `<div class="empty-state"><i class="fa-solid fa-route"></i><p>${escapeHtml(t("rep.at.empty"))}</p></div>`;
  }
  async function loadAttribution() {
    const key = `${query()}&by=${attr.by}&touch=${attr.touch}`;
    if (attr.key === key && attr.data) return renderAttribution();
    const seq = ++attr.seq;
    try {
      const data = await crmApi(`/reports/attribution?${key}`);
      if (seq !== attr.seq) return;
      attr.key = key;
      attr.data = data;
      renderAttribution();
    } catch (error) {
      if (seq === attr.seq) $("attrTable").innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(error, t("rep.at.err")))}</p></div>`;
    }
  }
  ["attrBy", "attrTouch"].forEach((id) => {
    $(id).addEventListener("click", (event) => {
      const button = event.target.closest("[data-value]");
      if (!button) return;
      $(id).querySelectorAll("[data-value]").forEach((b) => {
        b.classList.toggle("active", b === button);
        b.setAttribute("aria-checked", String(b === button));
      });
      attr[id === "attrBy" ? "by" : "touch"] = button.dataset.value;
      loadAttribution();
    });
  });

  function renderLeads() {
    loadAttribution();
    const s = got("sources");
    if (!s) return;
    $("sourceTable").innerHTML = s.items.length
      ? table([[t("board.field.lead.source")], [t("rep.enquiries"), 1], [t("nav.leads"), 1], [crmLabel("stage", "Contacted"), 1], [t("rep.quoted"), 1], [crmLabel("stage", "Won"), 1], [crmLabel("stage", "Lost"), 1], [t("rep.at.conversion"), 1]],
        [...s.items.map((r) => `<tr><td><strong>${escapeHtml(r.source)}</strong></td>${cell(r.enquiries || "—", r.repeatEnquiries ? `${r.repeatEnquiries} repeat` : "")}${cell(r.leads)}${cell(r.funnel.contacted)}${cell(r.funnel.quoted)}${cell(r.funnel.won)}${cell(r.byStage.Lost)}${cell(pctText(r.conversionPct))}</tr>`),
          `<tr><td><strong>${escapeHtml(t("quotes.total"))}</strong></td>${cell(s.totals.enquiries || "—")}${cell(s.totals.leads)}${cell("")}${cell("")}${cell(s.totals.won)}${cell("")}${cell(pctText(s.totals.conversionPct))}</tr>`])
      : `<div class="empty-state"><i class="fa-solid fa-bullseye"></i><p>${escapeHtml(t("rep.at.empty"))}</p></div>`;

    // Counted by the server over every lead of the period (Phase 3, D115).
    const range = { ...state.range };
    crmApi(`/leads/summary?${new URLSearchParams({ from: range.from, to: range.to })}`).then((summary) => {
      if (range.from !== state.range.from || range.to !== state.range.to) return; // another period since
      const names = new Map(getProducts().map((p) => [String(p.id), p.name]));
      const counted = summary.products.filter((row) => names.has(String(row.productId))).map((row) => ({ label: names.get(String(row.productId)), value: row.count })).sort((a, b) => b.value - a.value).slice(0, 8);
      bars($("leadsByProduct"), counted, t("rep.no-lead-of-this-period-names"), "fa-box-open");
    }, () => bars($("leadsByProduct"), [], t("rep.no-lead-of-this-period-names"), "fa-box-open"));

    const campaigns = getCampaigns().filter((c) => (!c.startDate || c.startDate <= state.range.to) && (!c.endDate || c.endDate >= state.range.from));
    $("campaignPerfTable").innerHTML = campaigns.length
      ? table([[t("dash.campaign")], [t("board.field.task.status")], [t("wf.field.budget"), 1], ["Leads", 1], [t("rep.cost-lead"), 1]], campaigns.map((c) => {
        const budget = Number(c.budget || 0);
        const leadsGen = Number(c.leadsGenerated || 0);
        return `<tr><td><strong>${escapeHtml(c.name)}</strong><span class="sub">${escapeHtml(c.type || "")}</span></td><td>${escapeHtml(c.status || "—")}</td>${cell(`₹${budget.toLocaleString("en-IN")}`)}${cell(leadsGen)}${cell(leadsGen ? `₹${Math.round(budget / leadsGen).toLocaleString("en-IN")}` : "—")}</tr>`;
      }))
      : `<div class="empty-state"><i class="fa-solid fa-bullhorn"></i><p>${escapeHtml(t("rep.no-campaign-ran-in-this-period"))}</p></div>`;

    $("broadcastPanel").hidden = !isOrgManager();
    const b = got("broadcasts");
    if (b) {
      $("broadcastTable").innerHTML = b.items.length
        ? table([[t("inbox.auto.broadcast")], [t("rep.recipients"), 1], [t("rep.col.sent"), 1], [t("rep.col.delivered"), 1], [t("inbox.tick.read"), 1], [t("rep.replied"), 1], [t("call.status.failed"), 1]],
          [...b.items.map((x) => `<tr><td><a href="Marketing.html?broadcast=${encodeURIComponent(x.id)}">${escapeHtml(x.name)}</a><span class="sub">${escapeHtml(x.templateName || "")}${x.startedAt ? ` · ${escapeHtml(niceDay(new Date(new Date(x.startedAt).getTime() + 330 * 60000).toISOString().slice(0, 10)))}` : ""}</span></td>${cell(x.total)}${cell(x.sent)}${cell(x.delivered, pctText(x.deliveredPct))}${cell(x.read, pctText(x.readPct))}${cell(x.replied, pctText(x.repliedPct))}${cell(x.failed)}</tr>`),
            `<tr><td><strong>${escapeHtml(t("quotes.total"))}</strong></td>${cell(b.totals.total)}${cell(b.totals.sent)}${cell(b.totals.delivered, pctText(b.totals.deliveredPct))}${cell(b.totals.read, pctText(b.totals.readPct))}${cell(b.totals.replied, pctText(b.totals.repliedPct))}${cell(b.totals.failed)}</tr>`])
        : `<div class="empty-state"><i class="fa-brands fa-whatsapp"></i><p>${escapeHtml(t("rep.no-broadcast-started-in-this-period"))}</p></div>`;
    }
  }

  // --- WhatsApp & Team ------------------------------------------------------------------------
  // D103: customers' answers to "How was our service?" (the share that said Good).
  function csatText(good, answers) {
    return answers ? crmI18n.t("myperf.good", { v: pctText(Math.round((good / answers) * 1000) / 10) }) : "—";
  }
  function csatKpi(score) {
    const { good = 0, answers = 0, bad = 0 } = score || {};
    return `<div class="stat-card"><div class="label">${escapeHtml(t("wa.csat.label"))}</div><div class="value">${escapeHtml(csatText(good, answers))}</div><div class="report-note">${escapeHtml(answers ? crmI18n.t(answers === 1 ? "teamlive.answer-bad-one" : "teamlive.answer-bad-many", { n: answers, bad }) : t("rep.no-answers-yet-settings-whatsapp"))}</div></div>`;
  }
  function renderTeam() {
    const a = got("agents");
    if (!a) return;
    const t = a.team;
    const kpi = (label, value, sub) => `<div class="stat-card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="report-note">${escapeHtml(sub)}</div></div>`;
    $("teamKpis").innerHTML = [
      kpi(crmI18n.t("sla.box.reply"), duration(t.firstResponseMedianSeconds), crmI18n.t("rep.median-new-chats")),
      kpi(crmI18n.t("rep.reply-time"), duration(t.responseMedianSeconds), crmI18n.t("rep.median-average", { v: duration(t.responseAverageSeconds) })),
      kpi(crmI18n.t("rep.chats-answered"), t.chatsHandled, count(t.replies, "rep.n.reply")),
      kpi(crmI18n.t("rep.chats-resolved"), t.chatsResolved || 0, t.resolutionMedianSeconds != null ? crmI18n.t("rep.median-to-resolve", { v: duration(t.resolutionMedianSeconds) }) : crmI18n.t("rep.closed-by-the-team")),
      kpi(crmI18n.t("reports.collected"), rupees(t.collectedPaise), crmI18n.t("rep.nWon", { n: t.won })),
      csatKpi(t.csat),
    ].join("");
    $("agentTable").innerHTML = a.items.length
      ? table([["#"], [crmLabel("role", "Agent")], [crmI18n.t("inbox.chats"), 1], [crmI18n.t("sla.box.reply"), 1], [crmI18n.t("rep.reply-time"), 1], [crmI18n.t("rep.col.resolved"), 1], [crmI18n.t("rep.feedback"), 1], [crmI18n.t("rep.open-leads"), 1], [crmI18n.t("gs.kind.leads"), 1], [crmLabel("stage", "Won"), 1], [crmI18n.t("rep.quotes"), 1], [crmI18n.t("nav.orders"), 1], [crmI18n.t("reports.collected"), 1], [crmI18n.t("nav.tasks"), 1], [crmI18n.t("rep.tickets"), 1]],
        a.items.map((r, i) => {
          const open = ["New", "Contacted", "Quote Sent", "Negotiation"].reduce((s, stage) => s + (r.leadsByStage[stage] || 0), 0);
          return `<tr>
            <td><span class="rank-badge ${i === 0 && (r.collectedPaise || r.won) ? "top" : ""}">${i + 1}</span></td>
            <td><div class="leaderboard-agent"><span class="avatar">${escapeHtml(initials(r.name))}</span><div>${escapeHtml(r.name)}<span class="sub">${escapeHtml(r.role || "")}${r.active ? "" : crmI18n.t("rep.no-longer-in-the-team")}</span></div></div></td>
            ${cell(r.chatsHandled, `${r.messagesSent} messages`)}${cell(duration(r.firstResponseMedianSeconds))}${cell(duration(r.responseMedianSeconds), r.replies ? `avg ${duration(r.responseAverageSeconds)}` : "")}
            ${cell(r.chatsResolved || 0, r.chatsResolved ? `${pctText(r.resolutionRatePct)} · ${duration(r.resolutionMedianSeconds)}` : "")}
            ${cell(csatText(r.csatGood || 0, r.csatAnswers || 0), r.csatAnswers ? count(r.csatAnswers, "rep.n.answer") : "")}
            ${cell(open, Object.entries(r.leadsByStage).filter(([stage, n]) => n && stage !== "Won" && stage !== "Lost").map(([stage, n]) => `${n} ${stage}`).join(", "))}
            ${cell(r.leadsCreated)}${cell(r.won, r.won || r.lost ? crmI18n.t("rep.win-rate-2", { v: pctText(r.winRatePct) }) : "")}${cell(`${r.quotationsAccepted}/${r.quotationsSent}`, crmI18n.t("rep.won-sent"))}
            ${cell(rupees(r.orderValuePaise), count(r.orders, "rep.n.order"))}${cell(rupees(r.collectedPaise))}${cell(r.tasksDone)}${cell(r.ticketsResolved)}
          </tr>`;
        }))
      : `<div class="empty-state"><i class="fa-solid fa-user-group"></i><p>${escapeHtml(crmI18n.t("rep.no-team-members-yet"))}</p></div>`;
    if (a.truncated) $("agentTable").insertAdjacentHTML("beforeend", '<p class="report-note" style="padding:0 16px 12px">Very many messages in this period: reply times use the first 100,000.</p>');
  }

  // --- Payments -------------------------------------------------------------------------------
  function renderPayments() {
    const p = got("payments");
    if (!p) return;
    const row = (icon, cls, name, sub, value) => `<div class="mini-row"><span class="mini-icon ${cls}"><i class="fa-solid ${icon}"></i></span><div class="info"><div class="name">${escapeHtml(name)}</div><div class="sub">${escapeHtml(sub)}</div></div><div class="mini-right">${escapeHtml(String(value))}</div></div>`;
    $("payTrendNote").textContent = `${rupees(p.collected.amountPaise)} · ${count(p.collected.count, "rep.n.payment")}`;
    if (!p.collected.count) {
      $("payTrend").classList.remove("dense");
      $("payTrend").innerHTML = empty("fa-indian-rupee-sign", t("rep.no-payment-came-in-during-this"));
    } else {
      barChart($("payTrend"), p.trend, (r) => r.amountPaise, (r) => bucketLabel(r.bucket, p.range.unit), rupees);
    }
    const inv = p.invoiced;
    if (!inv.invoices && !inv.creditNotes && !p.collected.count) {
      $("payInvoicedChart").classList.remove("dense");
      $("payInvoicedChart").innerHTML = empty("fa-file-invoice", t("rep.no-tax-invoice-was-made-and"));
    } else {
      pairChart($("payInvoicedChart"), p.trend, (r) => bucketLabel(r.bucket, p.range.unit), rupees);
    }
    const gap = inv.amountPaise - p.collected.amountPaise;
    $("payInvoiced").innerHTML = [
      row("fa-file-invoice", "info", t("reports.invoiced"), `${count(inv.invoices, "rep.n.taxInvoice")}${inv.creditNotes ? crmI18n.t("rep.lessCredit", { notes: count(inv.creditNotes, "rep.n.creditNote"), amount: rupees(inv.creditedPaise) }) : ""}`, rupees(inv.amountPaise)),
      row("fa-indian-rupee-sign", "success", t("reports.collected"), count(p.collected.count, "rep.n.payment"), rupees(p.collected.amountPaise)),
      row("fa-scale-balanced", gap > 0 ? "warning" : "", t("rep.difference"), gap > 0 ? t("rep.invoiced-not-collected-in-this-period") : gap < 0 ? t("rep.collected-more-than-was-invoiced-advances") : t("rep.invoiced-and-collected-match"), rupees(Math.abs(gap))),
      row("fa-building-columns", "", t("rep.gst-on-the-invoices"), t("rep.cgst-sgst-igst-less-credit-notes"), rupees(inv.taxPaise)),
    ].join("");
    bars($("payByWay"), p.byWay.map((r) => ({ label: r.name, value: r.amountPaise, meta: rupees(r.amountPaise), metaWidth: 96 })), t("rep.no-payments-in-this-period"), "fa-wallet");
    $("payStats").innerHTML = [
      row("fa-link", "info", t("rep.payment-links-made"), t("rep.in-this-period"), p.links.made),
      row("fa-circle-check", "success", t("rep.payment-links-paid"), p.links.averageHoursToPay != null ? t("rep.paid-on-average-h-after-they", { averageHoursToPay: p.links.averageHoursToPay }) : t("rep.in-this-period"), p.links.paid),
      row("fa-truck-fast", "", t("rep.orders-paid-in-full"), p.averageDaysToCollect != null ? t("rep.on-average-days-after-the-order", { averageDaysToCollect: p.averageDaysToCollect }) : t("rep.in-this-period"), p.ordersPaidInFull),
    ].join("");
    const buckets = Object.entries(p.dues.buckets);
    const max = Math.max(...buckets.map(([, b]) => b.duePaise), 1);
    $("payDues").innerHTML = p.dues.count
      ? buckets.map(([name, b]) => `
        <div class="pipeline-row">
          <div class="stage-label">${escapeHtml(name)} days</div>
          <div class="stage-track"><div class="stage-fill" style="width:${b.duePaise ? Math.max(4, Math.round((b.duePaise / max) * 100)) : 0}%;background:${name === "0-7" ? "var(--info)" : name === "8-30" ? "var(--warning)" : "var(--danger)"}"></div></div>
          <div class="stage-meta"><strong>${rupees(b.duePaise)}</strong> · ${escapeHtml(count(b.count, "rep.n.order"))}</div>
        </div>`).join("") + `<p class="report-note">${escapeHtml(crmI18n.t("rep.totalDue", { amount: rupees(p.dues.duePaise) }))} <a href="Orders.html?tab=dues">${escapeHtml(t("rep.open-the-list"))}</a></p>`
      : empty("fa-circle-check", t("orders.dues.none"));
  }

  // --- Support (from the loaded tickets) --------------------------------------------------
  function renderSupport() {
    const tickets = getTickets();
    const opened = tickets.filter((t) => inPeriod(t.createdAt));
    if (!donut($("ticketStatusDonut"), TICKET_STATUSES.map((status) => ({ label: crmLabel("ticketStatus", status), count: opened.filter((t) => t.status === status).length, color: TICKET_COLOR[status] })), opened.length, t("rep.tickets"))) {
      $("ticketStatusDonut").innerHTML = empty("fa-headset", t("rep.no-ticket-was-opened-in-this"));
    }
    bars($("ticketPriorityBars"), TICKET_PRIORITIES.map((priority) => ({ label: crmLabel("priority", priority), value: opened.filter((t) => t.priority === priority).length })).filter((r) => r.value), t("rep.no-ticket-was-opened-in-this"), "fa-headset");
    const today = indiaToday();
    const isClosed = (t) => t.status === "Resolved" || t.status === "Closed";
    // Open and past the SLA's first reply, or resolution unless it waits on the customer (D107).
    const slaMissed = (t) => {
      if (!t.sla || isClosed(t)) return false;
      const part = t.sla.reply.at ? t.sla.resolve : t.sla.reply;
      return part.state !== "paused" && new Date(part.dueAt) <= Date.now();
    };
    const o = got("overview");
    const rows = [
      ["fa-inbox", "info", t("rep.open-tickets"), t("rep.across-the-team"), tickets.filter((t) => !isClosed(t)).length],
      ["fa-triangle-exclamation", "warning", t("dash.overdue"), t("rep.past-their-due-date-not-resolved"), tickets.filter((t) => t.dueDate && t.dueDate < today && !isClosed(t)).length],
      ["fa-bolt", "warning", t("rep.urgent-and-open"), t("rep.need-attention-now"), tickets.filter((t) => t.priority === "Urgent" && !isClosed(t)).length],
      ["fa-circle-check", "success", t("rep.resolved-in-the-period"), "", o ? o.tickets.resolved : "—"],
      ...(got("sla")?.enabled ? [["fa-stopwatch", "warning", t("sla.chip.missed"), t("rep.open-past-the-first-reply-or"), tickets.filter(slaMissed).length]] : []),
    ];
    $("supportSnapshot").innerHTML = rows.map(([icon, cls, name, sub, value]) => `<div class="mini-row"><span class="mini-icon ${cls}"><i class="fa-solid ${icon}"></i></span><div class="info"><div class="name">${escapeHtml(name)}</div><div class="sub">${escapeHtml(sub)}</div></div><div class="mini-right">${escapeHtml(String(value))}</div></div>`).join("");
    renderSla();
  }

  // Ticket SLA (D107): of the tickets opened in the period, the first replies and resolutions in
  // time (met %: of those done or missed; tickets with time left are not counted yet).
  function renderSla() {
    const s = got("sla");
    if (!s) return;
    const inTime = (part) => (part.metPct == null ? "—" : pctText(part.metPct));
    const decided = (part) => part.met + part.late + part.breached;
    const missedOpen = (b) => b.reply.breached + b.resolve.breached;
    const medianText = (minutes) => (minutes == null ? "—" : minutes < 1 ? crmI18n.t("rep.1-min") : duration(minutes * 60));
    $("slaNote").textContent = !s.enabled
      ? crmI18n.t("rep.switched-off-for-new-tickets-support")
      : crmI18n.t("rep.tickets-opened-in-the-period", { v: s.workingHoursOnly ? crmI18n.t("rep.working-hours") : crmI18n.t("sla.box.allHours") });
    $("slaPeoplePanel").hidden = !s.total.tickets;
    if (!s.total.tickets) {
      $("slaKpis").innerHTML = "";
      $("slaPriorityTable").innerHTML = empty("fa-stopwatch", crmI18n.t("rep.no-ticket-with-an-sla-was"));
      return;
    }
    const kpi = (label, value, sub) => `<div class="stat-card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="report-note">${escapeHtml(sub)}</div></div>`;
    const t = s.total;
    $("slaKpis").innerHTML = [
      kpi(crmI18n.t("rep.first-reply-in-time"), inTime(t.reply), `${t.reply.met} of ${decided(t.reply)}`),
      kpi(crmI18n.t("rep.resolved-in-time"), inTime(t.resolve), `${t.resolve.met} of ${decided(t.resolve)}`),
      kpi(crmI18n.t("rep.sla-missed-still-open"), missedOpen(t), crmI18n.t("rep.first-replies-and-resolutions")),
      kpi(crmI18n.t("sla.box.reply"), medianText(t.firstReplyMedianMinutes), s.workingHoursOnly ? crmI18n.t("rep.median-in-working-time") : "median"),
    ].join("");
    const head = (first) => [[first], [crmI18n.t("rep.tickets"), 1], [crmI18n.t("rep.first-reply-in-time"), 1], [crmI18n.t("rep.resolved-in-time"), 1], [crmI18n.t("rep.missed-open"), 1], [crmI18n.t("sla.box.reply"), 1]];
    const row = (name, b) => `<tr><td>${name}</td>${cell(b.tickets)}${cell(inTime(b.reply), `${b.reply.met} of ${decided(b.reply)}`)}${cell(inTime(b.resolve), `${b.resolve.met} of ${decided(b.resolve)}`)}${cell(missedOpen(b))}${cell(medianText(b.firstReplyMedianMinutes))}</tr>`;
    $("slaPriorityTable").innerHTML = table(head(crmI18n.t("board.field.task.priority")), s.byPriority.filter((p) => p.tickets).map((p) => row(escapeHtml(p.priority), p)));
    $("slaPeopleTable").innerHTML = table(head("Agent"), s.byMember.map((m) => row(m.memberId ? escapeHtml(m.name) : crmI18n.t("rep.not-assigned"), m)));
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
  async function exportReport(format) {
    const type = EXPORT_TYPE[state.tab];
    try {
      await crmDownload(`/reports/export?type=${type}&format=${format}&${query()}`, `report-${type}-${state.range.from}-to-${state.range.to}.${format}`);
      showToast(t("rep.report-downloaded"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("rep.couldn-t-export-the-report")), "error");
    }
  }
  $("exportBtn").addEventListener("click", () => exportReport("csv"));
  $("exportXlsxBtn").addEventListener("click", () => exportReport("xlsx"));
  $("printBtn").addEventListener("click", () => window.print());

  const remembered = getPreference("reportsRange", "30");
  if ([...$("filterRange").options].some((o) => o.value === remembered && remembered !== "custom")) $("filterRange").value = remembered;
  crmReady(["products", "tickets", "campaigns"], applyRange);
})();
