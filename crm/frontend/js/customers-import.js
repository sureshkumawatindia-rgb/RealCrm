/**
 * customers-import.js — Customers → Import CSV (Phase 7)
 * Uploads a CSV file to /contacts/import/preview, lets the person choose what each column is
 * (the server's guess first), checks it (dry run), then imports and shows the report. Uses
 * app.js: crmApi, crmLoad, escapeHtml, showToast, apiErrorMessage; customers.js: renderTable.
 */
// Starts once the page's texts are in (i18n/*.json, CP5).
crmI18n.ready.then(function customersImport() {
  const $ = (id) => document.getElementById(id);
  const FIELD_LABELS = {
    "": t("import.skip"), name: t("col.name"), phone: t("wa.priv.phone"), email: t("leads.email"), company: t("col.company"), gstin: "GSTIN",
    state: t("import.state"), city: t("import.city"), address: t("import.address"), tags: t("customers.col.tags"), source: t("leads.col.source"), notes: t("leads.notes"),
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
      <th><div class="import-col">${escapeHtml(header || t("import.column", { n: index + 1 }))}</div>
        <select data-col="${index}" aria-label="${escapeHtml(t("import.columnIs", { n: index + 1 }))}">${Object.entries(FIELD_LABELS)
          .map(([value, text]) => `<option value="${value}" ${preview.mapping[index] === value ? "selected" : ""}>${escapeHtml(text)}</option>`)
          .join("")}</select></th>`).join("");
    const rows = preview.rows.map((row) => `<tr>${preview.headers.map((_, i) => `<td>${escapeHtml(row[i] || "")}</td>`).join("")}</tr>`).join("");
    $("importPreview").innerHTML = `<thead><tr>${columns}</tr></thead><tbody>${rows}</tbody>`;
    $("importCount").textContent = t("import.count", { n: preview.totalRows.toLocaleString(crmI18n.locale()) });
    $("importMapping").hidden = false;
    $("importCheck").disabled = false;
    $("importRun").disabled = false;
  }

  const mapping = () => [...$("importPreview").querySelectorAll("[data-col]")].map((select) => select.value);

  function renderReport(report) {
    const lines = [
      `<strong>${escapeHtml(t(report.dryRun ? "import.checked" : "import.imported"))}</strong>`,
      escapeHtml(t("import.summary", { created: report.created, updated: report.updated, unchanged: report.unchanged }) + (report.mergedInFile ? t("import.merged", { n: report.mergedInFile }) : "")),
      report.rejected ? escapeHtml(t("import.rejected", { n: report.rejected })) : "",
    ].filter(Boolean);
    const rejected = report.rejectedRows.map((r) => `<li>${escapeHtml(t("import.row", { n: r.row }))}: ${escapeHtml(r.text)}</li>`).join("");
    const warnings = report.warnings.map((w) => `<li>${escapeHtml(t("import.row", { n: w.row }))}: ${escapeHtml(w.text)}</li>`).join("");
    $("importReport").innerHTML = `${lines.map((l) => `<div>${l}</div>`).join("")}${rejected ? `<ul>${rejected}</ul>` : ""}${warnings ? `<div>${escapeHtml(t("import.notes"))}</div><ul>${warnings}</ul>` : ""}`;
    $("importReport").hidden = false;
  }

  async function send(dryRun) {
    if (!file || !preview) return;
    const fields = mapping();
    if (!fields.includes("phone") && !fields.includes("email")) {
      showToast(t("import.needPhone"), "error");
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
        showToast(t("import.done", { created: report.created, updated: report.updated }), "success");
        await crmLoad(["contacts"], { force: true });
        renderTable();
      }
    } catch (error) {
      showToast(apiErrorMessage(error, t("import.err.import")), "error");
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
      showToast(apiErrorMessage(error, t("import.err.read")), "error");
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
});
