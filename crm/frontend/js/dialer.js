/**
 * dialer.js — the power dialer (Phase 8B, D89)
 * A list of customers to call one after another: the current one (name, number, deal, last
 * note), Call (click-to-call through Calling — pressed every time, never automatic — or the
 * number to dial from one's own phone), what came of it (one tap; keys 1–8), a note, a
 * follow-up, then Save and next (Enter). Skip moves on. Sessions start from a board of leads or
 * from leads picked on a board.
 */
(function dialer() {
  const OUTCOMES = ["connected", "interested", "callback", "not_interested", "no_answer", "busy", "wrong_number", "switched_off"];
  const FOLLOW_UPS = [[null, "dialer.fu.none"], [1, "dialer.fu.tomorrow"], [3, "dialer.fu.3days"], [7, "dialer.fu.week"]];
  const $ = (id) => document.getElementById(id);
  const state = { session: null, index: null, outcome: "", followUp: null, busy: false, card: null };

  const stageLabel = (s) => (crmI18n.has(`stage.${s}`) ? t(`stage.${s}`) : s);
  const money = (paise) => (paise ? `₹${(Number(paise) / 100).toLocaleString(crmI18n.locale())}` : "");

  // ---------------------------------------------------------------- start screen
  async function renderStart() {
    $("dlSession").hidden = true;
    $("dlStart").hidden = false;
    const [sessions, boards] = await Promise.all([crmApi("/dialer/sessions").catch(() => []), crmApi("/boards?object=lead").catch(() => [])]);
    const usable = boards.filter((b) => b.layout !== "calendar");
    $("dlBoards").innerHTML = usable.length
      ? usable.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join("")
      : `<option value="">${escapeHtml(t("dialer.noBoards"))}</option>`;
    $("dlStartBtn").disabled = !usable.length;
    $("dlRecent").innerHTML = sessions.length
      ? sessions.map((s) => `<a class="dl-recent" href="?id=${encodeURIComponent(s.id)}"><strong>${escapeHtml(s.name)}</strong><span>${escapeHtml(t("dialer.progress", { done: s.stats.done + s.stats.skipped, total: s.stats.total }))}${s.status === "finished" ? ` · ${escapeHtml(t("dialer.finished"))}` : ""}</span></a>`).join("")
      : `<p class="settings-hint">${escapeHtml(t("dialer.noSessions"))}</p>`;
  }

  async function startFromBoard() {
    const boardId = $("dlBoards").value;
    if (!boardId) return;
    $("dlStartBtn").disabled = true;
    try {
      const session = await crmApi("/dialer/sessions", jsonRequest("POST", { boardId }));
      if (session.leftOut?.length) showToast(t("dialer.leftOut", { n: session.leftOut.length }), "info");
      history.replaceState(null, "", `?id=${encodeURIComponent(session.id)}`);
      await openSession(session);
    } catch (error) {
      showToast(apiErrorMessage(error, t("dialer.failed")), "error");
    } finally {
      $("dlStartBtn").disabled = false;
    }
  }

  // ---------------------------------------------------------------- the session
  async function openSession(session) {
    state.session = session;
    $("dlStart").hidden = true;
    $("dlSession").hidden = false;
    $("dlTitle").textContent = session.name;
    renderQueue();
    await showItem(session.next);
  }

  function renderProgress() {
    const s = state.session.stats;
    $("dlProgress").textContent = t("dialer.progress", { done: s.done + s.skipped, total: s.total });
    $("dlBar").style.width = `${Math.round(((s.done + s.skipped) / Math.max(s.total, 1)) * 100)}%`;
  }

  function renderQueue() {
    renderProgress();
    $("dlQueue").innerHTML = state.session.items.map((item) => {
      const icon = item.status === "done" ? "fa-circle-check" : item.status === "skipped" ? "fa-forward" : "fa-circle";
      const what = item.status === "done" ? t(`call.outcome.${item.outcome}`) : item.status === "skipped" ? t("dialer.skipped") : "";
      return `<button type="button" class="dl-q dl-q-${item.status}${item.index === state.index ? " current" : ""}" data-item="${item.index}" ${item.status !== "pending" ? "disabled" : ""}>
          <i class="fa-solid ${icon}" aria-hidden="true"></i><span>${escapeHtml(item.label || item.title)}</span><small>${escapeHtml(what)}</small></button>`;
    }).join("");
  }

  async function showItem(index) {
    state.index = index;
    state.outcome = "";
    state.followUp = null;
    renderQueue();
    if (index === null || index === undefined) {
      const s = state.session.stats;
      $("dlCard").innerHTML = `<div class="dl-done"><i class="fa-solid fa-flag-checkered" aria-hidden="true"></i>
        <h3>${escapeHtml(t("dialer.allDone"))}</h3>
        <p>${escapeHtml(t("dialer.summary", { done: s.done, talked: s.talked, skipped: s.skipped }))}</p>
        ${state.session.status === "active" ? `<button type="button" class="btn btn-primary" data-act="finish">${escapeHtml(t("dialer.finish"))}</button>` : ""}
        <a class="btn btn-outline" href="dialer.html">${escapeHtml(t("dialer.another"))}</a></div>`;
      return;
    }
    const item = state.session.items[index];
    $("dlCard").innerHTML = `<p class="settings-hint">${escapeHtml(t("cf.loading"))}</p>`;
    const [contact, lead] = await Promise.all([
      crmApi(`/contacts/${encodeURIComponent(item.contactId)}`).catch(() => null),
      crmApi(`/leads/${encodeURIComponent(item.leadId)}`).catch(() => null),
    ]);
    if (state.index !== index) return;
    state.card = { contact, lead };
    const phone = contact?.phone || "";
    const lastNote = lead?.notes || "";
    const calling = state.session.calling;
    $("dlCard").innerHTML = `
      <div class="dl-who">
        <h3>${escapeHtml(contact?.name || item.label)}</h3>
        <p>${escapeHtml([item.title, lead ? stageLabel(lead.stage) : "", money(lead?.expectedValuePaise)].filter(Boolean).join(" · "))}</p>
        ${lastNote ? `<p class="dl-note">${escapeHtml(lastNote.slice(0, 200))}</p>` : ""}
      </div>
      <div class="dl-call">
        ${calling
          ? `<button type="button" class="btn btn-primary dl-call-btn" data-act="call"><i class="fa-solid fa-phone"></i> ${escapeHtml(t("dialer.call"))}</button><span class="dl-phone">${escapeHtml(phone)}</span>`
          : `<a class="btn btn-primary dl-call-btn" href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ""))}"><i class="fa-solid fa-phone"></i> ${escapeHtml(phone || t("dialer.noNumber"))}</a><span class="settings-hint">${escapeHtml(t("dialer.ownPhone"))}</span>`}
      </div>
      <div class="dl-outcomes" role="radiogroup" aria-label="${escapeHtml(t("call.outcome"))}">
        ${OUTCOMES.map((o, i) => `<button type="button" class="dl-outcome" role="radio" aria-checked="false" data-outcome="${o}"><kbd>${i + 1}</kbd> ${escapeHtml(t(`call.outcome.${o}`))}</button>`).join("")}
      </div>
      <input type="text" id="dlNotes" maxlength="2000" placeholder="${escapeHtml(t("call.notesPh"))}" aria-label="${escapeHtml(t("call.notesPh"))}" />
      <div class="dl-followups" role="radiogroup" aria-label="${escapeHtml(t("dialer.followUp"))}">
        <span>${escapeHtml(t("dialer.followUp"))}</span>
        ${FOLLOW_UPS.map(([days, key]) => `<button type="button" class="dl-fu${days === null ? " active" : ""}" role="radio" aria-checked="${days === null}" data-fu="${days === null ? "" : days}">${escapeHtml(t(key))}</button>`).join("")}
      </div>
      <div class="pl-buttons">
        <button type="button" class="btn btn-primary" data-act="save" disabled>${escapeHtml(t("dialer.saveNext"))}</button>
        <button type="button" class="btn btn-outline" data-act="skip">${escapeHtml(t("dialer.skip"))}</button>
      </div>
      <p class="dl-keys">${escapeHtml(t("dialer.keys"))}</p>`;
    $("dlCard").querySelector('[data-act="call"], .dl-call-btn')?.focus();
  }

  function pickOutcome(outcome) {
    state.outcome = outcome;
    $("dlCard").querySelectorAll("[data-outcome]").forEach((b) => {
      const on = b.dataset.outcome === outcome;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
    });
    const save = $("dlCard").querySelector('[data-act="save"]');
    if (save) save.disabled = false;
  }

  async function act(fn) {
    if (state.busy) return;
    state.busy = true;
    try {
      await fn();
    } finally {
      state.busy = false;
    }
  }

  async function save() {
    if (!state.outcome || state.index === null) return;
    const body = { outcome: state.outcome, notes: $("dlNotes")?.value.trim() || "", ...(state.followUp !== null && { followUpInDays: state.followUp }) };
    try {
      const done = await crmApi(`/dialer/sessions/${encodeURIComponent(state.session.id)}/items/${state.index}/result`, jsonRequest("POST", body));
      state.session = { ...done.session, calling: state.session.calling };
      if (done.followUp?.error) showToast(done.followUp.error, "error");
      await showItem(state.session.next);
    } catch (error) {
      showToast(apiErrorMessage(error, t("dialer.failed")), "error");
    }
  }

  async function skip() {
    if (state.index === null) return;
    try {
      const session = await crmApi(`/dialer/sessions/${encodeURIComponent(state.session.id)}/items/${state.index}/skip`, jsonRequest("POST", {}));
      state.session = { ...session, calling: state.session.calling };
      await showItem(state.session.next);
    } catch (error) {
      showToast(apiErrorMessage(error, t("dialer.failed")), "error");
    }
  }

  async function call() {
    try {
      await crmApi(`/dialer/sessions/${encodeURIComponent(state.session.id)}/items/${state.index}/call`, jsonRequest("POST", {}));
      showToast(t("call.ringing"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("call.dialFailed")), "error");
    }
  }

  async function finish() {
    try {
      state.session = { ...(await crmApi(`/dialer/sessions/${encodeURIComponent(state.session.id)}/finish`, jsonRequest("POST", {}))), calling: state.session.calling };
      showToast(t("dialer.finished"), "success");
      await showItem(null);
    } catch (error) {
      showToast(apiErrorMessage(error, t("dialer.failed")), "error");
    }
  }

  function onCardClick(event) {
    const outcome = event.target.closest("[data-outcome]");
    if (outcome) return pickOutcome(outcome.dataset.outcome);
    const fu = event.target.closest("[data-fu]");
    if (fu) {
      state.followUp = fu.dataset.fu === "" ? null : Number(fu.dataset.fu);
      $("dlCard").querySelectorAll("[data-fu]").forEach((b) => {
        b.classList.toggle("active", b === fu);
        b.setAttribute("aria-checked", String(b === fu));
      });
      return undefined;
    }
    const button = event.target.closest("[data-act]");
    if (!button) return undefined;
    return act({ save, skip, call, finish }[button.dataset.act]);
  }

  // 1–8 pick an outcome, Enter saves and goes on, S skips (not while typing a note).
  function onKey(event) {
    if ($("dlSession").hidden || state.index === null || event.ctrlKey || event.metaKey || event.altKey) return;
    const typing = event.target.closest?.("input, textarea, select");
    if (event.key === "Enter" && state.outcome && (!typing || event.target.id === "dlNotes")) {
      event.preventDefault();
      act(save);
      return;
    }
    if (typing) return;
    if (/^[1-8]$/.test(event.key)) pickOutcome(OUTCOMES[Number(event.key) - 1]);
    else if (event.key === "s" || event.key === "S") act(skip);
  }

  async function startDialer() {
    await crmI18n.ready;
    $("dlCard").addEventListener("click", onCardClick);
    $("dlQueue").addEventListener("click", (event) => {
      const item = event.target.closest("[data-item]");
      if (item) showItem(Number(item.dataset.item));
    });
    $("dlStartBtn").addEventListener("click", startFromBoard);
    document.addEventListener("keydown", onKey);
    const id = new URLSearchParams(location.search).get("id");
    if (!id) return renderStart();
    try {
      return await openSession(await crmApi(`/dialer/sessions/${encodeURIComponent(id)}`));
    } catch (error) {
      showToast(apiErrorMessage(error, t("dialer.failed")), "error");
      return renderStart();
    }
  }

  startDialer();
})();
