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
  const idOf = (value) => String(value || "");
  const manager = isOrgManager();
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const clone = (value) => JSON.parse(JSON.stringify(value ?? {}));

  let activeTab = "workflows"; // workflows | runs | sequences | bot
  let meta = null; // what the builders offer (GET /workflows/meta)
  let templates = []; // WhatsApp templates (empty without Inbox access)
  let workflows = [];
  let sequences = [];

  // --- labels ------------------------------------------------------------------------------
  const STEP_LOOK = {
    "whatsapp.text": ["fa-brands fa-whatsapp", "Send a WhatsApp message"],
    "whatsapp.template": ["fa-brands fa-whatsapp", "Send a WhatsApp template"],
    assign: ["fa-solid fa-user-check", "Give the lead to someone"],
    "tag.add": ["fa-solid fa-tag", "Add a tag to the customer"],
    "tag.remove": ["fa-solid fa-tag", "Remove a tag"],
    "stage.change": ["fa-solid fa-arrow-right", "Move the lead to a stage"],
    "task.create": ["fa-solid fa-list-check", "Create a task"],
    "agent.notify": ["fa-solid fa-bell", "Notify someone in the CRM"],
    wait: ["fa-solid fa-hourglass-half", "Wait"],
    "webhook.call": ["fa-solid fa-plug", "Call a webhook"],
    "sequence.enroll": ["fa-solid fa-layer-group", "Add the customer to a sequence"],
    "payment.link": ["fa-solid fa-indian-rupee-sign", "Send the order's payment link"],
  };
  const TRIGGER_SHORT = {
    "lead.created": "New lead",
    "message.received": "WhatsApp message",
    "lead.stage_changed": "Stage change",
    "lead.no_reply": "No reply",
    "quotation.not_accepted": "Quote not accepted",
    "order.stage_changed": "Order stage",
    "payment.received": "Payment",
    "payment.overdue": "Not paid",
    "task.overdue": "Overdue task",
    manual: "Test run",
  };
  const OP_LABELS = {
    in: "is one of", notIn: "is not one of", has: "has", hasNot: "does not have", is: "is", isNot: "is not",
    none: "is nobody yet", any: "is someone", open: "we are open", closed: "we are closed",
  };
  const VALUE_LABELS = {
    "contact.name": "Customer's name",
    "contact.company": "Customer's company",
    "contact.city": "Customer's city",
    "lead.product": "Lead title (product)",
    "owner.name": "Name of the lead's owner",
    "org.name": "Your business name",
    "order.number": "Order number",
    "order.due": "Amount still due on the order",
    "quotation.number": "Quotation number",
  };
  const PLACEHOLDERS = ["contact.name", "contact.company", "contact.city", "lead.title", "owner.name", "org.name", "order.number", "order.due", "quotation.number", "task.title", "message.text"];
  const RUN_BADGE = {
    running: ["badge-info", "Running"], waiting: ["badge-warning", "Waiting"], done: ["badge-success", "Done"],
    failed: ["badge-danger", "Failed"], skipped: ["badge-neutral", "Skipped"], cancelled: ["badge-neutral", "Stopped"],
    active: ["badge-info", "In it now"], completed: ["badge-success", "Completed"], stopped: ["badge-neutral", "Stopped"],
  };
  const badge = (status) => {
    const [cls, label] = RUN_BADGE[status] || ["badge-neutral", status];
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
  };

  const activeMembers = () => cached("members").filter((m) => m.status === "active");
  const canTakeLeads = (m) => ["owner", "admin"].includes(m.role) || (m.modules || []).some((x) => x === "leads" || x === "deals");
  const nameOf = (id) => {
    const member = cached("members").find((m) => idOf(m.id) === idOf(id));
    return member ? member.name || member.email : "someone no longer in the team";
  };
  const memberOptions = (selected, filter = () => true) =>
    activeMembers().filter(filter).map((m) => `<option value="${escapeHtml(m.id)}" ${idOf(m.id) === idOf(selected) ? "selected" : ""}>${escapeHtml(m.name || m.email)}</option>`).join("");
  const templateOf = (id) => templates.find((t) => idOf(t.id) === idOf(id));
  const sequenceOf = (id) => sequences.find((s) => idOf(s.id) === idOf(id));
  const triggerLabel = (type) => meta?.triggers.find((t) => t.type === type)?.label || TRIGGER_SHORT[type] || type;
  const list = (value) => (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]);
  const clean = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)));
  const query = () => ($("searchInput").value || "").toLowerCase().trim();

  function triggerText(trigger) {
    const p = trigger.params || {};
    const extra = {
      "lead.created": p.sources?.length ? `from ${p.sources.join(", ")}` : "",
      "message.received": p.keywords?.length ? `with ${p.keywords.map((k) => `"${k}"`).join(" or ")}` : "",
      "lead.stage_changed": [p.fromStages?.length ? `from ${p.fromStages.join(" / ")}` : "", p.toStages?.length ? `to ${p.toStages.join(" / ")}` : ""].filter(Boolean).join(" "),
      "lead.no_reply": `${p.hours || 24} hours`,
      "quotation.not_accepted": `${p.days || 3} days`,
      "payment.overdue": `${p.days || 7} days`,
      "order.stage_changed": p.toStages?.length ? `to ${p.toStages.join(" / ")}` : "",
    }[trigger.type];
    return extra ? `${triggerLabel(trigger.type)} · ${extra}` : triggerLabel(trigger.type);
  }

  function stepText(step) {
    const p = step.params || {};
    switch (step.type) {
      case "whatsapp.text": return "WhatsApp message";
      case "whatsapp.template": return `Template ${templateOf(p.templateId)?.name || ""}`.trim();
      case "assign": return `Give to ${nameOf(p.memberId)}`;
      case "tag.add": return `Tag "${p.tag}"`;
      case "tag.remove": return `Untag "${p.tag}"`;
      case "stage.change": return `Stage → ${p.stage}`;
      case "task.create": return "Task";
      case "agent.notify": return `Notify ${p.to === "owner" ? "the owner" : p.to === "managers" ? "owners & admins" : nameOf(p.to)}`;
      case "wait": return `Wait ${p.amount} ${p.unit || "hours"}`;
      case "webhook.call": return "Webhook";
      case "sequence.enroll": return `Sequence ${sequenceOf(p.sequenceId)?.name || ""}`.trim();
      case "payment.link": return "Payment link";
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
    "task.create": { title: "Call {{contact.name}}", dueInDays: 1, assignTo: "owner", priority: "Medium" },
    "agent.notify": { to: "owner", message: "" },
    wait: { amount: 1, unit: "hours" },
    "webhook.call": { url: "" },
    "sequence.enroll": { sequenceId: "" },
    "payment.link": {},
  };

  const placeholderChips = () =>
    `<div class="au-placeholders" aria-label="Insert customer details">${PLACEHOLDERS.map((p) => `<button type="button" data-insert="{{${p}}}">{{${p}}}</button>`).join("")}</div>`;

  function templateVariables(template) {
    if (!template) return [];
    return [
      ...(template.header?.variables || []).map((name) => ["header", name, `{{${name}}} in the heading`]),
      ...template.body.variables.map((name) => ["body", name, `{{${name}}} in the message`]),
      ...template.buttons.filter((b) => b.variables.length).map((b) => ["buttons", String(b.index), `The end of the "${b.text}" button link`]),
    ];
  }

  function variablePickers(template, variables = {}) {
    const values = meta.variableValues.map((v) => [v, VALUE_LABELS[v] || v]).concat([["text:", "Fixed words…"]]);
    return templateVariables(template)
      .map(([part, name, label]) => {
        const spec = variables?.[part]?.[name] || "";
        const isText = String(spec).startsWith("text:");
        const options = values.map(([value, text]) => `<option value="${escapeHtml(value)}" ${spec === value || (value === "text:" && isText) ? "selected" : ""}>${escapeHtml(text)}</option>`).join("");
        return `<div class="au-inline"><label class="mini" style="min-width:150px">${escapeHtml(label)}</label>
          <select data-var-part="${part}" data-var-name="${escapeHtml(name)}"><option value="">Choose…</option>${options}</select>
          <input class="grow" type="text" data-var-text maxlength="200" placeholder="The fixed words (may use {{contact.name}})" value="${isText ? escapeHtml(spec.slice(5)) : ""}" ${isText ? "" : "hidden"} /></div>`;
      })
      .join("");
  }

  function stepBody(step, { inSequence = false } = {}) {
    const p = step.params || {};
    const hint = (text) => `<p class="au-hint">${text}</p>`;
    switch (step.type) {
      case "whatsapp.text":
        return `<textarea data-p="text" maxlength="4096" placeholder="Namaste {{contact.name}}, thank you for your enquiry…">${escapeHtml(p.text || "")}</textarea>${placeholderChips()}
          ${hint(inSequence
            ? "Goes only if the customer wrote to you in the last 24 hours (WhatsApp's rule), otherwise this step is skipped: for follow-ups days later, use a template step."
            : "Goes only if the customer wrote to you in the last 24 hours (WhatsApp's rule); otherwise this step is skipped. To reach anyone, use a template step.")}`;
      case "whatsapp.template": {
        const sendable = templates.filter((t) => t.sendable);
        if (!templates.length) return hint("No WhatsApp templates here: connect a number and sync templates in Settings → WhatsApp (or ask for Inbox access).");
        const template = templateOf(p.templateId);
        return `<select data-p="templateId" data-rerender><option value="">Choose a template…</option>${sendable.map((t) => `<option value="${escapeHtml(t.id)}" ${idOf(t.id) === idOf(p.templateId) ? "selected" : ""}>${escapeHtml(t.name)} (${escapeHtml(t.language)}, ${escapeHtml(t.category)})</option>`).join("")}</select>
          ${template ? `<p class="au-hint">${escapeHtml(template.body.text)}</p>` : ""}
          ${variablePickers(template, p.variables)}
          ${hint("Approved templates can be sent any time. Marketing templates skip customers who opted out.")}`;
      }
      case "assign":
        return `<select data-p="memberId"><option value="">Choose a person…</option>${memberOptions(p.memberId, canTakeLeads)}</select>
          ${hint("The lead, the customer (if nobody has them yet) and their unassigned WhatsApp chats go to this person.")}`;
      case "tag.add":
      case "tag.remove":
        return `<input type="text" data-p="tag" maxlength="50" placeholder="e.g. VIP" value="${escapeHtml(p.tag || "")}" />`;
      case "stage.change":
        return `<div class="au-inline"><select data-p="stage" data-rerender>${meta.leadStages.map((s) => `<option ${s === p.stage ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select>
          ${p.stage === "Lost" ? `<input class="grow" type="text" data-p="lostReason" maxlength="500" placeholder="Why it is lost" value="${escapeHtml(p.lostReason || "")}" />` : ""}</div>
          ${hint("Won also makes the contact a customer, as when a person does it.")}`;
      case "task.create":
        return `<input type="text" data-p="title" maxlength="300" placeholder="Call {{contact.name}}" value="${escapeHtml(p.title || "")}" />${placeholderChips()}
          <div class="au-inline"><span>Due in</span><input type="number" data-p="dueInDays" min="0" max="365" value="${escapeHtml(p.dueInDays ?? 1)}" /><span>days, for</span>
            <select data-p="assignTo"><option value="owner">the lead's owner</option>${memberOptions(p.assignTo)}</select>
            <span>priority</span><select data-p="priority">${["Low", "Medium", "High"].map((x) => `<option ${x === (p.priority || "Medium") ? "selected" : ""}>${x}</option>`).join("")}</select></div>`;
      case "agent.notify":
        return `<input type="text" data-p="message" maxlength="500" placeholder="New lead: {{contact.name}}" value="${escapeHtml(p.message || "")}" />${placeholderChips()}
          <div class="au-inline"><span>Who</span><select data-p="to">
            <option value="owner" ${p.to === "owner" || !p.to ? "selected" : ""}>The lead's owner (else owners and admins)</option>
            <option value="managers" ${p.to === "managers" ? "selected" : ""}>Owners and admins</option>${memberOptions(p.to)}</select></div>
          ${hint("Shows under the bell at the top of every page.")}`;
      case "wait":
        return `<div class="au-inline"><span>Wait</span><input type="number" data-p="amount" min="1" max="999" value="${escapeHtml(p.amount || 1)}" />
          <select data-p="unit">${["minutes", "hours", "days"].map((u) => `<option ${u === (p.unit || "hours") ? "selected" : ""}>${u}</option>`).join("")}</select><span>then carry on</span></div>
          ${hint("At most 90 days. If the workflow is paused meanwhile, the run stops.")}`;
      case "webhook.call":
        return `<input type="url" data-p="url" maxlength="500" placeholder="https://hooks.zapier.com/…" value="${escapeHtml(p.url || "")}" />
          ${hint("The CRM POSTs the lead, customer, order … as JSON to this https address (public addresses only). The <code>X-CRM-Signature</code> header is <code>sha256=</code> + an HMAC of the body with this workflow's secret, which owners and admins see here after saving.")}`;
      case "sequence.enroll":
        return `<select data-p="sequenceId"><option value="">Choose a sequence…</option>${sequences.map((s) => `<option value="${escapeHtml(s.id)}" ${idOf(s.id) === idOf(p.sequenceId) ? "selected" : ""}>${escapeHtml(s.name)}${s.status !== "Active" ? ` (${escapeHtml(s.status)})` : ""}</option>`).join("")}</select>
          ${hint("The customer gets the sequence's follow-ups from day 0. Someone already in it is not added twice.")}`;
      case "payment.link":
        return hint("For the order of this run (order and payment triggers): its open payment link — or a new one for what is still due — goes to the customer on WhatsApp: a message within 24 hours of their last message, else the payment-link template chosen in Settings → Payments. Paid or cancelled orders are skipped.");
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
              const [icon, label] = STEP_LOOK[step.type] || ["fa-solid fa-gear", step.type];
              return `
                <div class="au-step" data-index="${index}" data-type="${escapeHtml(step.type)}">
                  <div class="au-step-head"><span class="step-num">${index + 1}</span>
                    ${withDay ? `<label class="au-day">Day <input type="number" data-day min="0" max="365" value="${escapeHtml(step.day ?? 0)}" aria-label="Day" /></label>` : ""}
                    <i class="${icon} step-icon"></i> ${escapeHtml(label)}
                    <span class="au-step-tools">
                      <button type="button" class="icon-btn" data-move="-1" ${index === 0 ? "disabled" : ""} aria-label="Move up"><i class="fa-solid fa-arrow-up"></i></button>
                      <button type="button" class="icon-btn" data-move="1" ${index === total - 1 ? "disabled" : ""} aria-label="Move down"><i class="fa-solid fa-arrow-down"></i></button>
                      <button type="button" class="icon-btn danger" data-remove-step aria-label="Remove step"><i class="fa-solid fa-trash"></i></button>
                    </span>
                  </div>
                  <div class="au-step-body">${stepBody(step, { inSequence: withDay })}</div>
                </div>`;
            })
            .join("")
        : '<div class="dynamic-list-empty">No steps yet: choose one below and press Add step.</div>';
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

  const ownerOptions = (selected) => `<option value="">No owner</option>${memberOptions(selected)}`;
  const notesHtml = (notes) =>
    notes?.length ? `<strong><i class="fa-solid fa-triangle-exclamation"></i> From the old automation settings</strong><ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : "";

  // ===========================================================================================
  // KPIs and workflow cards
  // ===========================================================================================
  function renderKpis() {
    const sum = (key) => workflows.reduce((total, w) => total + (w.stats?.[key] || 0), 0);
    const inSequences = sequences.reduce((total, s) => total + (s.stats?.active || 0), 0);
    const cards = [
      { label: "Active Workflows", value: workflows.filter((w) => w.status === "Active").length, cls: "success" },
      { label: "Workflow Runs", value: sum("runs"), cls: "info" },
      { label: "Failed Runs", value: sum("failed"), cls: sum("failed") ? "warning" : "" },
      { label: "Customers in Sequences", value: inSequences, cls: "" },
    ];
    $("kpiGrid").innerHTML = cards.map((c) => `<div class="stat-card ${c.cls}"><div class="label">${c.label}</div><div class="value">${c.value}</div></div>`).join("");
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
            <div class="auto-card__owner">${escapeHtml(w.ownerId ? nameOf(w.ownerId) : "No owner")}</div>
          </div>
          <span class="status-pill status-${escapeHtml((w.status || "draft").toLowerCase())}">${escapeHtml(w.status)}</span>
        </div>
        ${w.notes?.length ? `<div class="auto-card__warn" title="${escapeHtml(w.notes.join("\n"))}"><i class="fa-solid fa-triangle-exclamation"></i> Needs a look before you turn it on</div>` : ""}
        <div class="auto-card__trigger">
          <i class="fa-solid fa-bolt-lightning"></i>
          <span>When <strong>${escapeHtml(triggerText(w.trigger))}</strong></span>
        </div>
        <div class="auto-card__chain">
          ${conditions ? `<span class="chain-chip cond">${conditions} condition${conditions === 1 ? "" : "s"}</span>` : ""}
          ${steps.length ? steps.map((step) => `<span class="chain-chip">${escapeHtml(stepText(step))}</span>`).join("") : '<span class="chain-chip">No steps yet</span>'}
        </div>
        <div class="auto-card__stats">
          <div class="auto-card__stat"><span class="num">${s.runs || 0}</span><span class="lbl">Runs</span></div>
          <div class="auto-card__stat"><span class="num">${s.done || 0}</span><span class="lbl">Finished</span></div>
          <div class="auto-card__stat"><span class="num">${s.failed || 0}</span><span class="lbl">Failed</span></div>
        </div>
        <div class="auto-card__foot">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-outline" type="button" data-act="test" ${w.status !== "Active" ? "disabled title=\"Turn it on first\"" : ""}><i class="fa-solid fa-play"></i> Test run</button>
            <button class="btn btn-outline" type="button" data-act="toggle">${w.status === "Active" ? '<i class="fa-solid fa-pause"></i> Pause' : '<i class="fa-solid fa-power-off"></i> Turn on'}</button>
          </div>
          <div class="auto-card__actions">
            <button class="icon-btn" type="button" data-act="log" title="Run log" aria-label="Run log"><i class="fa-solid fa-clock-rotate-left"></i></button>
            <button class="icon-btn" type="button" data-act="edit" title="Edit" aria-label="Edit"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn danger" type="button" data-act="delete" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      </div>`;
  }

  function renderWorkflows() {
    const q = query();
    const shown = workflows.filter((w) => !q || `${w.name} ${triggerText(w.trigger)} ${nameOf(w.ownerId)}`.toLowerCase().includes(q));
    $("workflowsGrid").innerHTML = shown.length
      ? shown.map(workflowCard).join("")
      : `<div class="empty-state"><i class="fa-solid fa-diagram-project"></i><p>${workflows.length ? "No workflow matches your search." : "No workflows yet. Greet new leads, chase quotations, remind your team — automatically."}</p></div>`;
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
      showToast(status === "Active" ? `"${item.name}" is on` : `"${item.name}" is paused`, "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't change it."), "error");
    }
    renderAll();
  }

  async function removeItem(kind, item, onDone) {
    const what = kind === "workflows" ? "Runs that are waiting stop." : "Everyone in it stops getting its steps.";
    if (!confirm(`Delete "${item.name}"? ${what} This can't be undone.`)) return;
    try {
      await crmApi(`/${kind}/${item.id}`, { method: "DELETE" });
      if (kind === "workflows") workflows = workflows.filter((x) => idOf(x.id) !== idOf(item.id));
      else sequences = sequences.filter((x) => idOf(x.id) !== idOf(item.id));
      if (onDone) onDone();
      showToast(kind === "workflows" ? "Workflow deleted" : "Sequence deleted", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't delete it."), "error");
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

  function checks(name, values, selected, attr = "data-tp") {
    const chosen = list(selected);
    return `<div class="au-checks">${values.map((v) => `<label class="au-check"><input type="checkbox" ${attr}="${escapeHtml(name)}" value="${escapeHtml(v)}" ${chosen.includes(v) ? "checked" : ""} /> ${escapeHtml(v)}</label>`).join("")}</div>`;
  }

  // --- trigger -------------------------------------------------------------------------------
  function renderTriggerParams() {
    const { type, params = {} } = draft.trigger;
    const hint = (text) => `<p class="au-hint">${text}</p>`;
    const html = {
      "lead.created": `${hint("Only leads from these sources (none ticked = every source):")}${checks("sources", meta.sources, params.sources)}`,
      "message.received": `<div class="au-inline"><span>Only if the message contains</span><input class="grow" type="text" data-tp="keywords" maxlength="600" value="${escapeHtml((params.keywords || []).join(", "))}" placeholder="price, rate, catalogue" /></div>
        ${hint("Words separated by commas; any one is enough and capitals don't matter. Empty = every message.")}`,
      "lead.stage_changed": `${hint("Moved to (none ticked = any stage):")}${checks("toStages", meta.leadStages, params.toStages)}
        ${hint("Moved from (none ticked = any stage):")}${checks("fromStages", meta.leadStages, params.fromStages)}`,
      "lead.no_reply": `<div class="au-inline"><span>No reply for</span><input type="number" data-tp="hours" min="1" max="720" value="${escapeHtml(params.hours || 24)}" /><span>hours after your last WhatsApp message</span></div>
        ${hint("Checked every 10 minutes. Each silence starts the workflow once.")}`,
      "quotation.not_accepted": `<div class="au-inline"><span>Still not accepted</span><input type="number" data-tp="days" min="1" max="90" value="${escapeHtml(params.days || 3)}" /><span>days after it was sent</span></div>
        ${hint("Quotations that are Sent or Viewed. Checked every 10 minutes; once per quotation revision.")}`,
      "order.stage_changed": `${hint("Moved to (none ticked = any stage):")}${checks("toStages", meta.orderStages, params.toStages)}`,
      "payment.received": hint("When a payment comes in: through a payment link, entered by hand on an order, or an order moved to Payment Collected."),
      "payment.overdue": `<div class="au-inline"><span>Still not fully paid</span><input type="number" data-tp="days" min="1" max="180" value="${escapeHtml(params.days || 7)}" /><span>days after the order date</span></div>
        ${hint("Orders that are not cancelled or collected. Checked every 10 minutes; once per order, and again after a part payment. Add the step “Send the order's payment link” for a reminder.")}`,
      "task.overdue": hint("Tasks past their due date and not done. Checked every 10 minutes; once per task and due date."),
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
    if (def.field === "source") value = checks("value", meta.sources, condition.value, "data-cv");
    if (def.field === "stage") value = checks("value", meta.leadStages, condition.value, "data-cv");
    if (def.field === "tag") value = `<input class="grow" type="text" data-cv-text maxlength="50" placeholder="Tag, e.g. VIP" value="${escapeHtml(condition.value || "")}" />`;
    if (def.field === "owner" && (op === "is" || op === "isNot")) value = `<select data-cv-member>${memberOptions(condition.value)}</select>`;
    return `
      <div class="dynamic-row au-inline au-cond" data-index="${index}">
        <select data-cf aria-label="What to check">${meta.conditions.map((f) => `<option value="${f.field}" ${f.field === def.field ? "selected" : ""}>${escapeHtml(f.label)}</option>`).join("")}</select>
        <select data-co aria-label="How">${def.ops.map((o) => `<option value="${o}" ${o === op ? "selected" : ""}>${escapeHtml(OP_LABELS[o] || o)}</option>`).join("")}</select>
        ${value}
        <button type="button" class="remove-row" data-remove-condition aria-label="Remove condition"><i class="fa-solid fa-xmark"></i></button>
      </div>`;
  }

  function renderConditions() {
    $("wfConditions").innerHTML = draft.conditions.length
      ? draft.conditions.map(conditionRow).join("")
      : '<div class="dynamic-list-empty">No conditions: the workflow runs every time the trigger happens.</div>';
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
      ? `<strong>Webhook secret</strong> (owners and admins only): <code id="wfSecretValue">${escapeHtml(workflow.webhookSecret)}</code>
         <button type="button" class="link-mini" id="wfSecretCopy"><i class="fa-regular fa-copy"></i> Copy</button>
         <p class="au-hint">Check each call: <code>X-CRM-Signature</code> must equal <code>sha256=</code> + HMAC-SHA256 of the raw body with this secret.</p>`
      : "";
  }

  async function openBuilder(id) {
    let workflow = null;
    if (id) {
      try {
        workflow = await crmApi(`/workflows/${id}`);
      } catch (error) {
        showToast(apiErrorMessage(error, "Couldn't open the workflow."), "error");
        return;
      }
    }
    draft = workflow
      ? { id: workflow.id, trigger: workflow.trigger, conditions: workflow.conditions || [] }
      : { id: "", trigger: { type: "lead.created", params: {} }, conditions: [] };
    $("workflowModalTitle").textContent = workflow ? "Edit Workflow" : "New Workflow";
    $("wfEditId").value = draft.id;
    $("wfName").value = workflow?.name || "";
    $("wfStatus").value = workflow?.status || "Active";
    $("wfOwnerField").hidden = !manager;
    $("wfOwner").innerHTML = ownerOptions(workflow ? workflow.ownerId : getCurrentMember()?.id);
    $("wfTrigger").innerHTML = meta.triggers.map((t) => `<option value="${t.type}" ${t.type === draft.trigger.type ? "selected" : ""}>${escapeHtml(t.label)}</option>`).join("");
    $("wfNewStepType").innerHTML = meta.actions.map((a) => `<option value="${a.type}">${escapeHtml(STEP_LOOK[a.type]?.[1] || a.label)}</option>`).join("");
    $("wfDeleteBtn").style.display = workflow ? "inline-flex" : "none";
    $("wfNotes").hidden = !workflow?.notes?.length;
    $("wfNotes").innerHTML = notesHtml(workflow?.notes);
    renderSecret(workflow);
    renderTriggerParams();
    renderConditions();
    wfSteps.set(workflow ? workflow.steps || [] : [{ type: "agent.notify", params: { to: "owner", message: "New lead: {{contact.name}}" } }]);
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
      showToast("Give the workflow a name.", "error");
      $("wfName").focus();
      return;
    }
    if (!steps.length) {
      showToast("Add at least one step.", "error");
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
      const secretNote = manager && saved.hasWebhook && !$("wfSecretBox").innerHTML ? " Open it again to copy the webhook secret." : "";
      showToast(`${draft.id ? "Workflow updated" : "Workflow created"}${saved.status === "Active" ? " and on" : ""}.${secretNote}`, "success");
      renderAll();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the workflow."), "error");
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
    navigator.clipboard?.writeText($("wfSecretValue").textContent).then(() => showToast("Secret copied", "success"), () => showToast("Select the secret and copy it.", "info"));
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
    if (run.status === "waiting" && run.nextAt) return `Waiting until ${when(run.nextAt)}`;
    const counts = {};
    run.steps.forEach((s) => (counts[s.status] = (counts[s.status] || 0) + 1));
    return Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(" · ") || "—";
  }

  function renderRuns() {
    $("runsBody").innerHTML = runs.length
      ? runs
          .map((run) => `
            <tr data-run="${escapeHtml(run.id)}">
              <td class="muted">${escapeHtml(when(run.createdAt))}</td>
              <td>${escapeHtml(run.workflowName)}</td>
              <td>${escapeHtml(run.subject.label || "—")}</td>
              <td class="muted">${escapeHtml(TRIGGER_SHORT[run.trigger] || run.trigger)}</td>
              <td>${badge(run.status)}</td>
              <td class="muted">${escapeHtml(stepsSummary(run))}</td>
            </tr>`)
          .join("")
      : '<tr><td colspan="6"><div class="empty-state" style="padding:30px 10px"><i class="fa-solid fa-clock-rotate-left"></i><p>No runs yet. They appear here when a workflow starts.</p></div></td></tr>';
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
      showToast(apiErrorMessage(error, "Couldn't load the run log."), "error");
    }
  }

  function fillWorkflowFilter() {
    const select = $("runWorkflowFilter");
    const current = select.value;
    select.innerHTML = `<option value="">All workflows</option>${workflows.map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join("")}`;
    select.value = workflows.some((w) => idOf(w.id) === current) ? current : "";
  }

  // --- one run -------------------------------------------------------------------------------
  let shownRun = null;
  let pollTimer = null;

  function eventText(run) {
    const e = run.event || {};
    const bits = [];
    if (e.source) bits.push(`source ${e.source}`);
    if (e.from || e.to) bits.push(`${e.from || "?"} → ${e.to || "?"}`);
    if (e.orderNumber) bits.push(`order ${e.orderNumber}`);
    if (e.quotationNumber) bits.push(`quotation ${e.quotationNumber}`);
    if (e.hours) bits.push(`no reply for ${e.hours} hours`);
    if (e.days) bits.push(`${e.days} days after sending`);
    if (e.startedBy) bits.push(`started by ${e.startedBy}`);
    if (e.text) bits.push(`"${e.text}"`);
    return bits.join(" · ");
  }

  const stepLog = (steps) =>
    `<ol class="au-runlog">${steps
      .map((s) => `<li>${badge(s.status)}<div><strong>${s.day != null ? `Day ${s.day} · ` : `${s.index + 1}. `}${escapeHtml(STEP_LOOK[s.type]?.[1] || s.label || s.type)}</strong>${s.detail ? `<div class="detail">${escapeHtml(s.detail)}</div>` : ""}</div><span class="when">${escapeHtml(when(s.at))}</span></li>`)
      .join("")}</ol>`;

  function renderRun(run) {
    shownRun = run;
    $("runModalTitle").textContent = run.workflowName || "Run";
    $("runModalSub").textContent = [run.subject.label, TRIGGER_SHORT[run.trigger] || run.trigger, `started ${when(run.createdAt)}`].filter(Boolean).join(" · ");
    const happened = eventText(run);
    $("runModalBody").innerHTML = `
      <p style="margin:0 0 12px">${badge(run.status)} ${run.finishedAt ? `<span class="au-hint">finished ${escapeHtml(when(run.finishedAt))}</span>` : ""}</p>
      ${happened ? `<p class="au-hint" style="margin:0 0 12px">${escapeHtml(happened)}</p>` : ""}
      ${run.error ? `<div class="au-run-error">${escapeHtml(run.error)}</div>` : ""}
      ${run.steps.length ? stepLog(run.steps) : '<p class="au-hint">No step has run yet.</p>'}`;
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
      showToast(apiErrorMessage(error, "Couldn't open the run."), "error");
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
    if (!shownRun || !confirm("Stop this run? Its remaining steps will not happen.")) return;
    try {
      renderRun(await crmApi(`/automation-runs/${shownRun.id}/cancel`, { method: "POST" }));
      showToast("Run stopped", "success");
      if (activeTab === "runs") loadRuns();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't stop the run."), "error");
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
            .map((lead) => `<button type="button" data-lead="${escapeHtml(lead.id)}"><strong>${escapeHtml(lead.contact?.name || lead.title || "Lead")}</strong>
              <span class="sub">${escapeHtml([lead.title, lead.contact?.phone, lead.stage].filter(Boolean).join(" · "))}</span></button>`)
            .join("")
        : '<p class="au-hint">No lead found.</p>';
    } catch (error) {
      box.innerHTML = `<p class="au-hint">${escapeHtml(error.status === 403 ? "You need access to Leads to pick one." : apiErrorMessage(error, "Couldn't search the leads."))}</p>`;
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
      title: "Test run",
      subtitle: w.name,
      hint: "The workflow runs now for the lead you pick, whatever its trigger. Its steps really happen: messages are sent and tasks are created.",
      pick: async (leadId) => {
        const run = await crmApi(`/workflows/${w.id}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() },
          body: JSON.stringify({ leadId }),
        });
        closeLeadPicker();
        showToast("Test run started", "success");
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
      showToast(apiErrorMessage(error, "That did not work."), "error");
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
    const stops = [s.stopOnReply && "a reply", s.stopOnClose && "won/lost"].filter(Boolean).join(" or ");
    return `
      <div class="auto-card" data-id="${escapeHtml(s.id)}">
        <div class="auto-card__top">
          <div class="auto-card__icon"><i class="fa-solid fa-layer-group"></i></div>
          <div class="auto-card__title-wrap">
            <div class="auto-card__name">${escapeHtml(s.name)}</div>
            <div class="auto-card__owner">${escapeHtml(s.ownerId ? nameOf(s.ownerId) : "No owner")}${stops ? ` · stops on ${escapeHtml(stops)}` : ""}</div>
          </div>
          <span class="status-pill status-${escapeHtml((s.status || "draft").toLowerCase())}">${escapeHtml(s.status)}</span>
        </div>
        ${s.notes?.length ? `<div class="auto-card__warn" title="${escapeHtml(s.notes.join("\n"))}"><i class="fa-solid fa-triangle-exclamation"></i> Needs a look before you turn it on</div>` : ""}
        <div class="auto-card__chain">
          ${steps.length ? steps.map((step) => `<span class="chain-chip step">Day ${step.day} · ${escapeHtml(stepText(step))}</span>`).join("") : '<span class="chain-chip step">No steps yet</span>'}
        </div>
        <div class="auto-card__stats">
          <div class="auto-card__stat"><span class="num">${st.active || 0}</span><span class="lbl">In it now</span></div>
          <div class="auto-card__stat"><span class="num">${st.completed || 0}</span><span class="lbl">Completed</span></div>
          <div class="auto-card__stat"><span class="num">${st.stopped || 0}</span><span class="lbl">Stopped</span></div>
        </div>
        <div class="auto-card__foot">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-outline" type="button" data-sq="enroll" ${s.status !== "Active" ? "disabled title=\"Turn it on first\"" : ""}><i class="fa-solid fa-user-plus"></i> Add customer</button>
            <button class="btn btn-outline" type="button" data-sq="toggle">${s.status === "Active" ? '<i class="fa-solid fa-pause"></i> Pause' : '<i class="fa-solid fa-power-off"></i> Turn on'}</button>
          </div>
          <div class="auto-card__actions">
            <button class="icon-btn" type="button" data-sq="people" title="Who is in it" aria-label="Who is in it"><i class="fa-solid fa-users"></i></button>
            <button class="icon-btn" type="button" data-sq="edit" title="Edit" aria-label="Edit"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn danger" type="button" data-sq="delete" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      </div>`;
  }

  function renderSequences() {
    const q = query();
    const shown = sequences.filter((s) => !q || `${s.name} ${nameOf(s.ownerId)}`.toLowerCase().includes(q));
    $("sequencesGrid").innerHTML = shown.length
      ? shown.map(sequenceCard).join("")
      : `<div class="empty-state"><i class="fa-solid fa-layer-group"></i><p>${sequences.length ? "No sequence matches your search." : "No sequences yet. Follow up on day 0, 2 and 5 with templates and tasks — they stop when the customer replies."}</p></div>`;
  }

  const enrollCustomer = (s) =>
    openLeadPicker({
      title: "Add a customer",
      subtitle: s.name,
      hint: "Pick a lead: its customer gets this sequence's steps from day 0 (in working hours if the sequence says so).",
      pick: async (leadId) => {
        const enrollment = await crmApi(`/sequences/${s.id}/enroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() },
          body: JSON.stringify({ leadId }),
        });
        closeLeadPicker();
        showToast(`${enrollment.label || "The customer"} was added to "${s.name}"`, "success");
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
    $("sequenceModalTitle").textContent = s ? "Edit Sequence" : "New Sequence";
    $("sqEditId").value = sqDraftId;
    $("sqName").value = s?.name || "";
    $("sqStatus").value = s?.status || "Active";
    $("sqOwnerField").hidden = !manager;
    $("sqOwner").innerHTML = ownerOptions(s ? s.ownerId : getCurrentMember()?.id);
    $("sqStopOnReply").checked = s ? s.stopOnReply : true;
    $("sqStopOnClose").checked = s ? s.stopOnClose : true;
    $("sqWorkingHours").checked = s ? s.workingHoursOnly : true;
    $("sqNewStepType").innerHTML = meta.sequenceSteps.map((type) => `<option value="${type}">${escapeHtml(STEP_LOOK[type]?.[1] || type)}</option>`).join("");
    $("sqDeleteBtn").style.display = s ? "inline-flex" : "none";
    $("sqNotes").hidden = !s?.notes?.length;
    $("sqNotes").innerHTML = notesHtml(s?.notes);
    sqSteps.set(s ? s.steps : [{ day: 0, type: "whatsapp.template", params: clone(NEW_STEP["whatsapp.template"]) }, { day: 2, type: "task.create", params: { title: "Call {{contact.name}}", dueInDays: 0, assignTo: "owner", priority: "Medium" } }]);
    $("sequenceModalOverlay").classList.add("open");
    $("sqName").focus();
  }
  const closeSequenceModal = () => $("sequenceModalOverlay").classList.remove("open");

  $("sequenceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const steps = sqSteps.read();
    const name = $("sqName").value.trim();
    if (!name) {
      showToast("Give the sequence a name.", "error");
      $("sqName").focus();
      return;
    }
    if (!steps.length) {
      showToast("Add at least one step.", "error");
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
      showToast(`${sqDraftId ? "Sequence updated" : "Sequence created"}${saved.status === "Active" ? " and on" : ""}.`, "success");
      renderAll();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the sequence."), "error");
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
    const by = e.enrolledBy.kind === "workflow" ? e.enrolledBy.name : `by ${e.enrolledBy.name || "a teammate"}`;
    const next = e.status === "active" && e.nextAt
      ? `Next: day ${peopleOf?.steps?.[e.stepIndex]?.day ?? "?"} step on ${when(e.nextAt)}`
      : e.stopReason || e.error || (e.status === "completed" ? `Finished ${when(e.finishedAt)}` : "");
    return `
      <div class="au-person" data-enrollment="${escapeHtml(e.id)}">
        <div class="au-person-head">
          <a href="customer-360.html?id=${encodeURIComponent(e.contactId)}">${escapeHtml(e.label || "Customer")}</a>
          ${badge(e.status)}
          ${e.status === "active" ? '<button class="btn btn-danger-outline" type="button" data-stop>Take out</button>' : ""}
        </div>
        <div class="sub">Added ${escapeHtml(when(e.enrolledAt))} ${escapeHtml(by)}${next ? ` · ${escapeHtml(next)}` : ""}</div>
        ${e.steps.length ? `<details><summary>${e.steps.length} step${e.steps.length === 1 ? "" : "s"} done</summary>${stepLog(e.steps)}</details>` : ""}
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
      $("peopleList").innerHTML = people.length ? people.map(personHtml).join("") : '<p class="au-hint">Nobody here yet. Add a customer, or let a workflow add them ("Add the customer to a sequence").</p>';
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't load who is in the sequence."), "error");
    }
  }

  function openPeople(s) {
    peopleOf = s;
    $("peopleModalTitle").textContent = s.name;
    $("peopleModalSub").textContent = `${s.stats?.active || 0} in it now · ${s.stats?.completed || 0} completed · ${s.stats?.stopped || 0} stopped`;
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
    if (!confirm("Take this customer out of the sequence? Its remaining steps will not happen for them.")) return;
    try {
      await crmApi(`/sequence-enrollments/${id}/stop`, { method: "POST" });
      showToast("Taken out of the sequence", "success");
      await refreshAutomations();
      loadPeople();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't take them out."), "error");
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
    $("addBtnLabel").textContent = tab === "sequences" ? "New Sequence" : "New Workflow";
    $("searchInput").placeholder = tab === "sequences" ? "Search sequences..." : "Search workflows...";
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
      .catch((error) => showToast(apiErrorMessage(error, "Couldn't load the automation settings."), "error"));
  });
})();
