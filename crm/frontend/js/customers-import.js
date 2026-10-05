/**
 * customers-import.js — Customers → Import CSV (Phase 7)
 * Uploads a CSV file to /contacts/import/preview, lets the person choose what each column is
 * (the server's guess first), checks it (dry run), then imports and shows the report. Uses
 * app.js: crmApi, crmLoad, escapeHtml, showToast, apiErrorMessage; customers.js: renderTable.
 */
(function customersImport() {
  const $ = (id) => document.getElementById(id);
  const FIELD_LABELS = {
    "": "— skip —", name: "Name", phone: "Mobile number", email: "Email", company: "Company", gstin: "GSTIN",
    state: "State", city: "City", address: "Address", tags: "Tags", source: "Source", notes: "Notes",
  };
  let file = null;
  let preview = null;

  function reset() {
    file = null;
    preview = null;
    $("importFile").value = "";
    $("importMapping").hidden = true;
    $("importReport").hidden = true;
    $("importCheck").disabled = true;
    $("importRun").disabled = true;
  }

  function renderPreview() {
    const columns = preview.headers.map((header, index) => `
      <th><div class="import-col">${escapeHtml(header || `Column ${index + 1}`)}</div>
        <select data-col="${index}" aria-label="What column ${index + 1} is">${Object.entries(FIELD_LABELS)
          .map(([value, text]) => `<option value="${value}" ${preview.mapping[index] === value ? "selected" : ""}>${escapeHtml(text)}</option>`)
          .join("")}</select></th>`).join("");
    const rows = preview.rows.map((row) => `<tr>${preview.headers.map((_, i) => `<td>${escapeHtml(row[i] || "")}</td>`).join("")}</tr>`).join("");
    $("importPreview").innerHTML = `<thead><tr>${columns}</tr></thead><tbody>${rows}</tbody>`;
    $("importCount").textContent = `${preview.totalRows.toLocaleString("en-IN")} customers in the file. Check what each column is (the first rows are shown).`;
    $("importMapping").hidden = false;
    $("importCheck").disabled = false;
    $("importRun").disabled = false;
  }

  const mapping = () => [...$("importPreview").querySelectorAll("[data-col]")].map((select) => select.value);

  function renderReport(report) {
    const lines = [
      report.dryRun ? "<strong>Checked — nothing was saved yet.</strong>" : "<strong>Imported.</strong>",
      `${report.created} new · ${report.updated} filled in or tagged · ${report.unchanged} already up to date${report.mergedInFile ? ` · ${report.mergedInFile} repeated rows merged` : ""}`,
      report.rejected ? `${report.rejected} rows left out:` : "",
    ].filter(Boolean);
    const rejected = report.rejectedRows.map((r) => `<li>Row ${r.row}: ${escapeHtml(r.text)}</li>`).join("");
    const warnings = report.warnings.map((w) => `<li>Row ${w.row}: ${escapeHtml(w.text)}</li>`).join("");
    $("importReport").innerHTML = `${lines.map((l) => `<div>${l}</div>`).join("")}${rejected ? `<ul>${rejected}</ul>` : ""}${warnings ? `<div>Notes:</div><ul>${warnings}</ul>` : ""}`;
    $("importReport").hidden = false;
  }

  async function send(dryRun) {
    if (!file || !preview) return;
    const fields = mapping();
    if (!fields.includes("phone") && !fields.includes("email")) {
      showToast("Choose which column has the mobile number (or the email).", "error");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    form.append("mapping", JSON.stringify(fields));
    form.append("tags", $("importTags").value);
    form.append("lifecycle", $("importLifecycle").value);
    form.append("consent", $("importConsent").checked ? "opted_in" : "unknown");
    form.append("updateExisting", String($("importUpdate").checked));
    form.append("dryRun", String(dryRun));
    $("importCheck").disabled = true;
    $("importRun").disabled = true;
    try {
      const report = await crmApi("/contacts/import", { method: "POST", body: form });
      renderReport(report);
      if (!dryRun) {
        showToast(`${report.created} customers added, ${report.updated} updated`, "success");
        await crmLoad(["contacts"], { force: true });
        renderTable();
      }
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't import the file."), "error");
    } finally {
      $("importCheck").disabled = false;
      $("importRun").disabled = false;
    }
  }

  $("importFile").addEventListener("change", async () => {
    file = $("importFile").files[0] || null;
    $("importMapping").hidden = true;
    $("importReport").hidden = true;
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    try {
      preview = await crmApi("/contacts/import/preview", { method: "POST", body: form });
      renderPreview();
    } catch (error) {
      preview = null;
      showToast(apiErrorMessage(error, "Couldn't read the file."), "error");
    }
  });
  $("importBtn").addEventListener("click", () => {
    reset();
    $("importOverlay").classList.add("open");
  });
  const close = () => $("importOverlay").classList.remove("open");
  $("importClose").addEventListener("click", close);
  $("importCancel").addEventListener("click", close);
  $("importOverlay").addEventListener("click", (event) => {
    if (event.target.id === "importOverlay") close();
  });
  $("importCheck").addEventListener("click", () => send(true));
  $("importRun").addEventListener("click", () => send(false));
})();
