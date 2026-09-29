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
  const SOURCES = ["IndiaMART", "WhatsApp", "Website", "Facebook", "Google Ads", "JustDial", "TradeIndia"];
  const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
  const VALUES = [
    ["contact.name", "Customer's name"],
    ["contact.company", "Customer's company"],
    ["contact.city", "Customer's city"],
    ["lead.product", "Product asked about"],
    ["owner.name", "Name of the person who got the lead"],
    ["org.name", "Your business name"],
    ["text:", "Fixed words…"],
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
    return member ? member.name || member.email : "someone no longer in the team";
  };
  const productName = (id) => products.find((p) => idOf(p.id) === idOf(id))?.name || "a removed product";
  const templateOf = (id) => templates.find((t) => idOf(t.id) === idOf(id));
  const list = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);
  const checks = (items, attr, selected) =>
    items.map(([value, label]) => `<label class="ls-check"><input type="checkbox" ${attr}="${escapeHtml(value)}" ${selected.includes(value) ? "checked" : ""} /> ${escapeHtml(label)}</label>`).join("");
  const ticked = (container, attr) => [...container.querySelectorAll(`[${attr}]:checked`)].map((box) => box.getAttribute(attr));
  const activeBadge = (active) => (active ? '<span class="badge badge-success">On</span>' : '<span class="badge badge-warning">Paused</span>');
  const ruleButtons = (kind, rule, index, count) => `
      <div class="order">
        <button class="icon-btn" type="button" data-${kind}-move="-1" data-id="${escapeHtml(rule.id)}" title="Try earlier" ${index === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
        <button class="icon-btn" type="button" data-${kind}-move="1" data-id="${escapeHtml(rule.id)}" title="Try later" ${index === count - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
      </div>`;
  const actionButtons = (kind, rule) => `
      <div class="ls-actions" style="margin-top:0">
        <button class="btn btn-outline" type="button" data-${kind}-edit="${escapeHtml(rule.id)}">Edit</button>
        <button class="btn btn-outline" type="button" data-${kind}-toggle="${escapeHtml(rule.id)}">${rule.active ? "Pause" : "Turn on"}</button>
        <button class="icon-btn danger" type="button" data-${kind}-remove="${escapeHtml(rule.id)}" title="Remove"><i class="fa-solid fa-trash"></i></button>
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
    $("lrDays").innerHTML = DAYS.map(([day, label]) => `<label class="ls-check"><input type="checkbox" data-day="${day}" ${hours.days.includes(day) ? "checked" : ""} /> ${label}</label>`).join("");
    $("lrStart").value = hours.start;
    $("lrEnd").value = hours.end;
    $("lrTz").value = hours.timezone;
    $("lrOpenNow").innerHTML = hours.openNow ? '<span class="badge badge-success">Open now</span>' : '<span class="badge badge-neutral">Closed now</span>';
  }
  $("lrHoursForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const days = ticked($("lrDays"), "data-day").map(Number);
    if (!days.length) return showToast("Tick at least one working day.", "error");
    try {
      hours = await crmApi("/organization/business-hours", jsonRequest("PUT", { days, start: $("lrStart").value, end: $("lrEnd").value, timezone: $("lrTz").value.trim() || "Asia/Kolkata" }));
      renderHours();
      renderRules();
      showToast("Working hours saved.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the working hours."), "error");
    }
  });

  // --- assignment rules ----------------------------------------------------------------
  function conditionText(c) {
    const parts = [c.sources.length ? c.sources.join(", ") : "any source"];
    if (c.productIds.length) parts.push(`for ${c.productIds.map(productName).join(", ")}`);
    if (c.states.length) parts.push(`in ${c.states.join(", ")}`);
    if (c.cities.length) parts.push(`in ${c.cities.join(", ")}`);
    return parts.join(" · ");
  }
  function ruleHtml(rule, index) {
    const people = rule.memberIds.map(nameOf);
    const who = rule.strategy === "specific" ? `always ${people[0]}${people.length > 1 ? ` (then ${people.slice(1).join(", ")})` : ""}` : `in turns: ${people.join(", ")}`;
    const fallback = rule.fallbackMemberId ? nameOf(rule.fallbackMemberId) : "";
    const outside = rule.respectWorkingHours ? `Outside working hours: ${fallback || "nobody (the lead stays unassigned)"}.` : fallback ? `If nobody above can take leads: ${fallback}.` : "";
    return `
      <div class="lr-rule">
        ${ruleButtons("assign", rule, index, rules.length)}
        <div class="info">
          <div class="name">${index + 1}. ${escapeHtml(rule.name || "Unnamed rule")} ${activeBadge(rule.active)}</div>
          <div class="sub">Leads from ${escapeHtml(conditionText(rule.conditions))} → ${escapeHtml(who)}</div>
          ${outside ? `<div class="sub">${escapeHtml(outside)}</div>` : ""}
          <div class="sub">${rule.stats?.assigned || 0} lead${rule.stats?.assigned === 1 ? "" : "s"} given${rule.stats?.lastAssignedAt ? ` · last ${escapeHtml(when(rule.stats.lastAssignedAt))}` : ""}</div>
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
          <div class="info" style="flex:1;min-width:0"><div class="name"><i class="fa-solid fa-lightbulb"></i> Suggestion</div>
            <div class="sub">Give every new lead, from any source, in turns to ${people.length === 1 ? escapeHtml(people[0].name || people[0].email) : `the ${people.length} people who can take leads (${escapeHtml(people.map((m) => m.name || m.email).join(", "))})`}.</div></div>
          <button class="btn btn-primary" type="button" id="lrAssignSuggest">Use this</button>
        </div>`
      : '<p class="settings-hint" style="margin:0">No rules yet: new leads stay unassigned.</p>';
  }

  function openRule(rule) {
    const form = $("lrAssignForm");
    const c = rule.conditions || { sources: [], productIds: [], states: [], cities: [] };
    $("lrAssignId").value = rule.id || "";
    $("lrAssignName").value = rule.name || "";
    $("lrAssignSources").innerHTML = checks(SOURCES.map((s) => [s, s]), "data-src", c.sources);
    $("lrAssignProducts").innerHTML = products.length
      ? `<div class="lr-picks">${checks(products.map((p) => [idOf(p.id), p.name]), "data-product", c.productIds.map(idOf))}</div>`
      : '<p class="sub">No products yet (Products page). Without products the rule fits any product.</p>';
    $("lrAssignStates").value = c.states.join(", ");
    $("lrAssignCities").value = c.cities.join(", ");
    form.querySelector(`[name="lrStrategy"][value="${rule.strategy || "round_robin"}"]`).checked = true;
    // Everyone who can take leads, plus anyone already in the rule who no longer can.
    const chosen = (rule.memberIds || []).map(idOf);
    const shown = members.filter((m) => canTakeLeads(m) || chosen.includes(idOf(m.id)));
    $("lrAssignMembers").innerHTML = shown.length
      ? `<div class="lr-picks">${shown
          .map((m) => `<label class="ls-check"><input type="checkbox" data-member="${escapeHtml(idOf(m.id))}" ${chosen.includes(idOf(m.id)) ? "checked" : ""} /> ${escapeHtml(m.name || m.email)}${canTakeLeads(m) ? "" : ' <span class="sub">(cannot take leads now)</span>'}</label>`)
          .join("")}</div>`
      : '<p class="sub">Nobody in the team can open Leads yet.</p>';
    $("lrAssignHours").checked = Boolean(rule.respectWorkingHours);
    $("lrAssignFallback").innerHTML =
      '<option value="">Nobody (the lead stays unassigned)</option>' +
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
    if (!memberIds.length) return showToast("Tick at least one person.", "error");
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
      showToast(id ? "Rule saved." : "Rule added. It decides the next new lead.", "success");
      closeRule();
      await loadRules();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the rule."), "error");
    }
  });

  $("lrAssignList").addEventListener("click", async (e) => {
    const target = (attr) => e.target.closest(`[${attr}]`);
    if (e.target.closest("#lrAssignSuggest")) {
      const people = takers();
      return openRule({ name: people.length === 1 ? "Every new lead" : "Everyone in turns", strategy: "round_robin", memberIds: people.map((m) => m.id) });
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
        showToast(rule.active ? "Rule paused." : "Rule on.", "success");
      } else if (remove) {
        if (!confirm("Remove this rule? Leads it already gave keep their owner.")) return;
        await crmApi(`/assignment-rules/${remove.dataset.assignRemove}`, { method: "DELETE" });
        showToast("Rule removed.", "success");
      } else return;
    } catch (error) {
      showToast(apiErrorMessage(error, "That didn't work."), "error");
    }
    await loadRules();
  });

  // --- auto-reply rules -----------------------------------------------------------------
  const sendable = () => templates.filter((t) => t.sendable);
  // Variables of a template: [part, name, label] in the order WhatsApp shows them.
  function variablesOf(template) {
    if (!template) return [];
    return [
      ...(template.header?.variables || []).map((name) => ["header", name, `{{${name}}} in the heading`]),
      ...template.body.variables.map((name) => ["body", name, `{{${name}}} in the message`]),
      ...template.buttons.filter((b) => b.variables.length).map((b) => ["buttons", String(b.index), `The end of the "${b.text}" button link`]),
    ];
  }
  const specText = (spec) => (String(spec).startsWith("text:") ? `"${String(spec).slice(5)}"` : valueLabel[spec] || spec);

  function replyHtml(rule, index) {
    const template = templateOf(rule.templateId);
    const problem = !template ? "The template was removed: this rule sends nothing." : !template.sendable ? `The template cannot be sent: ${template.notSendableReason}` : "";
    const s = rule.stats || {};
    const extras = [rule.onlyNewContacts ? "only people new to the CRM" : "also repeat enquiries", rule.maxAgeMinutes ? `not for enquiries older than ${rule.maxAgeMinutes} min` : "", rule.delaySeconds ? `waits ${rule.delaySeconds} s` : ""].filter(Boolean);
    return `
      <div class="lr-rule">
        ${ruleButtons("reply", rule, index, replies.length)}
        <div class="info">
          <div class="name">${index + 1}. ${escapeHtml(rule.name || "Auto-reply")} ${activeBadge(rule.active)}</div>
          <div class="sub">Leads from ${escapeHtml(rule.sources.length ? rule.sources.join(", ") : "any source")} → template <strong>${escapeHtml(template ? template.name : "?")}</strong>${template ? ` (${escapeHtml(template.language)})` : ""} · ${escapeHtml(extras.join(" · "))}</div>
          ${problem ? `<div class="sub" style="color:var(--danger)">${escapeHtml(problem)}</div>` : ""}
          <div class="sub">${s.sent || 0} sent · ${s.skipped || 0} skipped · ${s.failed || 0} failed${s.lastSentAt ? ` · last ${escapeHtml(when(s.lastSentAt))}` : ""}</div>
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
          <div class="info" style="flex:1;min-width:0"><div class="name"><i class="fa-solid fa-lightbulb"></i> Suggestion</div>
            <div class="sub">Greet every new enquiry on WhatsApp with your approved template <strong>${escapeHtml(first.name)}</strong>.</div></div>
          <button class="btn btn-primary" type="button" id="lrReplySuggest">Use this</button>
        </div>`
      : `<p class="settings-hint" style="margin:0">An auto-reply needs a WhatsApp template approved by Meta.
          <a href="#" id="lrGoWhatsapp">Settings → WhatsApp → Message templates</a></p>`;
  }

  function renderVariables(rule = {}) {
    const template = templateOf($("lrReplyTemplate").value);
    const vars = variablesOf(template);
    const options = (selected) => VALUES.map(([value, label]) => `<option value="${value}" ${selected === value || (value === "text:" && String(selected).startsWith("text:")) ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
    $("lrReplyVars").innerHTML = vars.length
      ? vars
          .map(([part, name, label]) => {
            const spec = rule.variables?.[part]?.[name] || "";
            const isText = String(spec).startsWith("text:");
            return `<div class="field lr-var"><label>${escapeHtml(label)}</label>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <select data-var-part="${part}" data-var-name="${escapeHtml(name)}"><option value="">Choose…</option>${options(spec)}</select>
                <input type="text" data-var-text maxlength="200" placeholder="The fixed words" value="${isText ? escapeHtml(spec.slice(5)) : ""}" ${isText ? "" : "hidden"} style="flex:1;min-width:160px" />
              </div></div>`;
          })
          .join("") + '<p class="sub" style="margin:-4px 0 12px">A customer without that value (for example no company) gets no auto-reply; the lead says why.</p>'
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
      box.innerHTML = '<p class="sub" style="margin:0">Choose a template.</p>';
      return;
    }
    const vars = readVariables();
    const fill = (text, part) =>
      String(text || "").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) => {
        const spec = vars[part]?.[name];
        return spec ? (spec.startsWith("text:") ? spec.slice(5) : `[${valueLabel[spec]}]`) : match;
      });
    const buttons = template.buttons.map((b) => b.text).filter(Boolean);
    box.innerHTML = `<div>${template.header?.text ? `<strong>${escapeHtml(fill(template.header.text, "header"))}</strong>\n` : ""}${escapeHtml(fill(template.body.text, "body"))}${template.footer ? `\n<span class="sub">${escapeHtml(template.footer)}</span>` : ""}${buttons.length ? `\n<span class="sub">${buttons.map((b) => `[${escapeHtml(b)}]`).join(" ")}</span>` : ""}</div>`;
  }

  function openReply(rule) {
    const form = $("lrReplyForm");
    $("lrReplyId").value = rule.id || "";
    $("lrReplyName").value = rule.name || "";
    $("lrReplySources").innerHTML = checks(SOURCES.map((s) => [s, s]), "data-src", rule.sources || []);
    const current = idOf(rule.templateId);
    $("lrReplyTemplate").innerHTML =
      '<option value="">Choose a template…</option>' +
      (current && !templateOf(current) ? '<option value="" selected disabled>(the template was removed)</option>' : "") +
      templates
        .map((t) => `<option value="${escapeHtml(idOf(t.id))}" ${idOf(t.id) === current ? "selected" : ""} ${t.sendable ? "" : "disabled"}>${escapeHtml(t.name)} (${escapeHtml(t.language)})${t.sendable ? "" : ` — ${escapeHtml(t.status === "APPROVED" ? "cannot be sent" : t.status.toLowerCase())}`}</option>`)
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
    if (!templateId) return showToast("Choose a template.", "error");
    const variables = readVariables();
    const missing = variablesOf(templateOf(templateId)).find(([part, name]) => !variables[part][name]);
    if (missing) return showToast(`Choose what fills: ${missing[2]}.`, "error");
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
      showToast(id ? "Auto-reply saved." : "Auto-reply on. The next new enquiry gets it.", "success");
      closeReply();
      await loadReplies();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the auto-reply."), "error");
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
      return openReply({ name: "Welcome new enquiries", templateId: template.id, variables: suggestedVariables(template) });
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
        showToast(rule.active ? "Auto-reply paused." : "Auto-reply on.", "success");
      } else if (remove) {
        if (!confirm("Remove this auto-reply?")) return;
        await crmApi(`/auto-reply-rules/${remove.dataset.replyRemove}`, { method: "DELETE" });
        showToast("Auto-reply removed.", "success");
      } else return;
    } catch (error) {
      showToast(apiErrorMessage(error, "That didn't work."), "error");
    }
    await loadReplies();
  });

  // --- loading ------------------------------------------------------------------------
  async function loadRules() {
    try {
      rules = await crmApi("/assignment-rules");
      renderRules();
    } catch (error) {
      $("lrAssignList").innerHTML = failed(error, "Couldn't load the assignment rules.");
    }
  }
  async function loadReplies() {
    try {
      replies = await crmApi("/auto-reply-rules");
      renderReplies();
    } catch (error) {
      $("lrReplyList").innerHTML = failed(error, "Couldn't load the auto-replies.");
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
      $("lrOpenNow").textContent = apiErrorMessage(h.reason, "Couldn't load the working hours.");
    }
    await Promise.all([loadRules(), loadReplies()]);
  }

  // Loaded when the tab is first opened (and again each time, for fresh counters).
  document.getElementById("leadRulesTab").addEventListener("click", load);
  if (new URLSearchParams(window.location.search).get("tab") === "leadrules") load();
})();
