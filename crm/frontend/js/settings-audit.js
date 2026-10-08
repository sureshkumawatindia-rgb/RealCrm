/**
 * settings-audit.js — Settings → Audit log (Phase 10F, owners and admins)
 * Who did what and when, newest first, 50 at a time, filtered by area (the first word of the
 * action: contact, lead, billing …), person and days. Read-only.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsAudit() {
  if (!isOrgManager()) return leaveManagerTab("audit");
  document.getElementById("auditTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const when = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  // A readable line for an entry: "contact.created" → "Contact created".
  const words = (action) => action.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  let page = 1;
  let loaded = false;
  let rows = [];

  function details(changes) {
    if (!changes) return "";
    if (Array.isArray(changes)) return changes.join(", ");
    const text = JSON.stringify(changes);
    return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  }

  function render() {
    $("auditList").innerHTML = rows.length ? `
      <div style="overflow-x: auto"><table>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
        <tbody>${rows.map((e) => `<tr>
          <td style="white-space: nowrap">${escapeHtml(when(e.at))}</td>
          <td>${e.actor ? `${escapeHtml(e.actor.name || e.actor.email)}` : '<span class="settings-hint" style="margin: 0">The CRM</span>'}</td>
          <td>${escapeHtml(words(e.action))}${e.entityType ? `<div class="settings-hint" style="margin: 0">${escapeHtml(e.entityType)}</div>` : ""}</td>
          <td style="font-size: 12px; word-break: break-word">${escapeHtml(details(e.changes))}</td>
        </tr>`).join("")}</tbody>
      </table></div>` : '<p class="settings-hint">Nothing for these filters.</p>';
  }

  function query() {
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if ($("auditArea").value) params.set("action", `${$("auditArea").value}.`);
    if ($("auditPerson").value) params.set("actorUserId", $("auditPerson").value);
    if ($("auditFrom").value) params.set("from", $("auditFrom").value);
    if ($("auditTo").value) params.set("to", $("auditTo").value);
    return params.toString();
  }

  async function load({ more = false } = {}) {
    page = more ? page + 1 : 1;
    try {
      const result = await crmRequest(`/audit-logs?${query()}`);
      rows = more ? rows.concat(result.data) : result.data;
      render();
      $("auditMore").hidden = !result.pagination?.hasNextPage;
    } catch (error) {
      $("auditList").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, "Could not load the audit log."))}</p>`;
    }
  }

  async function loadFilters() {
    try {
      const meta = await crmApi("/audit-logs/meta");
      $("auditArea").insertAdjacentHTML("beforeend", meta.areas.map((area) => `<option value="${escapeHtml(area)}">${escapeHtml(words(area))}</option>`).join(""));
      $("auditPerson").insertAdjacentHTML("beforeend", meta.people.map((p) => `<option value="${escapeHtml(p.userId)}">${escapeHtml(p.name)}</option>`).join(""));
    } catch {
      /* the list still works without the filters */
    }
  }

  ["auditArea", "auditPerson", "auditFrom", "auditTo"].forEach((id) => $(id).addEventListener("change", () => load()));
  $("auditMore").addEventListener("click", () => load({ more: true }));

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    loadFilters();
    load();
  }
  document.querySelector('.settings-tab[data-panel="audit"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="audit"]').classList.contains("active")) loadOnce();
})();
