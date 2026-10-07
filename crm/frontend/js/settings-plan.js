/**
 * settings-plan.js — Settings → Plan & usage (Phase 10, owners and admins)
 * The company's plan and where it stands (trial, active, payment due, ended …), the usage
 * meters (users, WhatsApp numbers, contacts, broadcasts and quotations this month, templates),
 * the plans on offer and the GST invoices. Choosing a plan opens Razorpay's page (or the test
 * page in development) in a new tab; this page then checks until the payment arrives. The
 * server checks every limit; this page shows them.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsPlan() {
  if (!isOrgManager()) return leaveManagerTab("plan");
  document.getElementById("planTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const rupees = (paise) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
  const count = (n) => Number(n).toLocaleString("en-IN");
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");
  const STATUS = {
    trialing: ["Free trial", "badge-info"],
    active: ["Active", "badge-success"],
    past_due: ["Payment due", "badge-warning"],
    halted: ["Payment failed", "badge-danger"],
    cancelled: ["Cancelled", "badge-warning"],
    expired: ["Ended", "badge-danger"],
    comped: ["Complimentary", "badge-neutral"],
  };
  // How a limit reads on a plan card.
  const LIMIT_TEXT = {
    users: (n) => `${count(n)} user${n === 1 ? "" : "s"}`,
    whatsappNumbers: (n) => `${count(n)} WhatsApp number${n === 1 ? "" : "s"}`,
    contacts: (n) => `${count(n)} contacts`,
    broadcastsPerMonth: (n) => `${count(n)} broadcasts a month`,
    quotesPerMonth: (n) => `${count(n)} quotations a month`,
    templates: (n) => `${count(n)} message templates`,
  };
  const UNLIMITED_TEXT = { templates: "Unlimited message templates" };
  let catalog = null;
  let current = null;
  let loaded = false;
  let watching = null; // the check after a checkout tab was opened

  const paying = () => ["active", "past_due"].includes(current.subscription.status) && Boolean(current.subscription.provider);
  const planName = (key) => catalog.plans.find((p) => p.key === key)?.name || key;

  function statusLine({ plan, subscription: s }) {
    switch (s.status) {
      case "trialing": return `Free ${plan.name} trial until ${day(s.trialEndsAt)} (${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"} left). Choose a plan before then to keep everything running; the rest of the trial stays free.`;
      case "active":
        if (s.firstChargeAt) return `Active. The first payment is on ${day(s.firstChargeAt)}, when the free trial ends.`;
        if (s.cancelAtPeriodEnd) return `Cancelled: it works until ${day(s.currentPeriodEnd)} and is not charged again.`;
        return s.currentPeriodEnd ? `Renews on ${day(s.currentPeriodEnd)}.` : "Active.";
      case "past_due": return "The last payment did not go through; Razorpay will try again. Check your card or UPI mandate.";
      case "halted": return "The payments for this plan failed. Your data is safe and chats keep working; choose a plan again to add things.";
      case "cancelled": return `Cancelled; it works until ${day(s.currentPeriodEnd)}.`;
      case "expired": return s.wasTrial && s.trialEndsAt
        ? `The free trial ended on ${day(s.trialEndsAt)}. Your data is safe and chats keep working; choose a plan to add contacts, quotations, broadcasts and teammates again.`
        : "This plan has ended. Your data is safe and chats keep working; choose a plan to add things again.";
      default: return "Complimentary: this company uses the CRM without a subscription.";
    }
  }

  function renderCurrent() {
    const s = current.subscription;
    const [label, badge] = STATUS[s.status] || [s.status, "badge-neutral"];
    const lines = [statusLine(current)];
    if (s.pendingPlan && paying()) lines.push(`Changes to ${planName(s.pendingPlan)} on ${day(s.currentPeriodEnd)}.`);
    if (s.checkoutUrl && s.pendingPlan) lines.push(`Waiting for the payment for ${planName(s.pendingPlan)}.`);
    const buttons = [
      s.checkoutUrl ? `<a class="btn btn-primary" href="${escapeHtml(s.checkoutUrl)}" target="_blank" rel="noopener">Finish paying</a>` : "",
      s.provider ? '<button class="btn btn-outline" type="button" data-act="refresh"><i class="fa-solid fa-rotate"></i> Check now</button>' : "",
      paying() && !s.cancelAtPeriodEnd ? '<button class="btn btn-danger-outline" type="button" data-act="cancel">Cancel plan</button>' : "",
    ].filter(Boolean);
    $("planCurrent").innerHTML = `
      <div class="plan-current">
        <div>
          <h4>${escapeHtml(current.plan.name)} <span class="badge ${badge}">${escapeHtml(label)}</span>${current.billing?.test && s.provider ? ' <span class="badge badge-neutral">Test payments</span>' : ""}</h4>
          ${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
          ${buttons.length ? `<div class="pl-buttons" style="margin-top: 10px">${buttons.join("")}</div>` : ""}
        </div>
        <div class="plan-price">${rupees(current.plan.pricePaise)}<small> /month + GST</small></div>
      </div>`;
  }

  function renderMeters() {
    $("planMeters").innerHTML = (current.usage || []).map((m) => {
      const pct = m.limit ? Math.min(Math.round((m.used / m.limit) * 100), 100) : 0;
      const level = m.limit && m.used >= m.limit ? " full" : pct >= 80 ? " near" : "";
      return `
        <div class="plan-meter">
          <div class="plan-meter-top"><span>${escapeHtml(m.label)}</span><strong>${count(m.used)}${m.limit === null ? "" : ` / ${count(m.limit)}`}</strong></div>
          ${m.limit === null ? '<div class="plan-meter-top" style="margin-top: 8px"><span>No limit on this plan</span></div>' : `<div class="plan-bar${level}" role="progressbar" aria-valuemin="0" aria-valuemax="${m.limit}" aria-valuenow="${m.used}" aria-label="${escapeHtml(m.label)}"><span style="width: ${pct}%"></span></div>`}
        </div>`;
    }).join("");
  }

  function buttonFor(p) {
    const isCurrent = p.key === current.plan.key;
    if (isCurrent && paying() && !current.subscription.pendingPlan) return '<button class="btn btn-outline" type="button" disabled>Current plan</button>';
    if (!current.billing?.enabled) return "";
    const verb = paying() ? (p.totalPaise > current.plan.totalPaise ? "Upgrade to" : "Switch to") : "Choose";
    return `<button class="btn btn-primary" type="button" data-plan="${escapeHtml(p.key)}">${verb} ${escapeHtml(p.name)}</button>`;
  }

  function planCard(p) {
    const isCurrent = p.key === current.plan.key;
    const limits = catalog.limits.map(({ metric }) => (p.limits[metric] === null ? UNLIMITED_TEXT[metric] : LIMIT_TEXT[metric](p.limits[metric]))).filter(Boolean);
    const features = catalog.features.map(({ feature, label }) => `<li class="${p.features[feature] ? "" : "no"}">${p.features[feature] ? '<i class="fa-solid fa-check"></i> ' : ""}${escapeHtml(label)}</li>`);
    // Above the new plan's limits: nothing is removed, but no more can be added.
    const over = (current.usage || []).filter((m) => p.limits[m.metric] !== null && m.used > p.limits[m.metric]).map((m) => m.label.toLowerCase());
    return `
      <div class="plan-card${isCurrent ? " current" : ""}">
        <h4>${escapeHtml(p.name)} ${isCurrent ? '<span class="badge badge-brand">Your plan</span>' : ""}</h4>
        <div class="plan-price">${rupees(p.pricePaise)}<small> /month</small></div>
        <div class="settings-hint" style="margin: 0">${rupees(p.totalPaise)} with GST</div>
        <ul>${limits.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}${features.join("")}</ul>
        ${over.length && !isCurrent ? `<div class="settings-hint" style="margin: 0">You have more ${escapeHtml(over.join(", "))} than this plan allows: they stay, but you cannot add more.</div>` : ""}
        ${buttonFor(p)}
      </div>`;
  }

  function renderPlans() {
    $("planGrid").innerHTML = catalog.plans.map(planCard).join("");
    const billing = current.billing || {};
    $("planGridHint").textContent = billing.enabled
      ? `Prices are per month, plus 18% GST. You pay on Razorpay's secure page (card, UPI or netbanking); it charges each month until you cancel, and a GST invoice appears below.${paying() ? " An upgrade starts now; a smaller plan starts with the next month." : ""}`
      : `Prices are per month, plus 18% GST. Paying online is not switched on yet: ${billing.contactEmail ? `write to ${billing.contactEmail}` : "contact support"} to change your plan.`;
  }

  async function renderInvoices() {
    let invoices = [];
    try {
      invoices = await crmApi("/billing/invoices");
    } catch {
      /* shown when it loads */
    }
    $("planInvoicesSection").hidden = !invoices.length;
    $("planInvoices").innerHTML = invoices.length ? `
      <div style="overflow-x: auto"><table>
        <thead><tr><th>Invoice</th><th>Date</th><th>Plan</th><th>Period</th><th style="text-align: right">Amount</th><th></th></tr></thead>
        <tbody>${invoices.map((i) => `<tr>
          <td>${escapeHtml(i.number)}</td><td>${escapeHtml(day(i.issuedAt))}</td><td>${escapeHtml(i.planName)}</td>
          <td>${i.periodStart ? `${escapeHtml(day(i.periodStart))} – ${escapeHtml(day(i.periodEnd))}` : ""}</td>
          <td style="text-align: right">${rupees(i.totalPaise)}<div class="settings-hint" style="margin: 0">incl. GST ${rupees(i.gstPaise)}</div></td>
          <td><button class="btn btn-outline" type="button" data-invoice="${escapeHtml(i.id)}" data-number="${escapeHtml(i.number)}"><i class="fa-solid fa-file-pdf"></i> PDF</button></td>
        </tr>`).join("")}</tbody>
      </table></div>` : "";
  }

  function render() {
    renderCurrent();
    renderMeters();
    renderPlans();
  }

  async function load() {
    try {
      [catalog, current] = await Promise.all([crmApi("/billing/plans"), crmPlan.state({ fresh: true })]);
      render();
      renderInvoices();
    } catch (error) {
      $("planCurrent").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, "Could not load the plan."))}</p>`;
    }
  }

  // After the checkout tab opens: look again every 5 seconds for 3 minutes, until it is paid.
  function watchForPayment() {
    clearInterval(watching);
    const started = Date.now();
    watching = setInterval(async () => {
      if (Date.now() - started > 3 * 60 * 1000) return clearInterval(watching);
      if (document.hidden) return;
      try {
        const before = current.subscription.checkoutUrl;
        current = await crmApi("/billing/subscription/refresh", { method: "POST" });
        if (before && !current.subscription.checkoutUrl) {
          clearInterval(watching);
          showToast(`Thank you! You are on the ${current.plan.name} plan.`, "success");
          crmPlan.forget();
          load();
          crmPlan.mountBanner();
        }
      } catch {
        /* tried again in 5 seconds */
      }
    }, 5000);
  }

  async function choose(button) {
    const key = button.dataset.plan;
    const changing = paying();
    if (changing && !confirm(`${button.textContent.trim()}? ${catalog.plans.find((p) => p.key === key).totalPaise > current.plan.totalPaise ? "It starts now." : "It starts with the next month."}`)) return;
    // The tab opens on the click itself (pop-up blockers allow that), then gets the address.
    const tab = changing ? null : window.open("", "_blank");
    button.disabled = true;
    try {
      const result = await crmApi("/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: key }) });
      if (result.checkoutUrl) {
        if (tab) {
          tab.opener = null;
          tab.location.href = result.checkoutUrl;
        } else {
          window.location.href = result.checkoutUrl;
        }
        showToast("Pay on the page that opened. This page updates when the payment arrives.", "info");
        await load();
        watchForPayment();
      } else {
        showToast(result.when === "now" ? `You are on the ${planName(key)} plan now.` : `The ${planName(key)} plan starts with the next month.`, "success");
        crmPlan.forget();
        await load();
      }
    } catch (error) {
      tab?.close();
      showToast(apiErrorMessage(error, "Could not start the payment."), "error");
    } finally {
      button.disabled = false;
    }
  }

  $("planGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-plan]");
    if (button && !button.disabled) choose(button);
  });

  $("planCurrent").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    if (button.dataset.act === "cancel" && !confirm(`Cancel the ${current.plan.name} plan? It works until the paid month ends and is not charged again. Your data stays.`)) return;
    button.disabled = true;
    try {
      const path = button.dataset.act === "cancel" ? "/billing/subscription/cancel" : "/billing/subscription/refresh";
      await crmApi(path, { method: "POST" });
      showToast(button.dataset.act === "cancel" ? "Plan cancelled. It works until the paid month ends." : "Checked with Razorpay.", "success");
      crmPlan.forget();
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, "That did not work."), "error");
    } finally {
      button.disabled = false;
    }
  });

  $("planInvoices").addEventListener("click", (event) => {
    const button = event.target.closest("[data-invoice]");
    if (!button) return;
    crmDownload(`/billing/invoices/${encodeURIComponent(button.dataset.invoice)}/pdf`, `${button.dataset.number.replace(/\//g, "-")}.pdf`)
      .catch((error) => showToast(apiErrorMessage(error, "Could not download the invoice."), "error"));
  });

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    load();
  }
  document.querySelector('.settings-tab[data-panel="plan"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="plan"]').classList.contains("active")) loadOnce();
})();
