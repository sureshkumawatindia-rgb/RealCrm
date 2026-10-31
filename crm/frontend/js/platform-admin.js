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
    if (!iso) return "never";
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 2) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
  }
  const pct = (value) => (value == null ? "—" : `${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`);
  const kpi = (label, value, sub = "", cls = "") => `<div class="stat-card ${cls}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="report-note">${escapeHtml(sub)}</div></div>`;
  const empty = (text) => `<div class="report-empty"><i class="fa-solid fa-circle-info"></i>${escapeHtml(text)}</div>`;
  const plural = (n, word) => `${n.toLocaleString("en-IN")} ${word}${n === 1 ? "" : "s"}`;

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
    $("paUntil").textContent = `Open until ${timeText(status.unlockedUntil)}`;
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
      showToast(apiErrorMessage(error, "Couldn't open the page."), "error");
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
      $("paUnlockError").textContent = error?.message || "That code didn't work.";
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
  }

  // --- overview ------------------------------------------------------------------------------
  async function loadOverview() {
    try {
      const o = await crmApi("/platform/overview");
      const c = o.companies;
      $("paKpis").innerHTML = [
        kpi("Companies", c.total, `${c.new30Days} new in 30 days · ${c.newThisMonth} this month`),
        kpi("Paying", c.paying, `${c.pastDue} payment due · ${c.cancelling} cancelling`, "success"),
        kpi("MRR", rupees(o.mrrPaise), "plan prices before GST, paying companies"),
        kpi("Money in this month", rupees(o.collectedThisMonth.totalPaise), `${plural(o.collectedThisMonth.invoices, "invoice")}, with GST`),
        kpi("On trial", c.trialing, `${c.locked} locked · ${c.comped} complimentary`),
        kpi("Trial to paid", pct(o.trialToPaid.pct), `${o.trialToPaid.paid} of ${o.trialToPaid.finished} (trials of the last 90 days)`),
        kpi("Churn", pct(o.churn.pct), `${o.churn.stopped} paying ${o.churn.stopped === 1 ? "company" : "companies"} stopped in 30 days`, o.churn.stopped ? "warning" : ""),
        kpi("Emails in 30 days", o.emails.sent || 0, o.emails.enabled ? `${o.emails.failed || 0} failed · ${o.emails.queued || 0} waiting` : "email is off: no Resend key", o.emails.failed ? "warning" : ""),
        ...(c.deletionScheduled ? [kpi("Set to be deleted", c.deletionScheduled, "companies in their 7 days", "warning")] : []),
      ].join("");
      $("paOverviewNote").textContent = "Trial to paid: companies that started in the last 90 days and whose trial is over (complimentary ones left out), and how many have paid at least once. Churn: paying companies that stopped (cancelled at the end of their month, or payments failed) in the last 30 days, against those paying now plus them.";
    } catch (error) {
      $("paKpis").innerHTML = empty("Couldn't load the overview.");
      handle(error, "Couldn't load the overview.");
    }
  }

  // --- companies -----------------------------------------------------------------------------
  const STATUS_BADGES = {
    trialing: ["badge-info", "Trial"],
    active: ["badge-success", "Paying"],
    past_due: ["badge-warning", "Payment due"],
    halted: ["badge-danger", "Stopped"],
    cancelled: ["badge-neutral", "Cancelling"],
    expired: ["badge-danger", "Ended"],
    comped: ["badge-brand", "Complimentary"],
  };
  function planCell(c) {
    const [cls, label] = STATUS_BADGES[c.status] || ["badge-neutral", c.status];
    const when = c.status === "trialing" && c.trialEndsAt ? `ends ${dateText(c.trialEndsAt)} (${c.daysLeft} days)`
      : c.currentPeriodEnd && ["active", "past_due", "cancelled"].includes(c.status) ? `${c.cancelAtPeriodEnd || c.status === "cancelled" ? "ends" : "renews"} ${dateText(c.currentPeriodEnd)}`
        : "";
    return `<td class="pa-plan">${escapeHtml(c.planName)} <span class="badge ${cls}">${escapeHtml(label)}</span>${c.deletionScheduledFor ? ` <span class="badge badge-danger">Deleting ${escapeHtml(dateText(c.deletionScheduledFor))}</span>` : ""}${when ? `<span class="pa-cell-sub">${escapeHtml(when)}</span>` : ""}</td>`;
  }
  function whatsappCell(w) {
    if (!w.numbers) return `<td class="pa-wa"><span class="pa-dot none"></span>none</td>`;
    const notes = [`${w.connected}/${w.numbers} connected`, w.quality ? `quality ${w.quality.toLowerCase()}` : "", `last from Meta ${ago(w.lastWebhookAt)}`].filter(Boolean).join(" · ");
    return `<td class="pa-wa"><span class="pa-dot ${escapeHtml(w.health)}"></span>${escapeHtml(plural(w.numbers, "number"))}<span class="pa-cell-sub">${escapeHtml(notes)}</span></td>`;
  }
  const num = (value, sub = "") => `<td class="num">${escapeHtml(Number(value || 0).toLocaleString("en-IN"))}${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ""}</td>`;
  function renderCompanies() {
    if (!state.companies.length) {
      $("paCompanyTable").innerHTML = empty(state.q || state.status ? "No company matches." : "No companies yet.");
      $("paPager").hidden = true;
      return;
    }
    const rows = state.companies.map((c) => `
      <tr>
        <td class="pa-company"><span class="name">${escapeHtml(c.name || "(no name)")}</span><span class="sub">${escapeHtml(c.owner ? `${c.owner.name ? `${c.owner.name} · ` : ""}${c.owner.email}` : "no owner")}</span><span class="sub">since ${escapeHtml(dateText(c.createdAt))} · ${escapeHtml(c.id)}</span></td>
        ${planCell(c)}
        ${num(c.users)}
        ${whatsappCell(c.whatsapp)}
        ${num(c.contacts)}
        ${num(c.broadcastsThisMonth)}
        <td class="num">${escapeHtml(rupees(c.paid.totalPaise))}<span class="sub">${escapeHtml(c.paid.invoices ? `${plural(c.paid.invoices, "invoice")} · last ${dateText(c.paid.lastPaidAt)}` : "never paid")}</span></td>
        <td>${escapeHtml(ago(c.lastActiveAt))}</td>
        <td class="pa-act"><button class="btn btn-outline" type="button" data-act="${escapeHtml(c.id)}"><i class="fa-solid fa-sliders"></i> Change…</button></td>
      </tr>`).join("");
    $("paCompanyTable").innerHTML = `<table><thead><tr><th>Company</th><th>Plan</th><th class="num">Users</th><th>WhatsApp</th><th class="num">Contacts</th><th class="num">Broadcasts <span class="sub">this month</span></th><th class="num">Paid</th><th>Last active</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    const pages = Math.max(Math.ceil(state.total / state.limit), 1);
    $("paPager").hidden = pages < 2;
    $("paPageInfo").textContent = `Page ${state.page} of ${pages} · ${plural(state.total, "company")}`;
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
      $("paCompanyTable").innerHTML = empty("Couldn't load the companies.");
      handle(error, "Couldn't load the companies.");
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
    trial: "The trial ends that many days from today and the trial reminders start again. A company that pays through Razorpay keeps its subscription there.",
    plan: "Sets the plan by hand (e.g. paid by bank transfer). Its limits and features change at once.",
    comp: "Free, with no end date and no payments. If the company pays through Razorpay, cancel its subscription in Razorpay too.",
  };
  function syncActionFields() {
    const action = $("paAction").value;
    $("paDaysField").hidden = action !== "trial";
    $("paPlanField").hidden = action !== "plan";
    $("paActionHint").textContent = HINTS[action];
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
    $("paActionCompany").textContent = `${company.name} — now ${company.planName}, ${(STATUS_BADGES[company.status] || [null, company.status])[1].toLowerCase()}.`;
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
    if (action === "comp" && !window.confirm(`Make ${company.name} complimentary (free, no end)?`)) return;
    $("paActionSave").disabled = true;
    try {
      const row = await crmApi(`/platform/companies/${company.id}/actions`, jsonRequest("POST", body));
      state.companies = state.companies.map((c) => (c.id === row.id ? row : c));
      renderCompanies();
      closeAction();
      showToast(`${row.name}: ${row.planName}, ${(STATUS_BADGES[row.status] || [null, row.status])[1].toLowerCase()}. Written to its audit log.`, "success");
    } catch (error) {
      handle(error, "That didn't work.");
    } finally {
      $("paActionSave").disabled = false;
    }
  });

  // --- emails --------------------------------------------------------------------------------
  const KIND_NAMES = {
    invite: "Team invite", trial_reminder: "Trial ends soon", trial_ended: "Trial ended", payment_failed: "Payment failed",
    plan_invoice: "Plan invoice", deletion_scheduled: "Deletion set", deletion_tomorrow: "Deleted tomorrow", login_alert: "New login",
  };
  const EMAIL_BADGES = { sent: ["badge-success", "Sent"], failed: ["badge-danger", "Failed"], skipped: ["badge-neutral", "Not sent"], queued: ["badge-info", "Waiting"] };
  async function loadEmails() {
    const status = $("paEmailStatus").value;
    try {
      const data = await crmApi(`/platform/emails?limit=100${status ? `&status=${encodeURIComponent(status)}` : ""}`);
      const t = data.totals;
      $("paEmailKpis").innerHTML = [
        kpi("Email", data.enabled ? "On" : "Off", data.enabled ? "Resend key and sender set" : "RESEND_API_KEY and EMAIL_FROM not set: see docs/EMAIL_SETUP.md", data.enabled ? "success" : "warning"),
        kpi("Sent in 30 days", t.sent || 0),
        kpi("Failed", t.failed || 0, "after every retry", t.failed ? "warning" : ""),
        kpi("Not sent", t.skipped || 0, "no key at the time"),
      ].join("");
      $("paEmailTable").innerHTML = data.recent.length
        ? `<table><thead><tr><th>When</th><th>To</th><th>Email</th><th>Status</th><th>Details</th></tr></thead><tbody>${data.recent.map((d) => {
          const [cls, label] = EMAIL_BADGES[d.status] || ["badge-neutral", d.status];
          return `<tr><td>${escapeHtml(dateText(d.createdAt))}<span class="pa-cell-sub">${escapeHtml(timeText(d.createdAt))}</span></td><td>${escapeHtml(d.to)}</td><td>${escapeHtml(KIND_NAMES[d.kind] || d.kind)}<span class="pa-cell-sub">${d.language === "hi" ? "Hindi" : "English"}</span></td><td><span class="badge ${cls}">${escapeHtml(label)}</span>${d.attempts > 1 ? `<span class="pa-cell-sub">${d.attempts} tries</span>` : ""}</td><td>${escapeHtml(d.error || d.subject || "")}</td></tr>`;
        }).join("")}</tbody></table>`
        : empty("No emails yet.");
    } catch (error) {
      $("paEmailTable").innerHTML = empty("Couldn't load the emails.");
      handle(error, "Couldn't load the emails.");
    }
  }
  $("paEmailStatus").addEventListener("change", loadEmails);

  // --- go-live checklist ---------------------------------------------------------------------
  async function loadChecklist() {
    try {
      const data = await crmApi("/platform/checklist");
      $("paChecklistNote").textContent = `${data.done} of ${data.total} done on this server. "Check by hand" items cannot be seen from here. The full steps are in docs/GO_LIVE_CHECKLIST.md; no key's value is ever shown.`;
      $("paWarnings").hidden = !data.warnings.length;
      $("paWarnings").innerHTML = data.warnings.map((w) => `<div><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(w)}</div>`).join("");
      $("paChecklist").innerHTML = data.items.map((item) => {
        const [cls, icon, label] = item.done === true ? ["done", "fa-circle-check", "Done"] : item.done === false ? ["missing", "fa-circle-xmark", "Not set"] : ["unknown", "fa-circle-question", "Check by hand"];
        return `<li class="pa-check"><i class="fa-solid ${icon} pa-check-icon ${cls}" aria-label="${label}"></i><div class="pa-check-body"><div class="title">${escapeHtml(item.title)} <span class="text-muted">· ${label}</span></div>${item.done === true ? "" : `<div class="without">Without it: ${escapeHtml(item.without)}</div>`}<div class="guide">Guide: ${escapeHtml(item.guide)}</div></div></li>`;
      }).join("");
    } catch (error) {
      $("paChecklist").innerHTML = "";
      handle(error, "Couldn't load the checklist.");
    }
  }

  start();
})();
