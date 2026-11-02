/**
 * settings-sheets.js — Settings → API & webhooks → Google Sheets (G4, D108, owners and admins)
 * The company's new leads or new orders go to the end of a Google Sheet by themselves, within about
 * 2 minutes (/sheet-syncs). The sheet is made in the Google Drive of the person who switches it on,
 * through their own Google connection with Drive (Your Profile → Google). Each sheet shows whether
 * it is on, how many rows went and the last one, and why it paused; Resume carries on in the same
 * sheet, Stop leaves the sheet in that Drive. One IIFE: no globals.
 */
(function settingsSheets() {
  const box = document.getElementById("sheetsBox");
  if (!box || !isOrgManager()) return;
  const KINDS = ["leads", "orders"];
  let data = null;

  const when = (iso) => new Date(iso).toLocaleString(crmI18n.locale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const ready = () => data.google.available && data.google.connected && data.google.drive && !data.google.needsReconnect;
  const safeUrl = (url) => (/^https:\/\//.test(url || "") ? url : "#");

  // The asking person's own Google: new sheets are made in their Drive.
  function googleLine(google) {
    if (!google.available) return `<p class="settings-hint">${escapeHtml(t("gs.google.off"))}</p>`;
    if (ready()) return `<p class="settings-hint"><i class="fa-brands fa-google-drive" aria-hidden="true"></i> ${escapeHtml(t("gs.google.ready", { email: google.email }))}</p>`;
    const key = !google.connected ? "gs.google.none" : google.needsReconnect ? "gs.google.reconnect" : "gs.google.noDrive";
    return `<div class="gs-need"><p class="settings-hint">${escapeHtml(t(key))}</p><a class="btn btn-outline" href="Settings.html?tab=profile">${escapeHtml(t("gs.google.open"))}</a></div>`;
  }

  function cardHtml(kind) {
    const sheet = data.sheets[kind];
    const name = escapeHtml(t(`gs.kind.${kind}`));
    if (!sheet) {
      return `<div class="gs-card" data-kind="${kind}">
        <div class="gs-main">
          <div class="gs-name"><strong>${name}</strong><span class="badge badge-neutral">${escapeHtml(t("gs.off"))}</span></div>
          <p class="settings-hint">${escapeHtml(t(`gs.what.${kind}`))}</p>
          ${ready() ? `<label class="gs-backfill"><input type="checkbox" data-backfill /> ${escapeHtml(t(`gs.backfill.${kind}`))}</label>` : ""}
        </div>
        ${ready() ? `<div class="gs-actions"><button class="btn btn-primary" type="button" data-gs="start"><i class="fa-solid fa-table" aria-hidden="true"></i> ${escapeHtml(t("gs.start"))}</button></div>` : ""}
      </div>`;
    }
    const paused = sheet.status === "paused";
    const by = sheet.startedBy || {};
    // While paused nothing new arrives, so "no rows yet" is said only of a sheet that is on.
    const rows = sheet.rowsAdded
      ? t("gs.rows", { n: sheet.rowsAdded.toLocaleString(crmI18n.locale()), time: sheet.lastRowAt ? when(sheet.lastRowAt) : "—" })
      : paused ? "" : t("gs.noRows");
    return `<div class="gs-card${paused ? " gs-paused" : ""}" data-kind="${kind}">
      <div class="gs-main">
        <div class="gs-name"><strong>${name}</strong><span class="badge ${paused ? "badge-warning" : "badge-success"}">${escapeHtml(t(paused ? "gs.pausedBadge" : "gs.on"))}</span></div>
        <div class="gs-title"><i class="fa-solid fa-table" aria-hidden="true"></i> ${escapeHtml(sheet.title)}</div>
        <p class="settings-hint">${escapeHtml(t("gs.where", { email: by.googleEmail || "", name: by.name || by.googleEmail || "" }))}</p>
        ${rows ? `<p class="settings-hint">${escapeHtml(rows)}</p>` : ""}
        ${paused ? `<p class="gs-warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(t(`gs.paused.${sheet.pausedReason}`, { email: by.googleEmail || "" }))}</p>` : ""}
        ${!paused && sheet.lastError ? `<p class="gs-warn">${escapeHtml(t("gs.lastError", { error: sheet.lastError }))}</p>` : ""}
      </div>
      <div class="gs-actions">
        <a class="btn btn-outline" href="${escapeHtml(safeUrl(sheet.url))}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> ${escapeHtml(t("gs.open"))}</a>
        ${paused ? `<button class="btn btn-primary" type="button" data-gs="resume">${escapeHtml(t("gs.resume"))}</button>` : ""}
        <button class="btn btn-danger-outline" type="button" data-gs="stop">${escapeHtml(t("gs.stop"))}</button>
      </div>
    </div>`;
  }

  function render() {
    box.innerHTML = `<p class="settings-hint">${escapeHtml(t("gs.hint"))}</p>
      ${googleLine(data.google)}
      <div class="gs-list">${KINDS.map(cardHtml).join("")}</div>`;
  }

  async function load() {
    try {
      data = await crmApi("/sheet-syncs");
      render();
    } catch (error) {
      box.innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("gs.loadFailed")))}</p>`;
    }
  }

  box.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-gs]");
    if (!button) return;
    const card = button.closest("[data-kind]");
    const kind = card.dataset.kind;
    const action = button.dataset.gs;
    if (action === "stop" && !confirm(t("gs.stopConfirm"))) return;
    button.disabled = true;
    try {
      if (action === "start") {
        const sheet = await crmApi("/sheet-syncs", jsonRequest("POST", { kind, backfillDays: card.querySelector("[data-backfill]")?.checked ? 30 : 0 }));
        showToast(t("gs.started", { title: sheet.title }), "success");
      } else if (action === "resume") {
        await crmApi(`/sheet-syncs/${kind}/resume`, { method: "POST" });
        showToast(t("gs.resumed"), "success");
      } else if (action === "stop") {
        await crmApi(`/sheet-syncs/${kind}`, { method: "DELETE" });
        showToast(t("gs.stopped"), "success");
      }
    } catch (error) {
      showToast(apiErrorMessage(error, t("gs.failed")), "error");
    }
    button.disabled = false;
    await load();
  });

  // Loaded the first time the tab opens (or now, when the page opens on it).
  let loaded = false;
  const loadOnce = () => {
    if (loaded) return;
    loaded = true;
    load();
  };
  document.querySelector('.settings-tab[data-panel="integrations"]')?.addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="integrations"]')?.classList.contains("active")) crmI18n.ready.then(loadOnce);
})();
