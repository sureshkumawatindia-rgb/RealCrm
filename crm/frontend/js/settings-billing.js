/**
 * settings-billing.js — Settings → Billing (owners and admins)
 * Bank details, UPI ID, standard terms, validity, round-off, number prefixes and the stock
 * option (/organization/billing). The GST state comes from the company profile.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsBilling() {
  if (!isOrgManager()) return leaveManagerTab("billing");
  document.getElementById("billingTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const PREFIX_FIELDS = { quotation: "billPreQ", estimate: "billPreE", proforma: "billPreP", order: "billPreO" };

  // "2026-27": the financial year runs April–March (India time).
  function financialYear() {
    const india = new Date(Date.now() + 330 * 60 * 1000);
    const start = india.getUTCMonth() >= 3 ? india.getUTCFullYear() : india.getUTCFullYear() - 1;
    return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  }
  function showExample() {
    const prefix = $("billPreQ").value.trim().toUpperCase() || "QT";
    $("billExample").textContent = `${prefix}/${financialYear()}/0001`;
  }

  function render(billing) {
    const from = billing.stateFrom === "gstin" ? `from your GSTIN ${billing.gstin}` : "from your company address";
    $("billGstState").innerHTML = billing.stateCode
      ? `Your state for GST is <strong>${escapeHtml(billing.state)} (${escapeHtml(billing.stateCode)})</strong>, ${escapeHtml(from)}. Customers in ${escapeHtml(billing.state)} pay CGST + SGST; customers elsewhere pay IGST. <a href="Settings.html?tab=company">Change it in Company</a>.`
      : 'Add your <strong>GSTIN</strong> (or at least your state) in <a href="Settings.html?tab=company">Company</a>, so quotations charge the right GST.';
    $("billAccName").value = billing.bank.accountName || "";
    $("billAccNo").value = billing.bank.accountNumber || "";
    $("billIfsc").value = billing.bank.ifsc || "";
    $("billBank").value = billing.bank.bankName || "";
    $("billBranch").value = billing.bank.branch || "";
    $("billUpi").value = billing.upiId || "";
    $("billTerms").value = billing.terms || "";
    $("billValidity").value = billing.validityDays || 15;
    $("billRound").checked = billing.roundOff !== false;
    $("billStock").checked = Boolean(billing.reduceStockOnDispatch);
    Object.entries(PREFIX_FIELDS).forEach(([key, id]) => {
      $(id).value = billing.prefixes[key] || "";
    });
    showExample();
  }

  async function load() {
    try {
      render(await crmApi("/organization/billing"));
    } catch (error) {
      $("billGstState").textContent = apiErrorMessage(error, "Couldn't load the billing settings.");
    }
  }

  $("billPreQ").addEventListener("input", showExample);
  $("billForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = (id) => $(id).value.trim();
    const body = {
      bank: { accountName: value("billAccName"), accountNumber: value("billAccNo").replace(/\s/g, ""), ifsc: value("billIfsc").toUpperCase(), bankName: value("billBank"), branch: value("billBranch") },
      upiId: value("billUpi"),
      terms: $("billTerms").value,
      validityDays: Number(value("billValidity")) || 15,
      roundOff: $("billRound").checked,
      reduceStockOnDispatch: $("billStock").checked,
      prefixes: Object.fromEntries(Object.entries(PREFIX_FIELDS).map(([key, id]) => [key, value(id).toUpperCase()])),
    };
    try {
      render(await crmApi("/organization/billing", jsonRequest("PUT", body)));
      showToast("Billing settings saved. New quotations use them.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the billing settings."), "error");
    }
  });

  document.getElementById("billingTab").addEventListener("click", load);
  if (new URLSearchParams(window.location.search).get("tab") === "billing") load();
})();
