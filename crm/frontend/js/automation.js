/**
 * automation.js — Sales Automation (Phase 6)
 * Workflows run on the server's automation engine: "when <trigger>, only if <conditions>, then
 * <steps>" (/workflows, /workflows/meta). The run log lists what each workflow did, step by step
 * (/automation-runs); a test run starts a workflow now for one lead (/workflows/:id/run).
 * Sequences stay as before until per-contact sequences arrive (Phase 6B).
 * Uses app.js: crmReady, cached, crmApi, crmRequest, jsonRequest, newIdempotencyKey, escapeHtml,
 * isOrgManager, getCurrentMember, getAgents, showToast, apiErrorMessage, getSequences,
 * saveAutomation, removeAutomation, enrollInSequence. Everything stays inside this function so
 * no names clash with app.js.
 */
(function salesAutomation() {
  requireAuth();
  renderSidebarUser();
  initSidebarToggle();

  const $ = (id) => document.getElementById(id);
  const idOf = (value) => String(value || "");
  const manager = isOrgManager();
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

  let activeTab = "workflows"; // workflows | runs | sequences
  let meta = null; // what the builder offers (GET /workflows/meta)
  let templates = []; // WhatsApp templates (empty without Inbox access)
  let workflows = [];

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
  };
  const TRIGGER_SHORT = {
    "lead.created": "New lead",
    "message.received": "WhatsApp message",
    "lead.stage_changed": "Stage change",
    "lead.no_reply": "No reply",
    "quotation.not_accepted": "Quote not accepted",
    "order.stage_changed": "Order stage",
    "payment.received": "Payment",
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
    "quotation.number": "Quotation number",
  };
  const PLACEHOLDERS = ["contact.name", "contact.company", "contact.city", "lead.title", "owner.name", "org.name", "order.number", "quotation.number", "task.title", "message.text"];
  const RUN_BADGE = {
    running: ["badge-info", "Running"], waiting: ["badge-warning", "Waiting"], done: ["badge-success", "Done"],
    failed: ["badge-danger", "Failed"], skipped: ["badge-neutral", "Skipped"], cancelled: ["badge-neutral", "Stopped"],
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
  const triggerLabel = (type) => meta?.triggers.find((t) => t.type === type)?.label || TRIGGER_SHORT[type] || type;
  const list = (value) => (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]);
  const clean = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)));

  function triggerText(trigger) {
    const p = trigger.params || {};
    const extra = {
      "lead.created": p.sources?.length ? `from ${p.sources.join(", ")}` : "",
      "message.received": p.keywords?.length ? `with ${p.keywords.map((k) => `"${k}"`).join(" or ")}` : "",
      "lead.stage_changed": [p.fromStages?.length ? `from ${p.fromStages.join(" / ")}` : "", p.toStages?.length ? `to ${p.toStages.join(" / ")}` : ""].filter(Boolean).join(" "),
      "lead.no_reply": `${p.hours || 24} hours`,
      "quotation.not_accepted": `${p.days || 3} days`,
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
      default: return step.type;
    }
  }

  // ===========================================================================================
  // KPIs and workflow cards
  // ===========================================================================================
  function renderKpis() {
    const sum = (key) => workflows.reduce((total, w) => total + (w.stats?.[key] || 0), 0);
    const cards = [
      { label: "Active Workflows", value: workflows.filter((w) => w.status === "Active").length, cls: "success" },
      { label: "Workflow Runs", value: sum("runs"), cls: "info" },
      { label: "Failed Runs", value: sum("failed"), cls: sum("failed") ? "warning" : "" },
      { label: "Active Sequences", value: getSequences().filter((s) => s.status === "Active").length, cls: "" },
    ];
    $("kpiGrid").innerHTML = cards.map((c) => `<div class="stat-card ${c.cls}"><div class="label">${c.label}</div><div class="value">${c.value}</div></div>`).join("");
  }

  const query = () => ($("searchInput").value || "").toLowerCase().trim();

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

  const upsert = (workflow) => {
    const index = workflows.findIndex((w) => idOf(w.id) === idOf(workflow.id));
    if (index === -1) workflows.unshift(workflow);
    else workflows[index] = workflow;
  };

  async function toggleWorkflow(w) {
    const status = w.status === "Active" ? "Paused" : "Active";
    try {
      upsert(await crmApi(`/workflows/${w.id}`, jsonRequest("PATCH", { status })));
      showToast(status === "Active" ? `"${w.name}" is on` : `"${w.name}" is paused`, "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't change the workflow."), "error");
    }
    renderAll();
  }

  async function deleteWorkflow(w, onDone) {
    if (!confirm(`Delete "${w.name}"? Runs that are waiting stop. This can't be undone.`)) return;
    try {
      await crmApi(`/workflows/${w.id}`, { method: "DELETE" });
      workflows = workflows.filter((x) => idOf(x.id) !== idOf(w.id));
      if (onDone) onDone();
      showToast("Workflow deleted", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't delete the workflow."), "error");
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
    if (act === "delete") deleteWorkflow(w);
    if (act === "toggle") toggleWorkflow(w);
    if (act === "test") openTestRun(w);
    if (act === "log") {
      $("runWorkflowFilter").value = w.id;
      setTab("runs");
    }
  });

  // ===========================================================================================
  // Builder: when / only if / then
  // ===========================================================================================
  let draft = null; // { id, trigger, conditions, steps }

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
      "payment.received": hint("When an order moves to Payment Collected."),
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
    if (type === "quotation.not_accepted") params.days = number("days");
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

  // --- steps ---------------------------------------------------------------------------------
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

  function stepBody(step) {
    const p = step.params || {};
    const hint = (text) => `<p class="au-hint">${text}</p>`;
    switch (step.type) {
      case "whatsapp.text":
        return `<textarea data-p="text" maxlength="4096" placeholder="Namaste {{contact.name}}, thank you for your enquiry…">${escapeHtml(p.text || "")}</textarea>${placeholderChips()}
          ${hint("Goes only if the customer wrote to you in the last 24 hours (WhatsApp's rule); otherwise this step is skipped. To reach anyone, use a template step.")}`;
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
      default:
        return "";
    }
  }

  function renderSteps() {
    const total = draft.steps.length;
    $("wfSteps").innerHTML = total
      ? draft.steps
          .map((step, index) => {
            const [icon, label] = STEP_LOOK[step.type] || ["fa-solid fa-gear", step.type];
            return `
              <div class="au-step" data-index="${index}" data-type="${escapeHtml(step.type)}">
                <div class="au-step-head"><span class="step-num">${index + 1}</span><i class="${icon} step-icon"></i> ${escapeHtml(label)}
                  <span class="au-step-tools">
                    <button type="button" class="icon-btn" data-move="-1" ${index === 0 ? "disabled" : ""} aria-label="Move up"><i class="fa-solid fa-arrow-up"></i></button>
                    <button type="button" class="icon-btn" data-move="1" ${index === total - 1 ? "disabled" : ""} aria-label="Move down"><i class="fa-solid fa-arrow-down"></i></button>
                    <button type="button" class="icon-btn danger" data-remove-step aria-label="Remove step"><i class="fa-solid fa-trash"></i></button>
                  </span>
                </div>
                <div class="au-step-body">${stepBody(step)}</div>
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
    return { type: card.dataset.type, params };
  }
  const readSteps = () => [...$("wfSteps").querySelectorAll(".au-step")].map(readStep);

  // Takes what is on screen into the draft (before anything is drawn again, and on save).
  function sync() {
    draft.trigger = readTrigger();
    draft.conditions = readConditions();
    draft.steps = readSteps();
  }

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
  };

  function renderNotes(workflow) {
    const box = $("wfNotes");
    box.hidden = !workflow?.notes?.length;
    box.innerHTML = workflow?.notes?.length
      ? `<strong><i class="fa-solid fa-triangle-exclamation"></i> From the old automation settings</strong><ul>${workflow.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
      : "";
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
      ? { id: workflow.id, trigger: workflow.trigger, conditions: workflow.conditions || [], steps: workflow.steps || [] }
      : { id: "", trigger: { type: "lead.created", params: {} }, conditions: [], steps: [{ type: "agent.notify", params: { to: "owner", message: "New lead: {{contact.name}}" } }] };
    $("workflowModalTitle").textContent = workflow ? "Edit Workflow" : "New Workflow";
    $("wfEditId").value = draft.id;
    $("wfName").value = workflow?.name || "";
    $("wfStatus").value = workflow?.status || "Active";
    $("wfOwnerField").hidden = !manager;
    $("wfOwner").innerHTML = `<option value="">No owner</option>${memberOptions(workflow ? workflow.ownerId : getCurrentMember()?.id)}`;
    $("wfTrigger").innerHTML = meta.triggers.map((t) => `<option value="${t.type}" ${t.type === draft.trigger.type ? "selected" : ""}>${escapeHtml(t.label)}</option>`).join("");
    $("wfNewStepType").innerHTML = meta.actions.map((a) => `<option value="${a.type}">${escapeHtml(STEP_LOOK[a.type]?.[1] || a.label)}</option>`).join("");
    $("wfDeleteBtn").style.display = workflow ? "inline-flex" : "none";
    renderNotes(workflow);
    renderSecret(workflow);
    renderTriggerParams();
    renderConditions();
    renderSteps();
    $("workflowModalOverlay").classList.add("open");
    $("wfName").focus();
  }
  const closeBuilder = () => $("workflowModalOverlay").classList.remove("open");

  // A field the server refused, e.g. "steps.2.params.templateId": show that step.
  function pointAt(error) {
    const field = error?.errors?.[0]?.field || "";
    const step = /^steps\.(\d+)/.exec(field);
    const target = step ? $("wfSteps").querySelector(`.au-step[data-index="${step[1]}"]`) : /^conditions/.test(field) ? $("wfConditions") : /^trigger/.test(field) ? $("wfTriggerParams") : null;
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.style.outline = "2px solid var(--danger)";
    setTimeout(() => (target.style.outline = ""), 2500);
  }

  async function saveWorkflow(event) {
    event.preventDefault();
    sync();
    const name = $("wfName").value.trim();
    if (!name) {
      showToast("Give the workflow a name.", "error");
      $("wfName").focus();
      return;
    }
    if (!draft.steps.length) {
      showToast("Add at least one step.", "error");
      return;
    }
    const body = { name, status: $("wfStatus").value, trigger: draft.trigger, conditions: draft.conditions, steps: draft.steps };
    if (manager) body.ownerId = $("wfOwner").value || null;
    const saveBtn = $("wfSaveBtn");
    saveBtn.disabled = true;
    try {
      const saved = await crmApi(draft.id ? `/workflows/${draft.id}` : "/workflows", jsonRequest(draft.id ? "PATCH" : "POST", body));
      upsert(saved);
      closeBuilder();
      const secretNote = manager && saved.hasWebhook && !$("wfSecretBox").innerHTML ? " Open it again to copy the webhook secret." : "";
      showToast(`${draft.id ? "Workflow updated" : "Workflow created"}${saved.status === "Active" ? " and on" : ""}.${secretNote}`, "success");
      renderAll();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the workflow."), "error");
      pointAt(error);
    } finally {
      saveBtn.disabled = false;
    }
  }

  // --- builder wiring ------------------------------------------------------------------------
  $("wfTrigger").addEventListener("change", () => {
    draft.trigger = { type: $("wfTrigger").value, params: {} };
    renderTriggerParams();
  });
  $("wfAddConditionBtn").addEventListener("click", () => {
    sync();
    draft.conditions.push({ field: "source", op: "in", value: [] });
    renderConditions();
  });
  $("wfConditions").addEventListener("change", (event) => {
    if (!event.target.matches("[data-cf], [data-co]")) return;
    const row = event.target.closest(".au-cond");
    sync();
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
    sync();
    draft.conditions.splice(Number(remove.closest(".au-cond").dataset.index), 1);
    renderConditions();
  });
  $("wfAddStepBtn").addEventListener("click", () => {
    sync();
    const type = $("wfNewStepType").value;
    draft.steps.push({ type, params: JSON.parse(JSON.stringify(NEW_STEP[type] || {})) });
    renderSteps();
    $("wfSteps").lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  $("wfSteps").addEventListener("click", (event) => {
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
    sync();
    if (remove) draft.steps.splice(index, 1);
    else {
      const to = index + Number(move.dataset.move);
      [draft.steps[index], draft.steps[to]] = [draft.steps[to], draft.steps[index]];
    }
    renderSteps();
  });
  $("wfSteps").addEventListener("change", (event) => {
    if (event.target.matches("[data-var-part]")) {
      const text = event.target.parentElement.querySelector("[data-var-text]");
      text.hidden = event.target.value !== "text:";
      if (!text.hidden) text.focus();
      return;
    }
    if (!event.target.matches("[data-rerender]")) return;
    sync();
    renderSteps();
  });
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
    if (w) deleteWorkflow(w, closeBuilder);
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

  function renderRun(run) {
    shownRun = run;
    $("runModalTitle").textContent = run.workflowName || "Run";
    $("runModalSub").textContent = [run.subject.label, TRIGGER_SHORT[run.trigger] || run.trigger, `started ${when(run.createdAt)}`].filter(Boolean).join(" · ");
    const steps = run.steps.length
      ? `<ol class="au-runlog">${run.steps
          .map((s) => `<li>${badge(s.status)}<div><strong>${s.index + 1}. ${escapeHtml(STEP_LOOK[s.type]?.[1] || s.label || s.type)}</strong>${s.detail ? `<div class="detail">${escapeHtml(s.detail)}</div>` : ""}</div><span class="when">${escapeHtml(when(s.at))}</span></li>`)
          .join("")}</ol>`
      : '<p class="au-hint">No step has run yet.</p>';
    const happened = eventText(run);
    $("runModalBody").innerHTML = `
      <p style="margin:0 0 12px">${badge(run.status)} ${run.finishedAt ? `<span class="au-hint">finished ${escapeHtml(when(run.finishedAt))}</span>` : ""}</p>
      ${happened ? `<p class="au-hint" style="margin:0 0 12px">${escapeHtml(happened)}</p>` : ""}
      ${run.error ? `<div class="au-run-error">${escapeHtml(run.error)}</div>` : ""}
      ${steps}`;
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
        else refreshWorkflows();
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
  // Test run: pick a lead
  // ===========================================================================================
  let testing = null;
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

  function openTestRun(w) {
    testing = w;
    $("testModalSub").textContent = w.name;
    $("testLeadSearch").value = "";
    $("testLeadResults").innerHTML = "";
    $("testModalOverlay").classList.add("open");
    $("testLeadSearch").focus();
    searchLeads();
  }
  const closeTestRun = () => $("testModalOverlay").classList.remove("open");

  $("testLeadSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchLeads, 250);
  });
  $("testLeadResults").addEventListener("click", async (event) => {
    const pick = event.target.closest("[data-lead]");
    if (!pick || !testing || pick.disabled) return;
    pick.disabled = true;
    try {
      const run = await crmApi(`/workflows/${testing.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() },
        body: JSON.stringify({ leadId: pick.dataset.lead }),
      });
      closeTestRun();
      showToast("Test run started", "success");
      openRun(run.id, { poll: true });
    } catch (error) {
      pick.disabled = false;
      showToast(apiErrorMessage(error, "Couldn't start the test run."), "error");
    }
  });
  $("testModalClose").addEventListener("click", closeTestRun);
  $("testModalOverlay").addEventListener("click", (event) => {
    if (event.target.id === "testModalOverlay") closeTestRun();
  });

  async function refreshWorkflows() {
    try {
      workflows = await crmFetchAll("/workflows");
      renderAll();
    } catch {
      /* the cards keep their last numbers */
    }
  }

  // ===========================================================================================
  // Sequences (as before Phase 6; per-contact sequences arrive in Phase 6B)
  // ===========================================================================================
  const STEP_TYPES = ["Email", "Call", "Task", "Wait"];
  const findById = (items, id) => items.find((item) => String(item.id) === String(id));

  function confirmDeleteSequence(id, onDone) {
    const item = findById(getSequences(), id);
    if (!item || !confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    removeAutomation("sequences", id)
      .then(() => {
        if (onDone) onDone();
        showToast("Sequence deleted", "success");
      })
      .catch((error) => showToast(apiErrorMessage(error, "Couldn't delete the sequence."), "error"))
      .finally(renderAll);
  }

  function renderSequences() {
    const q = query();
    const sequences = getSequences().filter((s) => !q || `${s.name} ${s.targetType} ${s.owner || ""}`.toLowerCase().includes(q));
    const grid = $("sequencesGrid");
    if (!sequences.length) {
      grid.innerHTML = `<div class="empty-state"><i class="fa-solid fa-layer-group"></i><p>No sequences yet. Build a multi-step follow-up cadence.</p></div>`;
      return;
    }
    grid.innerHTML = sequences
      .map((s) => {
        const steps = s.steps || [];
        return `
        <div class="auto-card" data-id="${escapeHtml(s.id)}">
          <div class="auto-card__top">
            <div class="auto-card__icon"><i class="fa-solid fa-layer-group"></i></div>
            <div class="auto-card__title-wrap">
              <div class="auto-card__name">${escapeHtml(s.name)}</div>
              <div class="auto-card__owner">${escapeHtml(s.owner || "Unassigned")} · ${escapeHtml(s.targetType)}</div>
            </div>
            <span class="status-pill status-${escapeHtml((s.status || "draft").toLowerCase())}">${escapeHtml(s.status)}</span>
          </div>
          <div class="auto-card__chain">
            ${steps.length ? steps.map((st) => `<span class="chain-chip step">Day ${st.day} · ${escapeHtml(st.type)}</span>`).join("") : '<span class="chain-chip step">No steps configured</span>'}
          </div>
          <div class="auto-card__stats">
            <div class="auto-card__stat"><span class="num">${steps.length}</span><span class="lbl">Touchpoints</span></div>
            <div class="auto-card__stat"><span class="num">${s.enrolledCount || 0}</span><span class="lbl">Enrolled</span></div>
          </div>
          <div class="auto-card__foot">
            <button class="btn btn-outline" type="button" data-sq="enroll" ${s.status !== "Active" ? "disabled" : ""}><i class="fa-solid fa-user-plus"></i> Enroll One</button>
            <div class="auto-card__actions">
              <button class="icon-btn" type="button" data-sq="edit" aria-label="Edit"><i class="fa-solid fa-pen"></i></button>
              <button class="icon-btn danger" type="button" data-sq="delete" aria-label="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
        </div>`;
      })
      .join("");
  }

  $("sequencesGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-sq]");
    const card = event.target.closest(".auto-card");
    if (!button || !card) return;
    const id = card.dataset.id;
    if (button.dataset.sq === "edit") openSequenceModal(id);
    if (button.dataset.sq === "delete") confirmDeleteSequence(id);
    if (button.dataset.sq === "enroll") enrollSequence(id);
  });

  // The server schedules the first Call/Task step as a task and counts the enrollment.
  async function enrollSequence(id) {
    const sq = findById(getSequences(), id);
    if (!sq) return;
    let result;
    try {
      result = await enrollInSequence(sq.id);
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't enroll."), "error");
      renderAll();
      return;
    }
    showToast(result.task ? `Enrolled — first task scheduled for Day ${result.firstTaskDay}` : `Enrolled in "${sq.name}"`, "success");
    renderAll();
  }

  let sqStepRows = [];

  function renderSqStepsList() {
    const el = $("sqStepsList");
    if (!sqStepRows.length) {
      el.innerHTML = `<div class="dynamic-list-empty">No steps yet — add one above.</div>`;
      return;
    }
    el.innerHTML = sqStepRows
      .map(
        (row, i) => `
        <div class="dynamic-row" data-idx="${i}">
          <span class="step-index">${i + 1}</span>
          <input type="number" min="0" class="day-input step-day-input" value="${escapeHtml(row.day ?? 0)}" title="Day offset" />
          <select class="type-select step-type-input">
            ${STEP_TYPES.map((t) => `<option value="${t}" ${t === row.type ? "selected" : ""}>${t}</option>`).join("")}
          </select>
          <input type="text" class="detail-input step-note-input" placeholder="Note (e.g. call script, email subject...)" value="${escapeHtml(row.note || "")}" />
          <button type="button" class="remove-row" data-idx="${i}"><i class="fa-solid fa-xmark"></i></button>
        </div>`,
      )
      .join("");
    el.querySelectorAll(".step-day-input").forEach((input, i) => input.addEventListener("input", () => (sqStepRows[i].day = parseInt(input.value, 10) || 0)));
    el.querySelectorAll(".step-type-input").forEach((select, i) => select.addEventListener("change", () => (sqStepRows[i].type = select.value)));
    el.querySelectorAll(".step-note-input").forEach((input, i) => input.addEventListener("input", () => (sqStepRows[i].note = input.value)));
    el.querySelectorAll(".remove-row").forEach((button) =>
      button.addEventListener("click", () => {
        sqStepRows.splice(Number(button.dataset.idx), 1);
        renderSqStepsList();
      }),
    );
  }

  function openSequenceModal(id) {
    $("sequenceForm").reset();
    const owners = getAgents().map((a) => a.name);
    $("sqOwner").innerHTML = owners.length
      ? owners.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")
      : `<option value="" disabled selected>Add an agent first (Account Champions)</option>`;
    if (id) {
      const sq = findById(getSequences(), id);
      if (!sq) return;
      $("sequenceModalTitle").textContent = "Edit Sequence";
      $("sqEditId").value = sq.id;
      $("sqName").value = sq.name;
      $("sqTarget").value = sq.targetType;
      $("sqStatus").value = sq.status;
      $("sqOwner").value = sq.owner || "";
      sqStepRows = (sq.steps || []).map((s) => ({ ...s }));
      $("sqDeleteBtn").style.display = "inline-flex";
    } else {
      $("sequenceModalTitle").textContent = "New Sequence";
      $("sqEditId").value = "";
      $("sqStatus").value = "Active";
      sqStepRows = [{ day: 0, type: "Email", note: "" }];
      $("sqDeleteBtn").style.display = "none";
    }
    renderSqStepsList();
    $("sequenceModalOverlay").classList.add("open");
  }
  const closeSequenceModal = () => $("sequenceModalOverlay").classList.remove("open");

  $("sequenceModalClose").addEventListener("click", closeSequenceModal);
  $("sqCancelBtn").addEventListener("click", closeSequenceModal);
  $("sequenceModalOverlay").addEventListener("click", (event) => {
    if (event.target.id === "sequenceModalOverlay") closeSequenceModal();
  });
  $("sqAddStepBtn").addEventListener("click", () => {
    const lastDay = sqStepRows.length ? sqStepRows[sqStepRows.length - 1].day : -2;
    sqStepRows.push({ day: lastDay + 2, type: "Email", note: "" });
    renderSqStepsList();
  });
  $("sqDeleteBtn").addEventListener("click", () => {
    const id = $("sqEditId").value;
    if (id) confirmDeleteSequence(id, closeSequenceModal);
  });
  $("sequenceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("sqEditId").value;
    const payload = {
      name: $("sqName").value.trim(),
      targetType: $("sqTarget").value,
      status: $("sqStatus").value,
      owner: $("sqOwner").value,
      steps: sqStepRows.filter((s) => s.type),
    };
    if (!payload.name) {
      showToast("Sequence name is required.", "error");
      return;
    }
    try {
      await saveAutomation("sequences", id || null, payload);
      showToast(id ? "Sequence updated" : "Sequence created", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the sequence."), "error");
      return;
    }
    closeSequenceModal();
    renderAll();
  });

  // ===========================================================================================
  // Tabs and start
  // ===========================================================================================
  function setTab(tab) {
    activeTab = tab;
    const panels = { workflows: "workflowsPanel", runs: "runsPanel", sequences: "sequencesPanel" };
    const buttons = { workflows: "tabWorkflowsBtn", runs: "tabRunsBtn", sequences: "tabSequencesBtn" };
    Object.entries(panels).forEach(([key, panel]) => ($(panel).style.display = key === tab ? "block" : "none"));
    Object.entries(buttons).forEach(([key, button]) => $(button).classList.toggle("active", key === tab));
    $("searchBox").style.display = tab === "runs" ? "none" : "";
    $("addBtn").style.display = tab === "runs" ? "none" : "";
    $("addBtnLabel").textContent = tab === "sequences" ? "New Sequence" : "New Workflow";
    $("searchInput").placeholder = tab === "sequences" ? "Search sequences..." : "Search workflows...";
    if (tab === "runs") {
      fillWorkflowFilter();
      loadRuns();
    }
    // Run counts change while the page is open (the engine runs on the server).
    if (tab === "workflows") refreshWorkflows();
    else renderAll();
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
  $("searchInput").addEventListener("input", renderAll);
  $("addBtn").addEventListener("click", () => (activeTab === "sequences" ? openSequenceModal(null) : openBuilder(null)));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if ($("testModalOverlay").classList.contains("open")) closeTestRun();
    else if ($("runModalOverlay").classList.contains("open")) closeRun();
  });

  crmReady(["workflows", "sequences", "members"], () => {
    Promise.all([crmApi("/workflows/meta"), crmApi("/templates").catch(() => [])])
      .then(([vocabulary, list]) => {
        meta = vocabulary;
        templates = list || [];
        workflows = cached("workflows").slice();
        const tab = new URLSearchParams(window.location.search).get("tab");
        if (tab === "runs" || tab === "sequences") setTab(tab);
        else renderAll();
      })
      .catch((error) => showToast(apiErrorMessage(error, "Couldn't load the automation settings."), "error"));
  });
})();
