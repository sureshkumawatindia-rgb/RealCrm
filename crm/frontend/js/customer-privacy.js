/**
 * customer-privacy.js — a customer's own data on their request (Phase 8, D120; India's DPDP Act
 * 2023): "Download their data" gives a file to send them, "Erase their data" removes it for good.
 * Used on Customer 360 and in Settings → Data & Privacy (deleted customers too). Owners and
 * admins, or owners only as the company chose (the server checks). Loads after app.js.
 *   crmCustomerPrivacy.download({ id, name })
 *   crmCustomerPrivacy.erase({ id, name }, { onErased(result) })
 *   crmCustomerPrivacy.erasedHtml({ erasedAt, keptUntil }) — the note for an erased customer
 */
const crmCustomerPrivacy = (() => {
  const $p = (id) => document.getElementById(id);
  // Today in India, as the date fields want it.
  const today = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short", year: "numeric" }) : "");
  const rupees = (paise) => `₹${(Math.round(Number(paise) || 0) / 100).toLocaleString(crmI18n.locale(), { maximumFractionDigits: 0 })}`;
  let overlay = null;
  let returnFocus = null;
  let onClose = null;

  function ensure() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "privOverlay";
    overlay.innerHTML = `
      <div class="modal priv-modal" role="dialog" aria-modal="true" aria-labelledby="privTitle">
        <div class="modal-head">
          <h3 id="privTitle"></h3>
          <button class="icon-btn" id="privClose" type="button" aria-label="${escapeHtml(t("common.close"))}"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="modal-body" id="privBody"></div>
        <div class="modal-foot" id="privFoot"></div>
      </div>`;
    document.body.appendChild(overlay);
    $p("privClose").addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && overlay.classList.contains("open")) close();
    });
  }

  function open(title, bodyHtml, footHtml) {
    ensure();
    returnFocus = document.activeElement;
    $p("privTitle").textContent = title;
    $p("privBody").innerHTML = bodyHtml;
    $p("privFoot").innerHTML = footHtml;
    overlay.classList.add("open");
    $p("privClose").focus();
  }
  function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    onClose = null;
    if (returnFocus?.focus) returnFocus.focus();
  }
  const askedField = () => `
    <div class="field">
      <label for="privAsked">${escapeHtml(t("priv.askedOn"))}</label>
      <input type="date" id="privAsked" value="${today()}" max="${today()}" />
      <small class="priv-hint">${escapeHtml(t("priv.askedHint"))}</small>
    </div>`;
  const errorBox = () => `<p class="priv-error" id="privError" role="alert" hidden></p>`;
  function showError(error, fallbackKey) {
    const box = $p("privError");
    if (!box) return;
    const field = error?.code === "VALIDATION_ERROR" ? error.errors?.[0]?.field : "";
    box.textContent = error?.status === 403 ? t("priv.err.notAllowed")
      : field === "askedAt" ? t("priv.err.askedFuture")
        : field === "confirmName" ? t("priv.err.name")
          : apiErrorMessage(error, t(fallbackKey));
    box.hidden = false;
  }
  // The day asked: today or before (some browsers let a later day be typed).
  function askedOk() {
    const value = $p("privAsked")?.value || "";
    if (value && value > today()) {
      showError({ code: "VALIDATION_ERROR", errors: [{ field: "askedAt" }] });
      return false;
    }
    return true;
  }

  // --- a copy of the customer's data ---------------------------------------------------------
  function download(customer) {
    open(t("priv.dl.title"), `
      <p class="priv-lead">${escapeHtml(t("priv.dl.text", { name: customer.name }))}</p>
      ${askedField()}
      <fieldset class="priv-choices">
        <legend>${escapeHtml(t("priv.dl.format"))}</legend>
        <label class="priv-choice"><input type="radio" name="privFormat" value="html" checked />
          <span><strong>${escapeHtml(t("priv.dl.html"))}</strong><small>${escapeHtml(t("priv.dl.htmlHint"))}</small></span></label>
        <label class="priv-choice"><input type="radio" name="privFormat" value="json" />
          <span><strong>${escapeHtml(t("priv.dl.json"))}</strong><small>${escapeHtml(t("priv.dl.jsonHint"))}</small></span></label>
      </fieldset>
      <p class="priv-note"><i class="fa-solid fa-clock"></i> ${escapeHtml(t("priv.dl.note"))}</p>
      ${errorBox()}`, `
      <button class="btn btn-outline" type="button" id="privCancel">${escapeHtml(t("common.cancel"))}</button>
      <button class="btn btn-primary" type="button" id="privGo"><i class="fa-solid fa-file-arrow-down"></i> ${escapeHtml(t("priv.dl.go"))}</button>`);
    $p("privCancel").addEventListener("click", close);
    $p("privGo").addEventListener("click", async () => {
      const button = $p("privGo");
      const format = document.querySelector('input[name="privFormat"]:checked')?.value || "html";
      if (!askedOk()) return;
      button.disabled = true;
      try {
        await crmDownload(`/contacts/${encodeURIComponent(customer.id)}/privacy/export`, `customer-data-${today()}.${format}`, jsonRequest("POST", { format, language: crmI18n.language(), askedAt: $p("privAsked").value || "" }));
        close();
        showToast(t("priv.dl.done"), "success");
        document.dispatchEvent(new CustomEvent("crm:privacy-request", { detail: { type: "access", id: customer.id } }));
      } catch (error) {
        showError(error, "priv.err.download");
        button.disabled = false;
      }
    });
  }

  // --- erasing ---------------------------------------------------------------------------------
  const DELETED = ["chats", "messages", "notes", "files", "sms", "emails", "consentEvents", "leadHistory", "openTasks", "comingMeetings", "scheduledMessages"];
  const ANONYMISED = ["leads", "quotations", "orders", "paymentLinks", "tickets", "doneTasks", "pastMeetings", "calls", "broadcasts", "adTouches", "sequences", "enquiries"];
  const KEPT = ["invoices", "receipts"];
  const lines = (counts, keys) => keys.filter((key) => counts?.[key]).map((key) => `<li><span>${escapeHtml(t(`priv.n.${key}`))}</span><strong>${escapeHtml(String(counts[key]))}</strong></li>`).join("");

  function previewHtml(customer, preview) {
    const { counts, warnings, keptUntil, linked } = preview;
    const warn = [
      warnings.openOrders ? t("priv.warn.orders", { n: warnings.openOrders }) : "",
      warnings.duePaise ? t("priv.warn.due", { amount: rupees(warnings.duePaise) }) : "",
      warnings.openLeads ? t("priv.warn.leads", { n: warnings.openLeads }) : "",
      warnings.openPaymentLinks ? t("priv.warn.links", { n: warnings.openPaymentLinks }) : "",
    ].filter(Boolean);
    const deleted = lines(counts.deleted, DELETED);
    const anonymised = lines(counts.anonymised, ANONYMISED);
    const kept = lines(counts.kept, KEPT);
    const linkedNames = [...(linked?.projects || []), ...(linked?.records || [])];
    return `
      <p class="priv-lead">${escapeHtml(t("priv.er.text", { name: customer.name }))}</p>
      ${preview.customer?.deleted ? `<p class="priv-note"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(t("priv.er.wasDeleted"))}</p>` : ""}
      ${warn.length ? `<div class="priv-warn" role="note"><strong><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(t("priv.warn.title"))}</strong><ul>${warn.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>` : ""}
      <div class="priv-groups">
        <section class="priv-group priv-group--gone">
          <h4><i class="fa-solid fa-trash"></i> ${escapeHtml(t("priv.er.deleted"))}</h4>
          ${deleted ? `<ul class="priv-counts">${deleted}</ul>` : `<p class="priv-hint">${escapeHtml(t("priv.er.nothing"))}</p>`}
        </section>
        <section class="priv-group">
          <h4><i class="fa-solid fa-user-secret"></i> ${escapeHtml(t("priv.er.anon"))}</h4>
          <p class="priv-hint">${escapeHtml(t("priv.er.anonHint"))}</p>
          ${anonymised ? `<ul class="priv-counts">${anonymised}</ul>` : `<p class="priv-hint">${escapeHtml(t("priv.er.nothing"))}</p>`}
        </section>
        ${kept ? `<section class="priv-group">
          <h4><i class="fa-solid fa-scale-balanced"></i> ${escapeHtml(t("priv.er.kept"))}</h4>
          <ul class="priv-counts">${kept}</ul>
          <p class="priv-hint">${escapeHtml(t("priv.er.keptHint", { date: day(keptUntil) }))}</p>
        </section>` : ""}
      </div>
      ${linkedNames.length ? `<p class="priv-note"><i class="fa-solid fa-link"></i> ${escapeHtml(t("priv.er.linked", { names: linkedNames.slice(0, 5).join(", ") }))}</p>` : ""}
      <div class="priv-outside">
        <strong>${escapeHtml(t("priv.er.outside"))}</strong>
        <p>${escapeHtml(t("priv.er.outsideText"))}</p>
      </div>
      ${askedField()}
      <div class="field">
        <label class="priv-confirm-label" for="privConfirm">${escapeHtml(t("priv.er.typeName", { name: customer.name }))}</label>
        <input type="text" id="privConfirm" autocomplete="off" maxlength="200" />
      </div>
      ${errorBox()}`;
  }

  async function erase(customer, { onErased } = {}) {
    open(t("priv.er.title"), `<p class="text-muted"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(t("cf.loading"))}</p>${errorBox()}`, `
      <button class="btn btn-outline" type="button" id="privCancel">${escapeHtml(t("common.cancel"))}</button>
      <button class="btn btn-danger-outline" type="button" id="privGo" disabled><i class="fa-solid fa-user-slash"></i> ${escapeHtml(t("priv.er.go"))}</button>`);
    $p("privCancel").addEventListener("click", close);
    const ticket = {};
    onClose = ticket;
    let preview;
    try {
      preview = await crmApi(`/contacts/${encodeURIComponent(customer.id)}/privacy/erase-preview`);
    } catch (error) {
      if (onClose !== ticket) return;
      showError(error, "priv.err.preview");
      return;
    }
    if (onClose !== ticket) return; // closed meanwhile
    const name = preview.customer?.name || customer.name;
    $p("privBody").innerHTML = previewHtml({ ...customer, name }, preview);
    const go = $p("privGo");
    const matches = () => $p("privConfirm").value.trim().toLowerCase() === String(name).trim().toLowerCase();
    $p("privConfirm").addEventListener("input", () => {
      go.disabled = !matches();
    });
    go.addEventListener("click", async () => {
      if (!matches() || !askedOk()) return;
      go.disabled = true;
      try {
        const result = await crmApi(`/contacts/${encodeURIComponent(customer.id)}/privacy/erase`, jsonRequest("POST", { confirmName: $p("privConfirm").value.trim(), askedAt: $p("privAsked").value || "", language: crmI18n.language() }));
        close();
        showToast(t("priv.er.done"), "success");
        document.dispatchEvent(new CustomEvent("crm:privacy-request", { detail: { type: "erasure", id: customer.id } }));
        if (onErased) onErased(result);
      } catch (error) {
        showError(error, "priv.err.erase");
        go.disabled = !matches();
      }
    });
  }

  // The note shown where an erased customer used to be.
  function erasedHtml({ erasedAt, keptUntil } = {}) {
    return `
      <div class="panel priv-erased">
        <i class="fa-solid fa-user-slash" aria-hidden="true"></i>
        <h3>${escapeHtml(t("priv.erased.title"))}</h3>
        <p>${escapeHtml(erasedAt ? t("priv.erased.on", { date: day(erasedAt) }) : t("priv.erased.text"))}</p>
        ${keptUntil ? `<p class="text-muted">${escapeHtml(t("priv.er.keptHint", { date: day(keptUntil) }))}</p>` : ""}
        <a class="btn btn-outline" href="customers.html"><i class="fa-solid fa-arrow-left"></i> ${escapeHtml(t("nav.customers"))}</a>
      </div>`;
  }

  return { download, erase, erasedHtml, close };
})();
