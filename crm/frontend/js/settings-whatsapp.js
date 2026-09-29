/**
 * settings-whatsapp.js — Settings → WhatsApp (owners and admins)
 * Connects WhatsApp Cloud API numbers (/whatsapp/accounts), shows what to paste into the Meta
 * app (callback URL and verify token), manages message templates (/templates), makes the
 * click-to-chat link and QR code (/whatsapp/click-to-chat), and in development lets you
 * receive a test message, photo, document or voice note.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsWhatsApp() {
  if (!isOrgManager()) return leaveManagerTab("whatsapp");
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
