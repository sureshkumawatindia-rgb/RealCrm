/**
 * contact-merge.js — "Possible duplicates" on the Customers page (D100; owners and admins).
 * Customers sharing a mobile number, an email or a GSTIN (GET /contacts/duplicates); pick the
 * one to keep and the one to merge into it, choose each field's value, see what moves, and
 * merge (POST /contacts/:id/merge). It cannot be undone, so it asks for a tick first.
 * Loads after customers.js (renderTable) and app.js.
 */
(() => {
  const $m = (id) => document.getElementById(id);
  if (!isOrgManager()) return;
  $m("dupBtn").hidden = false;

  const MOVES = ["leads", "chats", "chatsJoined", "messages", "quotations", "orders", "paymentLinks", "tickets", "tasks", "events", "documents", "notes", "calls", "sms", "emails", "sequences", "projects", "records"];
  const BUILT_IN = new Set(["name", "email", "phone", "company", "gstin", "city", "state", "address", "ownerId", "status"]);
  const day = (iso) => new Date(iso).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short", year: "numeric" });
  let groups = [];
  let merging = null; // { group, mainId, otherId, preview }

  function showList() {
    merging = null;
    $m("dupTitle").textContent = t("merge.title");
    $m("dupList").hidden = false;
    $m("mergeView").hidden = true;
    $m("mergeBack").hidden = true;
    $m("mergeRun").hidden = true;
  }

  async function loadList() {
    showList();
    $m("dupList").innerHTML = `<p class="text-muted">${escapeHtml(t("cf.loading"))}</p>`;
    try {
      ({ groups } = await crmApi("/contacts/duplicates"));
    } catch (error) {
      $m("dupList").innerHTML = `<p class="text-muted">${escapeHtml(apiErrorMessage(error, t("merge.err.load")))}</p>`;
      return;
    }
    $m("dupList").innerHTML = groups.length
      ? `<p class="merge-hint">${escapeHtml(t("merge.listHint"))}</p>${groups.map((group, index) => `
        <section class="dup-group">
          <p class="dup-reasons">${group.reasons.map((r) => escapeHtml(t(`merge.reason.${r.reason}`, { value: r.value }))).join(" · ")}</p>
          <ul class="dup-people">${group.contacts.map((c) => `
            <li>
              <strong>${escapeHtml(c.name)}</strong>
              <span>${escapeHtml([c.phone, c.email, c.company].filter(Boolean).join(" · ") || "—")}</span>
              <span class="text-muted">${escapeHtml(t("merge.counts", { leads: c.leads, chats: c.chats, orders: c.orders }))} · ${escapeHtml(t("merge.added", { date: day(c.createdAt) }))}</span>
            </li>`).join("")}</ul>
          <button type="button" class="btn btn-outline" data-merge-group="${index}"><i class="fa-solid fa-code-merge"></i> ${escapeHtml(t("merge.open"))}</button>
        </section>`).join("")}`
      : `<p class="merge-empty"><i class="fa-solid fa-circle-check"></i> ${escapeHtml(t("merge.none"))}</p>`;
  }

  async function openMerge(group, mainId, otherId) {
    merging = { group, mainId, otherId, preview: null };
    $m("dupTitle").textContent = t("merge.titleMerge");
    $m("dupList").hidden = true;
    $m("mergeView").hidden = false;
    $m("mergeBack").hidden = false;
    $m("mergeRun").hidden = false;
    $m("mergeRun").disabled = true;
    $m("mergeView").innerHTML = `<p class="text-muted">${escapeHtml(t("cf.loading"))}</p>`;
    try {
      merging.preview = await crmApi(`/contacts/${encodeURIComponent(mainId)}/merge-preview?with=${encodeURIComponent(otherId)}`);
    } catch (error) {
      $m("mergeView").innerHTML = `<p class="text-muted">${escapeHtml(apiErrorMessage(error, t("merge.err.load")))}</p>`;
      return;
    }
    renderMerge();
  }

  function renderMerge() {
    const { group, mainId, otherId, preview } = merging;
    const choice = (id) => group.contacts.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === id ? "selected" : ""}>${escapeHtml(c.name)}${c.phone ? ` (${escapeHtml(c.phone)})` : ""}</option>`).join("");
    const label = (row) => (BUILT_IN.has(row.key) ? t(`merge.field.${row.key}`) : row.label);
    const rows = preview.fields.map((row) => {
      if (row.same) return `<tr><th scope="row">${escapeHtml(label(row))}</th><td colspan="2">${escapeHtml(row.main)}</td></tr>`;
      const radio = (side) => `<label class="merge-pick"><input type="radio" name="keep_${escapeHtml(row.key)}" value="${side}" ${row.default === side ? "checked" : ""} /> <span>${escapeHtml(row[side]) || `<em>${escapeHtml(t("merge.empty"))}</em>`}</span></label>`;
      return `<tr><th scope="row">${escapeHtml(label(row))}</th><td>${radio("main")}</td><td>${radio("other")}</td></tr>`;
    }).join("");
    const moves = MOVES.filter((key) => preview.moves[key] > 0).map((key) => `<li>${escapeHtml(t(`merge.move.${key}`, { n: preview.moves[key] }))}</li>`).join("");
    $m("mergeView").innerHTML = `
      <div class="merge-pair">
        <label class="field"><span>${escapeHtml(t("merge.keep"))}</span><select id="mergeMain">${choice(mainId)}</select></label>
        <button type="button" class="btn btn-outline merge-swap" id="mergeSwap" title="${escapeHtml(t("merge.swap"))}" aria-label="${escapeHtml(t("merge.swap"))}"><i class="fa-solid fa-right-left"></i></button>
        <label class="field"><span>${escapeHtml(t("merge.into"))}</span><select id="mergeOther">${choice(otherId)}</select></label>
      </div>
      <p class="merge-hint">${escapeHtml(t("merge.pickHint"))}</p>
      <div class="merge-table-wrap"><table class="merge-table" data-keep-table>
        <thead><tr><th scope="col"></th><th scope="col">${escapeHtml(t("merge.kept", { name: preview.main.name }))}</th><th scope="col">${escapeHtml(t("merge.goes", { name: preview.other.name }))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="merge-hint">${escapeHtml(t("merge.alwaysHint"))}</p>
      ${moves ? `<p class="merge-sub">${escapeHtml(t("merge.movesTitle", { name: preview.main.name }))}</p><ul class="merge-moves">${moves}</ul>` : ""}
      ${preview.differentPhones ? `<p class="merge-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(t("merge.phonesWarn"))}</p>` : ""}
      <p class="merge-warn merge-final"><i class="fa-solid fa-circle-exclamation"></i> ${escapeHtml(t("merge.final", { name: preview.other.name }))}</p>
      <label class="merge-confirm"><input type="checkbox" id="mergeSure" /> <span>${escapeHtml(t("merge.sure"))}</span></label>`;
    $m("mergeRun").disabled = true;
  }

  async function runMerge() {
    const { mainId, otherId, preview } = merging;
    const keep = {};
    $m("mergeView").querySelectorAll('input[type="radio"]:checked').forEach((input) => { keep[input.name.slice(5)] = input.value; });
    $m("mergeRun").disabled = true;
    try {
      await crmApi(`/contacts/${encodeURIComponent(mainId)}/merge`, { ...jsonRequest("POST", { otherId, keep }), headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() } });
      showToast(t("merge.done", { name: preview.main.name }), "success");
      await crmLoad(["contacts"], { force: true });
      renderTable();
      await loadList();
    } catch (error) {
      showToast(apiErrorMessage(error, t("merge.err.merge")), "error");
      $m("mergeRun").disabled = !$m("mergeSure")?.checked;
    }
  }

  const close = () => $m("dupOverlay").classList.remove("open");
  $m("dupBtn").addEventListener("click", () => {
    $m("dupOverlay").classList.add("open");
    loadList();
  });
  $m("dupClose").addEventListener("click", close);
  $m("dupDone").addEventListener("click", close);
  $m("dupOverlay").addEventListener("click", (event) => {
    if (event.target.id === "dupOverlay") close();
  });
  $m("mergeBack").addEventListener("click", loadList);
  $m("mergeRun").addEventListener("click", runMerge);
  $m("dupList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-merge-group]");
    if (!button) return;
    const group = groups[Number(button.dataset.mergeGroup)];
    // The oldest is kept by default.
    openMerge(group, group.contacts[0].id, group.contacts[1].id);
  });
  $m("mergeView").addEventListener("change", (event) => {
    if (event.target.id === "mergeSure") $m("mergeRun").disabled = !event.target.checked;
    if (event.target.id === "mergeMain" || event.target.id === "mergeOther") {
      const main = $m("mergeMain").value;
      let other = $m("mergeOther").value;
      if (main === other) other = merging.group.contacts.find((c) => c.id !== main).id;
      openMerge(merging.group, main, other);
    }
  });
  $m("mergeView").addEventListener("click", (event) => {
    if (event.target.closest("#mergeSwap")) openMerge(merging.group, merging.otherId, merging.mainId);
  });
})();
