/**
 * settings-connections.js — Settings → Connections (D78, owners and admins)
 * Every integration on one screen (GET /integrations/status): WhatsApp numbers, Gmail, payment
 * gateways, lead sources, the Meta Conversions API, API keys and webhooks, each with its state,
 * last activity, the problem in plain words and a button to the tab where it is set up. The tab
 * shows how many need attention.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsConnections() {
  if (!isOrgManager()) return leaveManagerTab("connections");
  document.getElementById("connectionsTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  // Groups in the order they are shown; each kind's icon and name.
  const GROUPS = [
    ["conn.group.messaging", ["whatsapp", "gmail"]],
    ["conn.group.leads", ["leadsources", "metaCapi"]],
    ["conn.group.payments", ["payments"]],
    ["conn.group.developer", ["apiKeys", "webhooks"]],
    ["conn.group.microsoft", ["microsoft", "teams"]],
    ["conn.group.calling", ["calling"]],
  ];
  const ICONS = {
    microsoft: "fa-brands fa-microsoft", teams: "fa-solid fa-people-group", calling: "fa-solid fa-phone-volume",
    whatsapp: "fa-brands fa-whatsapp", gmail: "fa-solid fa-envelope", payments: "fa-solid fa-indian-rupee-sign", leadsources: "fa-solid fa-inbox",
    metaCapi: "fa-brands fa-meta", apiKeys: "fa-solid fa-key", webhooks: "fa-solid fa-satellite-dish",
  };
  const BADGES = { working: "badge-success", attention: "badge-warning", off: "badge-neutral", not_connected: "badge-neutral" };
  let loaded = false;

  function ago(iso) {
    if (!iso) return "";
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return t("bell.justNow");
    if (minutes < 60) return t("bell.minutesAgo", { n: minutes });
    if (minutes < 24 * 60) return t("bell.hoursAgo", { n: Math.round(minutes / 60) });
    return new Date(iso).toLocaleDateString(crmI18n.locale(), { day: "2-digit", month: "short" });
  }

  // A connection whose feature the plan lacks (D80): which plan has it. The server refuses anyway.
  const planBadge = (item) => (item.plan?.needs ? `<span class="badge badge-neutral"><i class="fa-solid fa-lock" aria-hidden="true"></i> ${escapeHtml(t("conn.plan.badge", { plan: item.plan.needs.name }))}</span>` : "");
  function planLine(item) {
    if (!item.plan) return "";
    const text = item.plan.needs ? t("conn.plan.needs", { plan: item.plan.needs.name }) : t("conn.plan.paused");
    return `<div class="conn-plan"><i class="fa-solid fa-gem" aria-hidden="true"></i> ${escapeHtml(text)}</div>`;
  }

  function cardHtml(item) {
    const name = item.name ? ` · ${escapeHtml(item.name)}` : "";
    const last = item.lastActivityAt ? `<span class="conn-last">${escapeHtml(t("conn.last", { when: ago(item.lastActivityAt) }))}</span>` : "";
    const action = item.state === "not_connected" ? "conn.setUp" : "conn.open";
    return `<div class="conn-card conn-${item.state}">
      <div class="conn-icon"><i class="${ICONS[item.kind] || "fa-solid fa-plug"}" aria-hidden="true"></i></div>
      <div class="conn-main">
        <div class="conn-name"><strong>${escapeHtml(t(`conn.kind.${item.kind}`))}</strong>${name}</div>
        <div class="conn-meta"><span class="badge ${BADGES[item.state] || "badge-neutral"}">${escapeHtml(t(`conn.state.${item.state}`))}</span>${planBadge(item)}${last}</div>
        ${item.problem ? `<div class="conn-problem"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(item.problem)}</div>` : ""}
        ${planLine(item)}
      </div>
      <button class="btn btn-outline" type="button" data-tab="${escapeHtml(item.settingsTab)}">${escapeHtml(t(action))}</button>
    </div>`;
  }

  function render({ items, needsAttention }) {
    $("connCount").textContent = needsAttention ? String(needsAttention) : "";
    $("connCount").hidden = !needsAttention;
    const working = items.filter((i) => i.state === "working").length;
    $("connSummary").innerHTML = needsAttention
      ? `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(t("conn.summary.attention", { n: needsAttention, ok: working }))}`
      : `<i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${escapeHtml(t("conn.summary.ok", { ok: working }))}`;
    $("connSummary").className = `conn-summary ${needsAttention ? "conn-summary-warn" : "conn-summary-ok"}`;
    $("connList").innerHTML = GROUPS.map(([titleKey, kinds]) => {
      // What needs attention first, then what works, then the rest.
      const order = { attention: 0, working: 1, off: 2, not_connected: 3 };
      const list = items.filter((i) => kinds.includes(i.kind)).sort((a, b) => order[a.state] - order[b.state]);
      return `<div class="settings-section conn-group"><div class="settings-section-label">${escapeHtml(t(titleKey))}</div>${list.map(cardHtml).join("")}</div>`;
    }).join("");
  }

  async function load() {
    try {
      render(await crmApi("/integrations/status"));
    } catch (error) {
      $("connList").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("conn.err.load")))}</p>`;
    }
  }

  // "Open settings" / "Set up": the tab where that connection is managed.
  $("connList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    document.querySelector(`.settings-tab[data-panel="${CSS.escape(button.dataset.tab)}"]`)?.click();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  // Read when the tab opens, and once at the start for the count on the tab.
  document.querySelector('.settings-tab[data-panel="connections"]').addEventListener("click", () => {
    if (loaded) load();
  });
  crmI18n.ready.then(() => {
    loaded = true;
    load();
  });
})();
