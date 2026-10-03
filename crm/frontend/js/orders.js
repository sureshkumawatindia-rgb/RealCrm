/**
 * orders.js — Orders page (Phase 5)
 * The list (stage tabs with counts, search) and one order: the stage stepper, moving it on
 * (with dispatch details, a cancel reason), the dispatch form, items and totals, notes, the
 * history, and a WhatsApp update to the customer after a move.
 * Addresses: Orders.html, Orders.html?id=<order>. One IIFE: no globals.
 */
(function ordersPage() {
  const $ = (id) => document.getElementById(id);
  const me = getCurrentMember() || {};
  function can(action) {
    if (isOrgManager()) return true;
    return ["leads", "deals"].some((module) => {
      if (!(me.modules || []).includes(module)) return false;
      if (action === "view") return true;
      if (me.role === "viewer") return false;
      return true;
    });
  }
  const canChat = () => isOrgManager() || (me.modules || []).includes("inbox");

  const FLOW = ["Received", "Processing", "Dispatched", "Delivered", "Payment Collected"];
  const STAGES = [...FLOW, "Cancelled"];
  const BADGE = { Received: "badge-neutral", Processing: "badge-info", Dispatched: "badge-brand", Delivered: "badge-success", "Payment Collected": "badge-success", Cancelled: "badge-danger" };
  const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "");
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const badge = (stage) => `<span class="badge ${BADGE[stage] || "badge-neutral"}">${escapeHtml(stage)}</span>`;

  // ------------------------------------------------------------------------------------------
  // List
  // ------------------------------------------------------------------------------------------
  const list = { stage: "", page: 1, items: [], more: false, seq: 0 };

  async function loadTabs() {
    try {
      const { counts, total } = await crmApi("/orders/summary");
      $("oTabs").innerHTML = [["", "All", total], ...STAGES.map((s) => [s, s, counts[s] || 0])]
        .map(([value, label, count]) => `<button class="o-tab ${list.stage === value ? "active" : ""}" type="button" role="tab" data-stage="${escapeHtml(value)}">${escapeHtml(label)}<span class="count">${count}</span></button>`)
        .join("");
    } catch {
      $("oTabs").innerHTML = "";
    }
  }

  async function loadList(reset = true) {
    if (reset) {
      list.page = 1;
      list.items = [];
    }
    const seq = ++list.seq;
    const params = new URLSearchParams({ page: String(list.page), limit: "30" });
    if (list.stage) params.set("stage", list.stage);
    const q = $("oSearch").value.trim();
    if (q) params.set("q", q);
    try {
      const body = await crmRequest(`/orders?${params}`);
      if (seq !== list.seq) return;
      list.items.push(...(body.data || []));
      list.more = Boolean(body.pagination?.hasNextPage);
      renderList();
    } catch (error) {
      $("oTable").innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(error, "Couldn't load the orders."))}</p></div>`;
    }
  }

  function renderList() {
    $("oMore").hidden = !list.more;
    if (!list.items.length) {
      $("oTable").innerHTML = `<div class="empty-state"><i class="fa-solid fa-truck-fast"></i><p>${list.stage || $("oSearch").value.trim() ? "No order matches." : "No orders yet. When a customer accepts a quotation, press “Create order” on it."}</p></div>`;
      return;
    }
    $("oTable").innerHTML = `
      <table>
        <thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Dispatch</th><th class="q-amount">Amount</th><th>Stage</th></tr></thead>
        <tbody>${list.items
          .map(
            (o) => `
          <tr data-open="${escapeHtml(o.id)}" tabindex="0">
            <td><div class="q-num">${escapeHtml(o.number)}</div><div class="q-muted">${escapeHtml(o.quotationNumber || "")}</div></td>
            <td><div>${escapeHtml(o.billTo?.name || "—")}</div>${o.billTo?.company ? `<div class="q-muted">${escapeHtml(o.billTo.company)}</div>` : ""}</td>
            <td>${escapeHtml(day(o.orderDate))}</td>
            <td class="q-muted">${escapeHtml([o.dispatch?.transporter, o.dispatch?.lrNumber].filter(Boolean).join(" · ") || "—")}</td>
            <td class="q-amount">${rupees(o.totals?.grandTotalPaise)}</td>
            <td>${badge(o.stage)}</td>
          </tr>`,
          )
          .join("")}</tbody>
      </table>`;
  }

  $("oTabs").addEventListener("click", (e) => {
    const tab = e.target.closest("[data-stage]");
    if (!tab) return;
    list.stage = tab.dataset.stage;
    document.querySelectorAll(".o-tab").forEach((t) => t.classList.toggle("active", t === tab));
    loadList();
  });
  let searchTimer;
  $("oSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadList(), 300);
  });
  $("oMore").addEventListener("click", () => {
    list.page += 1;
    loadList(false);
  });
  $("oTable").addEventListener("click", (e) => {
    const row = e.target.closest("[data-open]");
    if (row) go(`id=${encodeURIComponent(row.dataset.open)}`);
  });
  $("oTable").addEventListener("keydown", (e) => {
    const row = e.target.closest("[data-open]");
    if (row && e.key === "Enter") go(`id=${encodeURIComponent(row.dataset.open)}`);
  });

  // ------------------------------------------------------------------------------------------
  // One order
  // ------------------------------------------------------------------------------------------
  let order = null;

  function renderSteps() {
    if (order.stage === "Cancelled") {
      $("oSteps").innerHTML = `<div class="o-cancelled"><i class="fa-solid fa-ban"></i> Cancelled ${escapeHtml(day(order.cancelledAt))}${order.cancelReason ? ` — ${escapeHtml(order.cancelReason)}` : ""}</div>`;
      return;
    }
    const at = FLOW.indexOf(order.stage);
    const reached = (stage) => [...order.history].reverse().find((h) => h.stage === stage)?.at;
    $("oSteps").innerHTML = FLOW.map((stage, i) => {
      const cls = i < at ? "done" : i === at ? "current" : "";
      const date = i <= at ? reached(stage) : "";
      return `<div class="o-step ${cls}">${escapeHtml(stage)}${date ? `<small>${escapeHtml(day(date))}</small>` : ""}</div>`;
    }).join("");
  }

  function renderDetail() {
    const o = order;
    $("pageTitle").textContent = "Order";
    $("oNumber").textContent = o.number;
    $("oSub").innerHTML = [badge(o.stage), `dated ${escapeHtml(day(o.orderDate))}`, o.paidAt ? `paid ${escapeHtml(day(o.paidAt))}` : ""].filter(Boolean).join(" · ");
    renderSteps();
    $("oTransporter").value = o.dispatch?.transporter || "";
    $("oLr").value = o.dispatch?.lrNumber || "";
    $("oVehicle").value = o.dispatch?.vehicleNumber || "";
    $("oExpected").value = o.dispatch?.expectedDeliveryDate ? String(o.dispatch.expectedDeliveryDate).slice(0, 10) : "";
    $("oDispatchedAt").textContent = o.dispatch?.dispatchedAt ? `Dispatched ${when(o.dispatch.dispatchedAt)}` : "";
    $("oNotes").value = o.notes || "";
    $("oQuoteLink").innerHTML = o.quotationId ? `<a href="Quotations.html?id=${encodeURIComponent(o.quotationId)}">${escapeHtml(o.quotationNumber || "Quotation")}</a>` : "";
    const b = o.billTo || {};
    $("oCustomer").innerHTML = `<strong>${escapeHtml(b.name || "—")}</strong><div class="q-muted">${[b.company && b.company !== b.name ? b.company : "", b.address, [b.city, b.state].filter(Boolean).join(", "), b.gstin ? `GSTIN ${b.gstin}` : "", b.phone].filter(Boolean).map(escapeHtml).join("<br>")}</div>`;
    $("oItems").innerHTML = `<table><thead><tr><th>Item</th><th class="q-amount">Qty</th><th class="q-amount">Taxable</th><th class="q-amount">GST</th><th class="q-amount">Amount</th></tr></thead><tbody>${(o.items || [])
      .map((item) => `<tr><td>${escapeHtml(item.name)}${item.hsnSac ? `<div class="q-muted">HSN ${escapeHtml(item.hsnSac)}</div>` : ""}</td><td class="q-amount">${escapeHtml(String(item.quantity))} ${escapeHtml(item.unit || "")}</td><td class="q-amount">${rupees(item.taxablePaise)}</td><td class="q-amount">${escapeHtml(String(item.gstRatePct))}%</td><td class="q-amount">${rupees(item.totalPaise)}</td></tr>`)
      .join("")}</tbody></table>`;
    const t = o.totals || {};
    const s = o.supply || {};
    const row = (label, value, cls = "") => `<div class="q-sum-row ${cls}"><span>${label}</span><span>${value}</span></div>`;
    $("oTotals").innerHTML = [
      row("Taxable value", rupees(t.taxablePaise)),
      s.interState ? row("IGST", rupees(t.igstPaise)) : row("CGST", rupees(t.cgstPaise)) + row(escapeHtml(s.taxLabel || "SGST"), rupees(t.sgstPaise)),
      t.roundOffPaise ? row("Round off", `${t.roundOffPaise > 0 ? "+" : "−"} ${rupees(Math.abs(t.roundOffPaise))}`, "muted") : "",
      row("Total", rupees(t.grandTotalPaise), "grand"),
    ].join("");
    $("oHistory").innerHTML = [...(o.history || [])]
      .reverse()
      .map((h) => `<div class="o-history"><span class="when">${escapeHtml(when(h.at))}</span><span>${h.from ? `${escapeHtml(h.from)} → ` : ""}<strong>${escapeHtml(h.stage)}</strong>${h.byName ? ` · ${escapeHtml(h.byName)}` : ""}${h.note ? `<div class="q-muted">${escapeHtml(h.note)}</div>` : ""}${h.notified ? '<div class="q-muted"><i class="fa-brands fa-whatsapp"></i> Customer updated on WhatsApp</div>' : ""}</span></div>`)
      .join("");
    renderActions();
    const locked = !can("edit") || o.stage === "Cancelled";
    document.querySelectorAll("#oDispatchForm input, #oDispatchForm button, #oNotes, #oSaveNotes").forEach((field) => { field.disabled = locked; });
  }

  function renderActions() {
    const o = order;
    const buttons = [];
    if (can("edit") && o.stage !== "Cancelled") {
      const next = FLOW[FLOW.indexOf(o.stage) + 1];
      if (next) buttons.push(`<button class="btn btn-primary" type="button" data-move="${escapeHtml(next)}"><i class="fa-solid fa-arrow-right"></i> Move to ${escapeHtml(next)}</button>`);
      buttons.push('<button class="btn btn-outline" type="button" data-move="">Change stage…</button>');
      if (o.nextStages.includes("Cancelled")) buttons.push('<button class="btn btn-danger-outline" type="button" data-move="Cancelled"><i class="fa-solid fa-ban"></i> Cancel order</button>');
    }
    if (canChat() && can("edit")) buttons.push('<button class="btn btn-outline" type="button" data-notify><i class="fa-brands fa-whatsapp"></i> Update the customer</button>');
    $("oActions").innerHTML = buttons.join("");
  }

  async function openOrder(id) {
    $("oListView").hidden = true;
    $("oDetailView").hidden = false;
    $("oNumber").textContent = "Loading…";
    window.scrollTo(0, 0);
    try {
      order = await crmApi(`/orders/${encodeURIComponent(id)}`);
      renderDetail();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't open the order."), "error");
      go("", { replace: true });
    }
  }

  function showList() {
    order = null;
    $("oDetailView").hidden = true;
    $("oListView").hidden = false;
    $("pageTitle").textContent = "Orders";
    loadTabs();
    loadList();
  }

  $("oDispatchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      order = await crmApi(`/orders/${order.id}`, jsonRequest("PATCH", { dispatch: { transporter: $("oTransporter").value.trim(), lrNumber: $("oLr").value.trim(), vehicleNumber: $("oVehicle").value.trim(), expectedDeliveryDate: $("oExpected").value || null } }));
      renderDetail();
      showToast("Dispatch details saved.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save."), "error");
    }
  });
  $("oSaveNotes").addEventListener("click", async () => {
    try {
      order = await crmApi(`/orders/${order.id}`, jsonRequest("PATCH", { notes: $("oNotes").value }));
      renderDetail();
      showToast("Notes saved.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save."), "error");
    }
  });

  // --- moving the order ---
  function openStage(target) {
    const options = order.nextStages;
    $("stageSelect").innerHTML = options.map((s) => `<option ${s === target ? "selected" : ""}>${escapeHtml(s)}</option>`).join("");
    $("stTransporter").value = order.dispatch?.transporter || "";
    $("stLr").value = order.dispatch?.lrNumber || "";
    $("stageNote").value = "";
    $("stageReason").value = "";
    $("stageNotifyRow").hidden = !canChat();
    syncStageForm();
    $("stageOverlay").classList.add("open");
  }
  function syncStageForm() {
    const stage = $("stageSelect").value;
    $("stageTitle").textContent = stage === "Cancelled" ? "Cancel the order" : `Move to ${stage}`;
    $("stageDispatch").hidden = stage !== "Dispatched";
    $("stageReasonField").hidden = stage !== "Cancelled";
    $("stageNoteField").hidden = stage === "Cancelled";
    $("stageGo").textContent = stage === "Cancelled" ? "Cancel the order" : "Move";
    $("stageGo").className = `btn ${stage === "Cancelled" ? "btn-danger-outline" : "btn-primary"}`;
  }
  $("stageSelect").addEventListener("change", syncStageForm);
  const closeStage = () => $("stageOverlay").classList.remove("open");
  $("stageClose").addEventListener("click", closeStage);
  $("stageCancel").addEventListener("click", closeStage);
  $("stageGo").addEventListener("click", async () => {
    const stage = $("stageSelect").value;
    const body = { stage };
    if (stage === "Cancelled") body.cancelReason = $("stageReason").value.trim();
    else body.note = $("stageNote").value.trim();
    if (stage === "Dispatched") body.dispatch = { transporter: $("stTransporter").value.trim(), lrNumber: $("stLr").value.trim() };
    $("stageGo").disabled = true;
    try {
      order = await crmApi(`/orders/${order.id}/stage`, jsonRequest("POST", body));
      closeStage();
      renderDetail();
      showToast(`Order moved to ${order.stage}.${order.stage === "Payment Collected" ? " The lead is won." : ""}`, "success");
      if (canChat() && $("stageNotify").checked) openNotify();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't move the order."), "error");
    } finally {
      $("stageGo").disabled = false;
    }
  });
  $("oActions").addEventListener("click", (e) => {
    const move = e.target.closest("[data-move]");
    if (move) return openStage(move.dataset.move || order.nextStages[0]);
    if (e.target.closest("[data-notify]")) openNotify();
  });

  // --- WhatsApp update: a text in the 24-hour window, else an approved template ---
  const send = { options: null, mode: "text", templateId: "", done: "" };
  function templateVars(template) {
    if (!template) return [];
    return [
      ...(template.header?.variables || []).map((name) => ["header", name, `{{${name}}} in the heading`]),
      ...template.body.variables.map((name) => ["body", name, `{{${name}}} in the message`]),
      ...template.buttons.filter((b) => b.variables.length).map((b) => ["buttons", String(b.index), `The end of the "${b.text}" button link`]),
    ];
  }
  function preview(template) {
    const values = { header: {}, body: {}, buttons: {} };
    document.querySelectorAll("#sendBody [data-send-var]").forEach((input) => {
      values[input.dataset.part][input.dataset.sendVar] = input.value;
    });
    const fill = (text, part) => String(text || "").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) => values[part][name] || match);
    return [template.header?.text ? fill(template.header.text, "header") : "", fill(template.body.text, "body"), template.footer].filter(Boolean).join("\n\n");
  }
  function renderSend() {
    const o = send.options;
    $("sendGo").hidden = true;
    if (send.done) {
      $("sendBody").innerHTML = `<div class="q-send-done"><i class="fa-solid fa-circle-check"></i><p>Update sent.</p><a class="btn btn-outline" href="Inbox.html?c=${encodeURIComponent(send.done)}"><i class="fa-solid fa-comments"></i> Open the chat</a></div>`;
      $("sendCancel").textContent = "Close";
      return;
    }
    if (!o) {
      $("sendBody").innerHTML = '<p class="q-muted">Loading…</p>';
      return;
    }
    if (o.blocked) {
      $("sendBody").innerHTML = `<div class="q-warning">${escapeHtml(o.blocked)}</div>`;
      return;
    }
    if (!o.windowOpen) send.mode = "template";
    const template = o.templates.find((t) => String(t.id) === send.templateId) || null;
    const modes = o.windowOpen
      ? `<div class="q-send-mode">
          <label><input type="radio" name="sendMode" value="text" ${send.mode === "text" ? "checked" : ""} /><span>A message<small>The customer wrote in the last 24 hours.</small></span></label>
          <label><input type="radio" name="sendMode" value="template" ${send.mode === "template" ? "checked" : ""} /><span>An approved template</span></label>
        </div>`
      : '<div class="q-warning">The customer has not written in the last 24 hours, so WhatsApp allows only an approved template.</div>';
    let detail;
    if (send.mode === "text") {
      detail = `<div class="field"><label for="sendText">Message</label><textarea id="sendText" rows="4" maxlength="4096">${escapeHtml(send.text ?? o.text)}</textarea></div>`;
    } else if (!o.templates.length) {
      detail = '<p class="q-muted">No approved template on this WhatsApp number yet (Settings → WhatsApp → Message templates).</p>';
    } else {
      detail = `<div class="field"><label for="sendTemplate">Template</label><select id="sendTemplate"><option value="">Choose a template…</option>${o.templates
        .map((t) => `<option value="${escapeHtml(t.id)}" ${String(t.id) === send.templateId ? "selected" : ""}>${escapeHtml(t.name)} (${escapeHtml(t.language)})</option>`)
        .join("")}</select></div>
        ${templateVars(template).map(([part, name, label]) => `<div class="field"><label>${escapeHtml(label)}</label><input type="text" maxlength="1024" data-part="${part}" data-send-var="${escapeHtml(name)}" value="${escapeHtml(template.suggested?.[part]?.[name] || "")}" /></div>`).join("")}
        ${template ? '<div class="q-send-preview"><div id="sendPreview"></div></div>' : ""}`;
    }
    $("sendBody").innerHTML = `<div class="q-send-to">To <strong>${escapeHtml(order.billTo?.name || "")}</strong> · order ${escapeHtml(order.number)} · ${escapeHtml(order.stage)}</div>${modes}${detail}`;
    if (template) $("sendPreview").textContent = preview(template);
    $("sendGo").hidden = send.mode === "template" && !template;
  }
  async function openNotify() {
    Object.assign(send, { options: null, mode: "text", templateId: "", done: "", text: undefined });
    $("sendCancel").textContent = "Not now";
    $("sendOverlay").classList.add("open");
    renderSend();
    try {
      send.options = await crmApi(`/orders/${order.id}/notify-options`);
      const guess = send.options.templates.find((t) => /order|dispatch|ship|deliver/i.test(t.name)) || send.options.templates[0];
      if (guess) send.templateId = String(guess.id);
    } catch (error) {
      send.options = { blocked: apiErrorMessage(error, "Couldn't check WhatsApp.") };
    }
    renderSend();
  }
  const closeSend = () => $("sendOverlay").classList.remove("open");
  $("sendClose").addEventListener("click", closeSend);
  $("sendCancel").addEventListener("click", closeSend);
  $("sendBody").addEventListener("change", (e) => {
    if (e.target.name === "sendMode") send.mode = e.target.value;
    else if (e.target.id === "sendTemplate") send.templateId = e.target.value;
    else return;
    renderSend();
  });
  $("sendBody").addEventListener("input", (e) => {
    if (e.target.id === "sendText") send.text = e.target.value;
    if (e.target.dataset.sendVar !== undefined) $("sendPreview").textContent = preview(send.options.templates.find((t) => String(t.id) === send.templateId));
  });
  $("sendGo").addEventListener("click", async () => {
    const body = { mode: send.mode };
    if (send.mode === "text") body.text = (send.text ?? send.options.text).trim();
    else {
      body.templateId = send.templateId;
      body.variables = { header: {}, body: {}, buttons: {} };
      document.querySelectorAll("#sendBody [data-send-var]").forEach((input) => {
        body.variables[input.dataset.part][input.dataset.sendVar] = input.value.trim();
      });
    }
    $("sendGo").disabled = true;
    try {
      const request = jsonRequest("POST", body);
      request.headers["Idempotency-Key"] = newIdempotencyKey();
      const result = await crmApi(`/orders/${order.id}/notify`, request);
      order = result.order;
      renderDetail();
      send.done = String(result.conversationId);
      renderSend();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't send the update."), "error");
    } finally {
      $("sendGo").disabled = false;
    }
  });

  // --- page addresses ---
  function route() {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) openOrder(id);
    else showList();
  }
  function go(search, { replace = false } = {}) {
    const url = search ? `?${search}` : window.location.pathname;
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    route();
  }
  $("oBack").addEventListener("click", () => go(""));
  window.addEventListener("popstate", route);

  if (!can("view")) {
    $("oListView").innerHTML = '<div class="empty-state"><p>Orders need access to Leads or Deals. Ask the owner of your company.</p></div>';
    return;
  }
  route();
})();
