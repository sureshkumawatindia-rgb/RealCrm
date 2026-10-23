/**
 * settings-sms.js — Settings → SMS (Phase 8A, D88, owners and admins)
 * The company's own MSG91 account for SMS to customers: the auth key (stored encrypted, never
 * shown again; leave it empty to keep it), the 6-letter sender ID (DLT header), and the
 * DLT-approved templates it may send (MSG91's template id, the DLT id, and the approved text with
 * ##blanks##). Delivery reports and replies come back to the address shown here.
 * Runs after settings.js; one IIFE: no globals.
 */
(function settingsSms() {
  if (!isOrgManager()) return leaveManagerTab("sms");
  document.getElementById("smsTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  let current = null;
  let rows = [];
  let loaded = false;

  function templateRow(row, i) {
    return `<div class="sms-tpl" data-row="${i}">
      <div class="sms-tpl-grid">
        <div class="field"><label>${escapeHtml(t("smsset.tplName"))}</label><input type="text" data-f="name" maxlength="80" value="${escapeHtml(row.name || "")}" /></div>
        <div class="field"><label>${escapeHtml(t("smsset.flowId"))}</label><input type="text" data-f="flowId" maxlength="64" value="${escapeHtml(row.flowId || "")}" /></div>
        <div class="field"><label>${escapeHtml(t("smsset.dltId"))}</label><input type="text" data-f="dltTemplateId" maxlength="40" inputmode="numeric" value="${escapeHtml(row.dltTemplateId || "")}" /></div>
      </div>
      <div class="field"><label>${escapeHtml(t("smsset.text"))}</label><textarea data-f="text" rows="2" maxlength="1000">${escapeHtml(row.text || "")}</textarea></div>
      <button type="button" class="link-btn" data-remove="${i}">${escapeHtml(t("smsset.removeTpl"))}</button>
    </div>`;
  }

  function render() {
    const c = current;
    const status = !c.connected ? t("smsset.notConnected") : c.status === "error" ? t("smsset.error", { why: c.lastError }) : t("smsset.connected", { provider: c.provider === "mock" ? t("tel.mock") : "MSG91", sender: c.senderId || "—" });
    $("smsBox").innerHTML = `
      <p class="settings-hint${c.status === "error" ? " ms-warn" : ""}">${escapeHtml(status)}</p>
      <form class="cf-form" id="smsForm" autocomplete="off">
        <div class="field"><label for="smsProvider">${escapeHtml(t("tel.provider"))}</label>
          <select id="smsProvider">${(c.providers || ["msg91"]).map((p) => `<option value="${p}" ${p === (c.provider || "msg91") ? "selected" : ""}>${escapeHtml(p === "mock" ? t("tel.mock") : "MSG91")}</option>`).join("")}</select></div>
        <div class="field sms-msg91"><label for="smsKey">${escapeHtml(t("smsset.authKey"))}</label><input type="password" id="smsKey" maxlength="200" autocomplete="new-password" placeholder="${escapeHtml(c.hasKey ? t("tel.keepSaved") : "")}" /></div>
        <div class="field"><label for="smsSender">${escapeHtml(t("smsset.sender"))}</label><input type="text" id="smsSender" maxlength="6" value="${escapeHtml(c.senderId || "")}" placeholder="YELLOW" /></div>
        <h4 class="sms-head">${escapeHtml(t("smsset.templates"))}</h4>
        <p class="settings-hint">${escapeHtml(t("smsset.templatesHint"))}</p>
        <div id="smsTemplates">${rows.map(templateRow).join("")}</div>
        <button type="button" class="btn btn-outline" data-sms="add"><i class="fa-solid fa-plus"></i> ${escapeHtml(t("smsset.addTpl"))}</button>
        ${c.connected ? `<p class="settings-hint">${escapeHtml(t("smsset.webhook"))}<br /><code class="sms-url">${escapeHtml(c.webhookUrl)}</code></p>` : ""}
        <div class="pl-buttons">
          <button class="btn btn-primary" type="submit">${escapeHtml(t(c.connected ? "tel.save" : "tel.connect"))}</button>
          ${c.connected ? `<button class="btn btn-outline" type="button" data-sms="test">${escapeHtml(t("tel.test"))}</button><button class="btn btn-danger-outline" type="button" data-sms="remove">${escapeHtml(t("tel.disconnect"))}</button>` : ""}
        </div>
      </form>`;
    $("smsBox").querySelector(".sms-msg91").hidden = $("smsProvider").value !== "msg91";
  }

  // Keeps typed values when rows are added or removed.
  function readRows() {
    rows = [...$("smsBox").querySelectorAll(".sms-tpl")].map((row, i) => ({
      key: rows[i]?.key || "",
      ...Object.fromEntries([...row.querySelectorAll("[data-f]")].map((el) => [el.dataset.f, el.value.trim()])),
    }));
  }

  async function load() {
    try {
      await crmI18n.ready;
      current = await crmApi("/sms/connection");
      rows = (current.templates || []).map((x) => ({ ...x }));
      if (!rows.length) rows = [{ name: "", flowId: "", dltTemplateId: "", text: "" }];
      render();
    } catch (error) {
      $("smsBox").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("smsset.loadFailed")))}</p>`;
    }
  }

  async function save(event) {
    event.preventDefault();
    readRows();
    const provider = $("smsProvider").value;
    const templates = rows.filter((r) => r.name || r.text);
    if (templates.some((r) => !r.name || !r.text || (provider === "msg91" && !r.flowId))) {
      showToast(t("smsset.fillTemplates"), "error");
      return;
    }
    if (provider === "msg91" && !current.hasKey && !$("smsKey").value.trim()) {
      showToast(t("smsset.needKey"), "error");
      return;
    }
    try {
      current = await crmApi("/sms/connection", jsonRequest("PUT", { provider, authKey: $("smsKey").value.trim(), senderId: $("smsSender").value.trim(), templates }));
      rows = current.templates.map((x) => ({ ...x }));
      showToast(t("smsset.saved"), "success");
      render();
    } catch (error) {
      showToast(apiErrorMessage(error, t("smsset.saveFailed")), "error");
    }
  }

  async function onClick(event) {
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      readRows();
      rows.splice(Number(remove.dataset.remove), 1);
      render();
      return;
    }
    const button = event.target.closest("[data-sms]");
    if (!button) return;
    if (button.dataset.sms === "add") {
      readRows();
      rows.push({ name: "", flowId: "", dltTemplateId: "", text: "" });
      render();
      $("smsBox").querySelector(`.sms-tpl[data-row="${rows.length - 1}"] input`)?.focus();
      return;
    }
    if (button.dataset.sms === "remove" && !confirm(t("smsset.disconnectConfirm"))) return;
    button.disabled = true;
    try {
      if (button.dataset.sms === "test") {
        const result = await crmApi("/sms/connection/test", { method: "POST" });
        showToast(result.ok ? t("tel.testOk") : t("tel.testFailed", { why: result.error }), result.ok ? "success" : "error");
      } else {
        await crmApi("/sms/connection", { method: "DELETE" });
        showToast(t("smsset.disconnected"), "success");
      }
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, t("smsset.saveFailed")), "error");
    } finally {
      button.disabled = false;
    }
  }

  $("smsBox").addEventListener("submit", save);
  $("smsBox").addEventListener("click", onClick);
  $("smsBox").addEventListener("change", (event) => {
    if (event.target.id === "smsProvider") $("smsBox").querySelector(".sms-msg91").hidden = event.target.value !== "msg91";
  });
  function loadOnce() {
    if (loaded) return;
    loaded = true;
    load();
  }
  document.querySelector('.settings-tab[data-panel="sms"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="sms"]').classList.contains("active")) loadOnce();
  return undefined;
})();
