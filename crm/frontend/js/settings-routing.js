/**
 * settings-routing.js — Settings → Lead rules (owners and admins)
 * Working hours (/organization/business-hours), assignment rules (/assignment-rules: who gets a
 * new lead) and auto-reply rules (/auto-reply-rules: the instant WhatsApp template).
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsRouting() {
  if (!isOrgManager()) return leaveManagerTab("leadrules");
  document.getElementById("leadRulesTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  // Sources whose enquiries go through the rules (manual and imported leads do not).
  const SOURCES = ["IndiaMART", "WhatsApp", "WhatsApp Ad", "Website", "Website widget", "Facebook", "Google Ads", "JustDial", "TradeIndia", "Instagram", "Messenger"]; // Instagram, Messenger: G8
  // [day, the text's key (D116)]
  const DAYS = [[1, "setroute.day.mon"], [2, "setroute.day.tue"], [3, "setroute.day.wed"], [4, "setroute.day.thu"], [5, "setroute.day.fri"], [6, "setroute.day.sat"], [0, "setroute.day.sun"]];
  const VALUES = [
    // [what fills a variable, the text's key (D116)]
    ["contact.name", "setroute.val.name"],
    ["contact.company", "setroute.val.company"],
    ["contact.city", "setroute.val.city"],
    ["lead.product", "setroute.val.product"],
    ["owner.name", "setroute.val.owner"],
    ["org.name", "setroute.val.org"],
    ["text:", "setroute.val.text"],
  ];
  const valueLabel = Object.fromEntries(VALUES);

  let hours = null;
  let rules = [];
  let replies = [];
  let members = [];
  let products = [];
  let templates = [];

  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const idOf = (value) => String(value || "");
  const canTakeLeads = (m) => m.status === "active" && (m.role === "owner" || m.role === "admin" || (m.modules || []).some((x) => x === "leads" || x === "deals"));
  const takers = () => members.filter(canTakeLeads);
  const nameOf = (id) => {
    const member = members.find((m) => idOf(m.id) === idOf(id));
    return member ? member.name || member.email : t("setroute.someone-no-longer-in-the-team");
  };
  const productName = (id) => products.find((p) => idOf(p.id) === idOf(id))?.name || t("setroute.a-removed-product");
  const templateOf = (id) => templates.find((t) => idOf(t.id) === idOf(id));
  const list = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);
  const checks = (items, attr, selected) =>
    items.map(([value, label]) => `<label class="ls-check"><input type="checkbox" ${attr}="${escapeHtml(value)}" ${selected.includes(value) ? "checked" : ""} /> ${escapeHtml(label)}</label>`).join("");
  const ticked = (container, attr) => [...container.querySelectorAll(`[${attr}]:checked`)].map((box) => box.getAttribute(attr));
  const activeBadge = (active) => (active ? `<span class="badge badge-success">${escapeHtml(t("setroute.on"))}</span>` : `<span class="badge badge-warning">${escapeHtml(t("setroute.paused"))}</span>`);
  const ruleButtons = (kind, rule, index, count) => `
      <div class="order">
        <button class="icon-btn" type="button" data-${kind}-move="-1" data-id="${escapeHtml(rule.id)}" title="${escapeHtml(t("setroute.tryEarlier"))}" ${index === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
        <button class="icon-btn" type="button" data-${kind}-move="1" data-id="${escapeHtml(rule.id)}" title="${escapeHtml(t("setroute.tryLater"))}" ${index === count - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
      </div>`;
  const actionButtons = (kind, rule) => `
      <div class="ls-actions" style="margin-top:0">
        <button class="btn btn-outline" type="button" data-${kind}-edit="${escapeHtml(rule.id)}">${escapeHtml(t("common.edit"))}</button>
        <button class="btn btn-outline" type="button" data-${kind}-toggle="${escapeHtml(rule.id)}">${rule.active ? t("setroute.pause") : t("setroute.turn-on")}</button>
        <button class="icon-btn danger" type="button" data-${kind}-remove="${escapeHtml(rule.id)}" title="${escapeHtml(t("app.icon.remove"))}"><i class="fa-solid fa-trash"></i></button>
      </div>`;
  const failed = (error, fallback) => `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, fallback))}</p>`;

  // Rules are tried in the order shown: moving one renumbers the priorities 10, 20, 30…
  async function reorder(path, items, id, step) {
    const order = [...items];
    const from = order.findIndex((r) => idOf(r.id) === id);
    const to = from + step;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    for (const [index, rule] of order.entries()) {
      const priority = (index + 1) * 10;
      if (rule.priority !== priority) await crmApi(`${path}/${rule.id}`, jsonRequest("PATCH", { priority }));
    }
  }
  const nextPriority = (items) => (items.length ? Math.max(...items.map((r) => r.priority || 0)) + 10 : 10);

  // --- working hours -----------------------------------------------------------------
  function renderHours() {
    $("lrDays").innerHTML = DAYS.map(([day, label]) => `<label class="ls-check"><input type="checkbox" data-day="${day}" ${hours.days.includes(day) ? "checked" : ""} /> ${escapeHtml(t(label))}</label>`).join("");
    $("lrStart").value = hours.start;
    $("lrEnd").value = hours.end;
    $("lrTz").value = hours.timezone;
    $("lrOpenNow").innerHTML = hours.openNow ? `<span class="badge badge-success">${escapeHtml(t("setroute.openNow"))}</span>` : `<span class="badge badge-neutral">${escapeHtml(t("setroute.closedNow"))}</span>`;
  }
  $("lrHoursForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const days = ticked($("lrDays"), "data-day").map(Number);
    if (!days.length) return showToast(t("setroute.tick-at-least-one-working-day"), "error");
    try {
      hours = await crmApi("/organization/business-hours", jsonRequest("PUT", { days, start: $("lrStart").value, end: $("lrEnd").value, timezone: $("lrTz").value.trim() || "Asia/Kolkata" }));
      renderHours();
      renderRules();
      showToast(t("setroute.working-hours-saved"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("setroute.couldn-t-save-the-working-hours")), "error");
    }
  });

  // --- assignment rules ----------------------------------------------------------------
  function conditionText(c) {
    const parts = [c.sources.length ? c.sources.map((s) => crmLabel("source", s)).join(", ") : t("setroute.anySource")];
    if (c.productIds.length) parts.push(t("setroute.forList", { list: c.productIds.map(productName).join(", ") }));
    if (c.states.length) parts.push(t("setroute.inList", { list: c.states.join(", ") }));
    if (c.cities.length) parts.push(t("setroute.inList", { list: c.cities.join(", ") }));
    return parts.join(" · ");
  }
  function ruleHtml(rule, index) {
    const people = rule.memberIds.map(nameOf);
    const who = rule.strategy === "specific"
      ? `${t("setroute.always", { name: people[0] })}${people.length > 1 ? t("setroute.then", { list: people.slice(1).join(", ") }) : ""}`
      : t("setroute.inTurns", { list: people.join(", ") });
    const fallback = rule.fallbackMemberId ? nameOf(rule.fallbackMemberId) : "";
    const outside = rule.respectWorkingHours ? t("setroute.outsideHours", { who: fallback || t("setroute.nobodyStays") }) : fallback ? t("setroute.ifNobody", { fallback }) : "";
    return `
      <div class="lr-rule">
        ${ruleButtons("assign", rule, index, rules.length)}
        <div class="info">
          <div class="name">${index + 1}. ${escapeHtml(rule.name || t("setroute.unnamedRule"))} ${activeBadge(rule.active)}</div>
          <div class="sub">${escapeHtml(t("setroute.leadsFromTo", { from: conditionText(rule.conditions), to: who }))}</div>
          ${outside ? `<div class="sub">${escapeHtml(outside)}</div>` : ""}
          <div class="sub">${escapeHtml(t(rule.stats?.assigned === 1 ? "setroute.given.one" : "setroute.given.many", { n: rule.stats?.assigned || 0 }))}${rule.stats?.lastAssignedAt ? escapeHtml(t("setroute.last", { when: when(rule.stats.lastAssignedAt) })) : ""}</div>
        </div>
        ${actionButtons("assign", rule)}
      </div>`;
  }
  function renderRules() {
    if (rules.length) {
      $("lrAssignList").innerHTML = rules.map(ruleHtml).join("");
      return;
    }
    const people = takers();
    $("lrAssignList").innerHTML = people.length
      ? `<div class="settings-summary-row" style="flex-wrap:wrap">
          <div class="info" style="flex:1;min-width:0"><div class="name"><i class="fa-solid fa-lightbulb"></i> ${escapeHtml(t("setroute.suggestion"))}</div>
            <div class="sub">${escapeHtml(t("setroute.suggestAssign", { who: people.length === 1 ? people[0].name || people[0].email : t("setroute.thePeople", { n: people.length, names: people.map((m) => m.name || m.email).join(", ") }) }))}</div></div>
          <button class="btn btn-primary" type="button" id="lrAssignSuggest">${escapeHtml(t("setroute.useThis"))}</button>
        </div>`
      : `<p class="settings-hint" style="margin:0">${escapeHtml(t("setroute.noRules"))}</p>`;
  }

  function openRule(rule) {
    const form = $("lrAssignForm");
    const c = rule.conditions || { sources: [], productIds: [], states: [], cities: [] };
    $("lrAssignId").value = rule.id || "";
    $("lrAssignName").value = rule.name || "";
    $("lrAssignSources").innerHTML = checks(SOURCES.map((s) => [s, crmLabel("source", s)]), "data-src", c.sources);
    $("lrAssignProducts").innerHTML = products.length
      ? `<div class="lr-picks">${checks(products.map((p) => [idOf(p.id), p.name]), "data-product", c.productIds.map(idOf))}</div>`
      : `<p class="sub">${escapeHtml(t("setroute.noProducts"))}</p>`;
    $("lrAssignStates").value = c.states.join(", ");
    $("lrAssignCities").value = c.cities.join(", ");
    form.querySelector(`[name="lrStrategy"][value="${rule.strategy || "round_robin"}"]`).checked = true;
    // Everyone who can take leads, plus anyone already in the rule who no longer can.
    const chosen = (rule.memberIds || []).map(idOf);
    const shown = members.filter((m) => canTakeLeads(m) || chosen.includes(idOf(m.id)));
    $("lrAssignMembers").innerHTML = shown.length
      ? `<div class="lr-picks">${shown
          .map((m) => `<label class="ls-check"><input type="checkbox" data-member="${escapeHtml(idOf(m.id))}" ${chosen.includes(idOf(m.id)) ? "checked" : ""} /> ${escapeHtml(m.name || m.email)}${canTakeLeads(m) ? "" : ` <span class="sub">${escapeHtml(t("setroute.cannotTake"))}</span>`}</label>`)
          .join("")}</div>`
      : `<p class="sub">${escapeHtml(t("setroute.nobodyCan"))}</p>`;
    $("lrAssignHours").checked = Boolean(rule.respectWorkingHours);
    $("lrAssignFallback").innerHTML =
      `<option value="">${escapeHtml(t("setroute.nobodyOption"))}</option>` +
      takers().map((m) => `<option value="${escapeHtml(idOf(m.id))}" ${idOf(m.id) === idOf(rule.fallbackMemberId) ? "selected" : ""}>${escapeHtml(m.name || m.email)}</option>`).join("");
    form.hidden = false;
    $("lrAssignName").focus();
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function closeRule() {
    $("lrAssignForm").hidden = true;
    $("lrAssignForm").reset();
  }

  $("lrAssignNew").addEventListener("click", () => openRule({}));
  $("lrAssignCancel").addEventListener("click", closeRule);
  $("lrAssignForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const memberIds = ticked(form, "data-member");
    if (!memberIds.length) return showToast(t("setroute.tick-at-least-one-person"), "error");
    const body = {
      name: $("lrAssignName").value.trim(),
      conditions: { sources: ticked(form, "data-src"), productIds: ticked(form, "data-product"), states: list($("lrAssignStates").value), cities: list($("lrAssignCities").value) },
      strategy: form.querySelector('[name="lrStrategy"]:checked').value,
      memberIds,
      respectWorkingHours: $("lrAssignHours").checked,
      fallbackMemberId: $("lrAssignFallback").value || null,
    };
    const id = $("lrAssignId").value;
    try {
      if (id) await crmApi(`/assignment-rules/${id}`, jsonRequest("PATCH", body));
      else await crmApi("/assignment-rules", jsonRequest("POST", { ...body, priority: nextPriority(rules) }));
      showToast(id ? t("setroute.rule-saved") : t("setroute.rule-added-it-decides-the-next"), "success");
      closeRule();
      await loadRules();
    } catch (error) {
      showToast(apiErrorMessage(error, t("ap.err.save")), "error");
    }
  });

  $("lrAssignList").addEventListener("click", async (e) => {
    const target = (attr) => e.target.closest(`[${attr}]`);
    if (e.target.closest("#lrAssignSuggest")) {
      const people = takers();
      return openRule({ name: people.length === 1 ? t("setroute.every-new-lead") : t("setroute.everyone-in-turns"), strategy: "round_robin", memberIds: people.map((m) => m.id) });
    }
    const move = target("data-assign-move");
    const edit = target("data-assign-edit");
    const toggle = target("data-assign-toggle");
    const remove = target("data-assign-remove");
    try {
      if (move) await reorder("/assignment-rules", rules, move.dataset.id, Number(move.dataset.assignMove));
      else if (edit) return openRule(rules.find((r) => idOf(r.id) === edit.dataset.assignEdit));
      else if (toggle) {
        const rule = rules.find((r) => idOf(r.id) === toggle.dataset.assignToggle);
        await crmApi(`/assignment-rules/${rule.id}`, jsonRequest("PATCH", { active: !rule.active }));
        showToast(rule.active ? t("setroute.rule-paused") : t("setroute.rule-on"), "success");
      } else if (remove) {
        if (!confirm(t("setroute.remove-this-rule-leads-it-already"))) return;
        await crmApi(`/assignment-rules/${remove.dataset.assignRemove}`, { method: "DELETE" });
        showToast(t("setroute.rule-removed"), "success");
      } else return;
    } catch (error) {
      showToast(apiErrorMessage(error, t("gs.failed")), "error");
    }
    await loadRules();
  });

  // --- auto-reply rules -----------------------------------------------------------------
  const sendable = () => templates.filter((t) => t.sendable);
  // Variables of a template: [part, name, label] in the order WhatsApp shows them.
  function variablesOf(template) {
    if (!template) return [];
    return [
      ...(template.header?.variables || []).map((name) => ["header", name, t("quotes.var.header", { name })]),
      ...template.body.variables.map((name) => ["body", name, t("quotes.var.body", { name })]),
      ...template.buttons.filter((b) => b.variables.length).map((b) => ["buttons", String(b.index), t("quotes.var.button", { text: b.text })]),
    ];
  }
  const specText = (spec) => (String(spec).startsWith("text:") ? `"${String(spec).slice(5)}"` : valueLabel[spec] ? t(valueLabel[spec]) : spec);

  function replyHtml(rule, index) {
    const template = templateOf(rule.templateId);
    const problem = !template ? t("setroute.the-template-was-removed-this-rule") : !template.sendable ? t("setroute.the-template-cannot-be-sent", { notSendableReason: template.notSendableReason }) : "";
    const s = rule.stats || {};
    const extras = [t(rule.onlyNewContacts ? "setroute.onlyNew" : "setroute.alsoRepeat"), rule.maxAgeMinutes ? t("setroute.notOlder", { n: rule.maxAgeMinutes }) : "", rule.delaySeconds ? t("setroute.waits", { n: rule.delaySeconds }) : ""].filter(Boolean);
    return `
      <div class="lr-rule">
        ${ruleButtons("reply", rule, index, replies.length)}
        <div class="info">
          <div class="name">${index + 1}. ${escapeHtml(rule.name || t("setroute.autoReply"))} ${activeBadge(rule.active)}</div>
          <div class="sub">${escapeHtml(t("setroute.leadsFromTemplate", { from: rule.sources.length ? rule.sources.map((s) => crmLabel("source", s)).join(", ") : t("setroute.anySource") }))} <strong>${escapeHtml(template ? template.name : "?")}</strong>${template ? ` (${escapeHtml(template.language)})` : ""} · ${escapeHtml(extras.join(" · "))}</div>
          ${problem ? `<div class="sub" style="color:var(--danger)">${escapeHtml(problem)}</div>` : ""}
          <div class="sub">${escapeHtml(t("setroute.replyStats", { sent: s.sent || 0, skipped: s.skipped || 0, failed: s.failed || 0 }))}${s.lastSentAt ? escapeHtml(t("setroute.last", { when: when(s.lastSentAt) })) : ""}</div>
        </div>
        ${actionButtons("reply", rule)}
      </div>`;
  }
  function renderReplies() {
    if (replies.length) {
      $("lrReplyList").innerHTML = replies.map(replyHtml).join("");
      return;
    }
    const first = sendable()[0];
    $("lrReplyList").innerHTML = first
      ? `<div class="settings-summary-row" style="flex-wrap:wrap">
          <div class="info" style="flex:1;min-width:0"><div class="name"><i class="fa-solid fa-lightbulb"></i> ${escapeHtml(t("setroute.suggestion"))}</div>
            <div class="sub">${escapeHtml(t("setroute.suggestReply"))} <strong>${escapeHtml(first.name)}</strong>.</div></div>
          <button class="btn btn-primary" type="button" id="lrReplySuggest">${escapeHtml(t("setroute.useThis"))}</button>
        </div>`
      : `<p class="settings-hint" style="margin:0">${escapeHtml(t("setroute.needsTemplate"))}
          <a href="#" id="lrGoWhatsapp">${escapeHtml(t("setroute.templatesLink"))}</a></p>`;
  }

  function renderVariables(rule = {}) {
    const template = templateOf($("lrReplyTemplate").value);
    const vars = variablesOf(template);
    const options = (selected) => VALUES.map(([value, label]) => `<option value="${value}" ${selected === value || (value === "text:" && String(selected).startsWith("text:")) ? "selected" : ""}>${escapeHtml(t(label))}</option>`).join("");
    $("lrReplyVars").innerHTML = vars.length
      ? vars
          .map(([part, name, label]) => {
            const spec = rule.variables?.[part]?.[name] || "";
            const isText = String(spec).startsWith("text:");
            return `<div class="field lr-var"><label>${escapeHtml(label)}</label>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <select data-var-part="${part}" data-var-name="${escapeHtml(name)}"><option value="">${escapeHtml(t("setroute.choose"))}</option>${options(spec)}</select>
                <input type="text" data-var-text maxlength="200" placeholder="${escapeHtml(t("setroute.fixedWords"))}" value="${isText ? escapeHtml(spec.slice(5)) : ""}" ${isText ? "" : "hidden"} style="flex:1;min-width:160px" />
              </div></div>`;
          })
          .join("") + `<p class="sub" style="margin:-4px 0 12px">${escapeHtml(t("setroute.missingValue"))}</p>`
      : "";
    renderPreview();
  }
  function readVariables() {
    const out = { header: {}, body: {}, buttons: {} };
    for (const select of $("lrReplyVars").querySelectorAll("[data-var-part]")) {
      const text = select.parentElement.querySelector("[data-var-text]").value.trim();
      const spec = select.value === "text:" ? (text ? `text:${text}` : "") : select.value;
      out[select.dataset.varPart][select.dataset.varName] = spec;
    }
    return out;
  }
  function renderPreview() {
    const template = templateOf($("lrReplyTemplate").value);
    const box = $("lrReplyPreview");
    if (!template) {
      box.innerHTML = `<p class="sub" style="margin:0">${escapeHtml(t("setroute.chooseTemplate"))}</p>`;
      return;
    }
    const vars = readVariables();
    const fill = (text, part) =>
      String(text || "").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) => {
        const spec = vars[part]?.[name];
        return spec ? (spec.startsWith("text:") ? spec.slice(5) : `[${t(valueLabel[spec])}]`) : match;
      });
    const buttons = template.buttons.map((b) => b.text).filter(Boolean);
    box.innerHTML = `<div>${template.header?.text ? `<strong>${escapeHtml(fill(template.header.text, "header"))}</strong>\n` : ""}${escapeHtml(fill(template.body.text, "body"))}${template.footer ? `\n<span class="sub">${escapeHtml(template.footer)}</span>` : ""}${buttons.length ? `\n<span class="sub">${buttons.map((b) => `[${escapeHtml(b)}]`).join(" ")}</span>` : ""}</div>`;
  }

  function openReply(rule) {
    const form = $("lrReplyForm");
    $("lrReplyId").value = rule.id || "";
    $("lrReplyName").value = rule.name || "";
    $("lrReplySources").innerHTML = checks(SOURCES.map((s) => [s, crmLabel("source", s)]), "data-src", rule.sources || []);
    const current = idOf(rule.templateId);
    $("lrReplyTemplate").innerHTML =
      `<option value="">${escapeHtml(t("setroute.chooseTemplateOption"))}</option>` +
      (current && !templateOf(current) ? `<option value="" selected disabled>${escapeHtml(t("setroute.templateRemoved"))}</option>` : "") +
      templates
        .map((t) => `<option value="${escapeHtml(idOf(t.id))}" ${idOf(t.id) === current ? "selected" : ""} ${t.sendable ? "" : "disabled"}>${escapeHtml(t.name)} (${escapeHtml(t.language)})${t.sendable ? "" : ` — ${escapeHtml(t.status === "APPROVED" ? crmI18n.t("setroute.cannot-be-sent") : t.status.toLowerCase())}`}</option>`)
        .join("");
    $("lrReplyAge").value = rule.maxAgeMinutes ?? 60;
    $("lrReplyDelay").value = rule.delaySeconds ?? 0;
    $("lrReplyOnlyNew").checked = rule.onlyNewContacts ?? true;
    renderVariables(rule);
    form.hidden = false;
    $("lrReplyName").focus();
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function closeReply() {
    $("lrReplyForm").hidden = true;
    $("lrReplyForm").reset();
  }
  // The suggestion guesses sensible values; the preview shows them before saving.
  function suggestedVariables(template) {
    const guesses = { header: ["org.name"], body: ["contact.name", "lead.product", "org.name", "owner.name"] };
    const out = { header: {}, body: {}, buttons: {} };
    for (const [part, name] of variablesOf(template)) {
      const pool = guesses[part] || [];
      const index = Object.keys(out[part]).length;
      if (pool[index]) out[part][name] = pool[index];
    }
    return out;
  }

  $("lrReplyNew").addEventListener("click", () => openReply({}));
  $("lrReplyCancel").addEventListener("click", closeReply);
  $("lrReplyTemplate").addEventListener("change", () => renderVariables({}));
  $("lrReplyVars").addEventListener("change", (e) => {
    const select = e.target.closest("[data-var-part]");
    if (select) {
      const text = select.parentElement.querySelector("[data-var-text]");
      text.hidden = select.value !== "text:";
      if (!text.hidden) text.focus();
    }
    renderPreview();
  });
  $("lrReplyVars").addEventListener("input", renderPreview);
  $("lrReplyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const templateId = $("lrReplyTemplate").value;
    if (!templateId) return showToast(t("setroute.choose-a-template"), "error");
    const variables = readVariables();
    const missing = variablesOf(templateOf(templateId)).find(([part, name]) => !variables[part][name]);
    if (missing) return showToast(t("setroute.choose-what-fills", { v: missing[2] }), "error");
    const body = {
      name: $("lrReplyName").value.trim(),
      sources: ticked(e.target, "data-src"),
      templateId,
      variables,
      maxAgeMinutes: Number($("lrReplyAge").value) || 0,
      delaySeconds: Number($("lrReplyDelay").value) || 0,
      onlyNewContacts: $("lrReplyOnlyNew").checked,
    };
    const id = $("lrReplyId").value;
    try {
      if (id) await crmApi(`/auto-reply-rules/${id}`, jsonRequest("PATCH", body));
      else await crmApi("/auto-reply-rules", jsonRequest("POST", { ...body, priority: nextPriority(replies) }));
      showToast(id ? t("setroute.auto-reply-saved") : t("setroute.auto-reply-on-the-next-new"), "success");
      closeReply();
      await loadReplies();
    } catch (error) {
      showToast(apiErrorMessage(error, t("setroute.couldn-t-save-the-auto-reply")), "error");
    }
  });

  $("lrReplyList").addEventListener("click", async (e) => {
    const target = (attr) => e.target.closest(`[${attr}]`);
    if (e.target.closest("#lrGoWhatsapp")) {
      e.preventDefault();
      document.querySelector('.settings-tab[data-panel="whatsapp"]')?.click();
      return;
    }
    if (e.target.closest("#lrReplySuggest")) {
      const template = sendable()[0];
      return openReply({ name: t("setroute.welcome-new-enquiries"), templateId: template.id, variables: suggestedVariables(template) });
    }
    const move = target("data-reply-move");
    const edit = target("data-reply-edit");
    const toggle = target("data-reply-toggle");
    const remove = target("data-reply-remove");
    try {
      if (move) await reorder("/auto-reply-rules", replies, move.dataset.id, Number(move.dataset.replyMove));
      else if (edit) return openReply(replies.find((r) => idOf(r.id) === edit.dataset.replyEdit));
      else if (toggle) {
        const rule = replies.find((r) => idOf(r.id) === toggle.dataset.replyToggle);
        await crmApi(`/auto-reply-rules/${rule.id}`, jsonRequest("PATCH", { active: !rule.active }));
        showToast(rule.active ? t("setroute.auto-reply-paused") : t("setroute.auto-reply-on"), "success");
      } else if (remove) {
        if (!confirm(t("setroute.remove-this-auto-reply"))) return;
        await crmApi(`/auto-reply-rules/${remove.dataset.replyRemove}`, { method: "DELETE" });
        showToast(t("setroute.auto-reply-removed"), "success");
      } else return;
    } catch (error) {
      showToast(apiErrorMessage(error, t("gs.failed")), "error");
    }
    await loadReplies();
  });

  // --- loading ------------------------------------------------------------------------
  async function loadRules() {
    try {
      rules = await crmApi("/assignment-rules");
      renderRules();
    } catch (error) {
      $("lrAssignList").innerHTML = failed(error, t("setroute.couldn-t-load-the-assignment-rules"));
    }
  }
  async function loadReplies() {
    try {
      replies = await crmApi("/auto-reply-rules");
      renderReplies();
    } catch (error) {
      $("lrReplyList").innerHTML = failed(error, t("setroute.couldn-t-load-the-auto-replies"));
    }
  }
  async function load() {
    const [h, m, p, t] = await Promise.allSettled([crmApi("/organization/business-hours"), crmApi("/members?limit=100"), crmFetchAll("/products"), crmApi("/templates")]);
    members = m.status === "fulfilled" ? m.value : [];
    products = p.status === "fulfilled" ? p.value : [];
    templates = t.status === "fulfilled" ? t.value : [];
    if (h.status === "fulfilled") {
      hours = h.value;
      renderHours();
    } else {
      $("lrOpenNow").textContent = apiErrorMessage(h.reason, crmI18n.t("setroute.couldn-t-load-the-working-hours"));
    }
    await Promise.all([loadRules(), loadReplies()]);
  }

  // Loaded when the tab is first opened (and again each time, for fresh counters).
  document.getElementById("leadRulesTab").addEventListener("click", load);
  if (new URLSearchParams(window.location.search).get("tab") === "leadrules") load();
})();
