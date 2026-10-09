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
(function settingsWhatsApp() {
  if (!isOrgManager()) return leaveManagerTab("whatsapp");
  document.getElementById("whatsappTab").style.display = "";

  const STATUS_BADGE = {
    connected: '<span class="badge badge-success">Connected</span>',
    pending: '<span class="badge badge-warning">Not checked</span>',
    error: '<span class="badge badge-danger">Problem</span>',
    disconnected: '<span class="badge badge-danger">Disconnected</span>',
  };
  const QUALITY = { GREEN: "High", YELLOW: "Medium", RED: "Low" };
  const LIMIT = (tier) => (tier ? tier.replace(/^TIER_/, "").replace("UNLIMITED", "Unlimited").replace(/K$/, ",000").replace(/^(\d+)$/, "$1") : "");
  const listEl = document.getElementById("waAccountList");
  let accounts = [];
  let connect = { available: false, devTools: false };

  // "Connect WhatsApp" numbers (D60): how the import of the chats went.
  function syncHtml(a) {
    const s = a.sync;
    if (a.connectionType !== "coexistence" || !s) return "";
    const counts = `${s.chats.toLocaleString("en-IN")} chats, ${s.messages.toLocaleString("en-IN")} messages, ${s.contacts.toLocaleString("en-IN")} contacts`;
    const text = {
      pending: "Asking WhatsApp for the chats…",
      importing: `Importing chats: ${counts} so far`,
      done: `Chats imported: ${counts}${s.finishedAt ? ` · ${when(s.finishedAt)}` : ""}`,
      declined: "Old chats were not shared (history sharing is off in the WhatsApp Business app). New chats come in.",
      failed: `Importing chats stopped${s.error ? `: ${s.error}` : ""}`,
    }[s.status] || "";
    const retry = ["failed", "declined"].includes(s.status) ? ` <button class="btn btn-outline" type="button" data-wa-sync="${escapeHtml(a.id)}"><i class="fa-solid fa-rotate"></i> Import chats again</button>` : "";
    return `<div class="sub" style="margin-top:6px">${escapeHtml(text)}${retry}</div>`;
  }

  function connectedHtml(a) {
    const kind = a.connectionType === "coexistence" ? "WhatsApp Business app number (keeps working on the phone)" : "Cloud API number";
    const details = [
      kind,
      a.qualityRating ? `quality ${QUALITY[a.qualityRating] || a.qualityRating}` : "",
      a.messagingLimit ? `reaches up to ${LIMIT(a.messagingLimit)} people a day with templates` : "",
      a.lastWebhookAt ? `last message ${when(a.lastWebhookAt)}` : "no message received yet",
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
      document.getElementById("waConnectTitle").textContent = "Connect WhatsApp";
      document.getElementById("waConnectText").textContent = "Connecting your WhatsApp Business number is being set up by the YELLOW CRM team. It will appear here as soon as it is ready.";
      return;
    }
    document.getElementById("waConnectTitle").textContent = live ? "Connect another number" : "Connect your WhatsApp Business number";
    document.getElementById("waConnectText").textContent = live
      ? "Add another WhatsApp number of your company, or reconnect one."
      : "Opens Meta's secure window. Your WhatsApp Business app keeps working, and your chats come into the Inbox.";
    link.innerHTML = `<i class="fa-brands fa-whatsapp"></i> ${live ? "Connect another number" : "Connect WhatsApp"}`;
  }

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
    const viaMeta = a.connectionType === "embedded" || a.connectionType === "coexistence";
    const setup = a.provider === "mock"
      ? `<div class="sub" style="margin-top:6px">Test number — nothing reaches WhatsApp. Use the developer test tools below.</div>`
      : viaMeta ? connectedHtml(a) : `
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
          ${viaMeta ? "" : `<div class="sub">Phone number ID ${escapeHtml(a.phoneNumberId)}${a.accessToken.configured ? ` · token …${escapeHtml(a.accessToken.last4)}` : ""} · ${a.lastWebhookAt ? `last message from WhatsApp ${escapeHtml(when(a.lastWebhookAt))}` : "no message received yet"}</div>`}
          ${["error", "disconnected"].includes(a.status) && a.statusMessage ? `<div class="sub" style="color:var(--danger)">${escapeHtml(a.statusMessage)}</div>` : ""}
          ${setup}
          ${catalogHtml(a)}
        </div>
        <div style="display:flex; gap:8px; flex-shrink:0; flex-wrap:wrap">
          ${viaMeta && a.status !== "connected" ? `<a class="btn btn-primary" href="connect-whatsapp.html?add=1"><i class="fa-brands fa-whatsapp"></i> Reconnect</a>` : ""}
          <button class="btn btn-outline" type="button" data-wa-test="${escapeHtml(a.id)}"><i class="fa-solid fa-plug-circle-check"></i> ${viaMeta ? "Check" : "Test"}</button>
          ${a.provider === "meta" && !viaMeta ? `<button class="btn btn-outline" type="button" data-wa-token="${escapeHtml(a.id)}" title="Paste a new access token"><i class="fa-solid fa-key"></i></button>` : ""}
          ${a.isDefault ? "" : `<button class="btn btn-outline" type="button" data-wa-default="${escapeHtml(a.id)}" title="Make default">Default</button>`}
          ${viaMeta
            ? `<button class="btn btn-outline" type="button" data-wa-remove="${escapeHtml(a.id)}">Disconnect</button>`
            : `<button class="icon-btn danger" type="button" data-wa-remove="${escapeHtml(a.id)}" title="Remove"><i class="fa-solid fa-trash"></i></button>`}
        </div>
      </div>`;
  }

  // --- the Meta catalog of a number (Phase 8C) ---
  let catalogFormFor = "";
  function catalogHtml(a) {
    const c = a.catalog;
    const sync = c?.lastSyncAt
      ? `last sync ${escapeHtml(when(c.lastSyncAt))}: ${c.lastSync?.error ? `<span style="color:var(--danger)">${escapeHtml(c.lastSync.error)}</span>` : `${c.lastSync?.sent || 0} sent${c.lastSync?.removed ? `, ${c.lastSync.removed} removed` : ""}${c.lastSync?.failed ? `, <span style="color:var(--danger)">${c.lastSync.failed} need attention (Products page)</span>` : ""}`}`
      : "syncing…";
    const summary = c
      ? `<strong>WhatsApp catalog:</strong> ${escapeHtml(c.name || c.catalogId)} <span class="text-muted">(${escapeHtml(c.catalogId)})</span> · ${sync}${c.statusMessage ? `<div style="color:var(--danger)">${escapeHtml(c.statusMessage)}</div>` : ""}`
      : '<strong>WhatsApp catalog:</strong> none. Connect the catalog of this WhatsApp Business Account (Meta Commerce Manager → Catalogs) to send products in chats and receive orders.';
    const form = catalogFormFor === String(a.id)
      ? `<form class="wa-catalog-form" data-wa-catalog-form="${escapeHtml(a.id)}" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:6px">
          <input type="text" name="catalogId" inputmode="numeric" placeholder="Catalog ID (digits)" value="${escapeHtml(c?.catalogId || "")}" required style="max-width:220px" />
          <label class="ls-check" style="margin:0"><input type="checkbox" name="catalogVisible" ${c?.catalogVisible === false ? "" : "checked"} /> Show the shop button in chats</label>
          <label class="ls-check" style="margin:0"><input type="checkbox" name="cartEnabled" ${c?.cartEnabled === false ? "" : "checked"} /> Customers can send a cart</label>
          <button class="btn btn-primary" type="submit">Check and connect</button>
          <button class="btn btn-outline" type="button" data-wa-catalog-cancel>Cancel</button>
        </form>`
      : "";
    return `<div class="sub wa-catalog" style="margin-top:8px">${summary}
      <div style="display:flex; gap:8px; margin-top:6px; flex-wrap:wrap">
        ${form ? "" : `<button class="btn btn-outline" type="button" data-wa-catalog="${escapeHtml(a.id)}"><i class="fa-solid fa-store"></i> ${c ? "Change catalog" : "Connect catalog"}</button>`}
        ${c && !form ? `<a class="btn btn-outline" href="Products.html"><i class="fa-solid fa-box-open"></i> Choose products</a><button class="btn btn-outline" type="button" data-wa-catalog-off="${escapeHtml(a.id)}">Disconnect</button>` : ""}
      </div>${form}</div>`;
  }

  function render() {
    document.getElementById("waCount").textContent = accounts.length ? `${accounts.length} number${accounts.length === 1 ? "" : "s"}` : "";
    listEl.innerHTML = accounts.length ? accounts.map(accountHtml).join("") : "";
    renderConnectCard();
    // Developer test tools: a development server with DEV_TOOLS=on only.
    document.getElementById("waDevTools").hidden = !connect.devTools;
    document.getElementById("waSimulateSection").hidden = !accounts.length;
    document.getElementById("waSimulateForm").hidden = !accounts.length;
  }

  async function load() {
    try {
      [accounts, connect] = await Promise.all([crmApi("/whatsapp/accounts"), crmApi("/whatsapp/connect")]);
      render();
      refreshExtras();
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
      showToast(connected.statusMessage || `Catalog "${connected.name || connected.catalogId}" connected. The products marked for it are being sent.`, connected.statusMessage ? "error" : "success");
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't connect the catalog."), "error");
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
      if (!confirm("Disconnect the catalog? Products stay in Meta's catalog, but the CRM stops syncing them and cannot send them in chats.")) return undefined;
      return run(() => crmApi(`/whatsapp/accounts/${catalogOff.dataset.waCatalogOff}/catalog`, { method: "DELETE" }), "Catalog disconnected.");
    }
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
      if (!confirm("Disconnect this WhatsApp number from the CRM? Its chats stay in the CRM; new messages stop arriving here. The WhatsApp Business app on the phone keeps working.")) return;
      await run(() => crmApi(`/whatsapp/accounts/${remove.dataset.waRemove}`, { method: "DELETE" }), "WhatsApp number disconnected.");
    } else if (e.target.closest("[data-wa-sync]")) {
      await run(() => crmApi(`/whatsapp/accounts/${e.target.closest("[data-wa-sync]").dataset.waSync}/sync`, { method: "POST" }), "Asked WhatsApp for the chats again.");
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
      .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.verifiedName || a.name || "WhatsApp number")}${a.displayPhone ? ` · ${escapeHtml(a.displayPhone)}` : ""}</option>`)
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
            <span class="badge ${TEMPLATE_BADGE[t.status] || "badge-neutral"}">${escapeHtml(t.status.toLowerCase().replace(/_/g, " "))}</span></div>
          <div class="body">${escapeHtml(text)}</div>
          ${t.rejectedReason ? `<div class="why">Meta's reason: ${escapeHtml(t.rejectedReason.toLowerCase().replace(/_/g, " "))}</div>` : ""}
          ${t.status === "APPROVED" && !t.sendable ? `<div class="why">${escapeHtml(t.notSendableReason)}</div>` : ""}
        </div>
        <button class="icon-btn danger" type="button" data-tpl-delete="${escapeHtml(t.id)}" title="Delete at Meta and here"><i class="fa-solid fa-trash"></i></button>
      </div>`;
  }

  async function loadTemplates() {
    const accountId = $("waTplAccount").value;
    if (!accountId) return;
    try {
      templates = await crmApi(`/templates?accountId=${encodeURIComponent(accountId)}`);
      $("waTplList").innerHTML = templates.length
        ? templates.map(templateHtml).join("")
        : '<p class="settings-hint" style="margin:0">No templates here yet. Press "Sync from Meta" to bring the ones you made in WhatsApp Manager, or create one below.</p>';
    } catch (error) {
      $("waTplList").innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, "Couldn't load the templates."))}</p>`;
    }
  }

  $("waTplAccount").addEventListener("change", loadTemplates);
  $("waTplSync").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const list = await crmApi("/templates/sync", jsonRequest("POST", { accountId: $("waTplAccount").value }));
      showToast(`Synced: ${list.length} template${list.length === 1 ? "" : "s"}.`, "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't sync the templates."), "error");
    }
    e.target.disabled = false;
    await loadTemplates();
  });
  $("waTplList").addEventListener("click", async (e) => {
    const remove = e.target.closest("[data-tpl-delete]");
    if (!remove) return;
    const template = templates.find((t) => t.id === remove.dataset.tplDelete);
    if (!confirm(`Delete the template "${template?.name}" (${template?.language}) at Meta? It cannot be sent any more, and the same name cannot be reused for a while.`)) return;
    try {
      await crmApi(`/templates/${remove.dataset.tplDelete}`, { method: "DELETE" });
      showToast("Template deleted.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't delete the template."), "error");
    }
    await loadTemplates();
  });

  // New template: one example field per {{variable}}, up to three buttons.
  function renderExamples() {
    const saved = {};
    document.querySelectorAll("#waTplExamples input").forEach((input) => {
      saved[input.dataset.key] = input.value;
    });
    const header = placeholders($("waTplHeader").value).slice(0, 1).map((name) => ({ key: `h:${name}`, label: `Example for the header {{${name}}}` }));
    const body = placeholders($("waTplBody").value).map((name) => ({ key: `b:${name}`, label: `Example for {{${name}}}` }));
    const fields = [...header, ...body];
    $("waTplExamples").innerHTML = fields.length
      ? `<p class="settings-hint" style="margin:0 0 8px">Meta checks templates with example values (for instance a real-looking name or order number).</p>
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
      <select data-button-type aria-label="Button kind">
        <option value="QUICK_REPLY">Quick reply</option>
        <option value="URL">Open a link</option>
        <option value="PHONE_NUMBER">Call a number</option>
      </select>
      <input type="text" data-button-text maxlength="25" placeholder="Button text" aria-label="Button text" required />
      <input type="text" data-button-value placeholder="" aria-label="Link or phone number" hidden />
      <button class="icon-btn danger" type="button" data-button-remove aria-label="Remove button"><i class="fa-solid fa-xmark"></i></button>`;
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
      showToast(created.status === "APPROVED" ? "Template approved and ready to use." : "Sent to Meta for approval. The status updates here when Meta decides.", "success");
      e.target.reset();
      $("waTplButtons").innerHTML = "";
      $("waTplAddButton").hidden = false;
      renderExamples();
      $("waTplNew").open = false;
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't create the template."), "error");
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
      $("waLinkError").textContent = apiErrorMessage(error, "Couldn't make the link.");
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
      showToast("Link copied.", "success");
    } catch {
      showToast("Copy failed — select the link and copy it by hand.", "error");
    }
  });
  $("waLinkPng").addEventListener("click", async () => {
    try {
      await crmDownload(`/whatsapp/click-to-chat/qr.png?${linkQuery()}`, "whatsapp-qr.png");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't download the QR code."), "error");
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
})();
