/**
 * platform-admin.js — the platform admin page (D104): only for the emails in PLATFORM_ADMIN_EMAILS
 * with 2-step login by the authenticator app, after a code (open 30 minutes on this login).
 * Overview (MRR, money in, new companies, trial to paid, churn), every company as counts with
 * WhatsApp health and the plan actions (comp, give a trial, change the plan: audited in that
 * company), the platform's emails, and the go-live checklist (which keys are set, never values).
 * GET /platform/status, POST /platform/unlock|lock, GET /platform/overview|companies|emails|checklist,
 * POST /platform/companies/:id/actions.
 */
(function platformAdmin() {
  const $ = (id) => document.getElementById(id);
  const GATES = ["paLoading", "paNotAdmin", "paNeedsApp", "paUnlock", "paMain"];
  const state = { tab: "overview", page: 1, limit: 50, q: "", status: "", companies: [], total: 0, acting: null, lockTimer: null };

  const rupees = (paise) => `₹${(Math.round(Number(paise) || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  const dateText = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
  const timeText = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  function ago(iso) {
    if (!iso) return t("padm.never");
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 2) return t("bell.justNow");
    if (minutes < 60) return t("setdev.min-ago", { minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 48) return t("padm.hAgo", { hours });
    return t("padm.daysAgo", { n: Math.round(hours / 24) });
  }
  const pct = (value) => (value == null ? "—" : `${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`);
  const kpi = (label, value, sub = "", cls = "") => `<div class="stat-card ${cls}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="report-note">${escapeHtml(sub)}</div></div>`;
  const empty = (text) => `<div class="report-empty"><i class="fa-solid fa-circle-info"></i>${escapeHtml(text)}</div>`;
  const count = (n, key) => t(`${key}.${n === 1 ? "one" : "many"}`, { n: n.toLocaleString("en-IN") }); // "1 invoice", "2 invoices"

  function show(gate) {
    GATES.forEach((id) => {
      $(id).hidden = id !== gate;
    });
    const open = gate === "paMain";
    $("paLock").hidden = !open;
    $("paUntil").hidden = !open;
  }

  // The code ran out (30 minutes) or the page was locked elsewhere: ask again.
  function handle(error, fallback) {
    if (error?.code === "PLATFORM_CODE_REQUIRED") {
      openGate({ admin: true, authenticator: true, unlockedUntil: null });
      return;
    }
    if (error?.code === "PLATFORM_NEEDS_AUTHENTICATOR") {
      show("paNeedsApp");
      return;
    }
    showToast(apiErrorMessage(error, fallback), "error");
  }

  function openGate(status) {
    clearTimeout(state.lockTimer);
    if (!status.admin) return show("paNotAdmin");
    if (!status.authenticator) return show("paNeedsApp");
    if (!status.unlockedUntil) {
      show("paUnlock");
      $("paCode").value = "";
      $("paUnlockError").hidden = true;
      $("paCode").focus();
      return undefined;
    }
    show("paMain");
    $("paUntil").textContent = t("padm.open-until", { v: timeText(status.unlockedUntil) });
    // Closes itself when the 30 minutes are over.
    state.lockTimer = setTimeout(() => openGate({ ...status, unlockedUntil: null }), Math.max(new Date(status.unlockedUntil).getTime() - Date.now(), 0) + 1000);
    loadTab();
    return undefined;
  }

  async function start() {
    try {
      openGate(await crmApi("/platform/status"));
    } catch (error) {
      show("paNotAdmin");
      showToast(apiErrorMessage(error, t("padm.couldn-t-open-the-page")), "error");
    }
  }

  $("paUnlock").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = $("paCode").value.replace(/\s/g, "");
    if (!code) return;
    $("paUnlockBtn").disabled = true;
    try {
      const { unlockedUntil } = await crmApi("/platform/unlock", jsonRequest("POST", { code }));
      openGate({ admin: true, authenticator: true, unlockedUntil });
    } catch (error) {
      if (error?.code === "PLATFORM_NEEDS_AUTHENTICATOR") return show("paNeedsApp");
      // The whole sentence ("That code is not right. Enter the 6 digits …"), not the field's short note.
      $("paUnlockError").textContent = error?.message || t("padm.that-code-didn-t-work");
      $("paUnlockError").hidden = false;
      $("paCode").select();
    } finally {
      $("paUnlockBtn").disabled = false;
    }
    return undefined;
  });

  $("paLock").addEventListener("click", async () => {
    try {
      await crmApi("/platform/lock", { method: "POST" });
    } catch {
      /* locked here anyway */
    }
    openGate({ admin: true, authenticator: true, unlockedUntil: null });
  });

  // --- tabs ----------------------------------------------------------------------------------
  $("paTabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (!tab) return;
    state.tab = tab.dataset.tab;
    document.querySelectorAll("#paTabs [data-tab]").forEach((b) => b.classList.toggle("active", b === tab));
    document.querySelectorAll("#paMain .report-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `paPanel-${state.tab}`));
    loadTab();
  });
  function loadTab() {
    if (state.tab === "overview") loadOverview();
    if (state.tab === "companies") loadCompanies();
    if (state.tab === "emails") loadEmails();
    if (state.tab === "checklist") loadChecklist();
    if (state.tab === "support") loadSupport();
  }

  // --- overview ------------------------------------------------------------------------------
  async function loadOverview() {
    try {
      const o = await crmApi("/platform/overview");
      const c = o.companies;
      $("paKpis").innerHTML = [
        kpi(t("padmin.companies"), c.total, t("padm.new-in-30-days-this-month", { new30Days: c.new30Days, newThisMonth: c.newThisMonth })),
        kpi(t("padmin.paying"), c.paying, t("padm.payment-due-cancelling", { pastDue: c.pastDue, cancelling: c.cancelling }), "success"),
        kpi("MRR", rupees(o.mrrPaise), t("padm.plan-prices-before-gst-paying-companies")),
        kpi(t("padm.money-in-this-month"), rupees(o.collectedThisMonth.totalPaise), t("padm.withGst", { invoices: count(o.collectedThisMonth.invoices, "padm.n.invoice") })),
        kpi(t("padmin.on-trial"), c.trialing, t("padm.locked-complimentary", { locked: c.locked, comped: c.comped })),
        kpi(t("padm.trial-to-paid"), pct(o.trialToPaid.pct), t("padm.of-trials-of-the-last-90", { paid: o.trialToPaid.paid, finished: o.trialToPaid.finished })),
        kpi(t("padm.churn"), pct(o.churn.pct), t(o.churn.stopped === 1 ? "padm.churn.one" : "padm.churn.many", { n: o.churn.stopped }), o.churn.stopped ? "warning" : ""),
        kpi(t("padm.emails-in-30-days"), o.emails.sent || 0, o.emails.enabled ? t("padm.failed-waiting", { v: o.emails.failed || 0, v2: o.emails.queued || 0 }) : t("padm.email-is-off-no-resend-key"), o.emails.failed ? "warning" : ""),
        ...(c.deletionScheduled ? [kpi(t("padm.set-to-be-deleted"), c.deletionScheduled, t("padm.companies-in-their-7-days"), "warning")] : []),
      ].join("");
      $("paOverviewNote").textContent = t("padm.trial-to-paid-companies-that-started");
    } catch (error) {
      $("paKpis").innerHTML = empty(t("padm.couldn-t-load-the-overview"));
      handle(error, t("padm.couldn-t-load-the-overview"));
    }
  }

  // --- companies -----------------------------------------------------------------------------
  const STATUS_BADGES = {
    trialing: ["badge-info", "padm.st.trialing"], // the keys of their texts
    active: ["badge-success", "padm.st.active"],
    past_due: ["badge-warning", "padm.st.pastDue"],
    halted: ["badge-danger", "padm.st.halted"],
    cancelled: ["badge-neutral", "padm.st.cancelled"],
    expired: ["badge-danger", "padm.st.expired"],
    comped: ["badge-brand", "padm.st.comped"],
  };
  // A company's subscription status in words, small ("paying") for the middle of a sentence.
  const statusText = (status) => (STATUS_BADGES[status] ? t(STATUS_BADGES[status][1]) : status).toLowerCase();
  function planCell(c) {
    const [cls, label] = STATUS_BADGES[c.status] || ["badge-neutral", c.status];
    const when = c.status === "trialing" && c.trialEndsAt ? t(c.daysLeft === 1 ? "padm.trialEnds.one" : "padm.trialEnds.many", { date: dateText(c.trialEndsAt), n: c.daysLeft })
      : c.currentPeriodEnd && ["active", "past_due", "cancelled"].includes(c.status) ? t(c.cancelAtPeriodEnd || c.status === "cancelled" ? "padm.ends" : "padm.renews", { date: dateText(c.currentPeriodEnd) })
        : "";
    return `<td class="pa-plan">${escapeHtml(c.planName)} <span class="badge ${cls}">${escapeHtml(t(label))}</span>${c.deletionScheduledFor ? ` <span class="badge badge-danger">${escapeHtml(t("padm.deleting", { date: dateText(c.deletionScheduledFor) }))}</span>` : ""}${when ? `<span class="pa-cell-sub">${escapeHtml(when)}</span>` : ""}</td>`;
  }
  function whatsappCell(w) {
    if (!w.numbers) return `<td class="pa-wa"><span class="pa-dot none"></span>${escapeHtml(t("padm.waNone"))}</td>`;
    const notes = [t("padm.waConnected", { connected: w.connected, numbers: w.numbers }), w.quality ? t("padm.waQuality", { quality: w.quality.toLowerCase() }) : "", t("padm.waLast", { when: ago(w.lastWebhookAt) })].filter(Boolean).join(" · ");
    return `<td class="pa-wa"><span class="pa-dot ${escapeHtml(w.health)}"></span>${escapeHtml(count(w.numbers, "padm.n.number"))}<span class="pa-cell-sub">${escapeHtml(notes)}</span></td>`;
  }
  const num = (value, sub = "") => `<td class="num">${escapeHtml(Number(value || 0).toLocaleString("en-IN"))}${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ""}</td>`;
  function renderCompanies() {
    if (!state.companies.length) {
      $("paCompanyTable").innerHTML = empty(state.q || state.status ? t("padm.no-company-matches") : t("padm.no-companies-yet"));
      $("paPager").hidden = true;
      return;
    }
    const rows = state.companies.map((c) => `
      <tr>
        <td class="pa-company"><span class="name">${escapeHtml(c.name || t("padm.no-name"))}</span><span class="sub">${escapeHtml(c.owner ? `${c.owner.name ? `${c.owner.name} · ` : ""}${c.owner.email}` : t("padm.no-owner"))}</span><span class="sub">${escapeHtml(t("padm.since", { date: dateText(c.createdAt) }))} · ${escapeHtml(c.id)}</span></td>
        ${planCell(c)}
        ${num(c.users)}
        ${whatsappCell(c.whatsapp)}
        ${num(c.contacts)}
        ${num(c.broadcastsThisMonth)}
        <td class="num">${escapeHtml(rupees(c.paid.totalPaise))}<span class="sub">${escapeHtml(c.paid.invoices ? t("padm.paidLast", { invoices: count(c.paid.invoices, "padm.n.invoice"), date: dateText(c.paid.lastPaidAt) }) : t("padm.neverPaid"))}</span></td>
        <td>${escapeHtml(ago(c.lastActiveAt))}</td>
        <td class="pa-act"><button class="btn btn-outline" type="button" data-act="${escapeHtml(c.id)}"><i class="fa-solid fa-sliders"></i> ${escapeHtml(t("padm.change"))}</button></td>
      </tr>`).join("");
    $("paCompanyTable").innerHTML = `<table><thead><tr><th>${escapeHtml(t("board.field.lead.company"))}</th><th>${escapeHtml(t("padmin.plan"))}</th><th class="num">${escapeHtml(t("usage.m.users"))}</th><th>WhatsApp</th><th class="num">${escapeHtml(t("usage.m.contacts"))}</th><th class="num">${escapeHtml(t("padm.broadcasts"))} <span class="sub">${escapeHtml(t("padm.this-month"))}</span></th><th class="num">${escapeHtml(t("padm.paid"))}</th><th>${escapeHtml(t("padm.last-active"))}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    const pages = Math.max(Math.ceil(state.total / state.limit), 1);
    $("paPager").hidden = pages < 2;
    $("paPageInfo").textContent = t("padm.pageOf", { page: state.page, pages, companies: count(state.total, "padm.n.company") });
    $("paPrev").disabled = state.page <= 1;
    $("paNext").disabled = state.page >= pages;
  }
  async function loadCompanies() {
    const query = new URLSearchParams({ page: state.page, limit: state.limit, ...(state.q && { q: state.q }), ...(state.status && { status: state.status }) });
    try {
      const data = await crmApi(`/platform/companies?${query}`);
      state.companies = data.items;
      state.total = data.total;
      renderCompanies();
    } catch (error) {
      $("paCompanyTable").innerHTML = empty(t("padm.couldn-t-load-the-companies"));
      handle(error, t("padm.couldn-t-load-the-companies"));
    }
  }
  let searchTimer = null;
  $("paSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = $("paSearch").value.trim();
      state.page = 1;
      loadCompanies();
    }, 300);
  });
  $("paStatus").addEventListener("change", () => {
    state.status = $("paStatus").value;
    state.page = 1;
    loadCompanies();
  });
  $("paPrev").addEventListener("click", () => {
    state.page = Math.max(state.page - 1, 1);
    loadCompanies();
  });
  $("paNext").addEventListener("click", () => {
    state.page += 1;
    loadCompanies();
  });

  // --- comp, trial, plan ----------------------------------------------------------------------
  const HINTS = {
    trial: "padm.hint.trial", // the keys of their texts
    plan: "padm.hint.plan",
    comp: "padm.hint.comp",
  };
  function syncActionFields() {
    const action = $("paAction").value;
    $("paDaysField").hidden = action !== "trial";
    $("paPlanField").hidden = action !== "plan";
    $("paActionHint").textContent = t(HINTS[action]);
  }
  $("paAction").addEventListener("change", syncActionFields);
  const closeAction = () => {
    $("paActionModal").classList.remove("open");
    state.acting = null;
  };
  $("paActionClose").addEventListener("click", closeAction);
  $("paActionCancel").addEventListener("click", closeAction);
  $("paCompanyTable").addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const company = state.companies.find((c) => c.id === button.dataset.act);
    if (!company) return;
    state.acting = company;
    $("paActionCompany").textContent = t("padm.nowPlan", { name: company.name, plan: company.planName, status: statusText(company.status) });
    $("paPlan").value = company.plan;
    $("paAction").value = "trial";
    syncActionFields();
    $("paActionModal").classList.add("open");
  });
  $("paActionSave").addEventListener("click", async () => {
    const company = state.acting;
    if (!company) return;
    const action = $("paAction").value;
    const body = { action, ...(action === "trial" && { days: Number($("paDays").value) }), ...(action === "plan" && { plan: $("paPlan").value }) };
    if (action === "comp" && !window.confirm(t("padm.make-complimentary-free-no-end", { name: company.name }))) return;
    $("paActionSave").disabled = true;
    try {
      const row = await crmApi(`/platform/companies/${company.id}/actions`, jsonRequest("POST", body));
      state.companies = state.companies.map((c) => (c.id === row.id ? row : c));
      renderCompanies();
      closeAction();
      showToast(t("padm.actionDone", { name: row.name, plan: row.planName, status: statusText(row.status) }), "success");
    } catch (error) {
      handle(error, t("gs.failed"));
    } finally {
      $("paActionSave").disabled = false;
    }
  });

  // --- emails --------------------------------------------------------------------------------
  const KIND_NAMES = { // the keys of their texts
    invite: "padm.kind.invite", trial_reminder: "padm.kind.trialReminder", trial_ended: "padm.kind.trialEnded", payment_failed: "padm.kind.paymentFailed",
    plan_invoice: "padm.kind.planInvoice", deletion_scheduled: "padm.kind.deletionScheduled", deletion_tomorrow: "padm.kind.deletionTomorrow", login_alert: "padm.kind.loginAlert",
  };
  const EMAIL_BADGES = { sent: ["badge-success", "padm.em.sent"], failed: ["badge-danger", "padm.em.failed"], skipped: ["badge-neutral", "padm.em.skipped"], queued: ["badge-info", "padm.em.queued"] }; // the keys of their texts
  async function loadEmails() {
    const status = $("paEmailStatus").value;
    try {
      const data = await crmApi(`/platform/emails?limit=100${status ? `&status=${encodeURIComponent(status)}` : ""}`);
      const t = data.totals;
      $("paEmailKpis").innerHTML = [
        kpi(crmI18n.t("customers.email"), data.enabled ? crmI18n.t("gs.on") : crmI18n.t("conn.state.off"), data.enabled ? crmI18n.t("padm.resend-key-and-sender-set") : crmI18n.t("padm.resend-api-key-and-email-from"), data.enabled ? "success" : "warning"),
        kpi(crmI18n.t("padm.sent-in-30-days"), t.sent || 0),
        kpi(crmI18n.t("padm.failed"), t.failed || 0, crmI18n.t("padm.after-every-retry"), t.failed ? "warning" : ""),
        kpi(crmI18n.t("inbox.tick.failed"), t.skipped || 0, crmI18n.t("padm.no-key-at-the-time")),
      ].join("");
      $("paEmailTable").innerHTML = data.recent.length
        ? `<table><thead><tr><th>${escapeHtml(crmI18n.t("inbox.later.when"))}</th><th>${escapeHtml(crmI18n.t("padm.to"))}</th><th>${escapeHtml(crmI18n.t("c360.hist.email"))}</th><th>${escapeHtml(crmI18n.t("board.field.task.status"))}</th><th>${escapeHtml(crmI18n.t("cw.details"))}</th></tr></thead><tbody>${data.recent.map((d) => {
          const [cls, label] = EMAIL_BADGES[d.status] || ["badge-neutral", d.status];
          return `<tr><td>${escapeHtml(dateText(d.createdAt))}<span class="pa-cell-sub">${escapeHtml(timeText(d.createdAt))}</span></td><td>${escapeHtml(d.to)}</td><td>${escapeHtml(KIND_NAMES[d.kind] ? crmI18n.t(KIND_NAMES[d.kind]) : d.kind)}<span class="pa-cell-sub">${d.language === "hi" ? crmI18n.t("setls.hindi") : crmI18n.t("setls.english")}</span></td><td><span class="badge ${cls}">${escapeHtml(crmI18n.t(label))}</span>${d.attempts > 1 ? `<span class="pa-cell-sub">${escapeHtml(crmI18n.t("padm.tries", { n: d.attempts }))}</span>` : ""}</td><td>${escapeHtml(d.error || d.subject || "")}</td></tr>`;
        }).join("")}</tbody></table>`
        : empty(crmI18n.t("padm.no-emails-yet"));
    } catch (error) {
      $("paEmailTable").innerHTML = empty(t("padm.couldn-t-load-the-emails"));
      handle(error, t("padm.couldn-t-load-the-emails"));
    }
  }
  $("paEmailStatus").addEventListener("change", loadEmails);

  // --- go-live checklist ---------------------------------------------------------------------
  async function loadChecklist() {
    try {
      const data = await crmApi("/platform/checklist");
      $("paChecklistNote").textContent = t("padm.of-done-on-this-server-check", { done: data.done, total: data.total });
      $("paWarnings").hidden = !data.warnings.length;
      $("paWarnings").innerHTML = data.warnings.map((w) => `<div><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(w)}</div>`).join("");
      $("paChecklist").innerHTML = data.items.map((item) => {
        const [cls, icon, label] = item.done === true ? ["done", "fa-circle-check", t("padm.check.done")] : item.done === false ? ["missing", "fa-circle-xmark", t("padm.check.notSet")] : ["unknown", "fa-circle-question", t("padm.check.byHand")];
        return `<li class="pa-check"><i class="fa-solid ${icon} pa-check-icon ${cls}" aria-label="${escapeHtml(label)}"></i><div class="pa-check-body"><div class="title">${escapeHtml(item.title)} <span class="text-muted">· ${escapeHtml(label)}</span></div>${item.done === true ? "" : `<div class="without">${escapeHtml(t("padm.without-it"))} ${escapeHtml(item.without)}</div>`}<div class="guide">${escapeHtml(t("padm.guide"))} ${escapeHtml(item.guide)}</div></div></li>`;
      }).join("");
    } catch (error) {
      $("paChecklist").innerHTML = "";
      handle(error, t("padm.couldn-t-load-the-checklist"));
    }
  }

  // --- the support contact in every company's help (D118) ----------------------------------------
  async function loadSupport() {
    try {
      const data = await crmApi("/platform/support");
      $("paSupportWhatsapp").value = data.whatsapp;
      $("paSupportEmail").value = data.email;
      $("paSupportHours").value = data.hours;
    } catch (error) {
      handle(error, t("padmin.support.loadFailed"));
    }
  }
  $("paSupportForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("paSupportSave").disabled = true;
    try {
      const data = await crmApi("/platform/support", jsonRequest("PUT", { whatsapp: $("paSupportWhatsapp").value.trim(), email: $("paSupportEmail").value.trim(), hours: $("paSupportHours").value.trim() }));
      $("paSupportWhatsapp").value = data.whatsapp; // as it is kept: +91 …
      showToast(t("padmin.support.saved"), "success");
    } catch (error) {
      // A wrong number or email in the person's language; anything else as the server says.
      const field = error.code === "VALIDATION_ERROR" ? error.errors?.[0]?.field : "";
      if (field === "whatsapp" || field === "email") showToast(t(field === "whatsapp" ? "padmin.support.badNumber" : "padmin.support.badEmail"), "error");
      else handle(error, t("padmin.support.failed"));
    } finally {
      $("paSupportSave").disabled = false;
    }
  });

  start();
})();
