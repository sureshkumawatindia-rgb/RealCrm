/**
 * automation-bot.js — Sales Automation → FAQ bot (Phase 6C, owners and admins)
 * The WhatsApp bot's settings (/bot/settings: on/off, greeting, away message, "talk to a person")
 * and its answers (/faq-rules). An answer is a message with up to 10 options: 1–3 are sent as
 * buttons, 4–10 as a list (WhatsApp's limits); each option opens another answer or a person.
 * Loads the first time the tab opens (automation.js sends "automation:tab"). Uses app.js:
 * crmApi, jsonRequest, escapeHtml, isOrgManager, showToast, apiErrorMessage.
 */
(function automationBot() {
  if (!isOrgManager()) return;
  const $ = (id) => document.getElementById(id);
  $("tabBotBtn").hidden = false;

  const PLACEHOLDERS = ["contact.name", "org.name", "owner.name", "lead.title"];
  const MAX_OPTIONS = 10;
  const splitList = (text) => [...new Set(String(text || "").split(",").map((s) => s.trim()).filter(Boolean))];
  let loaded = false;
  let settings = null;
  let rules = [];
  let editingId = "";

  // ===========================================================================================
  // The answer editor (greeting, away message, each answer)
  // ===========================================================================================
  function answerEditor(container, { placeholder = "Namaste {{contact.name}}! …" } = {}) {
    let options = [];

    container.innerHTML = `
      <textarea class="au-answer-text" data-a="text" maxlength="1024" placeholder="${escapeHtml(placeholder)}"></textarea>
      <div class="au-placeholders">${PLACEHOLDERS.map((p) => `<button type="button" data-insert="{{${p}}}">{{${p}}}</button>`).join("")}</div>
      <div class="au-options" data-a-options></div>
      <div class="au-inline">
        <button type="button" class="link-mini" data-a-add><i class="fa-solid fa-plus"></i> Add option</button>
        <span class="au-hint" data-a-kind style="margin:0"></span>
      </div>
      <div class="au-inline" data-a-list hidden><span>List button</span><input type="text" data-a="listButton" maxlength="20" placeholder="Choose" /></div>
      <div class="au-inline"><span>Footer</span><input class="grow" type="text" data-a="footer" maxlength="60" placeholder="Optional small text under the message" /></div>`;
    const box = container.querySelector("[data-a-options]");

    const targetOptions = (option) => {
      const known = rules.some((r) => String(r.id) === String(option.ruleId));
      return `<option value="handoff" ${option.action === "handoff" ? "selected" : ""}>Talk to a person</option>
        ${rules.map((r) => `<option value="rule:${escapeHtml(r.id)}" ${option.action === "rule" && String(option.ruleId) === String(r.id) ? "selected" : ""}>Open "${escapeHtml(r.name)}"</option>`).join("")}
        ${option.action === "rule" && option.ruleId && !known ? `<option value="rule:${escapeHtml(option.ruleId)}" selected>(a removed answer)</option>` : ""}`;
    };

    function renderOptions() {
      const asList = options.length > 3;
      box.innerHTML = options
        .map((o, index) => `
          <div class="dynamic-row au-option" data-index="${index}">
            <input type="text" data-o="title" maxlength="${asList ? 24 : 20}" placeholder="${asList ? "Row title" : "Button text"}" value="${escapeHtml(o.title || "")}" />
            ${asList ? `<input class="grow" type="text" data-o="description" maxlength="72" placeholder="Short description (optional)" value="${escapeHtml(o.description || "")}" />` : ""}
            <select data-o="target" aria-label="What the option does">${targetOptions(o)}</select>
            <button type="button" class="remove-row" data-o-remove aria-label="Remove option"><i class="fa-solid fa-xmark"></i></button>
          </div>`)
        .join("");
      container.querySelector("[data-a-kind]").textContent = !options.length
        ? "Sent as a plain message."
        : asList ? `Sent as a list of ${options.length} (titles up to 24 characters).` : `Sent with ${options.length} button${options.length === 1 ? "" : "s"} (up to 20 characters each).`;
      container.querySelector("[data-a-list]").hidden = !asList;
      container.querySelector("[data-a-add]").disabled = options.length >= MAX_OPTIONS;
    }

    function readOptions() {
      options = [...box.querySelectorAll(".au-option")].map((row) => {
        const target = row.querySelector('[data-o="target"]').value;
        return {
          title: row.querySelector('[data-o="title"]').value.trim(),
          description: row.querySelector('[data-o="description"]')?.value.trim() || "",
          action: target === "handoff" ? "handoff" : "rule",
          ...(target !== "handoff" && { ruleId: target.slice(5) }),
        };
      });
      return options;
    }

    container.addEventListener("click", (event) => {
      const insert = event.target.closest("[data-insert]");
      if (insert) {
        const input = container.querySelector('[data-a="text"]');
        const start = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, start) + insert.dataset.insert + input.value.slice(input.selectionEnd ?? start);
        input.focus();
        return;
      }
      if (event.target.closest("[data-a-add]")) {
        readOptions();
        if (options.length < MAX_OPTIONS) options.push({ title: "", action: rules.length ? "rule" : "handoff", ruleId: rules[0]?.id });
        renderOptions();
        box.querySelector(".au-option:last-child [data-o='title']")?.focus();
        return;
      }
      const remove = event.target.closest("[data-o-remove]");
      if (remove) {
        readOptions();
        options.splice(Number(remove.closest(".au-option").dataset.index), 1);
        renderOptions();
      }
    });

    return {
      set(answer = {}) {
        container.querySelector('[data-a="text"]').value = answer.text || "";
        container.querySelector('[data-a="listButton"]').value = answer.listButton || "Choose";
        container.querySelector('[data-a="footer"]').value = answer.footer || "";
        options = (answer.options || []).map((o) => ({ ...o }));
        renderOptions();
      },
      read() {
        return {
          text: container.querySelector('[data-a="text"]').value.trim(),
          options: readOptions(),
          listButton: container.querySelector('[data-a="listButton"]').value.trim() || "Choose",
          footer: container.querySelector('[data-a="footer"]').value.trim(),
        };
      },
      // Rules changed (added, renamed, removed): redraw the choices, keep what is typed.
      refresh() {
        readOptions();
        renderOptions();
      },
    };
  }

  const greetingEditor = answerEditor($("botGreeting"), { placeholder: "Namaste {{contact.name}}! Welcome to {{org.name}}. How can we help?" });
  const awayEditor = answerEditor($("botAway"), { placeholder: "Thank you! We are closed now and will reply when we open." });
  const ruleEditor = answerEditor($("ruleAnswer"), { placeholder: "Our rates: …" });

  // ===========================================================================================
  // Settings
  // ===========================================================================================
  function renderSettings() {
    $("botEnabled").checked = settings.enabled;
    $("botGreetingOn").checked = settings.greeting.enabled;
    $("botAwayOn").checked = settings.away.enabled;
    greetingEditor.set(settings.greeting.answer);
    awayEditor.set(settings.away.answer);
    $("botHandoffKeywords").value = settings.handoff.keywords.join(", ");
    $("botHandoffText").value = settings.handoff.text;
    $("botRepeat").value = settings.repeatAfterHours;
  }

  $("botSaveBtn").addEventListener("click", async () => {
    const button = $("botSaveBtn");
    button.disabled = true;
    try {
      settings = await crmApi("/bot/settings", jsonRequest("PUT", {
        enabled: $("botEnabled").checked,
        greeting: { enabled: $("botGreetingOn").checked, answer: greetingEditor.read() },
        away: { enabled: $("botAwayOn").checked, answer: awayEditor.read() },
        handoff: { keywords: splitList($("botHandoffKeywords").value), text: $("botHandoffText").value.trim() },
        repeatAfterHours: Number($("botRepeat").value) || 24,
      }));
      renderSettings();
      showToast(settings.enabled ? "Bot settings saved — the bot is on" : "Bot settings saved — the bot is off", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the bot settings."), "error");
    } finally {
      button.disabled = false;
    }
  });

  // ===========================================================================================
  // Answers
  // ===========================================================================================
  function renderRules() {
    $("botRules").innerHTML = rules.length
      ? rules
          .map((r) => {
            const count = r.answer.options.length;
            const shape = !count ? "plain message" : count <= 3 ? `${count} button${count === 1 ? "" : "s"}` : `list of ${count}`;
            return `
              <div class="au-bot-rule ${r.active ? "" : "off"}" data-id="${escapeHtml(r.id)}">
                <div class="au-bot-rule-head">
                  <strong>${escapeHtml(r.name)}</strong>
                  <span class="badge ${r.active ? "badge-success" : "badge-neutral"}">${r.active ? "Active" : "Off"}</span>
                  <span class="au-bot-rule-tools">
                    <button class="icon-btn" type="button" data-rule="toggle" title="${r.active ? "Switch off" : "Switch on"}" aria-label="${r.active ? "Switch off" : "Switch on"}"><i class="fa-solid ${r.active ? "fa-pause" : "fa-power-off"}"></i></button>
                    <button class="icon-btn" type="button" data-rule="edit" title="Edit" aria-label="Edit"><i class="fa-solid fa-pen"></i></button>
                    <button class="icon-btn danger" type="button" data-rule="delete" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash"></i></button>
                  </span>
                </div>
                <div class="au-checks">${r.keywords.length ? r.keywords.map((k) => `<span class="chain-chip">${escapeHtml(k)}</span>`).join("") : '<span class="au-hint" style="margin:0">Only from another answer\'s option</span>'}</div>
                <div class="au-hint">${escapeHtml(r.answer.text.slice(0, 140))}${r.answer.text.length > 140 ? "…" : ""}</div>
                <div class="au-hint">${escapeHtml(shape)} · answered ${r.stats.answered} time${r.stats.answered === 1 ? "" : "s"}</div>
              </div>`;
          })
          .join("")
      : '<div class="dynamic-list-empty">No answers yet. Start with your price list, delivery times or address.</div>';
    // The option choices in every editor follow the answers.
    greetingEditor.refresh();
    awayEditor.refresh();
  }

  function openRule(rule) {
    editingId = rule ? rule.id : "";
    $("ruleModalTitle").textContent = rule ? `Edit "${rule.name}"` : "New answer";
    $("ruleName").value = rule?.name || "";
    $("rulePriority").value = rule ? rule.priority : Math.max(0, ...rules.map((r) => r.priority)) + 10;
    $("ruleKeywords").value = (rule?.keywords || []).join(", ");
    $("ruleActive").checked = rule ? rule.active : true;
    $("ruleDeleteBtn").style.display = rule ? "inline-flex" : "none";
    ruleEditor.set(rule?.answer || { text: "", options: [] });
    $("ruleModalOverlay").classList.add("open");
    $("ruleName").focus();
  }
  const closeRule = () => $("ruleModalOverlay").classList.remove("open");

  async function reloadRules() {
    rules = await crmApi("/faq-rules");
    renderRules();
  }

  async function removeRule(rule, onDone) {
    if (!confirm(`Delete the answer "${rule.name}"? Options that open it disappear from other answers.`)) return;
    try {
      await crmApi(`/faq-rules/${rule.id}`, { method: "DELETE" });
      if (onDone) onDone();
      await reloadRules();
      showToast("Answer deleted", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't delete the answer."), "error");
    }
  }

  $("ruleForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("ruleName").value.trim();
    if (!name) {
      showToast("Give the answer a name.", "error");
      $("ruleName").focus();
      return;
    }
    const body = {
      name,
      priority: Number($("rulePriority").value) || 0,
      keywords: splitList($("ruleKeywords").value),
      active: $("ruleActive").checked,
      answer: ruleEditor.read(),
    };
    const button = $("ruleSaveBtn");
    button.disabled = true;
    try {
      await crmApi(editingId ? `/faq-rules/${editingId}` : "/faq-rules", jsonRequest(editingId ? "PATCH" : "POST", body));
      closeRule();
      await reloadRules();
      showToast("Answer saved", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the answer."), "error");
    } finally {
      button.disabled = false;
    }
  });

  $("botRules").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-rule]");
    const card = event.target.closest("[data-id]");
    if (!button || !card) return;
    const rule = rules.find((r) => String(r.id) === card.dataset.id);
    if (!rule) return;
    if (button.dataset.rule === "edit") openRule(rule);
    if (button.dataset.rule === "delete") removeRule(rule);
    if (button.dataset.rule === "toggle") {
      try {
        await crmApi(`/faq-rules/${rule.id}`, jsonRequest("PATCH", { active: !rule.active }));
        await reloadRules();
      } catch (error) {
        showToast(apiErrorMessage(error, "Couldn't change the answer."), "error");
      }
    }
  });
  $("botAddRuleBtn").addEventListener("click", () => openRule(null));
  $("ruleModalClose").addEventListener("click", closeRule);
  $("ruleCancelBtn").addEventListener("click", closeRule);
  $("ruleModalOverlay").addEventListener("click", (event) => {
    if (event.target.id === "ruleModalOverlay") closeRule();
  });
  $("ruleDeleteBtn").addEventListener("click", () => {
    const rule = rules.find((r) => String(r.id) === String(editingId));
    if (rule) removeRule(rule, closeRule);
  });

  // ===========================================================================================
  // Loading when the tab opens
  // ===========================================================================================
  document.addEventListener("automation:tab", async (event) => {
    if (event.detail !== "bot" || loaded) return;
    loaded = true;
    $("botRules").innerHTML = '<p class="au-hint">Loading…</p>';
    try {
      [settings, rules] = await Promise.all([crmApi("/bot/settings"), crmApi("/faq-rules")]);
      renderSettings();
      renderRules();
    } catch (error) {
      loaded = false;
      showToast(apiErrorMessage(error, "Couldn't load the bot."), "error");
    }
  });
})();
