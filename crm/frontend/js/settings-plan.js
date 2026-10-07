/**
 * settings-plan.js — Settings → Plan & usage (Phase 10, owners and admins)
 * The company's plan and where it stands (trial, active, ended …), the usage meters (users,
 * WhatsApp numbers, contacts, broadcasts and quotations this month, templates) and the plans on
 * offer. The server checks every limit; this page shows them.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsPlan() {
  if (!isOrgManager()) return leaveManagerTab("plan");
  document.getElementById("planTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const rupees = (paise) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
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

  function statusLine({ plan, subscription: s }) {
    switch (s.status) {
      case "trialing": return `Free ${plan.name} trial until ${day(s.trialEndsAt)} (${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"} left). Choose a plan before then to keep everything running.`;
      case "active": return s.currentPeriodEnd ? `Renews on ${day(s.currentPeriodEnd)}.` : "Active.";
      case "past_due": return "The last payment did not go through; it will be tried again. Check your card or UPI mandate.";
      case "halted": return "The payments for this plan failed. Your data is safe and chats keep working; choose a plan again to add things.";
      case "cancelled": return `Cancelled; it ends on ${day(s.currentPeriodEnd)}.`;
      case "expired": return s.wasTrial && s.trialEndsAt
        ? `The free trial ended on ${day(s.trialEndsAt)}. Your data is safe and chats keep working; choose a plan to add contacts, quotations, broadcasts and teammates again.`
        : "This plan has ended. Your data is safe and chats keep working; choose a plan to add things again.";
      default: return "Complimentary: this company uses the CRM without a subscription.";
    }
  }

  function renderCurrent() {
    const [label, badge] = STATUS[current.subscription.status] || [current.subscription.status, "badge-neutral"];
    $("planCurrent").innerHTML = `
      <div class="plan-current">
        <div>
          <h4>${escapeHtml(current.plan.name)} <span class="badge ${badge}">${escapeHtml(label)}</span></h4>
          <p>${escapeHtml(statusLine(current))}</p>
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

  function planCard(p) {
    const isCurrent = p.key === current.plan.key;
    const paying = ["active", "past_due"].includes(current.subscription.status);
    const limits = catalog.limits.map(({ metric }) => (p.limits[metric] === null ? UNLIMITED_TEXT[metric] : LIMIT_TEXT[metric](p.limits[metric]))).filter(Boolean);
    const features = catalog.features.map(({ feature, label }) => `<li class="${p.features[feature] ? "" : "no"}">${p.features[feature] ? '<i class="fa-solid fa-check"></i> ' : ""}${escapeHtml(label)}</li>`);
    return `
      <div class="plan-card${isCurrent ? " current" : ""}">
        <h4>${escapeHtml(p.name)} ${isCurrent ? '<span class="badge badge-brand">Your plan</span>' : ""}</h4>
        <div class="plan-price">${rupees(p.pricePaise)}<small> /month</small></div>
        <div class="settings-hint" style="margin: 0">${rupees(p.totalPaise)} with GST</div>
        <ul>${limits.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}${features.join("")}</ul>
        <button class="btn ${isCurrent && paying ? "btn-outline" : "btn-primary"}" type="button" data-plan="${escapeHtml(p.key)}" ${isCurrent && paying ? "disabled" : ""}>${isCurrent && paying ? "Current plan" : `Choose ${escapeHtml(p.name)}`}</button>
      </div>`;
  }

  function renderPlans() {
    $("planGrid").innerHTML = catalog.plans.map(planCard).join("");
  }

  async function load() {
    try {
      [catalog, current] = await Promise.all([crmApi("/billing/plans"), crmPlan.state({ fresh: true })]);
      renderCurrent();
      renderMeters();
      renderPlans();
    } catch (error) {
      $("planCurrent").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, "Could not load the plan."))}</p>`;
    }
  }

  $("planGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-plan]");
    if (!button || button.disabled) return;
    showToast("Paying for a plan online is not switched on yet. Write to support to change your plan.", "info");
  });

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    load();
  }
  document.querySelector('.settings-tab[data-panel="plan"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="plan"]').classList.contains("active")) loadOnce();
})();
