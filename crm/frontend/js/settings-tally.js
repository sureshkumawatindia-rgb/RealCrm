/**
 * settings-tally.js — Settings → Billing → Tally (G5, D109, owners and admins)
 * The tax invoices, credit notes and receipts of a period as two files Tally imports (/tally):
 * first the ledgers (Import → Masters), then the vouchers (Import → Transactions). The ledger
 * names are kept as in the company's Tally, with one sales ledger per GST rate if it wants.
 * One IIFE: no globals.
 */
(function settingsTally() {
  const box = document.getElementById("tallyBox");
  if (!box || !isOrgManager()) return;
  const $ = (id) => document.getElementById(id);
  const LEDGERS = ["sales", "cgst", "sgst", "igst", "roundOff", "bank", "cash", "gateway"];
  let data = null;
  let seq = 0;

  const rupees = (paise) => `₹${(paise / 100).toLocaleString(crmI18n.locale(), { maximumFractionDigits: 2 })}`;
  // The first day of this month and today, in India.
  const indiaToday = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
  const range = () => ({ from: $("tallyFrom").value, to: $("tallyTo").value });
  const query = ({ from, to }) => `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  function summaryText(s) {
    if (!s.invoices && !s.creditNotes && !s.receipts) return t("tally.empty");
    return t("tally.summary", {
      invoices: s.invoices, invoicesAmount: rupees(s.invoicesPaise),
      creditNotes: s.creditNotes, creditNotesAmount: rupees(s.creditNotesPaise),
      receipts: s.receipts, receiptsAmount: rupees(s.receiptsPaise),
      parties: s.parties,
    });
  }

  function render() {
    const today = indiaToday();
    box.innerHTML = `
      <p class="settings-hint">${escapeHtml(t("tally.hint"))}</p>
      <div class="field-row tally-range">
        <div class="field"><label for="tallyFrom">${escapeHtml(t("tally.from"))}</label><input type="date" id="tallyFrom" value="${today.slice(0, 8)}01" max="${today}" /></div>
        <div class="field"><label for="tallyTo">${escapeHtml(t("tally.to"))}</label><input type="date" id="tallyTo" value="${today}" max="${today}" /></div>
      </div>
      <p class="tally-summary" id="tallySummary" role="status"></p>
      <div class="tally-steps">
        <div class="tally-step"><p>${escapeHtml(t("tally.step1"))}</p><button class="btn btn-outline" type="button" data-tally="ledgers"><i class="fa-solid fa-users" aria-hidden="true"></i> ${escapeHtml(t("tally.downloadLedgers"))}</button></div>
        <div class="tally-step"><p>${escapeHtml(t("tally.step2"))}</p><button class="btn btn-primary" type="button" data-tally="vouchers"><i class="fa-solid fa-file-invoice" aria-hidden="true"></i> ${escapeHtml(t("tally.downloadVouchers"))}</button></div>
      </div>
      <p class="settings-hint">${escapeHtml(t("tally.creditNoteHint"))}</p>
      <details class="tally-ledgers">
        <summary>${escapeHtml(t("tally.ledgersTitle"))}</summary>
        <form id="tallyForm" autocomplete="off">
          <p class="settings-hint">${escapeHtml(t("tally.ledgersHint"))}</p>
          <div class="field-row">${LEDGERS.map((key) => `<div class="field"><label for="tallyL-${key}">${escapeHtml(t(`tally.l.${key}`))}</label><input type="text" id="tallyL-${key}" data-ledger="${key}" maxlength="100" value="${escapeHtml(data.ledgers[key])}" placeholder="${escapeHtml(data.defaults[key])}" /></div>`).join("")}</div>
          <label class="ls-check"><input type="checkbox" id="tallySplit" ${data.splitByRate ? "checked" : ""} /> ${escapeHtml(t("tally.split"))}</label>
          <div class="data-actions"><button class="btn btn-primary" type="submit">${escapeHtml(t("tally.save"))}</button></div>
        </form>
      </details>`;
  }

  async function loadSummary() {
    const mine = ++seq;
    const r = range();
    const el = $("tallySummary");
    if (!r.from || !r.to || r.from > r.to) {
      el.textContent = t("tally.err.range");
      return;
    }
    try {
      const fresh = await crmApi(`/tally?${query(r)}`);
      if (mine === seq) el.textContent = summaryText(fresh.summary);
    } catch (error) {
      if (mine === seq) el.textContent = apiErrorMessage(error, t("tally.err.load"));
    }
  }

  async function load() {
    try {
      const today = indiaToday();
      data = await crmApi(`/tally?${query({ from: `${today.slice(0, 8)}01`, to: today })}`);
      render();
      $("tallySummary").textContent = summaryText(data.summary);
    } catch (error) {
      box.innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("tally.err.load")))}</p>`;
    }
  }

  box.addEventListener("change", (event) => {
    if (event.target.id === "tallyFrom" || event.target.id === "tallyTo") loadSummary();
  });

  box.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-tally]");
    if (!button) return;
    const r = range();
    if (!r.from || !r.to || r.from > r.to) {
      showToast(t("tally.err.range"), "error");
      return;
    }
    const part = button.dataset.tally;
    button.disabled = true;
    try {
      await crmDownload(`/tally/export?${query(r)}&part=${part}`, `tally-${part}-${r.from}-to-${r.to}.xml`);
      showToast(t("tally.downloaded"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("tally.err.download")), "error");
    }
    button.disabled = false;
  });

  box.addEventListener("submit", async (event) => {
    if (event.target.id !== "tallyForm") return;
    event.preventDefault();
    const ledgers = {};
    for (const input of box.querySelectorAll("[data-ledger]")) {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        showToast(t("tally.err.empty"), "error");
        return;
      }
      ledgers[input.dataset.ledger] = name;
    }
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const saved = await crmApi("/tally", jsonRequest("PATCH", { ledgers, splitByRate: $("tallySplit").checked }));
      data = { ...data, ...saved };
      showToast(t("tally.saved"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("tally.err.save")), "error");
    }
    button.disabled = false;
  });

  // Loaded the first time the tab opens (or now, when the page opens on it).
  let loaded = false;
  const loadOnce = () => {
    if (loaded) return;
    loaded = true;
    load();
  };
  document.querySelector('.settings-tab[data-panel="billing"]')?.addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="billing"]')?.classList.contains("active")) crmI18n.ready.then(loadOnce);
})();
