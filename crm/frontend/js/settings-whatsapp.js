/**
 * settings-whatsapp.js — Settings → WhatsApp (owners and admins)
 * Connects WhatsApp Cloud API numbers (/whatsapp/accounts), shows what to paste into the Meta
 * app (callback URL and verify token), and in development lets you receive a test message.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsWhatsApp() {
  if (!isOrgManager()) return;
  document.getElementById("whatsappTab").style.display = "";

  const STATUS_BADGE = {
    connected: '<span class="badge badge-success">Connected</span>',
    pending: '<span class="badge badge-warning">Not checked</span>',
    error: '<span class="badge badge-danger">Problem</span>',
  };
  const listEl = document.getElementById("waAccountList");
  let accounts = [];

  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  // Meta needs a public HTTPS address; 127.0.0.1 / localhost only works through a tunnel.
  const isLocal = (url) => /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url);

  function copyButton(value, label) {
    return `<button class="btn btn-outline" type="button" data-copy="${escapeHtml(value)}" title="Copy ${escapeHtml(label)}"><i class="fa-solid fa-copy"></i></button>`;
  }

  function accountHtml(a) {
    const title = a.verifiedName || a.name || "WhatsApp number";
    const tunnelHint = isLocal(a.webhookUrl)
      ? `<div class="sub" style="margin-top:4px">Meta cannot reach ${escapeHtml(new URL(a.webhookUrl).host)}. Start a tunnel (for example <code>cloudflared tunnel --url http://127.0.0.1:3000</code>) and use <strong>https://&lt;tunnel address&gt;${escapeHtml(a.webhookPath)}</strong> as the callback URL.</div>`
      : "";
    const setup = a.provider === "mock"
      ? `<div class="sub" style="margin-top:6px">Test number — nothing reaches WhatsApp. Use "Receive Test Message" below.</div>`
      : `
        <div class="sub" style="margin-top:8px"><strong>In the Meta app → WhatsApp → Configuration → Webhook:</strong> paste these two values, then subscribe to the <strong>messages</strong> field.</div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:6px; min-width:0">
          <span class="sub" style="flex-shrink:0; width:92px">Callback URL</span>
          <code style="word-break:break-all; font-size:12px; flex:1">${escapeHtml(a.webhookUrl)}</code>${copyButton(a.webhookUrl, "callback URL")}
        </div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:6px; min-width:0">
          <span class="sub" style="flex-shrink:0; width:92px">Verify token</span>
          <code style="word-break:break-all; font-size:12px; flex:1">${escapeHtml(a.verifyToken)}</code>${copyButton(a.verifyToken, "verify token")}
        </div>
        ${tunnelHint}`;
    return `
      <div class="settings-summary-row" style="align-items:flex-start; flex-wrap:wrap">
        <div class="info" style="min-width:0; flex:1">
          <div class="name">
            <i class="fa-brands fa-whatsapp" style="color:#25d366"></i> ${escapeHtml(title)}
            ${a.displayPhone ? `<span class="text-muted" style="font-weight:500">· ${escapeHtml(a.displayPhone)}</span>` : ""}
            ${STATUS_BADGE[a.status] || ""} ${a.isDefault ? '<span class="badge badge-brand">Default</span>' : ""}
            ${a.provider === "mock" ? '<span class="badge badge-neutral">Test number</span>' : ""}
          </div>
          <div class="sub">Phone number ID ${escapeHtml(a.phoneNumberId)}${a.accessToken.configured ? ` · token …${escapeHtml(a.accessToken.last4)}` : ""} · ${a.lastWebhookAt ? `last message from WhatsApp ${escapeHtml(when(a.lastWebhookAt))}` : "no message received yet"}</div>
          ${a.status === "error" && a.statusMessage ? `<div class="sub" style="color:var(--danger)">${escapeHtml(a.statusMessage)}</div>` : ""}
          ${setup}
        </div>
        <div style="display:flex; gap:8px; flex-shrink:0">
          <button class="btn btn-outline" type="button" data-wa-test="${escapeHtml(a.id)}"><i class="fa-solid fa-plug-circle-check"></i> Test</button>
          ${a.provider === "meta" ? `<button class="btn btn-outline" type="button" data-wa-token="${escapeHtml(a.id)}" title="Paste a new access token"><i class="fa-solid fa-key"></i></button>` : ""}
          ${a.isDefault ? "" : `<button class="btn btn-outline" type="button" data-wa-default="${escapeHtml(a.id)}" title="Make default">Default</button>`}
          <button class="icon-btn danger" type="button" data-wa-remove="${escapeHtml(a.id)}" title="Remove"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`;
  }

  function render() {
    document.getElementById("waCount").textContent = accounts.length ? `${accounts.length} number${accounts.length === 1 ? "" : "s"}` : "";
    listEl.innerHTML = accounts.length
      ? accounts.map(accountHtml).join("")
      : `<p class="settings-hint" style="margin:0">No WhatsApp number connected yet.</p>`;
    document.getElementById("waSimulateSection").hidden = !accounts.length;
  }

  async function load() {
    try {
      accounts = await crmApi("/whatsapp/accounts");
      render();
    } catch (error) {
      listEl.innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, "Couldn't load the WhatsApp numbers."))}</p>`;
    }
  }

  async function run(action, success) {
    try {
      const result = await action();
      if (success) showToast(typeof success === "function" ? success(result) : success, "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "That didn't work. Please try again."), "error");
    }
    await load();
  }

  listEl.addEventListener("click", async (e) => {
    const copy = e.target.closest("[data-copy]");
    const test = e.target.closest("[data-wa-test]");
    const token = e.target.closest("[data-wa-token]");
    const makeDefault = e.target.closest("[data-wa-default]");
    const remove = e.target.closest("[data-wa-remove]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        showToast("Copied.", "success");
      } catch {
        showToast("Copy failed — select the text and copy it by hand.", "error");
      }
    } else if (test) {
      await run(() => crmApi(`/whatsapp/accounts/${test.dataset.waTest}/test`, { method: "POST" }),
        (a) => (a.status === "connected" ? "WhatsApp answered: the number works." : `Problem: ${a.statusMessage}`));
    } else if (token) {
      const value = window.prompt("Paste the new access token (it is stored encrypted):");
      if (value && value.trim()) {
        await run(() => crmApi(`/whatsapp/accounts/${token.dataset.waToken}`, jsonRequest("PATCH", { accessToken: value.trim() })), "Access token updated.");
      }
    } else if (makeDefault) {
      await run(() => crmApi(`/whatsapp/accounts/${makeDefault.dataset.waDefault}`, jsonRequest("PATCH", { isDefault: true })), "Default number changed.");
    } else if (remove) {
      if (!confirm("Remove this WhatsApp number? Its chats stay in the CRM; new messages stop arriving.")) return;
      await run(() => crmApi(`/whatsapp/accounts/${remove.dataset.waRemove}`, { method: "DELETE" }), "WhatsApp number removed.");
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
    }, (a) => (a.status === "connected" ? "Number connected. Now set the webhook in the Meta app." : `Saved, but WhatsApp said: ${a.statusMessage}`));
    button.disabled = false;
  });

  document.getElementById("waAddMockBtn").addEventListener("click", () =>
    run(() => crmApi("/whatsapp/accounts", jsonRequest("POST", { provider: "mock", name: "Test number" })), "Test number added."));

  document.getElementById("waSimulateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = (id) => document.getElementById(id).value.trim();
    try {
      await crmApi("/dev/simulate/whatsapp-inbound", jsonRequest("POST", { from: value("waSimFrom"), name: value("waSimName"), text: value("waSimText") }));
      document.getElementById("waSimText").value = "";
      showToast("Test message received. The sender is now a contact (and a new lead if the number was new).", "success");
    } catch (error) {
      showToast(error.status === 404 ? "Test messages are turned off on this server." : apiErrorMessage(error, "Couldn't receive the test message."), "error");
    }
    await load();
  });

  load();
})();
