/**
 * settings-delivery.js — Settings → Failed sends (Phase 9, D151; docs/RELIABILITY.md; owners and
 * admins): everything of the last 7 days that did not go — chat messages (failed, or waiting for
 * their next try), SMS, webhooks to the company's own systems, broadcasts — with the reason, and
 * "Try again". GET /delivery-problems, POST /delivery-problems/:kind/:id/retry.
 */
(function settingsDelivery() {
  if (!isOrgManager()) return leaveManagerTab("delivery");
  const $ = (id) => document.getElementById(id);
  $("deliveryTab").style.display = "";

  const ICONS = { chat: "fa-brands fa-whatsapp", sms: "fa-solid fa-comment-sms", webhook: "fa-solid fa-plug", broadcast: "fa-solid fa-bullhorn" };
  const LIMIT = 30;
  let page = 1;
  let rows = [];
  let loaded = false;

  const when = (iso) => new Date(iso).toLocaleString(crmI18n.locale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const clock = (iso) => new Date(iso).toLocaleTimeString(crmI18n.locale(), { hour: "numeric", minute: "2-digit" });
  const kindName = (item) => t(item.kind === "chat" && item.channel !== "whatsapp" ? `deliv.channel.${item.channel}` : `deliv.kind.${item.kind}`);

  function openLink(item) {
    if (item.kind === "chat") return `Inbox.html?c=${encodeURIComponent(item.conversationId)}`;
    if (item.kind === "sms" && item.contactId) return `customer-360.html?id=${encodeURIComponent(item.contactId)}`;
    if (item.kind === "webhook") return "Settings.html?tab=integrations";
    if (item.kind === "broadcast") return `Marketing.html?broadcast=${encodeURIComponent(item.id)}`;
    return "";
  }

  function itemHtml(item) {
    const link = openLink(item);
    const what = item.kind === "broadcast" ? t(`deliv.broadcast.${item.count === 1 ? "one" : "many"}`, { n: item.count }) : item.what;
    const reason = item.stopped ? t("inbox.retry.stopped") : item.reason;
    return `<li class="deliv-item">
      <i class="${ICONS[item.kind]} deliv-icon" aria-hidden="true"></i>
      <div class="deliv-body">
        <div class="deliv-head"><strong>${escapeHtml(item.customer || t("deliv.unknown"))}</strong><span class="badge">${escapeHtml(kindName(item))}</span>${item.state === "waiting" ? `<span class="badge badge-warning">${escapeHtml(t("deliv.waiting"))}</span>` : ""}${item.automatic ? `<span class="badge">${escapeHtml(t("deliv.automatic"))}</span>` : ""}</div>
        ${what ? `<div class="deliv-what">${escapeHtml(what)}</div>` : ""}
        ${reason ? `<div class="deliv-reason">${escapeHtml(reason)}</div>` : ""}
        <div class="deliv-when">${escapeHtml(when(item.at))}${item.nextAt ? ` · ${escapeHtml(t("deliv.nextTry", { time: clock(item.nextAt) }))}` : ""}</div>
      </div>
      <div class="deliv-actions">
        ${item.canRetry ? `<button type="button" class="btn btn-primary" data-deliv-retry="${escapeHtml(item.kind)}:${escapeHtml(item.id)}"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> ${escapeHtml(t("outbox.retry"))}</button>` : ""}
        ${link ? `<a class="btn btn-outline" href="${escapeHtml(link)}">${escapeHtml(t("deliv.open"))}</a>` : ""}
      </div>
    </li>`;
  }

  function render(summary) {
    if (summary) {
      const total = summary.failed + summary.waiting;
      $("deliveryCount").textContent = String(total);
      $("deliveryCount").hidden = !total;
      $("deliverySummary").textContent = total ? t("deliv.summary", { failed: summary.failed, waiting: summary.waiting }) : "";
    }
    $("deliveryList").innerHTML = rows.length
      ? `<ul class="deliv-list">${rows.map(itemHtml).join("")}</ul>`
      : `<div class="report-empty deliv-empty"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${escapeHtml(t("deliv.nothing"))}</div>`;
  }

  async function load({ more = false } = {}) {
    page = more ? page + 1 : 1;
    try {
      const result = await crmRequest(`/delivery-problems?kind=${encodeURIComponent($("deliveryKind").value)}&page=${page}&limit=${LIMIT}`);
      rows = more ? rows.concat(result.data) : result.data;
      render(result.summary);
      $("deliveryMore").hidden = !result.pagination?.hasNextPage;
    } catch (error) {
      $("deliveryList").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("deliv.err.load")))}</p>`;
    }
  }

  // After "Try again": it went, or it is waiting, or it failed again with its reason.
  function tell(result) {
    if (result?.status === "failed") return showToast(result.error?.message || result.error || t("deliv.err.retry"), "error");
    return showToast(t(result?.status === "queued" ? "deliv.tryingLater" : "deliv.tried"), "success");
  }

  $("deliveryList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-deliv-retry]");
    if (!button) return;
    const [kind, id] = button.dataset.delivRetry.split(":");
    button.disabled = true;
    try {
      tell(await crmApi(`/delivery-problems/${kind}/${id}/retry`, { method: "POST" }));
    } catch (error) {
      showToast(apiErrorMessage(error, t("deliv.err.retry")), "error");
    }
    await load();
  });
  $("deliveryKind").addEventListener("change", () => load());
  $("deliveryMore").addEventListener("click", () => load({ more: true }));

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    load();
  }
  document.querySelector('.settings-tab[data-panel="delivery"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="delivery"]').classList.contains("active")) loadOnce();
  // The number on the tab, without opening it.
  crmI18n.ready.then(() => crmRequest("/delivery-problems?limit=1")).then((result) => {
    if (!loaded) render(result.summary);
  }).catch(() => {});
  return undefined;
})();
