/**
 * settings-google.js — Settings → My profile → Google (Phase 9, D90)
 * Each member connects their own Google account: Gmail (read-only: the emails with the company's
 * customers show on their history), and if they choose, Calendar (their CRM meetings in Google
 * Calendar) and Drive (Google Docs and Sheets made for customers and deals). Sync now, whether
 * the team sees the synced emails, reconnect (also to add a feature) and disconnect. Tokens never
 * reach this page. One IIFE: no globals.
 */
(function settingsGoogle() {
  const $ = (id) => document.getElementById(id);
  let current = null;

  const ago = (iso) => {
    if (!iso) return t("goog.never");
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return t("bell.justNow");
    if (minutes < 60) return t("bell.minutesAgo", { n: minutes });
    if (minutes < 24 * 60) return t("bell.hoursAgo", { n: Math.round(minutes / 60) });
    return new Date(iso).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short" });
  };
  const featureBoxes = (have = {}) => ["calendar", "drive"].map((f) => `
    <label class="goog-feature"><input type="checkbox" data-feature="${f}" ${have[f] ? "checked disabled" : ""} />
      <span><strong>${escapeHtml(t(`goog.f.${f}`))}</strong><small>${escapeHtml(t(`goog.f.${f}.hint`))}</small></span></label>`).join("");

  function render() {
    const c = current;
    const card = $("googleCard");
    if (!c.connected) {
      if (c.mode === "off") {
        card.innerHTML = `<p class="settings-hint">${escapeHtml(t("goog.off"))}</p>`;
        return;
      }
      card.innerHTML = `
        <p class="settings-hint">${escapeHtml(t(c.elsewhere ? "goog.elsewhere" : "goog.intro"))}</p>
        <div class="goog-features">${featureBoxes()}</div>
        <div class="pl-buttons"><button class="btn btn-primary" type="button" data-g="connect"><i class="fa-brands fa-google"></i> ${escapeHtml(t("goog.connect"))}</button></div>
        ${c.mode === "mock" ? `<p class="settings-hint">${escapeHtml(t("goog.mock"))}</p>` : ""}`;
      return;
    }
    const stuck = c.status === "needs_reconnect";
    const missing = !c.features.calendar || !c.features.drive;
    card.innerHTML = `
      <p class="settings-hint${stuck ? " ms-warn" : ""}">${escapeHtml(stuck ? t("goog.reconnectNeeded", { email: c.emailAddress }) : t("goog.connected", { email: c.emailAddress }))}</p>
      <p class="settings-hint">${escapeHtml(t("goog.lastSync", { when: ago(c.lastSyncAt), n: c.lastSyncCount }))}${c.lastError && !stuck ? ` · ${escapeHtml(c.lastError)}` : ""}</p>
      <div class="goog-chips">${["gmail", "calendar", "drive"].map((f) => `<span class="badge ${c.features[f] ? "badge-success" : "badge-neutral"}">${escapeHtml(t(`goog.f.${f}`))}</span>`).join("")}</div>
      <label class="goog-share"><input type="checkbox" data-g="share" ${c.shareEmails ? "checked" : ""} /> ${escapeHtml(t("goog.share"))}</label>
      ${missing || stuck ? `<div class="goog-features">${featureBoxes(c.features)}</div>` : ""}
      <div class="pl-buttons">
        ${stuck ? "" : `<button class="btn btn-outline" type="button" data-g="sync"><i class="fa-solid fa-rotate"></i> ${escapeHtml(t("goog.syncNow"))}</button>`}
        ${missing || stuck ? `<button class="btn btn-${stuck ? "primary" : "outline"}" type="button" data-g="connect"><i class="fa-brands fa-google"></i> ${escapeHtml(t(stuck ? "goog.reconnect" : "goog.addFeatures"))}</button>` : ""}
        <button class="btn btn-danger-outline" type="button" data-g="disconnect">${escapeHtml(t("goog.disconnect"))}</button>
      </div>`;
  }

  async function load() {
    try {
      await crmI18n.ready;
      current = await crmApi("/gmail/connection");
      render();
    } catch (error) {
      $("googleCard").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("goog.loadFailed")))}</p>`;
    }
  }

  async function onClick(event) {
    const button = event.target.closest("button[data-g]");
    if (!button) return;
    const action = button.dataset.g;
    if (action === "disconnect" && !confirm(t("goog.disconnectConfirm"))) return;
    button.disabled = true;
    try {
      if (action === "connect") {
        const features = [...$("googleCard").querySelectorAll("[data-feature]:checked")].map((i) => i.dataset.feature);
        const result = await crmApi("/gmail/connect", jsonRequest("POST", { features, returnUrl: window.location.href }));
        window.location.assign(result.authorizationUrl);
        return;
      }
      if (action === "sync") {
        const result = await crmApi("/gmail/sync", jsonRequest("POST", {}));
        showToast(result.skipped ? t("goog.syncedRecently") : t("goog.synced", { n: result.stored }), "success");
      } else if (action === "disconnect") {
        await crmApi("/gmail/connection", { method: "DELETE" });
        showToast(t("goog.disconnected"), "success");
      }
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, t("goog.failed")), "error");
      await load();
    } finally {
      button.disabled = false;
    }
  }

  async function onChange(event) {
    if (event.target.dataset.g !== "share") return;
    try {
      current = { ...current, ...(await crmApi("/gmail/connection", jsonRequest("PATCH", { shareEmails: event.target.checked }))) };
      showToast(t(event.target.checked ? "goog.sharedOn" : "goog.sharedOff"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("goog.failed")), "error");
      event.target.checked = !event.target.checked;
    }
  }

  // Back from Google: say how it went, and tidy the address.
  function showCallbackResult() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("gmail");
    if (!result) return;
    if (result === "connected") showToast(t("goog.connectedToast", { email: params.get("email") || "" }), "success");
    else showToast(t("goog.callbackFailed", { reason: params.get("reason") || "" }), "error");
    ["gmail", "email", "reason"].forEach((key) => params.delete(key));
    history.replaceState(null, "", `${location.pathname}${params.toString() ? `?${params}` : ""}`);
  }

  if (!$("googleCard")) return;
  $("googleCard").addEventListener("click", onClick);
  $("googleCard").addEventListener("change", onChange);
  crmI18n.ready.then(showCallbackResult);
  load();
})();
