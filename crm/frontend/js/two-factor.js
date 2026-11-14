/**
 * two-factor.js — 2-step login with an authenticator app (F7).
 * Off: why, and "Turn on" → the QR code (or the key to type) → the first code → 10 backup codes
 * (copy or download; shown once). On: since when, backup codes left, new backup codes, and "Turn
 * off" for those who may (owners and admins keep it on). Owners and admins sent here because their
 * grace days are over (?required=1) see why.
 */
(function twoFactorPage() {
  const card = document.getElementById("tfaCard");
  const required = new URLSearchParams(location.search).get("required") === "1";
  const day = (iso) => new Date(iso).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "long", year: "numeric" });
  const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let status = null;

  const codeForm = (id, button) => `<form class="tfa-code" id="${id}" autocomplete="off">
      <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="9" required placeholder="${escapeHtml(t("tfa.codePlaceholder"))}" aria-label="${escapeHtml(t("tfa.codePlaceholder"))}" />
      <button class="btn btn-primary" type="submit">${escapeHtml(button)}</button>
    </form>`;

  function renderStatus() {
    const note = status.required && !status.enabled
      ? `<p class="tfa-note"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> ${escapeHtml(required || !status.requiredBy ? t("tfa.requiredNow") : t("tfa.banner", { date: day(status.requiredBy) }))}</p>` : "";
    if (!status.enabled) {
      card.innerHTML = `${note}
        <h3>${escapeHtml(t("tfa.offTitle"))}</h3>
        <p>${escapeHtml(t("tfa.offText"))}</p>
        <button class="btn btn-primary" type="button" data-action="setup"><i class="fa-solid fa-shield-halved"></i> ${escapeHtml(t("tfa.turnOn"))}</button>`;
      return;
    }
    card.innerHTML = `<h3><i class="fa-solid fa-circle-check tfa-on" aria-hidden="true"></i> ${escapeHtml(t("tfa.onTitle"))}</h3>
      <p>${escapeHtml(t("tfa.onSince", { date: day(status.enabledAt) }))} ${escapeHtml(t("tfa.onLeft", { n: status.backupCodesLeft }))}</p>
      <div class="tfa-actions">
        <button class="btn btn-outline" type="button" data-action="codes">${escapeHtml(t("tfa.newCodes"))}</button>
        ${status.required ? "" : `<button class="btn btn-danger-outline" type="button" data-action="off">${escapeHtml(t("tfa.turnOff"))}</button>`}
      </div>
      ${status.required ? `<p class="settings-hint">${escapeHtml(t("tfa.keepOn"))}</p>` : ""}
      <div id="tfaAsk"></div>`;
  }

  function renderSetup(setup) {
    card.innerHTML = `<h3>${escapeHtml(t("tfa.setupTitle"))}</h3>
      <ol class="tfa-steps">
        <li>${escapeHtml(t("tfa.step1"))}</li>
        <li>${escapeHtml(t("tfa.step2"))}
          <div class="tfa-qr"><img src="${escapeHtml(setup.qr)}" alt="${escapeHtml(t("tfa.qrAlt"))}" width="200" height="200" /></div>
          <p class="settings-hint">${escapeHtml(t("tfa.keyInstead"))} <code class="tfa-key">${escapeHtml(setup.secret)}</code></p>
        </li>
        <li>${escapeHtml(t("tfa.step3"))}${codeForm("tfaEnable", t("tfa.turnOn"))}</li>
      </ol>
      <button class="link-btn" type="button" data-action="cancel">${escapeHtml(t("common.cancel"))}</button>`;
    card.querySelector("#tfaEnable input").focus();
  }

  function renderCodes(codes, firstTime) {
    card.innerHTML = `<h3>${escapeHtml(t(firstTime ? "tfa.onTitle" : "tfa.newCodesTitle"))}</h3>
      <p>${escapeHtml(t("tfa.codesText"))}</p>
      <ul class="tfa-codes">${codes.map((code) => `<li><code>${escapeHtml(code)}</code></li>`).join("")}</ul>
      <div class="tfa-actions">
        <button class="btn btn-outline" type="button" data-action="copy"><i class="fa-regular fa-copy"></i> ${escapeHtml(t("tfa.copy"))}</button>
        <button class="btn btn-outline" type="button" data-action="download"><i class="fa-solid fa-download"></i> ${escapeHtml(t("tfa.download"))}</button>
        <button class="btn btn-primary" type="button" data-action="saved">${escapeHtml(t("tfa.saved"))}</button>
      </div>`;
    card.dataset.codes = codes.join("\n");
  }

  async function load() {
    status = await crmApi("/auth/totp");
    renderStatus();
  }

  card.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    try {
      if (action === "setup") renderSetup(await crmApi("/auth/totp/setup", { method: "POST" }));
      if (action === "cancel" || action === "saved") await load();
      if (action === "codes" || action === "off") {
        document.getElementById("tfaAsk").innerHTML = `<p class="settings-hint">${escapeHtml(t(action === "off" ? "tfa.askOff" : "tfa.askCodes"))}</p>${codeForm(action === "off" ? "tfaOff" : "tfaCodes", t(action === "off" ? "tfa.turnOff" : "tfa.newCodes"))}`;
        document.querySelector("#tfaAsk input").focus();
      }
      if (action === "copy") {
        await navigator.clipboard.writeText(card.dataset.codes);
        showToast(t("tfa.copied"), "success");
      }
      if (action === "download") {
        const text = `agreem360 — ${t("tfa.title")}\n${getCurrentUser()?.email || ""}\n\n${card.dataset.codes}\n`;
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
        link.download = "agreem360-backup-codes.txt";
        link.click();
        URL.revokeObjectURL(link.href);
      }
    } catch (error) {
      showToast(apiErrorMessage(error, t("tfa.failed")), "error");
    }
  });

  card.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const code = form.elements.code.value.trim();
    form.querySelector("button").disabled = true;
    try {
      if (form.id === "tfaEnable") {
        const on = await crmApi("/auth/totp/enable", json({ code }));
        showToast(t("tfa.turnedOn"), "success");
        renderCodes(on.backupCodes, true);
        return;
      }
      if (form.id === "tfaCodes") {
        renderCodes((await crmApi("/auth/totp/backup-codes", json({ code }))).backupCodes, false);
        return;
      }
      if (form.id === "tfaOff") {
        await crmApi("/auth/totp/disable", json({ code }));
        showToast(t("tfa.turnedOff"), "success");
        await load();
      }
    } catch (error) {
      form.querySelector("button").disabled = false;
      showToast(apiErrorMessage(error, t("tfa.failed")), "error");
      form.elements.code.select();
    }
  });

  crmI18n.ready.then(load).catch((error) => {
    card.innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("tfa.failed")))}</p>`;
  });
})();
