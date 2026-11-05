/**
 * leads-import.js — Leads → Import (G1, D105): an Excel or CSV file to /leads/import/preview,
 * what each column is (the server's guess first: the customer's details, the lead's title,
 * stage, owner, value, source, close date, notes, lost reason, the company's own lead fields),
 * the pipeline, what to do with unknown owners and customers who already have an open lead, tags,
 * and "Run automations too" (off). "Check first" is a dry run; then the import and its report.
 * Uses app.js: crmApi, crmLoad, escapeHtml, showToast, apiErrorMessage; leads.js: renderTable.
 */
// Starts once the page's texts are in (i18n/*.json, CP5).
crmI18n.ready.then(function leadsImport() {
  const $ = (id) => document.getElementById(id);
  const GROUPS = [
    ["leadImport.group.customer", { name: "col.name", phone: "wa.priv.phone", email: "leads.email", company: "col.company", city: "import.city", state: "import.state", tags: "customers.col.tags" }],
    ["leadImport.group.lead", { title: "leadImport.f.title", stage: "deals.stage", owner: "leadImport.f.owner", value: "leads.value", source: "leads.col.source", closeDate: "deals.expected-close-date", notes: "leads.notes", lostReason: "leadImport.f.lostReason" }],
  ];
  const STAGES = ["New", "Contacted", "Quote Sent", "Negotiation", "Won", "Lost"];
  const rupees = (paise) => `₹${(Math.round(Number(paise) || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  let file = null;
  let preview = null;

  function reset() {
    file = null;
    preview = null;
    $("leadImportFile").value = "";
    $("leadImportMapping").hidden = true;
    $("leadImportReport").hidden = true;
    $("leadImportCheck").disabled = true;
    $("leadImportRun").disabled = true;
    $("leadImportAutomations").checked = false;
    $("leadImportOpen").value = "skip";
    $("leadImportOwner").value = "me";
    $("leadImportTags").value = "";
  }

  function renderPreview() {
    const choice = (index, value, text) => `<option value="${escapeHtml(value)}" ${preview.mapping[index] === value ? "selected" : ""}>${escapeHtml(text)}</option>`;
    const own = preview.customFields || [];
    const options = (index) => [
      choice(index, "", t("import.skip")),
      ...GROUPS.map(([group, fields]) => `<optgroup label="${escapeHtml(t(group))}">${Object.entries(fields).map(([value, key]) => choice(index, value, t(key))).join("")}</optgroup>`),
      own.length ? `<optgroup label="${escapeHtml(t("import.yourFields"))}">${own.map((field) => choice(index, field.value, field.label)).join("")}</optgroup>` : "",
    ].join("");
    const columns = preview.headers.map((header, index) => `
      <th><div class="import-col">${escapeHtml(header || t("import.column", { n: index + 1 }))}</div>
        <select data-col="${index}" aria-label="${escapeHtml(t("import.columnIs", { n: index + 1 }))}">${options(index)}</select></th>`).join("");
    const rows = preview.rows.map((row) => `<tr>${preview.headers.map((_, i) => `<td>${escapeHtml(row[i] ?? "")}</td>`).join("")}</tr>`).join("");
    $("leadImportPreview").innerHTML = `<thead><tr>${columns}</tr></thead><tbody>${rows}</tbody>`;
    $("leadImportCount").textContent = t("leadImport.count", { n: preview.totalRows.toLocaleString(crmI18n.locale()) });
    // More than one pipeline: choose where the leads go (the default first).
    const pipelines = preview.pipelines || [];
    $("leadImportPipelineField").hidden = pipelines.length < 2;
    $("leadImportPipeline").innerHTML = pipelines.map((p) => `<option value="${escapeHtml(p.id)}" ${p.isDefault ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
    // Only owners and admins give leads to others; an agent's leads are their own.
    $("leadImportOwnerField").hidden = !preview.canChooseOwners;
    $("leadImportYours").hidden = preview.canChooseOwners;
    $("leadImportMapping").hidden = false;
    $("leadImportCheck").disabled = false;
    $("leadImportRun").disabled = false;
  }

  const mapping = () => [...$("leadImportPreview").querySelectorAll("[data-col]")].map((select) => select.value);

  function renderReport(report) {
    const stages = STAGES.filter((s) => report.byStage[s]).map((s) => `${t(`stage.${s}`)} ${report.byStage[s]}`).join(" · ");
    const lines = [
      `<strong>${escapeHtml(t(report.dryRun ? "import.checked" : "import.imported"))}</strong>`,
      escapeHtml(t("leadImport.summary", { created: report.created, contactsCreated: report.contactsCreated, contactsFound: report.contactsFound })),
      escapeHtml(t("leadImport.pipelineName", { name: report.pipeline })),
      stages ? escapeHtml(t("leadImport.byStage", { list: stages })) : "",
      report.valuePaise ? escapeHtml(t("leadImport.value", { value: rupees(report.valuePaise) })) : "",
      report.skippedOpen ? escapeHtml(t("leadImport.skippedOpen", { n: report.skippedOpen })) : "",
      report.ownersIgnored ? escapeHtml(t("leadImport.ownersIgnored")) : "",
      report.customLeftOut ? escapeHtml(t("import.customLeftOut", { n: report.customLeftOut })) : "",
      !report.dryRun && report.automations ? escapeHtml(t("leadImport.automationsOn")) : "",
      report.rejected ? escapeHtml(t("leadImport.rejected", { n: report.rejected })) : "",
    ].filter(Boolean);
    const list = (items) => items.map((r) => `<li>${escapeHtml(t("import.row", { n: r.row }))}: ${escapeHtml(r.text)}</li>`).join("");
    const rejected = list(report.rejectedRows);
    const warnings = list(report.warnings);
    $("leadImportReport").innerHTML = `${lines.map((l) => `<div>${l}</div>`).join("")}${rejected ? `<ul>${rejected}</ul>` : ""}${warnings ? `<div>${escapeHtml(t("import.notes"))}</div><ul>${warnings}</ul>` : ""}`;
    $("leadImportReport").hidden = false;
  }

  async function send(dryRun) {
    if (!file || !preview) return;
    const fields = mapping();
    if (!fields.includes("phone") && !fields.includes("email")) {
      showToast(t("import.needPhone"), "error");
      return;
    }
    const automations = $("leadImportAutomations").checked;
    if (!dryRun && automations && !window.confirm(t("leadImport.confirmAutomations"))) return;
    const form = new FormData();
    form.append("file", file);
    form.append("mapping", JSON.stringify(fields));
    if (!$("leadImportPipelineField").hidden) form.append("pipelineId", $("leadImportPipeline").value);
    if (preview.canChooseOwners) form.append("ownerFallback", $("leadImportOwner").value);
    form.append("openLeads", $("leadImportOpen").value);
    form.append("tags", $("leadImportTags").value);
    form.append("runAutomations", String(automations));
    form.append("dryRun", String(dryRun));
    $("leadImportCheck").disabled = true;
    $("leadImportRun").disabled = true;
    try {
      const report = await crmApi("/leads/import", { method: "POST", body: form });
      renderReport(report);
      if (!dryRun) {
        showToast(t("leadImport.done", { n: report.created }), "success");
        await crmLoad(["leads"], { force: true });
        renderTable();
      }
    } catch (error) {
      showToast(apiErrorMessage(error, t("import.err.import")), "error");
    } finally {
      $("leadImportCheck").disabled = false;
      $("leadImportRun").disabled = false;
    }
  }

  $("leadImportFile").addEventListener("change", async () => {
    file = $("leadImportFile").files[0] || null;
    $("leadImportMapping").hidden = true;
    $("leadImportReport").hidden = true;
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    try {
      preview = await crmApi("/leads/import/preview", { method: "POST", body: form });
      renderPreview();
    } catch (error) {
      preview = null;
      showToast(apiErrorMessage(error, t("import.err.read")), "error");
    }
  });
  $("leadImportBtn").addEventListener("click", () => {
    reset();
    $("leadImportOverlay").classList.add("open");
  });
  const close = () => $("leadImportOverlay").classList.remove("open");
  $("leadImportClose").addEventListener("click", close);
  $("leadImportCancel").addEventListener("click", close);
  $("leadImportOverlay").addEventListener("click", (event) => {
    if (event.target.id === "leadImportOverlay") close();
  });
  $("leadImportCheck").addEventListener("click", () => send(true));
  $("leadImportRun").addEventListener("click", () => send(false));
  // The dashboard's "Get your CRM ready" list (D117) opens this box: leads.html?import=1.
  if (new URLSearchParams(window.location.search).get("import") === "1") $("leadImportBtn").click();
});
