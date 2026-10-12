/**
 * settings-whatsapp.js — Settings → WhatsApp (owners and admins)
 * The company's WhatsApp numbers (/whatsapp/accounts): "Connect WhatsApp" with Meta's popup
 * (connect-whatsapp.html, D60) with quality, limit and the import of the chats; numbers on the
 * company's own Meta app under "Advanced" (what to paste into that app: callback URL and verify
 * token). Manages message templates (/templates), makes the click-to-chat link and QR code
 * (/whatsapp/click-to-chat), and — developer test tools, DEV_TOOLS=on only — adds test numbers
 * and simulates a customer's message, photo, document or voice note.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
// Starts once the page's texts are in (i18n/*.json, CP5).
crmI18n.ready.then(function settingsWhatsApp() {
  if (!isOrgManager()) return leaveManagerTab("whatsapp");
  document.getElementById("whatsappTab").style.display = "";

  const STATUS_BADGE = {
    connected: `<span class="badge badge-success">${escapeHtml(t("wa.status.connected"))}</span>`,
    pending: `<span class="badge badge-warning">${escapeHtml(t("wa.status.pending"))}</span>`,
    error: `<span class="badge badge-danger">${escapeHtml(t("wa.status.error"))}</span>`,
    disconnected: `<span class="badge badge-danger">${escapeHtml(t("wa.status.disconnected"))}</span>`,
  };
  const QUALITY = { GREEN: t("wa.quality.high"), YELLOW: t("wa.quality.medium"), RED: t("wa.quality.low") };
  const LIMIT = (tier) => (tier ? tier.replace(/^TIER_/, "").replace("UNLIMITED", t("wa.unlimited")).replace(/K$/, ",000").replace(/^(\d+)$/, "$1") : "");
  const listEl = document.getElementById("waAccountList");
  let accounts = [];
  let connect = { available: false, devTools: false };
  let team = []; // who can take a number's chats (D67)
  let agentNumbersOn = false; // the plan has "An agent's own WhatsApp number"

  // "Connect WhatsApp" numbers (D60): how the import of the chats went.
  function syncHtml(a) {
    const s = a.sync;
    if (a.connectionType !== "coexistence" || !s) return "";
    const counts = t("wa.sync.counts", { chats: s.chats.toLocaleString(crmI18n.locale()), messages: s.messages.toLocaleString(crmI18n.locale()), contacts: s.contacts.toLocaleString(crmI18n.locale()) });
    const text = {
      pending: t("wa.sync.pending"),
      importing: t("wa.sync.importing", { counts }),
      done: `${t("wa.sync.done", { counts })}${s.finishedAt ? ` · ${when(s.finishedAt)}` : ""}`,
      declined: t("wa.sync.declined"),
      failed: s.error ? t("wa.sync.failedWhy", { error: s.error }) : t("wa.sync.failed"),
    }[s.status] || "";
    const retry = ["failed", "declined"].includes(s.status) ? ` <button class="btn btn-outline" type="button" data-wa-sync="${escapeHtml(a.id)}"><i class="fa-solid fa-rotate"></i> ${escapeHtml(t("cw.importAgain"))}</button>` : "";
    return `<div class="sub" style="margin-top:6px">${escapeHtml(text)}${retry}</div>`;
  }

  function connectedHtml(a) {
    const kind = t(a.connectionType === "coexistence" ? "wa.kind.app" : "wa.kind.cloud");
    const details = [
      kind,
      a.qualityRating ? t("wa.quality", { q: QUALITY[a.qualityRating] || a.qualityRating }) : "",
      a.messagingLimit ? t("wa.limit", { n: LIMIT(a.messagingLimit) }) : "",
      a.lastWebhookAt ? t("wa.lastMessage", { when: when(a.lastWebhookAt) }) : t("wa.noMessage"),
    ].filter(Boolean).join(" · ");
    return `<div class="sub" style="margin-top:6px">${escapeHtml(details)}</div>${syncHtml(a)}`;
  }

  function renderConnectCard() {
    const card = document.getElementById("waConnectCard");
    const live = accounts.some((a) => a.status === "connected");
    card.hidden = false;
    const link = document.getElementById("waConnectLink");
    link.hidden = !connect.available;
    if (!connect.available) {
      document.getElementById("waConnectTitle").textContent = t("inbox.connect.button");
      document.getElementById("waConnectText").textContent = t("wa.connect.notReady");
      return;
    }
    document.getElementById("waConnectTitle").textContent = t(live ? "wa.connect.another" : "wa.connect.title");
    document.getElementById("waConnectText").textContent = t(live ? "wa.connect.anotherText" : "wa.connect.text");
    link.innerHTML = `<i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t(live ? "wa.connect.another" : "inbox.connect.button"))}`;
  }

  const when = (iso) => (iso ? new Date(iso).toLocaleString(crmI18n.locale(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  // Meta needs a public HTTPS address; 127.0.0.1 / localhost only works through a tunnel.
  const isLocal = (url) => /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url);

  function copyButton(value, label) {
    return `<button class="btn btn-outline" type="button" data-copy="${escapeHtml(value)}" title="${escapeHtml(t("wa.copyLabel", { label }))}"><i class="fa-solid fa-copy"></i></button>`;
  }

  // An agent's own number (D67): its new chats and new WhatsApp leads go to that agent.
  const memberName = (m) => m.name || m.email || t("inbox.teammate");
  function agentHtml(a) {
    const takers = team.filter((m) => m.status === "active" && (["owner", "admin"].includes(m.role) || (m.modules || []).includes("inbox")));
    const chosen = a.agentMemberId ? String(a.agentMemberId) : "";
    const gone = chosen && !takers.some((m) => String(m.id) === chosen);
    const locked = !agentNumbersOn && !chosen;
    const options = takers.map((m) => `<option value="${escapeHtml(m.id)}" ${String(m.id) === chosen ? "selected" : ""}>${escapeHtml(t("wa.agent.own", { name: memberName(m) }))}</option>`).join("");
    const note = gone
      ? escapeHtml(t("wa.agent.gone"))
      : locked
        ? t("wa.agent.locked") // our own text with a link
        : escapeHtml(t(chosen ? "wa.agent.chosen" : "wa.agent.shared"));
    return `
      <div class="sub wa-agent" style="margin-top:8px">
        <label style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0">
          <strong>${escapeHtml(t("wa.agent.label"))}</strong>
          <select class="filter" data-wa-agent="${escapeHtml(a.id)}" style="flex:1 1 200px; max-width:280px; min-width:0" ${locked ? "disabled" : ""}>
            <option value="" ${chosen && !gone ? "" : "selected"}>${escapeHtml(t("wa.agent.team"))}</option>${options}
          </select>
        </label>
        <div style="margin-top:4px">${note}</div>
      </div>`;
  }

  function accountHtml(a) {
    const title = a.verifiedName || a.name || t("wa.number");
    const tunnelHint = isLocal(a.webhookUrl)
      ? `<div class="sub" style="margin-top:4px">Meta cannot reach ${escapeHtml(new URL(a.webhookUrl).host)}. Start a tunnel (for example <code>cloudflared tunnel --url http://127.0.0.1:3000</code>) and use <strong>https://&lt;tunnel address&gt;${escapeHtml(a.webhookPath)}</strong> as the callback URL.</div>`
      : "";
    const viaMeta = a.connectionType === "embedded" || a.connectionType === "coexistence";
    const setup = a.provider === "mock"
      ? `<div class="sub" style="margin-top:6px">${escapeHtml(t("wa.mockNote"))}</div>`
      : viaMeta ? connectedHtml(a) : `
        <div class="sub" style="margin-top:8px">${t("wa.webhookHelp")}</div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:6px; min-width:0">
          <span class="sub" style="flex-shrink:0; width:92px">${escapeHtml(t("wa.callbackUrl"))}</span>
          <code style="word-break:break-all; font-size:12px; flex:1">${escapeHtml(a.webhookUrl)}</code>${copyButton(a.webhookUrl, t("wa.callbackUrl"))}
        </div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:6px; min-width:0">
          <span class="sub" style="flex-shrink:0; width:92px">${escapeHtml(t("wa.verifyToken"))}</span>
          <code style="word-break:break-all; font-size:12px; flex:1">${escapeHtml(a.verifyToken)}</code>${copyButton(a.verifyToken, t("wa.verifyToken"))}
        </div>
        ${tunnelHint}`;
    return `
      <div class="settings-summary-row" style="align-items:flex-start; flex-wrap:wrap">
        <div class="info" style="min-width:0; flex:1 1 240px">
          <div class="name">
            <i class="fa-brands fa-whatsapp" style="color:var(--wa)"></i> ${escapeHtml(title)}
            ${a.displayPhone ? `<span class="text-muted" style="font-weight:500">· ${escapeHtml(a.displayPhone)}</span>` : ""}
            ${STATUS_BADGE[a.status] || ""} ${a.isDefault ? `<span class="badge badge-brand">${escapeHtml(t("wa.default"))}</span>` : ""}
            ${a.provider === "mock" ? `<span class="badge badge-neutral">${escapeHtml(t("wa.testNumber"))}</span>` : ""}
          </div>
          ${viaMeta ? "" : `<div class="sub">${escapeHtml(t("wa.phoneId", { id: a.phoneNumberId }))}${a.accessToken.configured ? ` · token …${escapeHtml(a.accessToken.last4)}` : ""} · ${escapeHtml(a.lastWebhookAt ? t("wa.lastFromWhatsApp", { when: when(a.lastWebhookAt) }) : t("wa.noMessage"))}</div>`}
          ${["error", "disconnected"].includes(a.status) && a.statusMessage ? `<div class="sub" style="color:var(--danger)">${escapeHtml(a.statusMessage)}</div>` : ""}
          ${setup}
          ${agentHtml(a)}
          ${catalogHtml(a)}
        </div>
        <div style="display:flex; gap:8px; flex-shrink:0; flex-wrap:wrap">
          ${viaMeta && a.status !== "connected" ? `<a class="btn btn-primary" href="connect-whatsapp.html?add=1"><i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("wa.reconnect"))}</a>` : ""}
          <button class="btn btn-outline" type="button" data-wa-test="${escapeHtml(a.id)}"><i class="fa-solid fa-plug-circle-check"></i> ${escapeHtml(t(viaMeta ? "wa.check" : "wa.test"))}</button>
          ${a.provider === "meta" && !viaMeta ? `<button class="btn btn-outline" type="button" data-wa-token="${escapeHtml(a.id)}" title="${escapeHtml(t("wa.newToken"))}"><i class="fa-solid fa-key"></i></button>` : ""}
          ${a.isDefault ? "" : `<button class="btn btn-outline" type="button" data-wa-default="${escapeHtml(a.id)}" title="${escapeHtml(t("wa.makeDefault"))}">${escapeHtml(t("wa.default"))}</button>`}
          ${viaMeta
            ? `<button class="btn btn-outline" type="button" data-wa-remove="${escapeHtml(a.id)}">${escapeHtml(t("wa.disconnect"))}</button>`
            : `<button class="icon-btn danger" type="button" data-wa-remove="${escapeHtml(a.id)}" title="${escapeHtml(t("wa.remove"))}"><i class="fa-solid fa-trash"></i></button>`}
        </div>
      </div>`;
  }

  // --- the Meta catalog of a number (Phase 8C) ---
  let catalogFormFor = "";
  function catalogHtml(a) {
    const c = a.catalog;
    const sync = c?.lastSyncAt
      ? `${escapeHtml(t("wa.cat.lastSync", { when: when(c.lastSyncAt) }))}: ${c.lastSync?.error ? `<span style="color:var(--danger)">${escapeHtml(c.lastSync.error)}</span>` : `${escapeHtml(t("wa.cat.sent", { n: c.lastSync?.sent || 0 }))}${c.lastSync?.removed ? `, ${escapeHtml(t("wa.cat.removed", { n: c.lastSync.removed }))}` : ""}${c.lastSync?.failed ? `, <span style="color:var(--danger)">${escapeHtml(t("wa.cat.failed", { n: c.lastSync.failed }))}</span>` : ""}`}`
      : escapeHtml(t("wa.cat.syncing"));
    const summary = c
      ? `<strong>${escapeHtml(t("wa.cat.label"))}</strong> ${escapeHtml(c.name || c.catalogId)} <span class="text-muted">(${escapeHtml(c.catalogId)})</span> · ${sync}${c.statusMessage ? `<div style="color:var(--danger)">${escapeHtml(c.statusMessage)}</div>` : ""}`
      : `<strong>${escapeHtml(t("wa.cat.label"))}</strong> ${escapeHtml(t("wa.cat.none"))}`;
    const form = catalogFormFor === String(a.id)
      ? `<form class="wa-catalog-form" data-wa-catalog-form="${escapeHtml(a.id)}" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:6px">
          <input type="text" name="catalogId" inputmode="numeric" placeholder="${escapeHtml(t("wa.cat.idPlaceholder"))}" value="${escapeHtml(c?.catalogId || "")}" required style="max-width:220px" />
          <label class="ls-check" style="margin:0"><input type="checkbox" name="catalogVisible" ${c?.catalogVisible === false ? "" : "checked"} /> ${escapeHtml(t("wa.cat.shopButton"))}</label>
          <label class="ls-check" style="margin:0"><input type="checkbox" name="cartEnabled" ${c?.cartEnabled === false ? "" : "checked"} /> ${escapeHtml(t("wa.cat.cart"))}</label>
          <button class="btn btn-primary" type="submit">${escapeHtml(t("wa.cat.connect"))}</button>
          <button class="btn btn-outline" type="button" data-wa-catalog-cancel>${escapeHtml(t("common.cancel"))}</button>
        </form>`
      : "";
    return `<div class="sub wa-catalog" style="margin-top:8px">${summary}
      <div style="display:flex; gap:8px; margin-top:6px; flex-wrap:wrap">
        ${form ? "" : `<button class="btn btn-outline" type="button" data-wa-catalog="${escapeHtml(a.id)}"><i class="fa-solid fa-store"></i> ${escapeHtml(t(c ? "wa.cat.change" : "wa.cat.connectButton"))}</button>`}
        ${c && !form ? `<a class="btn btn-outline" href="Products.html"><i class="fa-solid fa-box-open"></i> ${escapeHtml(t("wa.cat.choose"))}</a><button class="btn btn-outline" type="button" data-wa-catalog-off="${escapeHtml(a.id)}">${escapeHtml(t("wa.disconnect"))}</button>` : ""}
      </div>${form}</div>`;
  }

  function render() {
    document.getElementById("waCount").textContent = accounts.length ? t(accounts.length === 1 ? "wa.countOne" : "wa.countMany", { n: accounts.length }) : "";
    listEl.innerHTML = accounts.length ? accounts.map(accountHtml).join("") : "";
    renderConnectCard();
    // Developer test tools: a development server with DEV_TOOLS=on only.
    document.getElementById("waDevTools").hidden = !connect.devTools;
    document.getElementById("waSimulateSection").hidden = !accounts.length;
    document.getElementById("waSimulateForm").hidden = !accounts.length;
  }

  // --- private numbers (D61): owners only; the popup explains it before anything changes ---
  async function loadPrivate() {
    const section = document.getElementById("waPrivateSection");
    section.hidden = !isOrgOwner();
    if (section.hidden) return;
    const list = document.getElementById("waPrivateList");
    try {
      const numbers = await crmApi("/privacy/numbers");
      list.innerHTML = numbers.length
        ? numbers.map((n) => `
          <li>
            <span class="device-icon"><i class="fa-solid fa-lock"></i></span>
            <span class="device-text">
              <span class="device-name">${escapeHtml(n.name || formatPhoneE164(n.phone))}</span>${n.note ? ` <span class="badge badge-neutral">${escapeHtml(n.note)}</span>` : ""}
              <br /><span class="device-meta">${escapeHtml(formatPhoneE164(n.phone))} · ${escapeHtml(t(n.chats === 1 ? "wa.priv.chatOne" : "wa.priv.chatMany", { n: n.chats }))} · ${escapeHtml(t("wa.priv.since", { when: when(n.addedAt) }))}</span>
            </span>
            <button class="btn btn-outline" type="button" data-private-show="${escapeHtml(n.id)}" data-name="${escapeHtml(n.name)}" data-phone="${escapeHtml(n.phone)}">${escapeHtml(t("wa.priv.show"))}</button>
          </li>`).join("")
        : `<li class="device-empty">${escapeHtml(t("wa.priv.none"))}</li>`;
    } catch (error) {
      list.innerHTML = `<li class="device-empty">${escapeHtml(apiErrorMessage(error, t("wa.priv.loadFailed")))}</li>`;
    }
  }

  document.getElementById("waPrivateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = document.getElementById("waPrivatePhone").value.trim();
    const choice = await crmPrivacyDialog.open({ mode: "hide", phone });
    if (!choice) return;
    try {
      await crmApi("/privacy/numbers", jsonRequest("POST", { phone, note: choice.note || document.getElementById("waPrivateNote").value.trim() }));
      e.target.reset();
      showToast(t("wa.priv.hidden"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
    }
    loadPrivate();
  });

  document.getElementById("waPrivateList").addEventListener("click", async (e) => {
    const button = e.target.closest("[data-private-show]");
    if (!button) return;
    const choice = await crmPrivacyDialog.open({ mode: "show", name: button.dataset.name, phone: button.dataset.phone });
    if (!choice) return;
    try {
      await crmApi(`/privacy/numbers/${button.dataset.privateShow}`, { method: "DELETE" });
      showToast(t("wa.priv.shown"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
    }
    loadPrivate();
  });

  // Read receipts (CP3): blue ticks and "typing…" for customers; on unless turned off.
  async function loadReceipts() {
    try {
      const { sendReadReceipts } = await crmApi("/organization/settings");
      document.getElementById("readReceiptsToggle").checked = sendReadReceipts;
      document.getElementById("waReceiptsSection").hidden = false;
    } catch {
      document.getElementById("waReceiptsSection").hidden = true;
    }
  }
  document.getElementById("readReceiptsToggle").addEventListener("change", async (event) => {
    const toggle = event.target;
    toggle.disabled = true;
    try {
      const { sendReadReceipts } = await crmApi("/organization/settings", jsonRequest("PATCH", { sendReadReceipts: toggle.checked }));
      toggle.checked = sendReadReceipts;
      showToast(t(sendReadReceipts ? "wa.receipts.on" : "wa.receipts.off"), "success");
    } catch (error) {
      toggle.checked = !toggle.checked;
      showToast(apiErrorMessage(error, t("wa.receipts.failed")), "error");
    } finally {
      toggle.disabled = false;
    }
  });

  async function load() {
    loadPrivate();
    loadReceipts();
    try {
      [accounts, connect] = await Promise.all([crmApi("/whatsapp/accounts"), crmApi("/whatsapp/connect")]);
      // The team and the plan only decide the "New chats go to" choice; without them it stays shared.
      const [members, billing] = await Promise.allSettled([crmApi("/members?limit=100"), crmApi("/billing/subscription")]);
      team = members.status === "fulfilled" ? members.value : [];
      agentNumbersOn = billing.status === "fulfilled" && Boolean(billing.value.plan?.features?.agentNumbers);
      render();
      refreshExtras();
    } catch (error) {
      listEl.innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, t("wa.loadFailed")))}</p>`;
    }
  }

  async function run(action, success) {
    try {
      const result = await action();
      if (success) showToast(typeof success === "function" ? success(result) : success, "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
    }
    await load();
  }

  listEl.addEventListener("change", async (e) => {
    const select = e.target.closest("[data-wa-agent]");
    if (!select) return;
    const agentMemberId = select.value || null;
    const chosen = team.find((m) => String(m.id) === String(agentMemberId));
    const name = chosen ? memberName(chosen) : "";
    select.disabled = true;
    await run(() => crmApi(`/whatsapp/accounts/${select.dataset.waAgent}`, jsonRequest("PATCH", { agentMemberId })),
      agentMemberId ? t("wa.agent.nowTo", { name }) : t("wa.agent.nowShared"));
  });

  listEl.addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-wa-catalog-form]");
    if (!form) return;
    e.preventDefault();
    const id = form.dataset.waCatalogForm;
    const body = { catalogId: form.catalogId.value.trim(), catalogVisible: form.catalogVisible.checked, cartEnabled: form.cartEnabled.checked };
    form.querySelector('button[type="submit"]').disabled = true;
    try {
      const connected = await crmApi(`/whatsapp/accounts/${id}/catalog`, jsonRequest("PUT", body));
      catalogFormFor = "";
      showToast(connected.statusMessage || t("wa.cat.connected", { name: connected.name || connected.catalogId }), connected.statusMessage ? "error" : "success");
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, t("wa.cat.connectFailed")), "error");
      form.querySelector('button[type="submit"]').disabled = false;
    }
  });

  listEl.addEventListener("click", async (e) => {
    const catalogOpen = e.target.closest("[data-wa-catalog]");
    if (catalogOpen) {
      catalogFormFor = catalogOpen.dataset.waCatalog;
      return render();
    }
    if (e.target.closest("[data-wa-catalog-cancel]")) {
      catalogFormFor = "";
      return render();
    }
    const catalogOff = e.target.closest("[data-wa-catalog-off]");
    if (catalogOff) {
      if (!confirm(t("wa.cat.confirmOff"))) return undefined;
      return run(() => crmApi(`/whatsapp/accounts/${catalogOff.dataset.waCatalogOff}/catalog`, { method: "DELETE" }), t("wa.cat.off"));
    }
    const copy = e.target.closest("[data-copy]");
    const test = e.target.closest("[data-wa-test]");
    const token = e.target.closest("[data-wa-token]");
    const makeDefault = e.target.closest("[data-wa-default]");
    const remove = e.target.closest("[data-wa-remove]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        showToast(t("wa.copied"), "success");
      } catch {
        showToast(t("wa.copyFailed"), "error");
      }
    } else if (test) {
      await run(() => crmApi(`/whatsapp/accounts/${test.dataset.waTest}/test`, { method: "POST" }),
        (a) => (a.status === "connected" ? t("wa.testOk") : t("wa.testProblem", { message: a.statusMessage })));
    } else if (token) {
      const value = window.prompt(t("wa.tokenPrompt"));
      if (value && value.trim()) {
        await run(() => crmApi(`/whatsapp/accounts/${token.dataset.waToken}`, jsonRequest("PATCH", { accessToken: value.trim() })), t("wa.tokenUpdated"));
      }
    } else if (makeDefault) {
      await run(() => crmApi(`/whatsapp/accounts/${makeDefault.dataset.waDefault}`, jsonRequest("PATCH", { isDefault: true })), t("wa.defaultChanged"));
    } else if (remove) {
      if (!confirm(t("wa.confirmDisconnect"))) return;
      await run(() => crmApi(`/whatsapp/accounts/${remove.dataset.waRemove}`, { method: "DELETE" }), t("wa.disconnected"));
    } else if (e.target.closest("[data-wa-sync]")) {
      await run(() => crmApi(`/whatsapp/accounts/${e.target.closest("[data-wa-sync]").dataset.waSync}/sync`, { method: "POST" }), t("wa.askedAgain"));
    }
  });

  document.getElementById("waConnectForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = document.getElementById("waConnectBtn");
    button.disabled = true;
    const value = (id) => document.getElementById(id).value.trim();
    await run(async () => {
      const account = await crmApi("/whatsapp/accounts", jsonRequest("POST", {
        name: value("waName"),
        phoneNumberId: value("waPhoneNumberId"),
        wabaId: value("waWabaId"),
        accessToken: value("waAccessToken"),
        appSecret: value("waAppSecret"),
      }));
      e.target.reset();
      return account;
    }, (a) => (a.status === "connected" ? t("wa.adv.connected") : t("wa.adv.saved", { message: a.statusMessage })));
    button.disabled = false;
  });

  document.getElementById("waAddMockBtn").addEventListener("click", () =>
    run(() => crmApi("/whatsapp/accounts", jsonRequest("POST", { provider: "mock", name: "Test number" })), "Test number added."));

  // The simulator: a text, or (test numbers) a photo, document or voice note with a caption.
  const simType = document.getElementById("waSimType");
  simType.addEventListener("change", () => {
    const isText = simType.value === "text";
    const input = document.getElementById("waSimText");
    input.required = isText;
    input.disabled = simType.value === "audio";
    if (!isText) input.value = "";
    document.getElementById("waSimTextLabel").textContent = isText ? "Message" : simType.value === "audio" ? "Message (voice notes have none)" : "Caption (optional)";
  });
  document.getElementById("waSimulateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = (id) => document.getElementById(id).value.trim();
    try {
      await crmApi("/dev/simulate/whatsapp-inbound", jsonRequest("POST", { from: value("waSimFrom"), name: value("waSimName"), type: simType.value, text: value("waSimText") }));
      document.getElementById("waSimText").value = "";
      showToast("Test message received. The sender is now a contact (and a new lead if the number was new).", "success");
    } catch (error) {
      showToast(error.status === 404 ? "Test messages are turned off on this server." : apiErrorMessage(error, "Couldn't receive the test message."), "error");
    }
    await load();
  });

  // --- message templates -------------------------------------------------------
  const TEMPLATE_BADGE = { APPROVED: "badge-success", PENDING: "badge-warning", IN_APPEAL: "badge-warning", REJECTED: "badge-danger", DISABLED: "badge-danger", PAUSED: "badge-danger" };
  const $ = (id) => document.getElementById(id);
  const placeholders = (text) => [...new Set([...String(text || "").matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
  let templates = [];

  function fillAccountSelect(select) {
    const previous = select.value;
    select.innerHTML = accounts
      .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.verifiedName || a.name || t("wa.number"))}${a.displayPhone ? ` · ${escapeHtml(a.displayPhone)}` : ""}</option>`)
      .join("");
    if (accounts.some((a) => a.id === previous)) select.value = previous;
  }

  function templateHtml(t) {
    const text = [t.header?.text, t.body.text, t.footer].filter(Boolean).join("\n");
    return `
      <div class="wa-tpl">
        <div class="info">
          <div class="name">${escapeHtml(t.name)} <span class="badge badge-neutral">${escapeHtml(t.language)}</span>
            <span class="badge badge-info">${escapeHtml(t.category.toLowerCase())}</span>
            <span class="badge ${TEMPLATE_BADGE[t.status] || "badge-neutral"}">${escapeHtml(crmLabel("tplStatus", t.status))}</span></div>
          <div class="body">${escapeHtml(text)}</div>
          ${t.rejectedReason ? `<div class="why">${escapeHtml(crmI18n.t("wa.tpl.reason", { reason: t.rejectedReason.toLowerCase().replace(/_/g, " ") }))}</div>` : ""}
          ${t.status === "APPROVED" && !t.sendable ? `<div class="why">${escapeHtml(t.notSendableReason)}</div>` : ""}
        </div>
        <button class="icon-btn danger" type="button" data-tpl-delete="${escapeHtml(t.id)}" title="${escapeHtml(crmI18n.t("wa.tpl.deleteTitle"))}"><i class="fa-solid fa-trash"></i></button>
      </div>`;
  }

  async function loadTemplates() {
    const accountId = $("waTplAccount").value;
    if (!accountId) return;
    try {
      templates = await crmApi(`/templates?accountId=${encodeURIComponent(accountId)}`);
      $("waTplList").innerHTML = templates.length
        ? templates.map(templateHtml).join("")
        : `<p class="settings-hint" style="margin:0">${escapeHtml(t("wa.tpl.none"))}</p>`;
    } catch (error) {
      $("waTplList").innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, t("inbox.tpl.loadFailed")))}</p>`;
    }
  }

  $("waTplAccount").addEventListener("change", loadTemplates);
  $("waTplSync").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const list = await crmApi("/templates/sync", jsonRequest("POST", { accountId: $("waTplAccount").value }));
      showToast(t(list.length === 1 ? "wa.tpl.syncedOne" : "wa.tpl.syncedMany", { n: list.length }), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("wa.tpl.syncFailed")), "error");
    }
    e.target.disabled = false;
    await loadTemplates();
  });
  $("waTplList").addEventListener("click", async (e) => {
    const remove = e.target.closest("[data-tpl-delete]");
    if (!remove) return;
    const template = templates.find((t) => t.id === remove.dataset.tplDelete);
    if (!confirm(t("wa.tpl.confirmDelete", { name: template?.name, language: template?.language }))) return;
    try {
      await crmApi(`/templates/${remove.dataset.tplDelete}`, { method: "DELETE" });
      showToast(t("wa.tpl.deleted"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("wa.tpl.deleteFailed")), "error");
    }
    await loadTemplates();
  });

  // New template: one example field per {{variable}}, up to three buttons.
  function renderExamples() {
    const saved = {};
    document.querySelectorAll("#waTplExamples input").forEach((input) => {
      saved[input.dataset.key] = input.value;
    });
    const header = placeholders($("waTplHeader").value).slice(0, 1).map((name) => ({ key: `h:${name}`, label: t("wa.tpl.exampleHeader", { name }) }));
    const body = placeholders($("waTplBody").value).map((name) => ({ key: `b:${name}`, label: t("wa.tpl.example", { name }) }));
    const fields = [...header, ...body];
    $("waTplExamples").innerHTML = fields.length
      ? `<p class="settings-hint" style="margin:0 0 8px">${escapeHtml(t("wa.tpl.examplesHint"))}</p>
         <div class="field-row" style="flex-wrap:wrap">${fields
           .map((f) => `<div class="field" style="min-width:180px"><label>${escapeHtml(f.label)}</label><input type="text" maxlength="200" data-key="${escapeHtml(f.key)}" value="${escapeHtml(saved[f.key] || "")}" required /></div>`)
           .join("")}</div>`
      : "";
  }
  $("waTplHeader").addEventListener("input", renderExamples);
  $("waTplBody").addEventListener("input", renderExamples);
  $("waTplName").addEventListener("input", (e) => {
    // Meta's names: lower-case letters, digits and "_".
    const clean = e.target.value.toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
    if (clean !== e.target.value) e.target.value = clean;
  });

  function addButtonRow() {
    if ($("waTplButtons").children.length >= 3) return;
    const row = document.createElement("div");
    row.className = "wa-button-row";
    row.innerHTML = `
      <select data-button-type aria-label="${escapeHtml(t("wa.btn.kind"))}">
        <option value="QUICK_REPLY">${escapeHtml(t("wa.btn.quick"))}</option>
        <option value="URL">${escapeHtml(t("wa.btn.url"))}</option>
        <option value="PHONE_NUMBER">${escapeHtml(t("wa.btn.phone"))}</option>
      </select>
      <input type="text" data-button-text maxlength="25" placeholder="${escapeHtml(t("wa.btn.text"))}" aria-label="${escapeHtml(t("wa.btn.text"))}" required />
      <input type="text" data-button-value placeholder="" aria-label="${escapeHtml(t("wa.btn.value"))}" hidden />
      <button class="icon-btn danger" type="button" data-button-remove aria-label="${escapeHtml(t("wa.btn.remove"))}"><i class="fa-solid fa-xmark"></i></button>`;
    $("waTplButtons").appendChild(row);
    $("waTplAddButton").hidden = $("waTplButtons").children.length >= 3;
  }
  $("waTplAddButton").addEventListener("click", addButtonRow);
  $("waTplButtons").addEventListener("change", (e) => {
    if (!e.target.matches("[data-button-type]")) return;
    const value = e.target.closest(".wa-button-row").querySelector("[data-button-value]");
    value.hidden = e.target.value === "QUICK_REPLY";
    value.required = !value.hidden;
    value.placeholder = e.target.value === "URL" ? "https://your-site.com/prices" : "+91 98290 12345";
  });
  $("waTplButtons").addEventListener("click", (e) => {
    if (!e.target.closest("[data-button-remove]")) return;
    e.target.closest(".wa-button-row").remove();
    $("waTplAddButton").hidden = false;
  });

  $("waTplForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const examples = {};
    document.querySelectorAll("#waTplExamples input").forEach((input) => {
      examples[input.dataset.key] = input.value.trim();
    });
    const headerVar = placeholders($("waTplHeader").value)[0];
    const bodyExamples = Object.fromEntries(Object.entries(examples).filter(([key]) => key.startsWith("b:")).map(([key, value]) => [key.slice(2), value]));
    const buttons = [...document.querySelectorAll("#waTplButtons .wa-button-row")].map((row) => {
      const type = row.querySelector("[data-button-type]").value;
      const text = row.querySelector("[data-button-text]").value.trim();
      const value = row.querySelector("[data-button-value]").value.trim();
      return type === "URL" ? { type, text, url: value } : type === "PHONE_NUMBER" ? { type, text, phoneNumber: value } : { type, text };
    });
    const body = {
      accountId: $("waTplAccount").value,
      name: $("waTplName").value.trim(),
      language: $("waTplLanguage").value,
      category: $("waTplCategory").value,
      headerText: $("waTplHeader").value.trim(),
      ...(headerVar && { headerExample: examples[`h:${headerVar}`] || "" }),
      bodyText: $("waTplBody").value.trim(),
      bodyExamples,
      footerText: $("waTplFooter").value.trim(),
      ...(buttons.length && { buttons }),
    };
    const submit = $("waTplSubmit");
    submit.disabled = true;
    try {
      const created = await crmApi("/templates", jsonRequest("POST", body));
      showToast(t(created.status === "APPROVED" ? "wa.tpl.approved" : "wa.tpl.submitted"), "success");
      e.target.reset();
      $("waTplButtons").innerHTML = "";
      $("waTplAddButton").hidden = false;
      renderExamples();
      $("waTplNew").open = false;
    } catch (error) {
      showToast(apiErrorMessage(error, t("wa.tpl.createFailed")), "error");
    }
    submit.disabled = false;
    await loadTemplates();
  });

  // --- click-to-chat link + QR code ----------------------------------------------
  let linkTimer = null;
  const linkQuery = () => {
    const params = new URLSearchParams({ accountId: $("waLinkAccount").value });
    const text = $("waLinkText").value.trim();
    if (text) params.set("text", text);
    return params.toString();
  };
  async function loadLink() {
    if (!$("waLinkAccount").value) return;
    try {
      const link = await crmApi(`/whatsapp/click-to-chat?${linkQuery()}`);
      $("waLinkQr").src = link.qrDataUrl;
      $("waLinkUrl").textContent = link.link;
      $("waLinkOpen").href = link.link;
      $("waLinkResult").hidden = false;
      $("waLinkError").hidden = true;
    } catch (error) {
      $("waLinkResult").hidden = true;
      $("waLinkError").textContent = apiErrorMessage(error, t("wa.link.failed"));
      $("waLinkError").hidden = false;
    }
  }
  $("waLinkAccount").addEventListener("change", loadLink);
  $("waLinkText").addEventListener("input", () => {
    clearTimeout(linkTimer);
    linkTimer = setTimeout(loadLink, 400);
  });
  $("waLinkCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("waLinkUrl").textContent);
      showToast(t("wa.link.copied"), "success");
    } catch {
      showToast(t("wa.link.copyFailed"), "error");
    }
  });
  $("waLinkPng").addEventListener("click", async () => {
    try {
      await crmDownload(`/whatsapp/click-to-chat/qr.png?${linkQuery()}`, "whatsapp-qr.png");
    } catch (error) {
      showToast(apiErrorMessage(error, t("wa.link.qrFailed")), "error");
    }
  });

  // Runs after every reload of the numbers.
  function refreshExtras() {
    const hasNumbers = accounts.length > 0;
    $("waTemplatesSection").hidden = !hasNumbers;
    $("waLinkSection").hidden = !hasNumbers;
    if (!hasNumbers) return;
    fillAccountSelect($("waTplAccount"));
    fillAccountSelect($("waLinkAccount"));
    loadTemplates();
    loadLink();
  }

  load();
  return undefined;
});
