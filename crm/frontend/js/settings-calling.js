/**
 * settings-calling.js — Settings → Calling (Phase 6, D85, owners and admins)
 * The company's cloud-telephony account for click-to-call: Exotel (account SID, API key and
 * token, subdomain, the number customers see), or the test provider in development. The key and
 * token are stored encrypted and never shown again (leave them empty to keep the saved ones).
 * Each member's own mobile (Settings → My profile) is rung first, then the customer.
 * Runs after settings.js; one IIFE: no globals.
 */
(function settingsCalling() {
  if (!isOrgManager()) return leaveManagerTab("calling");
  document.getElementById("callingTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  let current = null;
  let loaded = false;

  function render() {
    const c = current;
    const providers = c.providers || ["exotel"];
    const status = !c.connected ? t("tel.notConnected") : c.status === "error" ? t("tel.error", { why: c.lastError }) : t("tel.connected", { provider: c.provider === "mock" ? t("tel.mock") : "Exotel", callerId: c.callerId });
    $("telBox").innerHTML = `
      <p class="settings-hint${c.status === "error" ? " ms-warn" : ""}">${escapeHtml(status)}</p>
      <form class="cf-form" id="telForm" autocomplete="off">
        <div class="field"><label for="telProvider">${escapeHtml(t("tel.provider"))}</label>
          <select id="telProvider">${providers.map((p) => `<option value="${p}" ${p === (c.provider || "exotel") ? "selected" : ""}>${escapeHtml(p === "mock" ? t("tel.mock") : "Exotel")}</option>`).join("")}</select></div>
        <div class="tel-exotel">
          <div class="field"><label for="telSid">${escapeHtml(t("tel.sid"))}</label><input type="text" id="telSid" maxlength="100" value="${escapeHtml(c.accountSid || "")}" /></div>
          <div class="field"><label for="telKey">${escapeHtml(t("tel.key"))}</label><input type="password" id="telKey" maxlength="200" autocomplete="new-password" placeholder="${escapeHtml(c.hasKeys ? t("tel.keepSaved") : "")}" /></div>
          <div class="field"><label for="telToken">${escapeHtml(t("tel.token"))}</label><input type="password" id="telToken" maxlength="200" autocomplete="new-password" placeholder="${escapeHtml(c.hasKeys ? t("tel.keepSaved") : "")}" /></div>
          <div class="field"><label for="telSub">${escapeHtml(t("tel.subdomain"))}</label><input type="text" id="telSub" maxlength="100" value="${escapeHtml(c.subdomain || "api.exotel.com")}" /></div>
        </div>
        <div class="field"><label for="telCaller">${escapeHtml(t("tel.callerId"))}</label><input type="tel" id="telCaller" maxlength="30" value="${escapeHtml(c.callerId || "")}" placeholder="080 6900 0000" /></div>
        <p class="settings-hint">${escapeHtml(t("tel.hint"))}</p>
        <div class="pl-buttons">
          <button class="btn btn-primary" type="submit">${escapeHtml(t(c.connected ? "tel.save" : "tel.connect"))}</button>
          ${c.connected ? `<button class="btn btn-outline" type="button" data-tel="test">${escapeHtml(t("tel.test"))}</button><button class="btn btn-danger-outline" type="button" data-tel="remove">${escapeHtml(t("tel.disconnect"))}</button>` : ""}
        </div>
      </form>`;
    toggleFields();
  }

  function toggleFields() {
    const exotel = $("telProvider").value === "exotel";
    document.querySelector("#telBox .tel-exotel").hidden = !exotel;
  }

  async function load() {
    try {
      await crmI18n.ready;
      current = await crmApi("/telephony");
      render();
    } catch (error) {
      $("telBox").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("tel.loadFailed")))}</p>`;
    }
  }

  async function save(event) {
    event.preventDefault();
    const provider = $("telProvider").value;
    const body = {
      provider,
      callerId: $("telCaller").value.trim(),
      ...(provider === "exotel" && { accountSid: $("telSid").value.trim(), subdomain: $("telSub").value.trim(), apiKey: $("telKey").value.trim(), apiToken: $("telToken").value.trim() }),
    };
    // Exotel needs its SID, and the key and token unless saved ones are kept; and every provider a number.
    const keysMissing = provider === "exotel" && (!body.accountSid || (!(current.hasKeys && current.provider === "exotel") && (!body.apiKey || !body.apiToken)));
    if (keysMissing || !body.callerId) {
      showToast(t(keysMissing ? "tel.needKeys" : "tel.needCallerId"), "error");
      return;
    }
    try {
      current = await crmApi("/telephony", jsonRequest("PUT", body));
      showToast(t("tel.saved"), "success");
      render();
    } catch (error) {
      showToast(apiErrorMessage(error, t("tel.saveFailed")), "error");
    }
  }

  async function onClick(event) {
    const button = event.target.closest("[data-tel]");
    if (!button) return;
    if (button.dataset.tel === "remove" && !confirm(t("tel.disconnectConfirm"))) return;
    button.disabled = true;
    try {
      if (button.dataset.tel === "test") {
        const result = await crmApi("/telephony/test", { method: "POST" });
        showToast(result.ok ? t("tel.testOk") : t("tel.testFailed", { why: result.error }), result.ok ? "success" : "error");
      } else {
        await crmApi("/telephony", { method: "DELETE" });
        showToast(t("tel.disconnected"), "success");
      }
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, t("tel.saveFailed")), "error");
    } finally {
      button.disabled = false;
    }
  }

  $("telBox").addEventListener("submit", save);
  $("telBox").addEventListener("click", onClick);
  $("telBox").addEventListener("change", (event) => { if (event.target.id === "telProvider") toggleFields(); });
  function loadOnce() {
    if (loaded) return;
    loaded = true;
    load();
  }
  document.querySelector('.settings-tab[data-panel="calling"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="calling"]').classList.contains("active")) loadOnce();
  return undefined;
})();
