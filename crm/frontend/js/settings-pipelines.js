/**
 * settings-pipelines.js — Settings → Pipelines (Phase 5, D84, owners and admins)
 * The company's pipelines: add, rename, delete; their stages in order, each with what it means
 * to reports (its kind: New, Contacted, Quote Sent or Negotiation), its chance (%) and after how
 * many quiet days the board flags a deal. Removing a stage or a pipeline that still holds open
 * deals asks where they go (the server moves them and keeps the history). Won and Lost end every
 * pipeline. Runs after settings.js; one IIFE: no globals.
 */
(function settingsPipelines() {
  if (!isOrgManager()) return leaveManagerTab("pipelines");
  document.getElementById("pipelinesTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const KINDS = ["New", "Contacted", "Quote Sent", "Negotiation"];
  const KIND_CHANCE = { New: 10, Contacted: 25, "Quote Sent": 50, Negotiation: 75 };
  const MAX_STAGES = 12; // backend/src/constants/pipelines.js
  let pipelines = [];
  let editing = null; // { id|null, name, stages: [{ id?, name, kind, probability, quietDays }] }
  let counts = {}; // stage id → open deals (for the pipeline being edited)
  let loaded = false;

  function listHtml() {
    if (!pipelines.length) return `<p class="settings-hint">${escapeHtml(t("pset.none"))}</p>`;
    return pipelines.map((p) => `
      <div class="cf-row" data-id="${escapeHtml(p.id)}">
        <div class="cf-row-main">
          <div class="cf-row-name"><strong>${escapeHtml(p.name)}</strong>${p.isDefault ? ` <span class="badge badge-neutral">${escapeHtml(t("pset.default"))}</span>` : ""}</div>
          <div class="settings-hint" style="margin:4px 0 0">${escapeHtml(p.stages.map((s) => s.name).join(" → "))} → ${escapeHtml(crmLabel("stage", "Won"))} / ${escapeHtml(crmLabel("stage", "Lost"))}</div>
          <div class="settings-hint" style="margin:2px 0 0">${escapeHtml(t("pset.open", { n: p.openLeads }))}</div>
        </div>
        <div class="pl-buttons">
          <button class="btn btn-outline" type="button" data-act="edit">${escapeHtml(t("pset.edit"))}</button>
          ${p.isDefault ? "" : `<button class="btn btn-danger-outline" type="button" data-act="delete">${escapeHtml(t("pset.delete"))}</button>`}
        </div>
      </div>`).join("");
  }

  function stageRowHtml(stage, index, total) {
    return `<div class="pset-stage" data-index="${index}">
      <input type="text" class="pset-name" maxlength="40" value="${escapeHtml(stage.name)}" aria-label="${escapeHtml(t("pset.stageName"))}" placeholder="${escapeHtml(t("pset.stageName"))}" />
      <select class="pset-kind" aria-label="${escapeHtml(t("pset.kind"))}">${KINDS.map((kind) => `<option value="${escapeHtml(kind)}" ${kind === stage.kind ? "selected" : ""}>${escapeHtml(t("pset.means", { stage: crmLabel("stage", kind) }))}</option>`).join("")}</select>
      <label class="pset-num">${escapeHtml(t("pset.chance"))}<input type="number" class="pset-prob" min="0" max="100" value="${stage.probability}" /></label>
      <label class="pset-num">${escapeHtml(t("pset.quiet"))}<input type="number" class="pset-quiet" min="0" max="365" value="${stage.quietDays}" /></label>
      <span class="pset-tools">
        <button type="button" class="icon-btn" data-stage="up" ${index === 0 ? "disabled" : ""} aria-label="${escapeHtml(t("pset.up"))}"><i class="fa-solid fa-arrow-up"></i></button>
        <button type="button" class="icon-btn" data-stage="down" ${index === total - 1 ? "disabled" : ""} aria-label="${escapeHtml(t("pset.down"))}"><i class="fa-solid fa-arrow-down"></i></button>
        <button type="button" class="icon-btn" data-stage="remove" ${total <= 2 ? "disabled" : ""} aria-label="${escapeHtml(t("pset.removeStage"))}"><i class="fa-solid fa-xmark"></i></button>
      </span>
      ${stage.id && counts[stage.id] ? `<span class="settings-hint pset-held">${escapeHtml(t("pset.holds", { n: counts[stage.id] }))}</span>` : ""}
    </div>`;
  }

  function formHtml() {
    if (!editing) return "";
    return `<form class="cf-form" id="psetForm" autocomplete="off">
      <h4>${escapeHtml(t(editing.id ? "pset.editTitle" : "pset.addTitle"))}</h4>
      <div class="field"><label for="psetName">${escapeHtml(t("pset.name"))}</label><input type="text" id="psetName" maxlength="60" value="${escapeHtml(editing.name)}" placeholder="${escapeHtml(t("pset.namePh"))}" required /></div>
      <div class="field"><label>${escapeHtml(t("pset.stages"))}</label>
        <div id="psetStages">${editing.stages.map((stage, i) => stageRowHtml(stage, i, editing.stages.length)).join("")}</div>
        <button type="button" class="btn btn-outline" data-stage="add" ${editing.stages.length >= MAX_STAGES ? "disabled" : ""}><i class="fa-solid fa-plus"></i> ${escapeHtml(t("pset.addStage"))}</button>
        <p class="settings-hint">${escapeHtml(t("pset.stagesHint"))}</p>
      </div>
      <div class="pl-buttons"><button class="btn btn-primary" type="submit">${escapeHtml(t("pset.save"))}</button><button class="btn btn-outline" type="button" data-act="cancel">${escapeHtml(t("pset.cancel"))}</button></div>
    </form>`;
  }

  function render() {
    $("psetList").innerHTML = listHtml();
    $("psetEditor").innerHTML = formHtml();
    $("psetAdd").disabled = pipelines.length >= 10;
  }

  // The form's current values back into `editing` (before a re-render or a save).
  function readForm() {
    if (!editing || !$("psetForm")) return;
    editing.name = $("psetName").value;
    document.querySelectorAll("#psetStages .pset-stage").forEach((row) => {
      const stage = editing.stages[Number(row.dataset.index)];
      stage.name = row.querySelector(".pset-name").value;
      stage.kind = row.querySelector(".pset-kind").value;
      stage.probability = Number(row.querySelector(".pset-prob").value);
      stage.quietDays = Number(row.querySelector(".pset-quiet").value);
    });
  }

  async function load() {
    try {
      await crmI18n.ready;
      pipelines = await crmApi("/pipelines");
      render();
    } catch (error) {
      $("psetList").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("pset.loadFailed")))}</p>`;
    }
  }

  async function startEdit(id) {
    counts = {};
    if (id) {
      const p = pipelines.find((x) => String(x.id) === String(id));
      editing = { id: p.id, name: p.name, original: p.stages.map((s) => s.id), stages: p.stages.map((s) => ({ ...s })) };
      try {
        const summary = await crmApi(`/pipelines/${id}/summary`);
        counts = Object.fromEntries(summary.columns.map((c) => [String(c.stage.id), c.count]));
      } catch {
        /* the server still asks where deals go */
      }
    } else {
      editing = { id: null, name: "", original: [], stages: KINDS.map((kind) => ({ name: crmLabel("stage", kind), kind, probability: KIND_CHANCE[kind], quietDays: 7 })) };
    }
    render();
    $("psetName").focus();
  }

  // For each removed stage that holds deals: where they go (the "Move to…" picker).
  async function moveTargets() {
    const kept = editing.stages.filter((s) => s.id);
    const moves = {};
    for (const id of editing.original.filter((stageId) => !kept.some((s) => String(s.id) === String(stageId)) && counts[stageId])) {
      const old = pipelines.find((p) => String(p.id) === String(editing.id)).stages.find((s) => String(s.id) === String(id));
      if (!kept.length) throw new Error(t("pset.keepOne"));
      const target = await crmMoveMenu.open({ title: t("pset.whereTo", { n: counts[id], name: old.name }), current: "", options: kept.map((s) => ({ value: String(s.id), label: s.name })) });
      if (!target) return null;
      moves[id] = target;
    }
    return moves;
  }

  async function save(event) {
    event.preventDefault();
    readForm();
    const stages = editing.stages.map(({ id, name, kind, probability, quietDays }) => ({ ...(id && { id }), name: name.trim(), kind, probability, quietDays }));
    try {
      if (editing.id) {
        const moveStages = await moveTargets();
        if (moveStages === null) return;
        await crmApi(`/pipelines/${editing.id}`, jsonRequest("PATCH", { name: editing.name.trim(), stages, ...(Object.keys(moveStages).length && { moveStages }) }));
      } else {
        await crmApi("/pipelines", jsonRequest("POST", { name: editing.name.trim(), stages }));
      }
      showToast(t("pset.saved"), "success");
      editing = null;
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, t("pset.saveFailed")), "error");
    }
  }

  async function remove(id) {
    const p = pipelines.find((x) => String(x.id) === String(id));
    let moveTo = "";
    if (p.openLeads) {
      moveTo = await crmMoveMenu.open({ title: t("pset.deleteWhere", { n: p.openLeads, name: p.name }), current: "", options: pipelines.filter((x) => x.id !== p.id).map((x) => ({ value: String(x.id), label: x.name })) });
      if (!moveTo) return;
    } else if (!confirm(t("pset.deleteConfirm", { name: p.name }))) return;
    try {
      await crmApi(`/pipelines/${id}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ""}`, { method: "DELETE" });
      showToast(t("pset.deleted"), "success");
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, t("pset.saveFailed")), "error");
    }
  }

  $("psetAdd").addEventListener("click", () => startEdit(null));
  $("psetList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const id = button.closest("[data-id]").dataset.id;
    if (button.dataset.act === "edit") startEdit(id);
    else remove(id);
  });
  $("psetEditor").addEventListener("click", (event) => {
    const button = event.target.closest("[data-stage], [data-act='cancel']");
    if (!button) return;
    if (button.dataset.act === "cancel") {
      editing = null;
      render();
      return;
    }
    readForm();
    const row = button.closest(".pset-stage");
    const index = row ? Number(row.dataset.index) : -1;
    const list = editing.stages;
    if (button.dataset.stage === "add") list.push({ name: "", kind: list[list.length - 1]?.kind || "New", probability: KIND_CHANCE[list[list.length - 1]?.kind || "New"], quietDays: 7 });
    if (button.dataset.stage === "remove") list.splice(index, 1);
    if (button.dataset.stage === "up" && index > 0) [list[index - 1], list[index]] = [list[index], list[index - 1]];
    if (button.dataset.stage === "down" && index < list.length - 1) [list[index + 1], list[index]] = [list[index], list[index + 1]];
    render();
  });
  // A new kind suggests its usual chance.
  $("psetEditor").addEventListener("change", (event) => {
    if (!event.target.classList.contains("pset-kind")) return;
    const prob = event.target.closest(".pset-stage").querySelector(".pset-prob");
    prob.value = KIND_CHANCE[event.target.value];
  });
  $("psetEditor").addEventListener("submit", save);

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    load();
  }
  document.querySelector('.settings-tab[data-panel="pipelines"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="pipelines"]').classList.contains("active")) loadOnce();
  return undefined;
})();
