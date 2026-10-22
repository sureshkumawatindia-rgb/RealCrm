/**
 * settings-microsoft.js — Microsoft 365 (Phase 4B, D83)
 * My profile: each member connects their own Microsoft 365 (their CRM meetings go to their
 * Outlook calendar, and meetings can get a Teams link). API & webhooks (owners and admins):
 * Teams channel notes from a Teams "Workflows" address. The server checks everything; tokens and
 * the Teams address's secret never reach this page. One IIFE: no globals.
 */
(function settingsMicrosoft() {
  const $ = (id) => document.getElementById(id);
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short", year: "numeric" }) : "");

  // --- My profile ------------------------------------------------------------------------------
  async function loadProfile() {
    const section = $("msSection");
    if (!section) return;
    let data;
    try {
      await crmI18n.ready;
      data = await crmApi("/integrations/microsoft");
    } catch {
      return; // the card is a convenience
    }
    if (data.mode === "off" && !data.connection) return; // not set up on this CRM
    section.hidden = false;
    const c = data.connection;
    const status = !c ? t("ms.notConnected") : c.status === "needs_reconnect" ? t("ms.reconnect", { email: c.email }) : t("ms.connected", { email: c.email, date: day(c.calendarSyncFrom) });
    const buttons = [
      !c || c.status !== "active" ? `<button class="btn btn-outline" type="button" data-ms="connect"><i class="fa-brands fa-microsoft"></i> ${escapeHtml(t(c ? "ms.reconnectBtn" : "ms.connectBtn"))}</button>` : "",
      c ? `<button class="btn btn-danger-outline" type="button" data-ms="disconnect">${escapeHtml(t("ms.disconnect"))}</button>` : "",
    ].join("");
    $("msCard").innerHTML = `
      <div class="ms-row">
        <div><strong>Outlook &amp; Teams</strong><p class="settings-hint${c?.status === "needs_reconnect" ? " ms-warn" : ""}">${escapeHtml(status)}</p></div>
        <div class="pl-buttons">${buttons}</div>
      </div>
      <p class="settings-hint">${escapeHtml(t("ms.what"))}</p>
      ${data.mode === "mock" ? `<p class="settings-hint">${escapeHtml(t("ms.mock"))}</p>` : ""}`;
  }

  async function onProfileClick(event) {
    const button = event.target.closest("[data-ms]");
    if (!button) return;
    button.disabled = true;
    try {
      if (button.dataset.ms === "connect") {
        const { authorizationUrl } = await crmApi("/integrations/microsoft/connect", { method: "POST" });
        window.location.href = authorizationUrl;
        return;
      }
      if (!confirm(t("ms.disconnectConfirm"))) return;
      await crmApi("/integrations/microsoft", { method: "DELETE" });
      showToast(t("ms.disconnected"), "success");
      await loadProfile();
    } catch (error) {
      showToast(apiErrorMessage(error, t("ms.failed")), "error");
    } finally {
      button.disabled = false;
    }
  }

  // Back from Microsoft's sign-in page.
  function afterSignIn() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("microsoft");
    if (!result) return;
    crmI18n.ready.then(() => showToast(result === "connected" ? t("ms.done") : t("ms.error", { reason: params.get("reason") || "" }), result === "connected" ? "success" : "error"));
    params.delete("microsoft");
    params.delete("reason");
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
  }

  // --- Teams channels (owners and admins) ---------------------------------------------------------
  let events = [];
  function channelHtml(channel) {
    const state = !channel.active ? (channel.disabledReason ? "attention" : "off") : channel.lastStatus === "failed" ? "attention" : "working";
    const badge = { working: "badge-success", attention: "badge-warning", off: "badge-neutral" }[state];
    const problem = !channel.active ? channel.disabledReason : channel.lastStatus === "failed" ? channel.lastError : "";
    return `<div class="teams-channel" data-id="${escapeHtml(channel.id)}">
      <div class="teams-channel-main">
        <strong>${escapeHtml(channel.name)}</strong> <span class="badge ${badge}">${escapeHtml(t(`conn.state.${state}`))}</span>
        <div class="settings-hint">${escapeHtml(channel.urlHint)}</div>
        <div class="teams-events">${channel.events.map((key) => `<span class="badge badge-neutral">${escapeHtml(t(`teams.ev.${key}`))}</span>`).join("")}</div>
        ${problem ? `<div class="conn-problem"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(problem)}</div>` : ""}
      </div>
      <div class="pl-buttons">
        <button class="btn btn-outline" type="button" data-teams="test">${escapeHtml(t("teams.test"))}</button>
        <button class="btn btn-outline" type="button" data-teams="${channel.active ? "off" : "on"}">${escapeHtml(t(channel.active ? "teams.switchOff" : "teams.switchOn"))}</button>
        <button class="btn btn-danger-outline" type="button" data-teams="remove">${escapeHtml(t("teams.remove"))}</button>
      </div>
    </div>`;
  }

  function formHtml() {
    return `<form class="wa-block" id="teamsForm" autocomplete="off" hidden>
      <div class="field"><label for="teamsName">${escapeHtml(t("teams.name"))}</label><input type="text" id="teamsName" maxlength="100" placeholder="${escapeHtml(t("teams.namePh"))}" required /></div>
      <div class="field"><label for="teamsUrl">${escapeHtml(t("teams.url"))}</label><input type="url" id="teamsUrl" maxlength="2000" placeholder="https://….logic.azure.com/workflows/…" required /></div>
      <div class="field"><label>${escapeHtml(t("teams.events"))}</label><div class="teams-checks">${events.map((e) => `<label class="checkbox-row"><input type="checkbox" value="${escapeHtml(e.key)}" ${["lead.won", "ticket.created"].includes(e.key) ? "checked" : ""} /> ${escapeHtml(t(`teams.ev.${e.key}`))}</label>`).join("")}</div></div>
      <div class="pl-buttons"><button class="btn btn-primary" type="submit">${escapeHtml(t("teams.save"))}</button><button class="btn btn-outline" type="button" data-teams="cancel">${escapeHtml(t("teams.cancel"))}</button></div>
    </form>`;
  }

  async function loadTeams() {
    const box = $("teamsChannels");
    if (!box || !isOrgManager()) return;
    try {
      await crmI18n.ready;
      const data = await crmApi("/integrations/teams-channels");
      events = data.events;
      box.innerHTML = `
        <p class="settings-hint">${escapeHtml(t("teams.hint"))}</p>
        <ol class="teams-steps"><li>${escapeHtml(t("teams.step.1"))}</li><li>${escapeHtml(t("teams.step.2"))}</li><li>${escapeHtml(t("teams.step.3"))}</li></ol>
        <div id="teamsList">${data.items.length ? data.items.map(channelHtml).join("") : `<p class="settings-hint">${escapeHtml(t("teams.none"))}</p>`}</div>
        <button class="btn btn-outline" type="button" data-teams="new"><i class="fa-solid fa-plus"></i> ${escapeHtml(t("teams.add"))}</button>
        ${formHtml()}`;
    } catch (error) {
      box.innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("teams.loadFailed")))}</p>`;
    }
  }

  async function onTeamsClick(event) {
    const button = event.target.closest("[data-teams]");
    if (!button) return;
    const action = button.dataset.teams;
    const form = $("teamsForm");
    if (action === "new") {
      form.hidden = false;
      $("teamsName").focus();
      return;
    }
    if (action === "cancel") {
      form.hidden = true;
      return;
    }
    const id = button.closest("[data-id]")?.dataset.id;
    if (!id) return;
    if (action === "remove" && !confirm(t("teams.removeConfirm"))) return;
    button.disabled = true;
    try {
      if (action === "test") {
        const result = await crmApi(`/integrations/teams-channels/${id}/test`, { method: "POST" });
        showToast(result.sent ? t("teams.testSent") : t("teams.testFailed", { why: result.error || result.status || "" }), result.sent ? "success" : "error");
      } else if (action === "remove") {
        await crmApi(`/integrations/teams-channels/${id}`, { method: "DELETE" });
      } else {
        await crmApi(`/integrations/teams-channels/${id}`, jsonRequest("PATCH", { active: action === "on" }));
      }
      await loadTeams();
    } catch (error) {
      showToast(apiErrorMessage(error, t("teams.failed")), "error");
    } finally {
      button.disabled = false;
    }
  }

  async function onTeamsSubmit(event) {
    if (event.target.id !== "teamsForm") return;
    event.preventDefault();
    const chosen = [...event.target.querySelectorAll("input[type=checkbox]:checked")].map((box) => box.value);
    if (!chosen.length) return showToast(t("teams.pickEvent"), "error");
    try {
      await crmApi("/integrations/teams-channels", jsonRequest("POST", { name: $("teamsName").value.trim(), url: $("teamsUrl").value.trim(), events: chosen }));
      showToast(t("teams.added"), "success");
      await loadTeams();
    } catch (error) {
      showToast(apiErrorMessage(error, t("teams.failed")), "error");
    }
    return undefined;
  }

  $("msCard")?.addEventListener("click", onProfileClick);
  $("teamsChannels")?.addEventListener("click", onTeamsClick);
  $("teamsChannels")?.addEventListener("submit", onTeamsSubmit);
  afterSignIn();
  loadProfile();
  let teamsLoaded = false;
  const loadTeamsOnce = () => {
    if (teamsLoaded) return;
    teamsLoaded = true;
    loadTeams();
  };
  document.querySelector('.settings-tab[data-panel="integrations"]')?.addEventListener("click", loadTeamsOnce);
  if (document.querySelector('[data-settings-panel="integrations"]')?.classList.contains("active")) loadTeamsOnce();
})();
