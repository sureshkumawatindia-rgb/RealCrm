/**
 * settings-payments.js — Settings → Payments (Phase 8, owners and admins)
 * The company's payment gateways (Razorpay, Cashfree, the test gateway): connect with the
 * gateway's keys (checked first, never shown again), the webhook address to paste into the
 * gateway, check, make default, change keys, remove. Then how links behave: days valid,
 * receipts, and the approved templates used when the customer's 24-hour window is closed.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsPayments() {
  if (!isOrgManager()) return leaveManagerTab("payments");
  document.getElementById("paymentsTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const NAMES = { razorpay: "Razorpay", cashfree: "Cashfree", mock: "Test gateway" };
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  let gateways = [];
  let templates = [];
  let editing = null; // the gateway whose keys are being changed, or null for a new one
  let loaded = false;

  function gatewayCard(g) {
    const status = g.status === "connected" ? '<span class="badge badge-success">Connected</span>' : '<span class="badge badge-danger">Problem</span>';
    const mode = g.mode === "live" ? '<span class="badge badge-brand">Live</span>' : '<span class="badge badge-neutral">Test</span>';
    const events = g.provider === "razorpay"
      ? "In Razorpay: Account &amp; Settings → Webhooks → Add new webhook. Paste this URL, type the same webhook secret, and tick <strong>payment_link.paid</strong>, <strong>payment_link.partially_paid</strong>, <strong>payment_link.expired</strong> and <strong>payment_link.cancelled</strong>."
      : "In Cashfree: Developers → Webhooks → Add webhook endpoint. Paste this URL and choose the <strong>Payment link</strong> events.";
    return `
      <div class="pay-gateway" data-gateway="${escapeHtml(g.id)}">
        <div class="pay-gateway-top">
          <strong>${escapeHtml(g.name)}${g.isDefault ? ' <span class="badge badge-info">Default</span>' : ""}</strong>
          <span>${mode} ${status}</span>
        </div>
        ${g.statusMessage ? `<div class="pay-gateway-meta">${escapeHtml(g.statusMessage)}</div>` : ""}
        ${g.provider !== "mock" ? `<div class="pay-gateway-meta">Key ${escapeHtml(g.keyId)} · secret ••••${escapeHtml(g.keySecret.last4 || "")}</div>` : '<div class="pay-gateway-meta">Its links open a test payment page on this CRM. Nothing is charged.</div>'}
        ${g.webhookUrl ? `<div class="pl-url"><input type="text" readonly value="${escapeHtml(g.webhookUrl)}" aria-label="Webhook URL" /><button class="btn btn-outline" type="button" data-copy="${escapeHtml(g.webhookUrl)}"><i class="fa-regular fa-copy"></i> Copy</button></div>
          <div class="pay-gateway-meta">${events}</div>
          ${/\/\/(127\.0\.0\.1|localhost)[:/]/.test(g.webhookUrl) ? '<div class="pay-gateway-meta">This address works only on this computer. Until the CRM has a public https address, payments are found by checking the gateway every 10 minutes (or “Check now” on a link).</div>' : ""}` : ""}
        <div class="pay-gateway-meta">${[
          g.lastWebhookAt ? `Last message from ${escapeHtml(NAMES[g.provider])}: ${escapeHtml(when(g.lastWebhookAt))}` : g.provider === "mock" ? "" : "No message from the gateway yet.",
          g.lastCheckedAt && g.provider !== "mock" ? `keys checked ${escapeHtml(when(g.lastCheckedAt))}` : "",
        ].filter(Boolean).join(" · ")}</div>
        <div class="pl-buttons">
          ${g.provider !== "mock" ? '<button class="btn btn-outline" type="button" data-act="test"><i class="fa-solid fa-rotate"></i> Check keys</button><button class="btn btn-outline" type="button" data-act="keys">Change keys</button>' : ""}
          ${g.isDefault ? "" : '<button class="btn btn-outline" type="button" data-act="default">Make default</button>'}
          <button class="btn btn-danger-outline" type="button" data-act="remove">Remove</button>
        </div>
      </div>`;
  }

  function renderGateways() {
    $("payGateways").innerHTML = gateways.length
      ? gateways.map(gatewayCard).join("")
      : '<p class="settings-hint">No gateway yet. Connect Razorpay or Cashfree with your keys, or the test gateway to try it out.</p>';
    const connected = new Set(gateways.map((g) => g.provider));
    [...$("payProvider").options].forEach((option) => { option.disabled = connected.has(option.value) && !editing; });
  }

  function templateOptions(selected) {
    // Approved ones that can go as they are (not those that need a PDF in their heading).
    return `<option value="">— none —</option>${templates
      .filter((t) => t.status === "APPROVED" && t.sendable !== false)
      .map((t) => `<option value="${escapeHtml(t.id)}" ${String(t.id) === String(selected || "") ? "selected" : ""}>${escapeHtml(t.name)} (${escapeHtml(t.language)}, ${escapeHtml(t.category)})</option>`)
      .join("")}`;
  }

  function renderSettings(settings) {
    $("payExpiry").value = settings.expiryDays || 7;
    $("paySendReceipt").checked = settings.sendReceipt !== false;
    $("payLinkTpl").innerHTML = templateOptions(settings.linkTemplateId);
    $("payReceiptTpl").innerHTML = templateOptions(settings.receiptTemplateId);
  }

  async function load() {
    loaded = true;
    try {
      const [list, settings, tpl] = await Promise.all([crmApi("/payments/connections"), crmApi("/payments/settings"), crmApi("/templates").catch(() => [])]);
      gateways = list;
      templates = Array.isArray(tpl) ? tpl : [];
      renderGateways();
      renderSettings(settings);
    } catch (error) {
      $("payGateways").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, "Couldn't load the payment settings."))}</p>`;
    }
  }

  // --- the connect / change keys form ---
  function syncForm() {
    const provider = editing ? editing.provider : $("payProvider").value;
    $("payModeField").hidden = provider !== "cashfree";
    $("payKeyFields").hidden = provider === "mock";
    $("payWebhookSecretField").hidden = provider !== "razorpay";
    $("payKeyIdLabel").textContent = provider === "cashfree" ? "App ID (x-client-id)" : "Key Id";
    $("payKeySecretLabel").textContent = provider === "cashfree" ? "Secret Key" : "Key Secret";
    $("payKeyHint").textContent = provider === "razorpay"
      ? "Razorpay Dashboard → Account & Settings → API Keys. Test keys start with rzp_test_, live keys with rzp_live_. Make up a long webhook secret and type the same one when you add the webhook in Razorpay."
      : "Cashfree Merchant Dashboard → Developers → API Keys (choose Test or Production at the top first). Cashfree signs its webhooks with this secret key.";
    $("payFormSave").textContent = provider === "mock" ? "Connect" : "Check and save";
  }
  function openForm(gateway = null) {
    editing = gateway;
    $("payFormTitle").textContent = gateway ? `Change the keys of ${gateway.name}` : "Connect a gateway";
    $("payProvider").disabled = Boolean(gateway);
    if (gateway) $("payProvider").value = gateway.provider;
    else $("payProvider").value = [...$("payProvider").options].find((o) => !o.disabled)?.value || "razorpay";
    $("payMode").value = gateway?.mode || "test";
    $("payKeyId").value = gateway?.keyId || "";
    $("payKeySecret").value = "";
    $("payWebhookSecret").value = "";
    $("payKeySecret").placeholder = gateway ? "Leave empty to keep it" : "";
    $("payWebhookSecret").placeholder = gateway ? "Leave empty to keep it" : "";
    $("payForm").hidden = false;
    $("payAddBtn").hidden = true;
    syncForm();
    renderGateways();
  }
  function closeForm() {
    editing = null;
    $("payForm").hidden = true;
    $("payAddBtn").hidden = false;
    renderGateways();
  }

  $("payAddBtn").addEventListener("click", () => openForm());
  $("payFormCancel").addEventListener("click", closeForm);
  $("payProvider").addEventListener("change", syncForm);
  $("payForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const provider = editing ? editing.provider : $("payProvider").value;
    const body = editing ? {} : { provider };
    if (provider !== "mock") {
      const keyId = $("payKeyId").value.trim();
      const keySecret = $("payKeySecret").value.trim();
      const webhookSecret = $("payWebhookSecret").value.trim();
      if (!editing || keyId !== editing.keyId) body.keyId = keyId;
      if (keySecret) body.keySecret = keySecret;
      if (provider === "razorpay" && webhookSecret) body.webhookSecret = webhookSecret;
      if (provider === "cashfree" && (!editing || $("payMode").value !== editing.mode)) body.mode = $("payMode").value;
      if (editing && !Object.keys(body).length) return closeForm();
    }
    $("payFormSave").disabled = true;
    try {
      const saved = editing
        ? await crmApi(`/payments/connections/${editing.id}`, jsonRequest("PATCH", body))
        : await crmApi("/payments/connections", jsonRequest("POST", body));
      showToast(saved.status === "connected" ? `${saved.name} is connected.` : `${saved.name} was saved, but: ${saved.statusMessage}`, saved.status === "connected" ? "success" : "error");
      closeForm();
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the gateway."), "error");
    } finally {
      $("payFormSave").disabled = false;
    }
    return undefined;
  });

  $("payGateways").addEventListener("click", async (e) => {
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        showToast("Webhook URL copied.", "success");
      } catch {
        copy.previousElementSibling?.select();
      }
      return;
    }
    const button = e.target.closest("[data-act]");
    if (!button) return;
    const gateway = gateways.find((g) => g.id === button.closest("[data-gateway]").dataset.gateway);
    const act = button.dataset.act;
    if (act === "keys") return openForm(gateway);
    if (act === "remove" && !window.confirm(`Remove ${gateway.name}? Its links stay in the CRM, but their payments will no longer be recorded.`)) return;
    button.disabled = true;
    try {
      if (act === "test") {
        const checked = await crmApi(`/payments/connections/${gateway.id}/test`, jsonRequest("POST", {}));
        showToast(checked.status === "connected" ? "The keys work." : checked.statusMessage, checked.status === "connected" ? "success" : "error");
      } else if (act === "default") {
        await crmApi(`/payments/connections/${gateway.id}`, jsonRequest("PATCH", { isDefault: true }));
        showToast(`New links go through ${gateway.name}.`, "success");
      } else if (act === "remove") {
        await crmApi(`/payments/connections/${gateway.id}`, { method: "DELETE" });
        showToast(`${gateway.name} removed.`, "success");
      }
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, "That didn't work."), "error");
      button.disabled = false;
    }
  });

  $("paySettingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      renderSettings(await crmApi("/payments/settings", jsonRequest("PUT", {
        expiryDays: Number($("payExpiry").value) || 7,
        sendReceipt: $("paySendReceipt").checked,
        linkTemplateId: $("payLinkTpl").value || null,
        receiptTemplateId: $("payReceiptTpl").value || null,
      })));
      showToast("Payment settings saved.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the payment settings."), "error");
    }
  });

  document.getElementById("paymentsTab").addEventListener("click", () => {
    if (!loaded) load();
  });
  if (new URLSearchParams(window.location.search).get("tab") === "payments") load();
  return undefined;
})();
