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
    const status = g.status === "connected" ? `<span class="badge badge-success">${escapeHtml(t("setpay.connected"))}</span>` : `<span class="badge badge-danger">${escapeHtml(t("setpay.problem"))}</span>`;
    const mode = g.mode === "live" ? `<span class="badge badge-brand">${escapeHtml(t("setpay.live"))}</span>` : `<span class="badge badge-neutral">${escapeHtml(t("setpay.test"))}</span>`;
    const events = g.provider === "razorpay"
      ? t("setpay.razorpayEvents")
      : t("setpay.cashfreeEvents");
    return `
      <div class="pay-gateway" data-gateway="${escapeHtml(g.id)}">
        <div class="pay-gateway-top">
          <strong>${escapeHtml(g.name)}${g.isDefault ? ` <span class="badge badge-info">${escapeHtml(t("setpay.default"))}</span>` : ""}</strong>
          <span>${mode} ${status}</span>
        </div>
        ${g.statusMessage ? `<div class="pay-gateway-meta">${escapeHtml(g.statusMessage)}</div>` : ""}
        ${g.provider !== "mock" ? `<div class="pay-gateway-meta">${escapeHtml(t("setpay.keyLine", { key: g.keyId, last4: g.keySecret.last4 || "" }))}</div>` : `<div class="pay-gateway-meta">${escapeHtml(t("setpay.testGatewayNote"))}</div>`}
        ${g.webhookUrl ? `<div class="pl-url"><input type="text" readonly value="${escapeHtml(g.webhookUrl)}" aria-label="${escapeHtml(t("setpay.webhookUrl"))}" /><button class="btn btn-outline" type="button" data-copy="${escapeHtml(g.webhookUrl)}"><i class="fa-regular fa-copy"></i> ${escapeHtml(t("int.ex.copy"))}</button></div>
          <div class="pay-gateway-meta">${events}</div>
          ${/\/\/(127\.0\.0\.1|localhost)[:/]/.test(g.webhookUrl) ? `<div class="pay-gateway-meta">${escapeHtml(t("setpay.localOnly"))}</div>` : ""}` : ""}
        <div class="pay-gateway-meta">${[
          g.lastWebhookAt ? t("setpay.last-message-from", { v: escapeHtml(NAMES[g.provider]), v2: escapeHtml(when(g.lastWebhookAt)) }) : g.provider === "mock" ? "" : t("setpay.no-message-from-the-gateway-yet"),
          g.lastCheckedAt && g.provider !== "mock" ? t("setpay.keys-checked", { v: escapeHtml(when(g.lastCheckedAt)) }) : "",
        ].filter(Boolean).join(" · ")}</div>
        <div class="pl-buttons">
          ${g.provider !== "mock" ? `<button class="btn btn-outline" type="button" data-act="test"><i class="fa-solid fa-rotate"></i> ${escapeHtml(t("setpay.checkKeys"))}</button><button class="btn btn-outline" type="button" data-act="keys">${escapeHtml(t("setpay.changeKeys"))}</button>` : ""}
          ${g.isDefault ? "" : `<button class="btn btn-outline" type="button" data-act="default">${escapeHtml(t("setpay.makeDefault"))}</button>`}
          <button class="btn btn-danger-outline" type="button" data-act="remove">${escapeHtml(t("cf.sec.remove"))}</button>
        </div>
      </div>`;
  }

  function renderGateways() {
    $("payGateways").innerHTML = gateways.length
      ? gateways.map(gatewayCard).join("")
      : `<p class="settings-hint">${escapeHtml(t("setpay.noGateway"))}</p>`;
    const connected = new Set(gateways.map((g) => g.provider));
    [...$("payProvider").options].forEach((option) => { option.disabled = connected.has(option.value) && !editing; });
  }

  function templateOptions(selected) {
    // Approved ones that can go as they are (not those that need a PDF in their heading).
    return `<option value="">${escapeHtml(t("setpay.none"))}</option>${templates
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
      $("payGateways").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("setpay.couldn-t-load-the-payment-settings")))}</p>`;
    }
  }

  // --- the connect / change keys form ---
  function syncForm() {
    const provider = editing ? editing.provider : $("payProvider").value;
    $("payModeField").hidden = provider !== "cashfree";
    $("payKeyFields").hidden = provider === "mock";
    $("payWebhookSecretField").hidden = provider !== "razorpay";
    $("payKeyIdLabel").textContent = provider === "cashfree" ? t("setpay.app-id-x-client-id") : t("set.key-id");
    $("payKeySecretLabel").textContent = provider === "cashfree" ? t("setpay.secret-key") : t("set.key-secret");
    $("payKeyHint").textContent = provider === "razorpay"
      ? t("setpay.razorpay-dashboard-account-settings-api-keys")
      : t("setpay.cashfree-merchant-dashboard-developers-api-keys");
    $("payFormSave").textContent = provider === "mock" ? t("dash.setup.leads.action") : t("set.check-and-save");
  }
  function openForm(gateway = null) {
    editing = gateway;
    $("payFormTitle").textContent = gateway ? t("setpay.change-the-keys-of", { name: gateway.name }) : t("set.connect-a-gateway");
    $("payProvider").disabled = Boolean(gateway);
    if (gateway) $("payProvider").value = gateway.provider;
    else $("payProvider").value = [...$("payProvider").options].find((o) => !o.disabled)?.value || "razorpay";
    $("payMode").value = gateway?.mode || "test";
    $("payKeyId").value = gateway?.keyId || "";
    $("payKeySecret").value = "";
    $("payWebhookSecret").value = "";
    $("payKeySecret").placeholder = gateway ? t("setpay.leave-empty-to-keep-it") : "";
    $("payWebhookSecret").placeholder = gateway ? t("setpay.leave-empty-to-keep-it") : "";
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
      showToast(saved.status === "connected" ? t("setpay.is-connected", { name: saved.name }) : t("setpay.was-saved-but", { name: saved.name, statusMessage: saved.statusMessage }), saved.status === "connected" ? "success" : "error");
      closeForm();
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, t("setpay.couldn-t-save-the-gateway")), "error");
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
        showToast(t("setpay.webhook-url-copied"), "success");
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
    if (act === "remove" && !window.confirm(t("setpay.remove-its-links-stay-in-the", { name: gateway.name }))) return;
    button.disabled = true;
    try {
      if (act === "test") {
        const checked = await crmApi(`/payments/connections/${gateway.id}/test`, jsonRequest("POST", {}));
        showToast(checked.status === "connected" ? t("tel.testOk") : checked.statusMessage, checked.status === "connected" ? "success" : "error");
      } else if (act === "default") {
        await crmApi(`/payments/connections/${gateway.id}`, jsonRequest("PATCH", { isDefault: true }));
        showToast(t("setpay.new-links-go-through", { name: gateway.name }), "success");
      } else if (act === "remove") {
        await crmApi(`/payments/connections/${gateway.id}`, { method: "DELETE" });
        showToast(`${gateway.name} removed.`, "success");
      }
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, t("gs.failed")), "error");
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
      showToast(t("setpay.payment-settings-saved"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("setpay.couldn-t-save-the-payment-settings")), "error");
    }
  });

  document.getElementById("paymentsTab").addEventListener("click", () => {
    if (!loaded) load();
  });
  if (new URLSearchParams(window.location.search).get("tab") === "payments") load();
  return undefined;
})();
