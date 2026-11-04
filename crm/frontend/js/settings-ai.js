/**
 * settings-ai.js — Settings → AI assistant (Phase 10D, owners and admins)
 * Switch the assistant on (reply drafts for agents) and, separately, its own answers to
 * customers; the company's instructions; this month's use against the budget; and a test box
 * that shows what it would answer (nothing is sent).
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsAi() {
  if (!isOrgManager()) return leaveManagerTab("ai");
  document.getElementById("aiTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const count = (n) => Number(n || 0).toLocaleString("en-IN");
  let loaded = false;

  function render(s) {
    $("aiEnabled").checked = s.enabled;
    $("aiAutoReply").checked = s.autoReply;
    $("aiInstructions").value = s.instructions;
    const note = $("aiNotReady");
    note.hidden = s.configured;
    note.textContent = s.configured ? "" : t("setai.the-ai-assistant-is-not-set");
    $("aiForm").querySelectorAll("input, textarea, button").forEach((el) => { el.disabled = !s.configured; });
    $("aiTestBtn").disabled = !s.configured;
    const m = s.month;
    const pct = m.budgetUsd ? Math.min(Math.round((m.costUsd / m.budgetUsd) * 100), 100) : 0;
    $("aiUsage").innerHTML = `
      <div class="plan-meter"><div class="plan-meter-top"><span>${escapeHtml(t("setai.estimated-cost"))}</span><strong>$${m.costUsd.toFixed(2)} / $${m.budgetUsd.toFixed(2)}</strong></div>
        <div class="plan-bar${pct >= 100 ? " full" : pct >= 80 ? " near" : ""}"><span style="width: ${pct}%"></span></div></div>
      <div class="plan-meter"><div class="plan-meter-top"><span>${escapeHtml(t("setai.reply-suggestions"))}</span><strong>${count(m.suggested)}</strong></div></div>
      <div class="plan-meter"><div class="plan-meter-top"><span>${escapeHtml(t("setai.answers-sent-by-itself"))}</span><strong>${count(m.sent)}</strong></div></div>
      <div class="plan-meter"><div class="plan-meter-top"><span>${escapeHtml(t("setai.chats-passed-to-the-team"))}</span><strong>${count(m.handoffs)}</strong></div></div>
      <div class="plan-meter"><div class="plan-meter-top"><span>${escapeHtml(t("setai.tokens-in-out-from-cache"))}</span><strong>${count(m.inputTokens)} / ${count(m.outputTokens)} / ${count(m.cacheReadTokens)}</strong></div></div>`;
  }

  async function load() {
    try {
      render(await crmApi("/ai/settings"));
    } catch (error) {
      $("aiNotReady").hidden = false;
      $("aiNotReady").textContent = apiErrorMessage(error, t("setai.could-not-load-the-ai-assistant"));
    }
  }

  $("aiAutoReply").addEventListener("change", () => {
    if ($("aiAutoReply").checked) $("aiEnabled").checked = true;
  });
  $("aiEnabled").addEventListener("change", () => {
    if (!$("aiEnabled").checked) $("aiAutoReply").checked = false;
  });

  $("aiForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      render(await crmApi("/ai/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: $("aiEnabled").checked, autoReply: $("aiAutoReply").checked, instructions: $("aiInstructions").value.trim() }) }));
      showToast(t("setai.ai-assistant-saved"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("setai.could-not-save")), "error");
    }
  });

  $("aiTestForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("aiTestMessage").value.trim();
    if (!message) return;
    const box = $("aiTestResult");
    box.innerHTML = `<p class="settings-hint">${escapeHtml(t("setai.thinking"))}</p>`;
    $("aiTestBtn").disabled = true;
    try {
      const answer = await crmApi("/ai/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
      box.innerHTML = answer.handoff
        ? `<p class="settings-hint"><span class="badge badge-warning">${escapeHtml(t("setai.passes-to-your-team"))}</span> ${escapeHtml(answer.reason || "")}</p>`
        : `<div class="pay-gateway"><div class="pay-gateway-top"><strong>${escapeHtml(t("setai.it-would-answer"))}</strong><span class="badge badge-success">${escapeHtml(t("setai.sure"))} ${escapeHtml(answer.confidence)}</span></div><p style="white-space: pre-wrap; margin: 8px 0 0">${escapeHtml(answer.reply)}</p></div>`;
      load();
    } catch (error) {
      box.innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("setai.no-answer-this-time")))}</p>`;
    } finally {
      $("aiTestBtn").disabled = false;
    }
  });

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    load();
  }
  document.querySelector('.settings-tab[data-panel="ai"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="ai"]').classList.contains("active")) loadOnce();
})();
