/**
 * automation.js — Sales Automation (Phase 6)
 * Workflows run on the server's automation engine: "when <trigger>, only if <conditions>, then
 * <steps>" (/workflows, /workflows/meta). The run log lists what each workflow did, step by step
 * (/automation-runs); a test run starts a workflow now for one lead (/workflows/:id/run).
 * Sequences send follow-ups per customer on day 0, 2, 5 … and stop when the customer replies
 * (/sequences, /sequence-enrollments). Workflows and sequences share the step editor. The FAQ bot
 * tab is js/automation-bot.js (it hears "automation:tab").
 * Uses app.js: crmReady, cached, crmApi, crmRequest, crmFetchAll, jsonRequest, newIdempotencyKey,
 * escapeHtml, isOrgManager, getCurrentMember, showToast, apiErrorMessage. Everything stays
 * inside this function so no names clash with app.js.
 */
(function salesAutomation() {
  requireAuth();
  renderSidebarUser();
  initSidebarToggle();

  const $ = (id) => document.getElementById(id);
  const T = crmI18n.t;
  const idOf = (value) => String(value || "");
  const manager = isOrgManager();
  const when = (iso) => (iso ? new Date(iso).toLocaleString(crmI18n.locale(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const clone = (value) => JSON.parse(JSON.stringify(value ?? {}));

  let activeTab = "workflows"; // workflows | runs | sequences | bot
  let meta = null; // what the builders offer (GET /workflows/meta)
  let templates = []; // WhatsApp templates (empty without Inbox access)
  let workflows = [];
  let sequences = [];

  // --- labels (text keys: the server keeps English values) --------------------------------
  const STEP_LOOK = {
    "whatsapp.text": ["fa-brands fa-whatsapp"],
    "whatsapp.template": ["fa-brands fa-whatsapp"],
    assign: ["fa-solid fa-user-check"],
    "tag.add": ["fa-solid fa-tag"],
    "tag.remove": ["fa-solid fa-tag"],
    "stage.change": ["fa-solid fa-arrow-right"],
    "task.create": ["fa-solid fa-list-check"],
    "agent.notify": ["fa-solid fa-bell"],
    wait: ["fa-solid fa-hourglass-half"],
    "webhook.call": ["fa-solid fa-plug"],
    "sequence.enroll": ["fa-solid fa-layer-group"],
    "payment.link": ["fa-solid fa-indian-rupee-sign"],
  };
  const stepName = (type, fallback) => (STEP_LOOK[type] ? T(`auto.step.${type}`) : fallback || type);
  const triggerShort = (type) => (crmI18n.has(`auto.short.${type}`) ? T(`auto.short.${type}`) : type);
  const opLabel = (op) => (crmI18n.has(`auto.op.${op}`) ? T(`auto.op.${op}`) : op);
  const VALUE_KEYS = {
    "contact.name": "bc.val.name",
    "contact.company": "bc.val.company",
    "contact.city": "bc.val.city",
    "lead.product": "bc.val.product",
    "owner.name": "auto.val.owner",
    "org.name": "bc.val.org",
    "order.number": "auto.val.orderNumber",
    "order.due": "auto.val.orderDue",
    "quotation.number": "auto.val.quoteNumber",
  };
  const PLACEHOLDERS = ["contact.name", "contact.company", "contact.city", "lead.title", "owner.name", "org.name", "order.number", "order.due", "quotation.number", "task.title", "message.text"];
  // [badge class, text key]: a run's or a step's status, then a customer's in a sequence.
  const RUN_BADGE = {
    running: ["badge-info", "runStatus.running"], waiting: ["badge-warning", "runStatus.waiting"], done: ["badge-success", "runStatus.done"],
    failed: ["badge-danger", "runStatus.failed"], skipped: ["badge-neutral", "runStatus.skipped"], cancelled: ["badge-neutral", "runStatus.cancelled"],
    active: ["badge-info", "auto.in-it-now"], completed: ["badge-success", "enroll.completed"], stopped: ["badge-neutral", "runStatus.cancelled"],
  };
  const badge = (status) => {
    const [cls, key] = RUN_BADGE[status] || ["badge-neutral", ""];
    return `<span class="badge ${cls}">${escapeHtml(key ? T(key) : status)}</span>`;
  };
  const statusLabel = (status) => crmLabel("wfStatus", status);

  const activeMembers = () => cached("members").filter((m) => m.status === "active");
  const canTakeLeads = (m) => ["owner", "admin"].includes(m.role) || (m.modules || []).some((x) => x === "leads" || x === "deals");
  const nameOf = (id) => {
    const member = cached("members").find((m) => idOf(m.id) === idOf(id));
    return member ? member.name || member.email : T("auto.gone");
  };
  const memberOptions = (selected, filter = () => true) =>
    activeMembers().filter(filter).map((m) => `<option value="${escapeHtml(m.id)}" ${idOf(m.id) === idOf(selected) ? "selected" : ""}>${escapeHtml(m.name || m.email)}</option>`).join("");
  const templateOf = (id) => templates.find((t) => idOf(t.id) === idOf(id));
  const sequenceOf = (id) => sequences.find((s) => idOf(s.id) === idOf(id));
  const triggerLabel = (type) => (crmI18n.has(`auto.trigger.${type}`) ? T(`auto.trigger.${type}`) : meta?.triggers.find((tr) => tr.type === type)?.label || triggerShort(type));
  const list = (value) => (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]);
  const clean = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)));
  const query = () => ($("searchInput").value || "").toLowerCase().trim();

  function triggerText(trigger) {
    const p = trigger.params || {};
    const extra = {
      "lead.created": p.sources?.length ? T("auto.tt.from", { list: p.sources.map((x) => crmLabel("source", x)).join(", ") }) : "",
      "message.received": p.keywords?.length ? T("auto.tt.with", { words: p.keywords.map((k) => `"${k}"`).join(T("bc.f.or")) }) : "",
      "lead.stage_changed": [p.fromStages?.length ? T("auto.tt.from", { list: p.fromStages.map((x) => crmLabel("stage", x)).join(" / ") }) : "", p.toStages?.length ? T("auto.tt.to", { list: p.toStages.map((x) => crmLabel("stage", x)).join(" / ") }) : ""].filter(Boolean).join(" "),
      "lead.no_reply": T("auto.tt.hours", { n: p.hours || 24 }),
      "quotation.not_accepted": T("auto.tt.days", { n: p.days || 3 }),
      "payment.overdue": T("auto.tt.days", { n: p.days || 7 }),
      "order.stage_changed": p.toStages?.length ? T("auto.tt.to", { list: p.toStages.map((x) => crmLabel("orderStage", x)).join(" / ") }) : "",
    }[trigger.type];
    return extra ? `${triggerLabel(trigger.type)} · ${extra}` : triggerLabel(trigger.type);
  }

  function stepText(step) {
    const p = step.params || {};
    switch (step.type) {
      case "whatsapp.text": return T("auto.st.text");
      case "whatsapp.template": return T("auto.st.template", { name: templateOf(p.templateId)?.name || "" }).trim();
      case "assign": return T("auto.st.assign", { name: nameOf(p.memberId) });
      case "tag.add": return T("auto.st.tag", { tag: p.tag });
      case "tag.remove": return T("auto.st.untag", { tag: p.tag });
      case "stage.change": return T("auto.st.stage", { stage: crmLabel("stage", p.stage) });
      case "task.create": return T("dash.add.task");
      case "agent.notify": return T("auto.st.notify", { who: p.to === "owner" ? T("auto.who.owner") : p.to === "managers" ? T("auto.who.managers") : nameOf(p.to) });
      case "wait": return T("auto.st.wait", { n: p.amount, unit: T(`auto.unit.${p.unit || "hours"}`) });
      case "webhook.call": return T("auto.st.webhook");
      case "sequence.enroll": return T("auto.st.sequence", { name: sequenceOf(p.sequenceId)?.name || "" }).trim();
      case "payment.link": return T("quotes.act.paylink");
      default: return step.type;
    }
  }

  // ===========================================================================================
  // The step editor (workflows and sequences)
  // ===========================================================================================
  const NEW_STEP = {
    "whatsapp.text": { text: "" },
    "whatsapp.template": { templateId: "", variables: {} },
    assign: { memberId: "" },
    "tag.add": { tag: "" },
    "tag.remove": { tag: "" },
    "stage.change": { stage: "Contacted" },
    "task.create": { get title() { return T("auto.ph.call"); }, dueInDays: 1, assignTo: "owner", priority: "Medium" },
    "agent.notify": { to: "owner", message: "" },
    wait: { amount: 1, unit: "hours" },
    "webhook.call": { url: "" },
    "sequence.enroll": { sequenceId: "" },
    "payment.link": {},
  };

  const placeholderChips = () =>
    `<div class="au-placeholders" aria-label="${escapeHtml(T("auto.insertDetails"))}">${PLACEHOLDERS.map((p) => `<button type="button" data-insert="{{${p}}}">{{${p}}}</button>`).join("")}</div>`;

  function templateVariables(template) {
    if (!template) return [];
    return [
      ...(template.header?.variables || []).map((name) => ["header", name, T("quotes.var.header", { name })]),
      ...template.body.variables.map((name) => ["body", name, T("quotes.var.body", { name })]),
      ...template.buttons.filter((b) => b.variables.length).map((b) => ["buttons", String(b.index), T("quotes.var.button", { text: b.text })]),
    ];
  }

  function variablePickers(template, variables = {}) {
    const values = meta.variableValues.map((v) => [v, VALUE_KEYS[v] ? T(VALUE_KEYS[v]) : v]).concat([["text:", T("bc.val.text")]]);
    return templateVariables(template)
      .map(([part, name, label]) => {
        const spec = variables?.[part]?.[name] || "";
        const isText = String(spec).startsWith("text:");
        const options = values.map(([value, text]) => `<option value="${escapeHtml(value)}" ${spec === value || (value === "text:" && isText) ? "selected" : ""}>${escapeHtml(text)}</option>`).join("");
        return `<div class="au-inline"><label class="mini" style="min-width:150px">${escapeHtml(label)}</label>
          <select data-var-part="${part}" data-var-name="${escapeHtml(name)}"><option value="">${escapeHtml(T("bc.choose"))}</option>${options}</select>
          <input class="grow" type="text" data-var-text maxlength="200" placeholder="${escapeHtml(T("auto.fixedWords"))}" value="${isText ? escapeHtml(spec.slice(5)) : ""}" ${isText ? "" : "hidden"} /></div>`;
      })
      .join("");
  }

  function stepBody(step, { inSequence = false } = {}) {
    const p = step.params || {};
    const hint = (text) => `<p class="au-hint">${text}</p>`;
    switch (step.type) {
      case "whatsapp.text":
        return `<textarea data-p="text" maxlength="4096" placeholder="${escapeHtml(T("auto.ph.text"))}">${escapeHtml(p.text || "")}</textarea>${placeholderChips()}
          ${hint(escapeHtml(T(inSequence ? "auto.hint.textSeq" : "auto.hint.text")))}`;
      case "whatsapp.template": {
        const sendable = templates.filter((tpl) => tpl.sendable);
        if (!templates.length) return hint(escapeHtml(T("auto.hint.noTemplates")));
        const template = templateOf(p.templateId);
        return `<select data-p="templateId" data-rerender><option value="">${escapeHtml(T("quotes.send.chooseTpl"))}</option>${sendable.map((tpl) => `<option value="${escapeHtml(tpl.id)}" ${idOf(tpl.id) === idOf(p.templateId) ? "selected" : ""}>${escapeHtml(tpl.name)} (${escapeHtml(tpl.language)}, ${escapeHtml(tpl.category)})</option>`).join("")}</select>
          ${template ? `<p class="au-hint">${escapeHtml(template.body.text)}</p>` : ""}
          ${variablePickers(template, p.variables)}
          ${hint(escapeHtml(T("auto.hint.template")))}`;
      }
      case "assign":
        return `<select data-p="memberId"><option value="">${escapeHtml(T("auto.choosePerson"))}</option>${memberOptions(p.memberId, canTakeLeads)}</select>
          ${hint(escapeHtml(T("auto.hint.assign")))}`;
      case "tag.add":
      case "tag.remove":
        return `<input type="text" data-p="tag" maxlength="50" placeholder="${escapeHtml(T("auto.ph.tag"))}" value="${escapeHtml(p.tag || "")}" />`;
      case "stage.change":
        return `<div class="au-inline"><select data-p="stage" data-rerender>${meta.leadStages.map((s) => `<option value="${escapeHtml(s)}" ${s === p.stage ? "selected" : ""}>${escapeHtml(crmLabel("stage", s))}</option>`).join("")}</select>
          ${p.stage === "Lost" ? `<input class="grow" type="text" data-p="lostReason" maxlength="500" placeholder="${escapeHtml(T("auto.ph.lost"))}" value="${escapeHtml(p.lostReason || "")}" />` : ""}</div>
          ${hint(escapeHtml(T("auto.hint.won")))}`;
      case "task.create":
        return `<input type="text" data-p="title" maxlength="300" placeholder="${escapeHtml(T("auto.ph.call"))}" value="${escapeHtml(p.title || "")}" />${placeholderChips()}
          <div class="au-inline"><span>${escapeHtml(T("auto.dueIn"))}</span><input type="number" data-p="dueInDays" min="0" max="365" value="${escapeHtml(p.dueInDays ?? 1)}" /><span>${escapeHtml(T("auto.daysFor"))}</span>
            <select data-p="assignTo"><option value="owner">${escapeHtml(T("auto.leadOwner"))}</option>${memberOptions(p.assignTo)}</select>
            <span>${escapeHtml(T("auto.priorityWord"))}</span><select data-p="priority">${["Low", "Medium", "High"].map((x) => `<option value="${x}" ${x === (p.priority || "Medium") ? "selected" : ""}>${escapeHtml(crmLabel("priority", x))}</option>`).join("")}</select></div>`;
      case "agent.notify":
        return `<input type="text" data-p="message" maxlength="500" placeholder="${escapeHtml(T("auto.ph.notify"))}" value="${escapeHtml(p.message || "")}" />${placeholderChips()}
          <div class="au-inline"><span>${escapeHtml(T("auto.who"))}</span><select data-p="to">
            <option value="owner" ${p.to === "owner" || !p.to ? "selected" : ""}>${escapeHtml(T("auto.who.ownerElse"))}</option>
            <option value="managers" ${p.to === "managers" ? "selected" : ""}>${escapeHtml(T("auto.who.managersCap"))}</option>${memberOptions(p.to)}</select></div>
          ${hint(escapeHtml(T("auto.hint.bell")))}`;
      case "wait":
        return `<div class="au-inline"><span>${escapeHtml(T("auto.step.wait"))}</span><input type="number" data-p="amount" min="1" max="999" value="${escapeHtml(p.amount || 1)}" />
          <select data-p="unit">${["minutes", "hours", "days"].map((u) => `<option value="${u}" ${u === (p.unit || "hours") ? "selected" : ""}>${escapeHtml(T(`auto.unit.${u}`))}</option>`).join("")}</select><span>${escapeHtml(T("auto.carryOn"))}</span></div>
          ${hint(escapeHtml(T("auto.hint.wait")))}`;
      case "webhook.call":
        return `<input type="url" data-p="url" maxlength="500" placeholder="https://hooks.zapier.com/…" value="${escapeHtml(p.url || "")}" />
          ${hint(T("auto.hint.webhook"))}`;
      case "sequence.enroll":
        return `<select data-p="sequenceId"><option value="">${escapeHtml(T("auto.chooseSequence"))}</option>${sequences.map((s) => `<option value="${escapeHtml(s.id)}" ${idOf(s.id) === idOf(p.sequenceId) ? "selected" : ""}>${escapeHtml(s.name)}${s.status !== "Active" ? ` (${escapeHtml(statusLabel(s.status))})` : ""}</option>`).join("")}</select>
          ${hint(escapeHtml(T("auto.hint.sequence")))}`;
      case "payment.link":
        return hint(escapeHtml(T("auto.hint.payment")));
      default:
        return "";
    }
  }

  // One editor per list of steps; withDay adds "Day N" to each step (sequences).
  function stepEditor(container, { withDay = false } = {}) {
    let steps = [];

    function render() {
      const total = steps.length;
      container.innerHTML = total
        ? steps
            .map((step, index) => {
              const [icon] = STEP_LOOK[step.type] || ["fa-solid fa-gear"];
              const label = stepName(step.type);
              return `
                <div class="au-step" data-index="${index}" data-type="${escapeHtml(step.type)}">
                  <div class="au-step-head"><span class="step-num">${index + 1}</span>
                    ${withDay ? `<label class="au-day">${escapeHtml(T("auto.day"))} <input type="number" data-day min="0" max="365" value="${escapeHtml(step.day ?? 0)}" aria-label="${escapeHtml(T("auto.day"))}" /></label>` : ""}
                    <i class="${icon} step-icon"></i> ${escapeHtml(label)}
                    <span class="au-step-tools">
                      <button type="button" class="icon-btn" data-move="-1" ${index === 0 ? "disabled" : ""} aria-label="${escapeHtml(T("auto.moveUp"))}"><i class="fa-solid fa-arrow-up"></i></button>
                      <button type="button" class="icon-btn" data-move="1" ${index === total - 1 ? "disabled" : ""} aria-label="${escapeHtml(T("auto.moveDown"))}"><i class="fa-solid fa-arrow-down"></i></button>
                      <button type="button" class="icon-btn danger" data-remove-step aria-label="${escapeHtml(T("auto.removeStep"))}"><i class="fa-solid fa-trash"></i></button>
                    </span>
                  </div>
                  <div class="au-step-body">${stepBody(step, { inSequence: withDay })}</div>
                </div>`;
            })
            .join("")
        : `<div class="dynamic-list-empty">${escapeHtml(T("auto.noSteps"))}</div>`;
    }

    function readStep(card) {
      const params = {};
      card.querySelectorAll("[data-p]").forEach((input) => {
        const value = input.type === "number" ? (input.value === "" ? undefined : Number(input.value)) : input.value.trim();
        if (value !== undefined && value !== "") params[input.dataset.p] = value;
      });
      if (card.dataset.type === "whatsapp.template") {
        const variables = { header: {}, body: {}, buttons: {} };
        card.querySelectorAll("[data-var-part]").forEach((select) => {
          const text = select.parentElement.querySelector("[data-var-text]").value.trim();
          const spec = select.value === "text:" ? (text ? `text:${text}` : "") : select.value;
          if (spec) variables[select.dataset.varPart][select.dataset.varName] = spec;
        });
        params.variables = variables;
      }
      const day = card.querySelector("[data-day]");
      return { ...(day && { day: day.value === "" ? 0 : Number(day.value) }), type: card.dataset.type, params };
    }

    // What is on screen (before anything is drawn again, and on save).
    const read = () => {
      steps = [...container.querySelectorAll(".au-step")].map(readStep);
      return steps;
    };

    container.addEventListener("click", (event) => {
      const card = event.target.closest(".au-step");
      if (!card) return;
      const index = Number(card.dataset.index);
      const insert = event.target.closest("[data-insert]");
      if (insert) {
        const input = card.querySelector('textarea[data-p], input[data-p="title"], input[data-p="message"]');
        if (!input) return;
        const start = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, start) + insert.dataset.insert + input.value.slice(input.selectionEnd ?? start);
        input.focus();
        input.setSelectionRange(start + insert.dataset.insert.length, start + insert.dataset.insert.length);
        return;
      }
      const move = event.target.closest("[data-move]");
      const remove = event.target.closest("[data-remove-step]");
      if (!move && !remove) return;
      read();
      if (remove) steps.splice(index, 1);
      else {
        const to = index + Number(move.dataset.move);
        [steps[index], steps[to]] = [steps[to], steps[index]];
      }
      render();
    });
    container.addEventListener("change", (event) => {
      if (event.target.matches("[data-var-part]")) {
        const text = event.target.parentElement.querySelector("[data-var-text]");
        text.hidden = event.target.value !== "text:";
        if (!text.hidden) text.focus();
        return;
      }
      if (!event.target.matches("[data-rerender]")) return;
      read();
      render();
    });

    return {
      set(list) {
        steps = list.map(clone);
        render();
      },
      read,
      add(type) {
        read();
        const lastDay = steps.length ? Number(steps[steps.length - 1].day) || 0 : -2;
        steps.push({ ...(withDay && { day: lastDay + 2 }), type, params: clone(NEW_STEP[type]) });
        render();
        container.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      },
      // A field the server refused, e.g. "steps.2.params.templateId": show that step.
      point(field) {
        const match = /^steps\.(\d+)/.exec(field || "");
        const target = match ? container.querySelector(`.au-step[data-index="${match[1]}"]`) : null;
        if (!target) return false;
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        target.style.outline = "2px solid var(--danger)";
        setTimeout(() => (target.style.outline = ""), 2500);
        return true;
      },
    };
  }

  const ownerOptions = (selected) => `<option value="">${escapeHtml(T("auto.noOwner"))}</option>${memberOptions(selected)}`;
  const notesHtml = (notes) =>
    notes?.length ? `<strong><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(T("auto.oldSettings"))}</strong><ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : "";

  // ===========================================================================================
  // KPIs and workflow cards
  // ===========================================================================================
  function renderKpis() {
    const sum = (key) => workflows.reduce((total, w) => total + (w.stats?.[key] || 0), 0);
    const inSequences = sequences.reduce((total, s) => total + (s.stats?.active || 0), 0);
    const cards = [
      { label: T("auto.kpi.active"), value: workflows.filter((w) => w.status === "Active").length, cls: "success" },
      { label: T("auto.kpi.runs"), value: sum("runs"), cls: "info" },
      { label: T("auto.kpi.failed"), value: sum("failed"), cls: sum("failed") ? "warning" : "" },
      { label: T("auto.kpi.inSequences"), value: inSequences, cls: "" },
    ];
    $("kpiGrid").innerHTML = cards.map((c) => `<div class="stat-card ${c.cls}"><div class="label">${escapeHtml(c.label)}</div><div class="value">${escapeHtml(String(c.value))}</div></div>`).join("");
  }

  function workflowCard(w) {
    const steps = w.steps || [];
    const s = w.stats || {};
    const conditions = (w.conditions || []).length;
    return `
      <div class="auto-card" data-id="${escapeHtml(w.id)}">
        <div class="auto-card__top">
          <div class="auto-card__icon"><i class="fa-solid fa-bolt"></i></div>
          <div class="auto-card__title-wrap">
            <div class="auto-card__name">${escapeHtml(w.name)}</div>
            <div class="auto-card__owner">${escapeHtml(w.ownerId ? nameOf(w.ownerId) : T("auto.noOwner"))}</div>
          </div>
          <span class="status-pill status-${escapeHtml((w.status || "draft").toLowerCase())}">${escapeHtml(statusLabel(w.status))}</span>
        </div>
        ${w.notes?.length ? `<div class="auto-card__warn" title="${escapeHtml(w.notes.join("\n"))}"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(T("auto.needsLook"))}</div>` : ""}
        <div class="auto-card__trigger">
          <i class="fa-solid fa-bolt-lightning"></i>
          <span>${T("auto.whenTrigger", { trigger: `<strong>${escapeHtml(triggerText(w.trigger))}</strong>` })}</span>
        </div>
        <div class="auto-card__chain">
          ${conditions ? `<span class="chain-chip cond">${escapeHtml(T(conditions === 1 ? "auto.conditions.one" : "auto.conditions.many", { n: conditions }))}</span>` : ""}
          ${steps.length ? steps.map((step) => `<span class="chain-chip">${escapeHtml(stepText(step))}</span>`).join("") : `<span class="chain-chip">${escapeHtml(T("auto.noStepsShort"))}</span>`}
        </div>
        <div class="auto-card__stats">
          <div class="auto-card__stat"><span class="num">${s.runs || 0}</span><span class="lbl">${escapeHtml(T("auto.stat.runs"))}</span></div>
          <div class="auto-card__stat"><span class="num">${s.done || 0}</span><span class="lbl">${escapeHtml(T("auto.stat.finished"))}</span></div>
          <div class="auto-card__stat"><span class="num">${s.failed || 0}</span><span class="lbl">${escapeHtml(T("runStatus.failed"))}</span></div>
        </div>
        <div class="auto-card__foot">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-outline" type="button" data-act="test" ${w.status !== "Active" ? `disabled title="${escapeHtml(T("auto.turnOnFirst"))}"` : ""}><i class="fa-solid fa-play"></i> ${escapeHtml(T("auto.test-run"))}</button>
            <button class="btn btn-outline" type="button" data-act="toggle">${w.status === "Active" ? `<i class="fa-solid fa-pause"></i> ${escapeHtml(T("mkt.pause"))}` : `<i class="fa-solid fa-power-off"></i> ${escapeHtml(T("auto.turnOn"))}`}</button>
          </div>
          <div class="auto-card__actions">
            <button class="icon-btn" type="button" data-act="log" title="${escapeHtml(T("auto.run-log"))}" aria-label="${escapeHtml(T("auto.run-log"))}"><i class="fa-solid fa-clock-rotate-left"></i></button>
            <button class="icon-btn" type="button" data-act="edit" title="${escapeHtml(T("common.edit"))}" aria-label="${escapeHtml(T("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn danger" type="button" data-act="delete" title="${escapeHtml(T("common.delete"))}" aria-label="${escapeHtml(T("common.delete"))}"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      </div>`;
  }

  function renderWorkflows() {
    const q = query();
    const shown = workflows.filter((w) => !q || `${w.name} ${triggerText(w.trigger)} ${nameOf(w.ownerId)}`.toLowerCase().includes(q));
    $("workflowsGrid").innerHTML = shown.length
      ? shown.map(workflowCard).join("")
      : `<div class="empty-state"><i class="fa-solid fa-diagram-project"></i><p>${escapeHtml(T(workflows.length ? "auto.empty.wfSearch" : "auto.empty.wf"))}</p></div>`;
  }

  const upsertIn = (items, item) => {
    const index = items.findIndex((x) => idOf(x.id) === idOf(item.id));
    if (index === -1) items.unshift(item);
    else items[index] = item;
  };

  // Pause / turn on a workflow or a sequence.
  async function toggle(kind, item) {
    const status = item.status === "Active" ? "Paused" : "Active";
    try {
      upsertIn(kind === "workflows" ? workflows : sequences, await crmApi(`/${kind}/${item.id}`, jsonRequest("PATCH", { status })));
      showToast(T(status === "Active" ? "auto.isOn" : "auto.isPaused", { name: item.name }), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, T("auto.err.change")), "error");
    }
    renderAll();
  }

  async function removeItem(kind, item, onDone) {
    if (!confirm(T(kind === "workflows" ? "auto.confirmDeleteWf" : "auto.confirmDeleteSq", { name: item.name }))) return;
    try {
      await crmApi(`/${kind}/${item.id}`, { method: "DELETE" });
      if (kind === "workflows") workflows = workflows.filter((x) => idOf(x.id) !== idOf(item.id));
      else sequences = sequences.filter((x) => idOf(x.id) !== idOf(item.id));
      if (onDone) onDone();
      showToast(T(kind === "workflows" ? "auto.wfDeleted" : "auto.sqDeleted"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, T("common.deleteFailed")), "error");
    }
    renderAll();
  }

  $("workflowsGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    const card = event.target.closest(".auto-card");
    if (!button || !card) return;
    const w = workflows.find((x) => idOf(x.id) === card.dataset.id);
    if (!w) return;
    const act = button.dataset.act;
    if (act === "edit") openBuilder(w.id);
    if (act === "delete") removeItem("workflows", w);
    if (act === "toggle") toggle("workflows", w);
    if (act === "test") openTestRun(w);
    if (act === "log") {
      $("runWorkflowFilter").value = w.id;
      setTab("runs");
    }
  });

  // ===========================================================================================
  // Workflow builder: when / only if / then
  // ===========================================================================================
  let draft = null; // { id, trigger, conditions }
  const wfSteps = stepEditor($("wfSteps"));

  // label: how a value reads (sources and stages are kept in English by the server).
  function checks(name, values, selected, attr = "data-tp", label = (v) => v) {
    const chosen = list(selected);
    return `<div class="au-checks">${values.map((v) => `<label class="au-check"><input type="checkbox" ${attr}="${escapeHtml(name)}" value="${escapeHtml(v)}" ${chosen.includes(v) ? "checked" : ""} /> ${escapeHtml(label(v))}</label>`).join("")}</div>`;
  }

  // --- trigger -------------------------------------------------------------------------------
  function renderTriggerParams() {
    const { type, params = {} } = draft.trigger;
    const hint = (key) => `<p class="au-hint">${escapeHtml(T(key))}</p>`;
    const source = (v) => crmLabel("source", v);
    const stage = (v) => crmLabel("stage", v);
    const html = {
      "lead.created": `${hint("auto.tp.sources")}${checks("sources", meta.sources, params.sources, "data-tp", source)}`,
      "message.received": `<div class="au-inline"><span>${escapeHtml(T("auto.tp.contains"))}</span><input class="grow" type="text" data-tp="keywords" maxlength="600" value="${escapeHtml((params.keywords || []).join(", "))}" placeholder="${escapeHtml(T("auto.tp.keywordsPh"))}" /></div>
        ${hint("auto.tp.keywords")}`,
      "lead.stage_changed": `${hint("auto.tp.movedTo")}${checks("toStages", meta.leadStages, params.toStages, "data-tp", stage)}
        ${hint("auto.tp.movedFrom")}${checks("fromStages", meta.leadStages, params.fromStages, "data-tp", stage)}`,
      "lead.no_reply": `<div class="au-inline"><span>${escapeHtml(T("auto.tp.noReplyFor"))}</span><input type="number" data-tp="hours" min="1" max="720" value="${escapeHtml(params.hours || 24)}" /><span>${escapeHtml(T("auto.tp.hoursAfter"))}</span></div>
        ${hint("auto.tp.noReplyHint")}`,
      "quotation.not_accepted": `<div class="au-inline"><span>${escapeHtml(T("auto.tp.notAccepted"))}</span><input type="number" data-tp="days" min="1" max="90" value="${escapeHtml(params.days || 3)}" /><span>${escapeHtml(T("auto.tp.daysAfterSent"))}</span></div>
        ${hint("auto.tp.quoteHint")}`,
      "order.stage_changed": `${hint("auto.tp.movedTo")}${checks("toStages", meta.orderStages, params.toStages, "data-tp", (v) => crmLabel("orderStage", v))}`,
      "payment.received": hint("auto.tp.payment"),
      "payment.overdue": `<div class="au-inline"><span>${escapeHtml(T("auto.tp.notPaid"))}</span><input type="number" data-tp="days" min="1" max="180" value="${escapeHtml(params.days || 7)}" /><span>${escapeHtml(T("auto.tp.daysAfterOrder"))}</span></div>
        ${hint("auto.tp.overdueHint")}`,
      "task.overdue": hint("auto.tp.task"),
    }[type] || "";
    $("wfTriggerParams").innerHTML = html;
  }

  function readTrigger() {
    const box = $("wfTriggerParams");
    const type = draft.trigger.type;
    const ticked = (name) => [...box.querySelectorAll(`input[data-tp="${name}"]:checked`)].map((input) => input.value);
    const number = (name) => {
      const value = box.querySelector(`[data-tp="${name}"]`)?.value;
      return value === "" || value == null ? undefined : Number(value);
    };
    const params = {};
    if (type === "lead.created") params.sources = ticked("sources");
    if (type === "message.received") params.keywords = (box.querySelector('[data-tp="keywords"]')?.value || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (type === "lead.stage_changed") Object.assign(params, { toStages: ticked("toStages"), fromStages: ticked("fromStages") });
    if (type === "order.stage_changed") params.toStages = ticked("toStages");
    if (type === "lead.no_reply") params.hours = number("hours");
    if (type === "quotation.not_accepted" || type === "payment.overdue") params.days = number("days");
    return { type, params: clean(params) };
  }

  // --- conditions ----------------------------------------------------------------------------
  function conditionRow(condition, index) {
    const def = meta.conditions.find((f) => f.field === condition.field) || meta.conditions[0];
    const op = def.ops.includes(condition.op) ? condition.op : def.ops[0];
    let value = "";
    if (def.field === "source") value = checks("value", meta.sources, condition.value, "data-cv", (v) => crmLabel("source", v));
    if (def.field === "stage") value = checks("value", meta.leadStages, condition.value, "data-cv", (v) => crmLabel("stage", v));
    if (def.field === "tag") value = `<input class="grow" type="text" data-cv-text maxlength="50" placeholder="${escapeHtml(T("auto.ph.condTag"))}" value="${escapeHtml(condition.value || "")}" />`;
    if (def.field === "owner" && (op === "is" || op === "isNot")) value = `<select data-cv-member>${memberOptions(condition.value)}</select>`;
    return `
      <div class="dynamic-row au-inline au-cond" data-index="${index}">
        <select data-cf aria-label="${escapeHtml(T("auto.whatToCheck"))}">${meta.conditions.map((f) => `<option value="${f.field}" ${f.field === def.field ? "selected" : ""}>${escapeHtml(crmI18n.has(`auto.cond.${f.field}`) ? T(`auto.cond.${f.field}`) : f.label)}</option>`).join("")}</select>
        <select data-co aria-label="${escapeHtml(T("auto.how"))}">${def.ops.map((o) => `<option value="${o}" ${o === op ? "selected" : ""}>${escapeHtml(opLabel(o))}</option>`).join("")}</select>
        ${value}
        <button type="button" class="remove-row" data-remove-condition aria-label="${escapeHtml(T("auto.removeCondition"))}"><i class="fa-solid fa-xmark"></i></button>
      </div>`;
  }

  function renderConditions() {
    $("wfConditions").innerHTML = draft.conditions.length
      ? draft.conditions.map(conditionRow).join("")
      : `<div class="dynamic-list-empty">${escapeHtml(T("auto.noConditions"))}</div>`;
  }

  function readConditions() {
    return [...$("wfConditions").querySelectorAll(".au-cond")].map((row) => {
      const field = row.querySelector("[data-cf]").value;
      const op = row.querySelector("[data-co]").value;
      let value;
      if (field === "source" || field === "stage") value = [...row.querySelectorAll("input[data-cv]:checked")].map((input) => input.value);
      if (field === "tag") value = row.querySelector("[data-cv-text]")?.value.trim();
      if (field === "owner" && (op === "is" || op === "isNot")) value = row.querySelector("[data-cv-member]")?.value;
      return { field, op, ...(value !== undefined && { value }) };
    });
  }

  function syncWorkflow() {
    draft.trigger = readTrigger();
    draft.conditions = readConditions();
  }

  function renderSecret(workflow) {
    const box = $("wfSecretBox");
    box.hidden = !workflow?.webhookSecret;
    box.innerHTML = workflow?.webhookSecret
      ? `<strong>${escapeHtml(T("auto.secret"))}</strong> ${escapeHtml(T("auto.secretWho"))}: <code id="wfSecretValue">${escapeHtml(workflow.webhookSecret)}</code>
         <button type="button" class="link-mini" id="wfSecretCopy"><i class="fa-regular fa-copy"></i> ${escapeHtml(T("pl.copy"))}</button>
         <p class="au-hint">${T("auto.secretHint")}</p>`
      : "";
  }

  async function openBuilder(id) {
    let workflow = null;
    if (id) {
      try {
        workflow = await crmApi(`/workflows/${id}`);
      } catch (error) {
        showToast(apiErrorMessage(error, T("auto.err.openWf")), "error");
        return;
      }
    }
    draft = workflow
      ? { id: workflow.id, trigger: workflow.trigger, conditions: workflow.conditions || [] }
      : { id: "", trigger: { type: "lead.created", params: {} }, conditions: [] };
    $("workflowModalTitle").textContent = T(workflow ? "auto.editWf" : "auto.new-workflow");
    $("wfEditId").value = draft.id;
    $("wfName").value = workflow?.name || "";
    $("wfStatus").value = workflow?.status || "Active";
    $("wfOwnerField").hidden = !manager;
    $("wfOwner").innerHTML = ownerOptions(workflow ? workflow.ownerId : getCurrentMember()?.id);
    $("wfTrigger").innerHTML = meta.triggers.map((tr) => `<option value="${tr.type}" ${tr.type === draft.trigger.type ? "selected" : ""}>${escapeHtml(triggerLabel(tr.type))}</option>`).join("");
    $("wfNewStepType").innerHTML = meta.actions.map((a) => `<option value="${a.type}">${escapeHtml(stepName(a.type, a.label))}</option>`).join("");
    $("wfDeleteBtn").style.display = workflow ? "inline-flex" : "none";
    $("wfNotes").hidden = !workflow?.notes?.length;
    $("wfNotes").innerHTML = notesHtml(workflow?.notes);
    renderSecret(workflow);
    renderTriggerParams();
    renderConditions();
    wfSteps.set(workflow ? workflow.steps || [] : [{ type: "agent.notify", params: { to: "owner", message: T("auto.ph.notify") } }]);
    $("workflowModalOverlay").classList.add("open");
    $("wfName").focus();
  }
  const closeBuilder = () => $("workflowModalOverlay").classList.remove("open");

  function pointAt(error, editor) {
    const field = error?.errors?.[0]?.field || "";
    if (editor.point(field)) return;
    const target = /^conditions/.test(field) ? $("wfConditions") : /^trigger/.test(field) ? $("wfTriggerParams") : null;
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  async function saveWorkflow(event) {
    event.preventDefault();
    syncWorkflow();
    const steps = wfSteps.read();
    const name = $("wfName").value.trim();
    if (!name) {
      showToast(T("auto.needWfName"), "error");
      $("wfName").focus();
      return;
    }
    if (!steps.length) {
      showToast(T("auto.needStep"), "error");
      return;
    }
    const body = { name, status: $("wfStatus").value, trigger: draft.trigger, conditions: draft.conditions, steps };
    if (manager) body.ownerId = $("wfOwner").value || null;
    const saveBtn = $("wfSaveBtn");
    saveBtn.disabled = true;
    try {
      const saved = await crmApi(draft.id ? `/workflows/${draft.id}` : "/workflows", jsonRequest(draft.id ? "PATCH" : "POST", body));
      upsertIn(workflows, saved);
      closeBuilder();
      const secretNote = manager && saved.hasWebhook && !$("wfSecretBox").innerHTML ? ` ${T("auto.secretAgain")}` : "";
      showToast(`${T(draft.id ? (saved.status === "Active" ? "auto.wfUpdatedOn" : "auto.wfUpdated") : saved.status === "Active" ? "auto.wfCreatedOn" : "auto.wfCreated")}${secretNote}`, "success");
      renderAll();
    } catch (error) {
      showToast(apiErrorMessage(error, T("auto.err.saveWf")), "error");
      pointAt(error, wfSteps);
    } finally {
      saveBtn.disabled = false;
    }
  }

  $("wfTrigger").addEventListener("change", () => {
    draft.trigger = { type: $("wfTrigger").value, params: {} };
    renderTriggerParams();
  });
  $("wfAddConditionBtn").addEventListener("click", () => {
    syncWorkflow();
    draft.conditions.push({ field: "source", op: "in", value: [] });
    renderConditions();
  });
  $("wfConditions").addEventListener("change", (event) => {
    if (!event.target.matches("[data-cf], [data-co]")) return;
    const row = event.target.closest(".au-cond");
    syncWorkflow();
    const condition = draft.conditions[Number(row.dataset.index)];
    if (event.target.matches("[data-cf]")) {
      const def = meta.conditions.find((f) => f.field === condition.field);
      condition.op = def.ops[0];
      delete condition.value;
    }
    renderConditions();
  });
  $("wfConditions").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-condition]");
    if (!remove) return;
    syncWorkflow();
    draft.conditions.splice(Number(remove.closest(".au-cond").dataset.index), 1);
    renderConditions();
  });
  $("wfAddStepBtn").addEventListener("click", () => wfSteps.add($("wfNewStepType").value));
  $("wfSecretBox").addEventListener("click", (event) => {
    if (!event.target.closest("#wfSecretCopy")) return;
    navigator.clipboard?.writeText($("wfSecretValue").textContent).then(() => showToast(T("auto.secretCopied"), "success"), () => showToast(T("auto.secretSelect"), "info"));
  });
  $("workflowForm").addEventListener("submit", saveWorkflow);
  $("workflowModalClose").addEventListener("click", closeBuilder);
  $("wfCancelBtn").addEventListener("click", closeBuilder);
  $("workflowModalOverlay").addEventListener("click", (event) => {
    if (event.target.id === "workflowModalOverlay") closeBuilder();
  });
  $("wfDeleteBtn").addEventListener("click", () => {
    const w = workflows.find((x) => idOf(x.id) === idOf(draft?.id));
    if (w) removeItem("workflows", w, closeBuilder);
  });

  // ===========================================================================================
  // Run log
  // ===========================================================================================
  let runs = [];
  let runPage = 1;

  function stepsSummary(run) {
    if (run.status === "waiting" && run.nextAt) return T("auto.waitingUntil", { when: when(run.nextAt) });
    const counts = {};
    run.steps.forEach((s) => (counts[s.status] = (counts[s.status] || 0) + 1));
    return Object.entries(counts).map(([status, n]) => `${n} ${RUN_BADGE[status] ? T(RUN_BADGE[status][1]) : status}`).join(" · ") || "—";
  }

  function renderRuns() {
    $("runsBody").innerHTML = runs.length
      ? runs
          .map((run) => `
            <tr data-run="${escapeHtml(run.id)}">
              <td class="muted">${escapeHtml(when(run.createdAt))}</td>
              <td>${escapeHtml(run.workflowName)}</td>
              <td>${escapeHtml(run.subject.label || "—")}</td>
              <td class="muted">${escapeHtml(triggerShort(run.trigger))}</td>
              <td>${badge(run.status)}</td>
              <td class="muted">${escapeHtml(stepsSummary(run))}</td>
            </tr>`)
          .join("")
      : `<tr><td colspan="6"><div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-clock-rotate-left"></i><p>${escapeHtml(T("auto.noRuns"))}</p></div></td></tr>`;
  }

  async function loadRuns({ more = false } = {}) {
    runPage = more ? runPage + 1 : 1;
    const params = new URLSearchParams({ page: String(runPage), limit: "25" });
    if ($("runWorkflowFilter").value) params.set("workflowId", $("runWorkflowFilter").value);
    if ($("runStatusFilter").value) params.set("status", $("runStatusFilter").value);
    try {
      const body = await crmRequest(`/automation-runs?${params}`);
      runs = more ? runs.concat(body.data) : body.data;
      $("runMoreBtn").hidden = !body.pagination?.hasNextPage;
      renderRuns();
    } catch (error) {
      showToast(apiErrorMessage(error, T("auto.err.runs")), "error");
    }
  }

  function fillWorkflowFilter() {
    const select = $("runWorkflowFilter");
    const current = select.value;
    select.innerHTML = `<option value="">${escapeHtml(T("auto.all-workflows"))}</option>${workflows.map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join("")}`;
    select.value = workflows.some((w) => idOf(w.id) === current) ? current : "";
  }

  // --- one run -------------------------------------------------------------------------------
  let shownRun = null;
  let pollTimer = null;

  function eventText(run) {
    const e = run.event || {};
    const bits = [];
    if (e.source) bits.push(T("auto.ev.source", { source: crmLabel("source", e.source) }));
    if (e.from || e.to) bits.push(`${e.from ? crmLabel("stage", e.from) : "?"} → ${e.to ? crmLabel("stage", e.to) : "?"}`);
    if (e.orderNumber) bits.push(T("orders.orderNumber", { number: e.orderNumber }));
    if (e.quotationNumber) bits.push(T("auto.ev.quotation", { number: e.quotationNumber }));
    if (e.hours) bits.push(T("auto.ev.noReply", { n: e.hours }));
    if (e.days) bits.push(T("auto.ev.days", { n: e.days }));
    if (e.startedBy) bits.push(T("auto.ev.startedBy", { name: e.startedBy }));
    if (e.text) bits.push(`"${e.text}"`);
    return bits.join(" · ");
  }

  const stepLog = (steps) =>
    `<ol class="au-runlog">${steps
      .map((s) => `<li>${badge(s.status)}<div><strong>${s.day != null ? `${escapeHtml(T("auto.dayN", { n: s.day }))} · ` : `${s.index + 1}. `}${escapeHtml(stepName(s.type, s.label))}</strong>${s.detail ? `<div class="detail">${escapeHtml(s.detail)}</div>` : ""}</div><span class="when">${escapeHtml(when(s.at))}</span></li>`)
      .join("")}</ol>`;

  function renderRun(run) {
    shownRun = run;
    $("runModalTitle").textContent = run.workflowName || T("auto.run");
    $("runModalSub").textContent = [run.subject.label, triggerShort(run.trigger), T("bc.startedAt", { when: when(run.createdAt) })].filter(Boolean).join(" · ");
    const happened = eventText(run);
    $("runModalBody").innerHTML = `
      <p style="margin:0 0 12px">${badge(run.status)} ${run.finishedAt ? `<span class="au-hint">${escapeHtml(T("auto.finishedAt", { when: when(run.finishedAt) }))}</span>` : ""}</p>
      ${happened ? `<p class="au-hint" style="margin:0 0 12px">${escapeHtml(happened)}</p>` : ""}
      ${run.error ? `<div class="au-run-error">${escapeHtml(run.error)}</div>` : ""}
      ${run.steps.length ? stepLog(run.steps) : `<p class="au-hint">${escapeHtml(T("auto.noStepRun"))}</p>`}`;
    $("runCancelBtn").hidden = !["running", "waiting"].includes(run.status);
    const link = $("runOpenLink");
    link.hidden = !run.subject.contactId;
    if (run.subject.contactId) link.href = `customer-360.html?id=${encodeURIComponent(run.subject.contactId)}`;
  }

  async function openRun(id, { poll = false } = {}) {
    clearTimeout(pollTimer);
    try {
      renderRun(await crmApi(`/automation-runs/${id}`));
    } catch (error) {
      showToast(apiErrorMessage(error, T("auto.err.openRun")), "error");
      return;
    }
    $("runModalOverlay").classList.add("open");
    // A test run: follow it for a little while.
    if (poll) {
      let tries = 0;
      const tick = async () => {
        if (!$("runModalOverlay").classList.contains("open") || idOf(shownRun?.id) !== idOf(id)) return;
        try {
          renderRun(await crmApi(`/automation-runs/${id}`));
        } catch {
          return;
        }
        tries += 1;
        if (shownRun.status === "running" && tries < 15) pollTimer = setTimeout(tick, 1500);
        else refreshAutomations();
      };
      pollTimer = setTimeout(tick, 1200);
    }
  }
  const closeRun = () => {
    clearTimeout(pollTimer);
    $("runModalOverlay").classList.remove("open");
  };

  $("runsBody").addEventListener("click", (event) => {
    const row = event.target.closest("[data-run]");
    if (row) openRun(row.dataset.run);
  });
  $("runCancelBtn").addEventListener("click", async () => {
    if (!shownRun || !confirm(T("auto.confirmStopRun"))) return;
    try {
      renderRun(await crmApi(`/automation-runs/${shownRun.id}/cancel`, { method: "POST" }));
      showToast(T("auto.runStopped"), "success");
      if (activeTab === "runs") loadRuns();
    } catch (error) {
      showToast(apiErrorMessage(error, T("auto.err.stopRun")), "error");
    }
  });
  $("runModalClose").addEventListener("click", closeRun);
  $("runCloseBtn").addEventListener("click", closeRun);
  $("runModalOverlay").addEventListener("click", (event) => {
    if (event.target.id === "runModalOverlay") closeRun();
  });
  $("runWorkflowFilter").addEventListener("change", () => loadRuns());
  $("runStatusFilter").addEventListener("change", () => loadRuns());
  $("runRefreshBtn").addEventListener("click", () => loadRuns());
  $("runMoreBtn").addEventListener("click", () => loadRuns({ more: true }));

  // ===========================================================================================
  // The lead picker: a workflow's test run, or adding a customer to a sequence
  // ===========================================================================================
  let onPick = null;
  let searchTimer = null;

  async function searchLeads() {
    const q = $("testLeadSearch").value.trim();
    const box = $("testLeadResults");
    const params = new URLSearchParams({ limit: "8", sort: "-updatedAt" });
    if (q) params.set("q", q);
    try {
      const leads = await crmApi(`/leads?${params}`);
      box.innerHTML = leads.length
        ? leads
            .map((lead) => `<button type="button" data-lead="${escapeHtml(lead.id)}"><strong>${escapeHtml(lead.contact?.name || lead.title || T("dash.add.lead"))}</strong>
              <span class="sub">${escapeHtml([lead.title, lead.contact?.phone, lead.stage ? crmLabel("stage", lead.stage) : ""].filter(Boolean).join(" · "))}</span></button>`)
            .join("")
        : `<p class="au-hint">${escapeHtml(T("auto.noLead"))}</p>`;
    } catch (error) {
      box.innerHTML = `<p class="au-hint">${escapeHtml(error.status === 403 ? T("auto.needLeads") : apiErrorMessage(error, T("auto.err.searchLeads")))}</p>`;
    }
  }

  function openLeadPicker({ title, subtitle, hint, pick }) {
    onPick = pick;
    $("testModalTitle").textContent = title;
    $("testModalSub").textContent = subtitle;
    $("testModalHint").textContent = hint;
    $("testLeadSearch").value = "";
    $("testLeadResults").innerHTML = "";
    $("testModalOverlay").classList.add("open");
    $("testLeadSearch").focus();
    searchLeads();
  }
  const closeLeadPicker = () => $("testModalOverlay").classList.remove("open");

  const openTestRun = (w) =>
    openLeadPicker({
      title: T("auto.test-run"),
      subtitle: w.name,
      hint: T("auto.testHint"),
      pick: async (leadId) => {
        const run = await crmApi(`/workflows/${w.id}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() },
          body: JSON.stringify({ leadId }),
        });
        closeLeadPicker();
        showToast(T("auto.testStarted"), "success");
        openRun(run.id, { poll: true });
      },
    });

  $("testLeadSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchLeads, 250);
  });
  $("testLeadResults").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-lead]");
    if (!button || !onPick || button.disabled) return;
    button.disabled = true;
    try {
      await onPick(button.dataset.lead);
    } catch (error) {
      showToast(apiErrorMessage(error, T("bc.err.act")), "error");
    } finally {
      button.disabled = false;
    }
  });
  $("testModalClose").addEventListener("click", closeLeadPicker);
  $("testModalOverlay").addEventListener("click", (event) => {
    if (event.target.id === "testModalOverlay") closeLeadPicker();
  });

  async function refreshAutomations() {
    try {
      [workflows, sequences] = await Promise.all([crmFetchAll("/workflows"), crmFetchAll("/sequences")]);
      renderAll();
    } catch {
      /* the cards keep their last numbers */
    }
  }

  // ===========================================================================================
  // Sequences: follow-ups per customer
  // ===========================================================================================
  let sqDraftId = "";
  const sqSteps = stepEditor($("sqSteps"), { withDay: true });

  function sequenceCard(s) {
    const steps = s.steps || [];
    const st = s.stats || {};
    const stops = [s.stopOnReply && T("auto.stop.reply"), s.stopOnClose && T("auto.stop.close")].filter(Boolean).join(T("bc.f.or"));
    return `
      <div class="auto-card" data-id="${escapeHtml(s.id)}">
        <div class="auto-card__top">
          <div class="auto-card__icon"><i class="fa-solid fa-layer-group"></i></div>
          <div class="auto-card__title-wrap">
            <div class="auto-card__name">${escapeHtml(s.name)}</div>
            <div class="auto-card__owner">${escapeHtml(s.ownerId ? nameOf(s.ownerId) : T("auto.noOwner"))}${stops ? ` · ${escapeHtml(T("auto.stopsOn", { what: stops }))}` : ""}</div>
          </div>
          <span class="status-pill status-${escapeHtml((s.status || "draft").toLowerCase())}">${escapeHtml(statusLabel(s.status))}</span>
        </div>
        ${s.notes?.length ? `<div class="auto-card__warn" title="${escapeHtml(s.notes.join("\n"))}"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(T("auto.needsLook"))}</div>` : ""}
        <div class="auto-card__chain">
          ${steps.length ? steps.map((step) => `<span class="chain-chip step">${escapeHtml(T("auto.dayN", { n: step.day }))} · ${escapeHtml(stepText(step))}</span>`).join("") : `<span class="chain-chip step">${escapeHtml(T("auto.noStepsShort"))}</span>`}
        </div>
        <div class="auto-card__stats">
          <div class="auto-card__stat"><span class="num">${st.active || 0}</span><span class="lbl">${escapeHtml(T("auto.in-it-now"))}</span></div>
          <div class="auto-card__stat"><span class="num">${st.completed || 0}</span><span class="lbl">${escapeHtml(T("enroll.completed"))}</span></div>
          <div class="auto-card__stat"><span class="num">${st.stopped || 0}</span><span class="lbl">${escapeHtml(T("runStatus.cancelled"))}</span></div>
        </div>
        <div class="auto-card__foot">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-outline" type="button" data-sq="enroll" ${s.status !== "Active" ? `disabled title="${escapeHtml(T("auto.turnOnFirst"))}"` : ""}><i class="fa-solid fa-user-plus"></i> ${escapeHtml(T("auto.addCustomer"))}</button>
            <button class="btn btn-outline" type="button" data-sq="toggle">${s.status === "Active" ? `<i class="fa-solid fa-pause"></i> ${escapeHtml(T("mkt.pause"))}` : `<i class="fa-solid fa-power-off"></i> ${escapeHtml(T("auto.turnOn"))}`}</button>
          </div>
          <div class="auto-card__actions">
            <button class="icon-btn" type="button" data-sq="people" title="${escapeHtml(T("auto.whoIn"))}" aria-label="${escapeHtml(T("auto.whoIn"))}"><i class="fa-solid fa-users"></i></button>
            <button class="icon-btn" type="button" data-sq="edit" title="${escapeHtml(T("common.edit"))}" aria-label="${escapeHtml(T("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn danger" type="button" data-sq="delete" title="${escapeHtml(T("common.delete"))}" aria-label="${escapeHtml(T("common.delete"))}"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      </div>`;
  }

  function renderSequences() {
    const q = query();
    const shown = sequences.filter((s) => !q || `${s.name} ${nameOf(s.ownerId)}`.toLowerCase().includes(q));
    $("sequencesGrid").innerHTML = shown.length
      ? shown.map(sequenceCard).join("")
      : `<div class="empty-state"><i class="fa-solid fa-layer-group"></i><p>${escapeHtml(T(sequences.length ? "auto.empty.sqSearch" : "auto.empty.sq"))}</p></div>`;
  }

  const enrollCustomer = (s) =>
    openLeadPicker({
      title: T("auto.add-a-customer"),
      subtitle: s.name,
      hint: T("auto.enrollHint"),
      pick: async (leadId) => {
        const enrollment = await crmApi(`/sequences/${s.id}/enroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() },
          body: JSON.stringify({ leadId }),
        });
        closeLeadPicker();
        showToast(T("auto.enrolled", { who: enrollment.label || T("auto.theCustomer"), name: s.name }), "success");
        await refreshAutomations();
        if ($("peopleModalOverlay").classList.contains("open")) loadPeople();
      },
    });

  $("sequencesGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-sq]");
    const card = event.target.closest(".auto-card");
    if (!button || !card) return;
    const s = sequences.find((x) => idOf(x.id) === card.dataset.id);
    if (!s) return;
    const act = button.dataset.sq;
    if (act === "edit") openSequenceModal(s.id);
    if (act === "delete") removeItem("sequences", s);
    if (act === "toggle") toggle("sequences", s);
    if (act === "enroll") enrollCustomer(s);
    if (act === "people") openPeople(s);
  });

  function openSequenceModal(id) {
    const s = id ? sequences.find((x) => idOf(x.id) === idOf(id)) : null;
    sqDraftId = s ? s.id : "";
    $("sequenceModalTitle").textContent = T(s ? "auto.editSq" : "auto.new-sequence");
    $("sqEditId").value = sqDraftId;
    $("sqName").value = s?.name || "";
    $("sqStatus").value = s?.status || "Active";
    $("sqOwnerField").hidden = !manager;
    $("sqOwner").innerHTML = ownerOptions(s ? s.ownerId : getCurrentMember()?.id);
    $("sqStopOnReply").checked = s ? s.stopOnReply : true;
    $("sqStopOnClose").checked = s ? s.stopOnClose : true;
    $("sqWorkingHours").checked = s ? s.workingHoursOnly : true;
    $("sqNewStepType").innerHTML = meta.sequenceSteps.map((type) => `<option value="${type}">${escapeHtml(stepName(type))}</option>`).join("");
    $("sqDeleteBtn").style.display = s ? "inline-flex" : "none";
    $("sqNotes").hidden = !s?.notes?.length;
    $("sqNotes").innerHTML = notesHtml(s?.notes);
    sqSteps.set(s ? s.steps : [{ day: 0, type: "whatsapp.template", params: clone(NEW_STEP["whatsapp.template"]) }, { day: 2, type: "task.create", params: { title: T("auto.ph.call"), dueInDays: 0, assignTo: "owner", priority: "Medium" } }]);
    $("sequenceModalOverlay").classList.add("open");
    $("sqName").focus();
  }
  const closeSequenceModal = () => $("sequenceModalOverlay").classList.remove("open");

  $("sequenceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const steps = sqSteps.read();
    const name = $("sqName").value.trim();
    if (!name) {
      showToast(T("auto.needSqName"), "error");
      $("sqName").focus();
      return;
    }
    if (!steps.length) {
      showToast(T("auto.needStep"), "error");
      return;
    }
    const body = {
      name, status: $("sqStatus").value, steps,
      stopOnReply: $("sqStopOnReply").checked, stopOnClose: $("sqStopOnClose").checked, workingHoursOnly: $("sqWorkingHours").checked,
    };
    if (manager) body.ownerId = $("sqOwner").value || null;
    const saveBtn = $("sqSaveBtn");
    saveBtn.disabled = true;
    try {
      const saved = await crmApi(sqDraftId ? `/sequences/${sqDraftId}` : "/sequences", jsonRequest(sqDraftId ? "PATCH" : "POST", body));
      upsertIn(sequences, saved);
      closeSequenceModal();
      showToast(T(sqDraftId ? (saved.status === "Active" ? "auto.sqUpdatedOn" : "auto.sqUpdated") : saved.status === "Active" ? "auto.sqCreatedOn" : "auto.sqCreated"), "success");
      renderAll();
    } catch (error) {
      showToast(apiErrorMessage(error, T("auto.err.saveSq")), "error");
      sqSteps.point(error?.errors?.[0]?.field);
    } finally {
      saveBtn.disabled = false;
    }
  });
  $("sqAddStepBtn").addEventListener("click", () => sqSteps.add($("sqNewStepType").value));
  $("sequenceModalClose").addEventListener("click", closeSequenceModal);
  $("sqCancelBtn").addEventListener("click", closeSequenceModal);
  $("sequenceModalOverlay").addEventListener("click", (event) => {
    if (event.target.id === "sequenceModalOverlay") closeSequenceModal();
  });
  $("sqDeleteBtn").addEventListener("click", () => {
    const s = sequences.find((x) => idOf(x.id) === idOf(sqDraftId));
    if (s) removeItem("sequences", s, closeSequenceModal);
  });

  // --- who is in a sequence ------------------------------------------------------------------
  let peopleOf = null;
  let people = [];
  let peoplePage = 1;

  function personHtml(e) {
    const by = e.enrolledBy.kind === "workflow" ? e.enrolledBy.name : T("auto.byName", { name: e.enrolledBy.name || T("auto.aTeammate") });
    const next = e.status === "active" && e.nextAt
      ? T("auto.nextStep", { day: peopleOf?.steps?.[e.stepIndex]?.day ?? "?", when: when(e.nextAt) })
      : e.stopReason || e.error || (e.status === "completed" ? T("auto.finishedCap", { when: when(e.finishedAt) }) : "");
    return `
      <div class="au-person" data-enrollment="${escapeHtml(e.id)}">
        <div class="au-person-head">
          <a href="customer-360.html?id=${encodeURIComponent(e.contactId)}">${escapeHtml(e.label || T("orders.customer"))}</a>
          ${badge(e.status)}
          ${e.status === "active" ? `<button class="btn btn-danger-outline" type="button" data-stop>${escapeHtml(T("auto.takeOut"))}</button>` : ""}
        </div>
        <div class="sub">${escapeHtml(T("auto.added", { when: when(e.enrolledAt), by }))}${next ? ` · ${escapeHtml(next)}` : ""}</div>
        ${e.steps.length ? `<details><summary>${escapeHtml(T("auto.stepsDone", { n: e.steps.length }))}</summary>${stepLog(e.steps)}</details>` : ""}
      </div>`;
  }

  async function loadPeople({ more = false } = {}) {
    peoplePage = more ? peoplePage + 1 : 1;
    const params = new URLSearchParams({ page: String(peoplePage), limit: "25" });
    if ($("peopleStatusFilter").value) params.set("status", $("peopleStatusFilter").value);
    try {
      const body = await crmRequest(`/sequences/${peopleOf.id}/enrollments?${params}`);
      people = more ? people.concat(body.data) : body.data;
      $("peopleMoreBtn").hidden = !body.pagination?.hasNextPage;
      $("peopleList").innerHTML = people.length ? people.map(personHtml).join("") : `<p class="au-hint">${escapeHtml(T("auto.nobodyYet"))}</p>`;
    } catch (error) {
      showToast(apiErrorMessage(error, T("auto.err.people")), "error");
    }
  }

  function openPeople(s) {
    peopleOf = s;
    $("peopleModalTitle").textContent = s.name;
    $("peopleModalSub").textContent = T("auto.peopleSub", { active: s.stats?.active || 0, completed: s.stats?.completed || 0, stopped: s.stats?.stopped || 0 });
    $("peopleStatusFilter").value = "";
    $("peopleAddBtn").disabled = s.status !== "Active";
    $("peopleList").innerHTML = "";
    $("peopleModalOverlay").classList.add("open");
    loadPeople();
  }
  const closePeople = () => $("peopleModalOverlay").classList.remove("open");

  $("peopleList").addEventListener("click", async (event) => {
    const stop = event.target.closest("[data-stop]");
    if (!stop) return;
    const id = stop.closest("[data-enrollment]").dataset.enrollment;
    if (!confirm(T("auto.confirmTakeOut"))) return;
    try {
      await crmApi(`/sequence-enrollments/${id}/stop`, { method: "POST" });
      showToast(T("auto.takenOut"), "success");
      await refreshAutomations();
      loadPeople();
    } catch (error) {
      showToast(apiErrorMessage(error, T("auto.err.takeOut")), "error");
    }
  });
  $("peopleStatusFilter").addEventListener("change", () => loadPeople());
  $("peopleMoreBtn").addEventListener("click", () => loadPeople({ more: true }));
  $("peopleAddBtn").addEventListener("click", () => peopleOf && enrollCustomer(peopleOf));
  $("peopleModalClose").addEventListener("click", closePeople);
  $("peopleModalOverlay").addEventListener("click", (event) => {
    if (event.target.id === "peopleModalOverlay") closePeople();
  });

  // ===========================================================================================
  // Tabs and start
  // ===========================================================================================
  function setTab(tab) {
    activeTab = tab;
    const panels = { workflows: "workflowsPanel", runs: "runsPanel", sequences: "sequencesPanel", bot: "botPanel" };
    const buttons = { workflows: "tabWorkflowsBtn", runs: "tabRunsBtn", sequences: "tabSequencesBtn", bot: "tabBotBtn" };
    Object.entries(panels).forEach(([key, panel]) => ($(panel).style.display = key === tab ? "block" : "none"));
    Object.entries(buttons).forEach(([key, button]) => $(button).classList.toggle("active", key === tab));
    const ownList = tab === "runs" || tab === "bot"; // these tabs have their own buttons
    $("searchBox").style.display = ownList ? "none" : "";
    $("addBtn").style.display = ownList ? "none" : "";
    $("addBtnLabel").textContent = T(tab === "sequences" ? "auto.new-sequence" : "auto.new-workflow");
    $("searchInput").placeholder = T(tab === "sequences" ? "auto.searchSq" : "auto.searchWf");
    document.dispatchEvent(new CustomEvent("automation:tab", { detail: tab }));
    if (tab === "bot") {
      renderAll();
    } else if (tab === "runs") {
      fillWorkflowFilter();
      loadRuns();
      renderAll();
    } else {
      // Counts change while the page is open (the engine runs on the server).
      refreshAutomations();
    }
  }

  function renderAll() {
    if (!meta) return;
    renderKpis();
    if (activeTab === "workflows") renderWorkflows();
    if (activeTab === "sequences") renderSequences();
  }

  $("tabWorkflowsBtn").addEventListener("click", () => setTab("workflows"));
  $("tabRunsBtn").addEventListener("click", () => setTab("runs"));
  $("tabSequencesBtn").addEventListener("click", () => setTab("sequences"));
  $("tabBotBtn").addEventListener("click", () => setTab("bot"));
  $("searchInput").addEventListener("input", renderAll);
  $("addBtn").addEventListener("click", () => (activeTab === "sequences" ? openSequenceModal(null) : openBuilder(null)));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if ($("testModalOverlay").classList.contains("open")) closeLeadPicker();
    else if ($("runModalOverlay").classList.contains("open")) closeRun();
    else if ($("peopleModalOverlay").classList.contains("open")) closePeople();
  });

  crmReady(["workflows", "sequences", "members"], () => {
    Promise.all([crmApi("/workflows/meta"), crmApi("/templates").catch(() => [])])
      .then(([vocabulary, items]) => {
        meta = vocabulary;
        templates = items || [];
        workflows = cached("workflows").slice();
        sequences = cached("sequences").slice();
        const tab = new URLSearchParams(window.location.search).get("tab");
        if (tab === "runs" || tab === "sequences" || (tab === "bot" && manager)) setTab(tab);
        else renderAll();
      })
      .catch((error) => showToast(apiErrorMessage(error, T("auto.err.load")), "error"));
  });
})();
