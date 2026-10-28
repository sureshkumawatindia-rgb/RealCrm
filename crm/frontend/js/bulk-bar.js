/**
 * bulk-bar.js — tick rows in the Leads or Customers list and act on all of them at once (D100).
 *   const bulk = crmBulkBar({ object: "lead" | "contact", bar, onDone })
 *   bulk.head(rows)          the header cell: ticks every row the list shows now (all that match
 *                            the search and filters; the lists hold up to 5,000)
 *   bulk.cell(id)            a row's tick box
 *   bulk.wire(table, rows)   after each drawing: the ticks, the count and the bar
 * Up to 200 rows are done at once; more go to the background (POST /bulk/leads or /bulk/contacts
 * answers with a job), whose progress shows here until the report. Private numbers are left
 * alone by the server; a stage change starts workflows only with "Run automations too".
 * Loads after app.js. Names start with crmBulk / bulk: page scripts share one global scope.
 */
const BULK_INLINE_MAX = 200;
const BULK_STAGES = ["New", "Contacted", "Quote Sent", "Negotiation", "Won", "Lost"];

function crmBulkBar({ object, bar, onDone }) {
  const isLead = object === "lead";
  const me = getCurrentMember() || {};
  const manager = ["owner", "admin"].includes(me.role);
  const allowed = (module, action) => manager || ((me.modules || []).includes(module) && (action === "edit" ? me.role !== "viewer" : (me.permissions || []).includes(`${module}:${action}`)));
  const canDelete = isLead ? allowed("leads", "delete") || allowed("deals", "delete") : allowed("customers", "delete");
  // The actions this member may use, in the order of the menu.
  const ACTIONS = [
    manager && "assign",
    isLead && "stage",
    isLead && "followUp",
    "tag",
    "untag",
    allowed("automation", "edit") && "sequence",
    manager && "export",
    canDelete && "delete",
  ].filter(Boolean);
  const selected = new Set();
  let rows = [];
  let sequences = null;

  const label = (key, vars) => t(`bulkbar.${key}`, vars);
  bar.classList.add("bulk-bar-wrap");
  bar.hidden = true;
  // Drawn with the first list (the page's texts are in by then).
  let built = false;
  function build() {
    if (built) return;
    built = true;
    bar.innerHTML = `
    <div class="bulk-bar" role="toolbar" aria-label="${escapeHtml(t("bulk.toolbar"))}">
      <span class="bulk-count" aria-live="polite"></span>
      <button type="button" class="link-btn bulk-all" hidden></button>
      <select class="bulk-action" aria-label="${escapeHtml(label("action"))}">
        <option value="">${escapeHtml(label("choose"))}</option>
        ${ACTIONS.map((a) => `<option value="${a}">${escapeHtml(label(`do.${a}`))}</option>`).join("")}
      </select>
      <span class="bulk-params"></span>
      <label class="bulk-auto" hidden><input type="checkbox" class="bulk-auto-box" /> <span>${escapeHtml(label("runAutomations"))}</span></label>
      <button type="button" class="btn btn-primary bulk-apply" disabled>${escapeHtml(label("apply"))}</button>
      <button type="button" class="link-btn bulk-clear">${escapeHtml(label("clear"))}</button>
    </div>
    <div class="bulk-progress" hidden><progress max="100" value="0"></progress> <span class="bulk-progress-text"></span></div>
    <div class="bulk-report" hidden></div>`;
    bar.addEventListener("change", onChange);
    bar.addEventListener("click", onClick);
  }
  const $q = (selector) => bar.querySelector(selector);

  const nameOf = (id) => {
    if (isLead) {
      const lead = getLeadRecord(id);
      return lead ? lead.contact?.name || lead.title || id : id;
    }
    return cached("contacts").find((c) => String(c.id) === String(id))?.name || id;
  };

  function renderBar() {
    const n = selected.size;
    bar.hidden = !n && $q(".bulk-report").hidden && $q(".bulk-progress").hidden;
    $q(".bulk-bar").hidden = !n;
    $q(".bulk-count").textContent = t("bulk.selected", { n: n.toLocaleString(crmI18n.locale()) });
    const all = $q(".bulk-all");
    all.hidden = !n || n >= rows.length;
    all.textContent = label("selectAll", { n: rows.length.toLocaleString(crmI18n.locale()) });
    $q(".bulk-apply").disabled = !n || !$q(".bulk-action").value;
  }

  function syncTicks(table) {
    table.querySelectorAll(".bulk-check").forEach((box) => { box.checked = selected.has(box.dataset.id); });
    const head = table.querySelector(".bulk-check-all");
    if (head) {
      head.checked = rows.length > 0 && rows.every((r) => selected.has(String(r.id)));
      head.indeterminate = !head.checked && rows.some((r) => selected.has(String(r.id)));
    }
  }

  // The settings an action needs, next to it in the bar.
  async function renderParams() {
    const action = $q(".bulk-action").value;
    const box = $q(".bulk-params");
    $q(".bulk-auto").hidden = action !== "stage";
    if (action === "assign") {
      const members = cached("members").filter((m) => m.status === "active");
      box.innerHTML = `<select class="bulk-p" data-p="ownerId" aria-label="${escapeHtml(label("to"))}"><option value="">${escapeHtml(label("nobody"))}</option>${members.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.email)}</option>`).join("")}</select>`;
    } else if (action === "stage") {
      box.innerHTML = `<select class="bulk-p" data-p="stage" aria-label="${escapeHtml(label("stage"))}">${BULK_STAGES.map((s) => `<option value="${s}">${escapeHtml(crmLabel("stage", s))}</option>`).join("")}</select>
        <input type="text" class="bulk-p" data-p="lostReason" maxlength="500" placeholder="${escapeHtml(label("lostReason"))}" aria-label="${escapeHtml(label("lostReason"))}" hidden />`;
    } else if (action === "followUp") {
      box.innerHTML = `<input type="date" class="bulk-p" data-p="at" aria-label="${escapeHtml(label("followUpOn"))}" />`;
    } else if (action === "tag" || action === "untag") {
      const tags = [...new Set(cached("contacts").flatMap((c) => c.tags || []))].sort((a, b) => a.localeCompare(b));
      box.innerHTML = `<input type="text" class="bulk-p" data-p="tag" maxlength="50" list="bulkTagList" placeholder="${escapeHtml(label("tag"))}" aria-label="${escapeHtml(label("tag"))}" />
        <datalist id="bulkTagList">${tags.map((tag) => `<option value="${escapeHtml(tag)}"></option>`).join("")}</datalist>`;
    } else if (action === "sequence") {
      box.innerHTML = `<span class="text-muted">${escapeHtml(label("loading"))}</span>`;
      sequences = sequences || (await crmApi("/sequences?limit=100").catch(() => [])).filter((s) => s.status === "Active");
      if ($q(".bulk-action").value !== "sequence") return;
      box.innerHTML = sequences.length
        ? `<select class="bulk-p" data-p="sequenceId" aria-label="${escapeHtml(t("bulk.sequence"))}">${sequences.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("")}</select>`
        : `<span class="text-muted">${escapeHtml(t("bulk.noSequences"))}</span>`;
    } else {
      box.innerHTML = "";
    }
    renderBar();
  }

  // The action's settings, or null (with a note) when something is missing.
  function paramsOf(action) {
    const value = (name) => $q(`.bulk-p[data-p="${name}"]`)?.value.trim() ?? "";
    const missing = (key) => {
      showToast(label(key), "error");
      return null;
    };
    switch (action) {
      case "assign": return { ownerId: value("ownerId") || null };
      case "stage": {
        const stage = value("stage");
        if (stage === "Lost" && !value("lostReason")) return missing("needLostReason");
        return { stage, ...(stage === "Lost" && { lostReason: value("lostReason") }) };
      }
      case "followUp": {
        if (!value("at")) return missing("needDate");
        return { at: new Date(`${value("at")}T10:00:00+05:30`).toISOString() };
      }
      case "tag":
      case "untag": return value("tag") ? { tag: value("tag") } : missing("needTag");
      case "sequence": return value("sequenceId") ? { sequenceId: value("sequenceId") } : missing("needSequence");
      default: return {};
    }
  }

  const REASONS = ["PRIVATE", "NOT_FOUND", "FORBIDDEN", "ALREADY_ENROLLED", "NOT_ACTIVE", "VERSION_CONFLICT", "LOST_REASON_REQUIRED", "ERROR"];
  function showReport(result) {
    const box = $q(".bulk-report");
    const failedCount = result.failedCount ?? result.failed.length;
    const reasons = Object.entries(result.reasons || {}).map(([code, n]) => {
      const words = REASONS.includes(code) ? label(`reason.${code}`) : result.failed.find((f) => f.code === code)?.message || code;
      return `${escapeHtml(words)} (${n.toLocaleString(crmI18n.locale())})`;
    });
    const list = result.failed.slice(0, 20).map((f) => `<li><strong>${escapeHtml(nameOf(f.id))}</strong>: ${escapeHtml(f.message)}</li>`).join("");
    box.innerHTML = `<p class="bulk-report-line ${failedCount ? "partly" : "all"}"><i class="fa-solid ${failedCount ? "fa-circle-info" : "fa-circle-check"}" aria-hidden="true"></i>
        ${escapeHtml(label(result.status === "failed" ? "stopped" : "report", { done: result.done.toLocaleString(crmI18n.locale()), total: result.total.toLocaleString(crmI18n.locale()) }))}
        ${failedCount ? ` ${escapeHtml(label("notDone", { n: failedCount.toLocaleString(crmI18n.locale()) }))} ${reasons.join(", ")}` : ""}
        ${result.error ? ` ${escapeHtml(result.error)}` : ""}</p>
      ${list ? `<ul>${list}</ul>` : ""}
      <button type="button" class="link-btn bulk-report-close">${escapeHtml(label("closeReport"))}</button>`;
    box.hidden = false;
  }

  // A job (more than 200 rows): its progress until it ends.
  async function follow(job) {
    const progress = $q(".bulk-progress");
    progress.hidden = false;
    let current = job;
    while (current.status === "queued" || current.status === "running") {
      progress.querySelector("progress").value = current.total ? Math.round((current.position / current.total) * 100) : 0;
      progress.querySelector(".bulk-progress-text").textContent = label("progress", { done: current.position.toLocaleString(crmI18n.locale()), total: current.total.toLocaleString(crmI18n.locale()) });
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
      try {
        current = await crmApi(`/bulk/jobs/${encodeURIComponent(job.jobId)}`);
      } catch {
        /* the next turn asks again */
      }
    }
    progress.hidden = true;
    return current;
  }

  async function apply() {
    const action = $q(".bulk-action").value;
    const ids = [...selected];
    if (!action || !ids.length) return;
    const params = paramsOf(action);
    if (!params) return;
    const n = ids.length.toLocaleString(crmI18n.locale());
    if (action === "delete" && !confirm(label(isLead ? "deleteLeads" : "deleteCustomers", { n }))) return;
    if (ids.length > BULK_INLINE_MAX && action !== "export" && !confirm(label("bigConfirm", { n }))) return;
    const buttons = bar.querySelectorAll("button, select, input");
    buttons.forEach((el) => { el.disabled = true; });
    $q(".bulk-report").hidden = true;
    try {
      if (action === "export") {
        await crmDownload(`/${isLead ? "leads" : "contacts"}/export`, `${isLead ? "leads" : "customers"}-${new Date().toISOString().slice(0, 10)}.xlsx`, jsonRequest("POST", { ids }));
        showToast(t("xl.downloaded"), "success");
        return;
      }
      const body = { action, ids, params, ...(action === "stage" && { runAutomations: $q(".bulk-auto-box").checked }) };
      let result = await crmApi(`/bulk/${isLead ? "leads" : "contacts"}`, { ...jsonRequest("POST", body), headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() } });
      if (result.jobId) {
        showToast(label("started", { n }), "info");
        result = await follow(result);
      }
      showReport(result);
      // What was not done stays ticked, to look at or try again.
      selected.clear();
      result.failed.forEach((f) => selected.add(String(f.id)));
      await onDone();
    } catch (error) {
      showToast(apiErrorMessage(error, t("bulk.failed")), "error");
    } finally {
      buttons.forEach((el) => { el.disabled = false; });
      renderBar();
    }
  }

  function onChange(event) {
    if (event.target.matches(".bulk-action")) renderParams();
    else if (event.target.matches('.bulk-p[data-p="stage"]')) {
      $q('.bulk-p[data-p="lostReason"]').hidden = event.target.value !== "Lost";
    }
    renderBar();
  }
  function onClick(event) {
    if (event.target.closest(".bulk-apply")) apply();
    else if (event.target.closest(".bulk-clear")) {
      selected.clear();
      document.querySelectorAll(".bulk-check, .bulk-check-all").forEach((box) => { box.checked = false; box.indeterminate = false; });
      renderBar();
    } else if (event.target.closest(".bulk-all")) {
      rows.forEach((r) => selected.add(String(r.id)));
      document.querySelectorAll(".bulk-check, .bulk-check-all").forEach((box) => { box.checked = true; box.indeterminate = false; });
      renderBar();
    } else if (event.target.closest(".bulk-report-close")) {
      $q(".bulk-report").hidden = true;
      renderBar();
    }
  }

  return {
    head: () => `<th class="bulk-pick" scope="col"><input type="checkbox" class="bulk-check-all" aria-label="${escapeHtml(label("tickAll"))}" /></th>`,
    cell: (id, name = "") => `<td class="bulk-pick"><input type="checkbox" class="bulk-check" data-id="${escapeHtml(String(id))}" aria-label="${escapeHtml(label("tickOne", { name }))}" /></td>`,
    // After each drawing: ticks of rows no longer in the list are dropped.
    wire(table, list) {
      build();
      rows = list;
      const shown = new Set(list.map((r) => String(r.id)));
      [...selected].forEach((id) => { if (!shown.has(id)) selected.delete(id); });
      if (table) {
        syncTicks(table);
        if (table.bulkWired) return renderBar();
        table.bulkWired = true; // the list's box stays; only its rows are drawn again
        table.addEventListener("change", (event) => {
          if (event.target.matches(".bulk-check")) {
            if (event.target.checked) selected.add(event.target.dataset.id);
            else selected.delete(event.target.dataset.id);
          } else if (event.target.matches(".bulk-check-all")) {
            rows.forEach((r) => (event.target.checked ? selected.add(String(r.id)) : selected.delete(String(r.id))));
          } else return;
          syncTicks(table);
          renderBar();
        });
      }
      return renderBar();
    },
  };
}
