/**
 * payment-links.js — the "Payment link" dialog (Phase 8), shared by Orders, Quotations and the
 * Inbox. It makes a link through the company's payment gateway for an order (what is still
 * due), a quotation (its total) or an amount for a customer, then sends it into the customer's
 * WhatsApp chat (a ready message inside the 24-hour window, else an approved template) or copies
 * it. The subject's open link and earlier links show with their status, "Check now" and "Cancel".
 * One global: crmPaymentLinks.open({ orderId | quotationId | contactId, onChange? }).
 */
const crmPaymentLinks = (function paymentLinks() {
  const STATUS = {
    created: ["badge-info", "Waiting for payment"], partially_paid: ["badge-warning", "Part paid"], paid: ["badge-success", "Paid"],
    expired: ["badge-neutral", "Expired"], cancelled: ["badge-neutral", "Cancelled"],
  };
  const OPEN = ["created", "partially_paid"];
  const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const badge = (status) => {
    const [cls, label] = STATUS[status] || ["badge-neutral", status];
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
  };
  const toPaise = (text) => {
    const value = Number(String(text || "").replace(/[₹,\s]/g, ""));
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
  };
  const me = () => getCurrentMember() || {};
  const canChat = () => isOrgManager() || (me().modules || []).includes("inbox");
  const canEdit = () => isOrgManager() || (me().role !== "viewer" && (me().modules || []).some((m) => m === "leads" || m === "deals"));

  // state: { subject, options, view: loading | form | link | send | done, link, send, busy, onChange }
  let state = null;
  let els = null;

  function build() {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "plOverlay";
    overlay.innerHTML = `
      <div class="modal pl-modal" role="dialog" aria-modal="true" aria-labelledby="plTitle">
        <div class="modal-head">
          <h3 id="plTitle"><i class="fa-solid fa-indian-rupee-sign"></i> Payment link</h3>
          <button class="icon-btn" type="button" data-pl="close" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="modal-body" id="plBody"></div>
        <div class="modal-foot" id="plFoot"></div>
      </div>`;
    document.body.appendChild(overlay);
    els = { overlay, body: overlay.querySelector("#plBody"), foot: overlay.querySelector("#plFoot") };
    overlay.addEventListener("click", onClick);
    overlay.addEventListener("change", onChange);
    overlay.addEventListener("input", onInput);
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  }

  function close() {
    els?.overlay.classList.remove("open");
    state = null;
  }

  // --- views ------------------------------------------------------------------------------
  function linkCard(link, { actions = true } = {}) {
    const left = Math.max(link.amountPaise - (link.amountPaidPaise || 0), 0);
    const open = OPEN.includes(link.status);
    const meta = [
      `${escapeHtml(link.providerName || link.provider)}${link.mode === "test" ? " (test)" : ""}`,
      link.amountPaidPaise ? `${rupees(link.amountPaidPaise)} paid of ${rupees(link.amountPaise)}` : "",
      open && link.expiresAt ? `valid till ${escapeHtml(day(link.expiresAt))}` : "",
      link.sentAt ? `sent on WhatsApp ${escapeHtml(when(link.sentAt))}` : "not sent yet",
      link.paidAt ? `paid ${escapeHtml(when(link.paidAt))}` : "",
    ].filter(Boolean).join(" · ");
    return `
      <div class="pl-link">
        <div class="pl-link-top"><span class="pl-amount">${rupees(open ? left : link.amountPaise)}</span>${badge(link.status)}</div>
        <div class="pl-to">${escapeHtml(link.description || "")}</div>
        ${link.shortUrl ? `<div class="pl-url"><input type="text" readonly value="${escapeHtml(link.shortUrl)}" aria-label="Payment link" /><button class="btn btn-outline" type="button" data-pl="copy" data-url="${escapeHtml(link.shortUrl)}"><i class="fa-regular fa-copy"></i> Copy</button></div>` : ""}
        <div class="pl-meta">${meta}</div>
        ${link.lastSyncError ? `<div class="pl-meta">Last check: ${escapeHtml(link.lastSyncError)}</div>` : ""}
        ${(link.receipts || []).filter((r) => r.status !== "sent").map((r) => `<div class="pl-meta">Receipt not sent: ${escapeHtml(r.reason || r.status)}</div>`).join("")}
        ${actions ? `<div class="pl-buttons">
          ${open && canChat() && canEdit() ? '<button class="btn btn-primary" type="button" data-pl="send"><i class="fa-brands fa-whatsapp"></i> Send on WhatsApp</button>' : ""}
          <button class="btn btn-outline" type="button" data-pl="refresh"><i class="fa-solid fa-rotate"></i> Check now</button>
          ${link.status === "created" && canEdit() ? '<button class="btn btn-danger-outline" type="button" data-pl="cancel">Cancel link</button>' : ""}
        </div>` : ""}
      </div>`;
  }

  function history() {
    const others = (state.options?.links || []).filter((l) => l.id !== state.link?.id);
    if (!others.length) return "";
    return `<details class="pl-history"><summary>Earlier links (${others.length})</summary>${others
      .map((l) => `<div class="pl-history-row"><span>${rupees(l.amountPaise)} · ${escapeHtml(day(l.createdAt))}${l.amountPaidPaise ? ` · ${rupees(l.amountPaidPaise)} paid` : ""}</span>${badge(l.status)}</div>`)
      .join("")}</details>`;
  }

  function formView() {
    const o = state.options;
    const forAmount = o.purpose === "amount";
    const gateways = o.gateways.length > 1
      ? `<div class="field"><label for="plGateway">Through</label><select id="plGateway">${o.gateways.map((g) => `<option value="${escapeHtml(g.id)}" ${g.isDefault ? "selected" : ""}>${escapeHtml(g.name)}${g.mode === "test" ? " (test)" : ""}</option>`).join("")}</select></div>`
      : "";
    return `
      <div class="pl-to">${forAmount ? `For <strong>${escapeHtml(o.customerName || "the customer")}</strong>` : `${escapeHtml(o.purpose === "order" ? "Order" : "Quotation")} <strong>${escapeHtml(o.documentNumber)}</strong> · ${escapeHtml(o.customerName || "")}`}</div>
      <div class="field-row">
        <div class="field"><label for="plAmount">Amount (₹)</label><input type="text" id="plAmount" inputmode="decimal" value="${o.amountPaise ? escapeHtml((o.amountPaise / 100).toFixed(2)) : ""}" placeholder="e.g. 5000" /></div>
        <div class="field"><label for="plDays">Valid for (days)</label><input type="number" id="plDays" min="1" max="180" value="${escapeHtml(o.expiryDays || 7)}" /></div>
      </div>
      ${o.maxPaise ? `<p class="pl-hint">${o.purpose === "order" ? "Still due" : "Quotation total"}: ${rupees(o.maxPaise)}. You can ask for less (an advance).</p>` : ""}
      <div class="field"><label for="plFor">${forAmount ? "What is it for" : "Description (the customer sees it)"}</label><input type="text" id="plFor" maxlength="500" placeholder="${forAmount ? "e.g. Advance for 50 bags of jeera" : "Leave empty for the document number"}" /></div>
      <label class="pl-check"><input type="checkbox" id="plPartial" /> The customer may pay in parts</label>
      <div class="field" id="plMinField" hidden><label for="plMin">Smallest part (₹)</label><input type="text" id="plMin" inputmode="decimal" placeholder="e.g. 1000" /></div>
      ${gateways}
      ${history()}`;
  }

  function sendView() {
    const s = state.send;
    const o = s.options;
    if (!o) return '<p class="pl-to">Checking WhatsApp…</p>';
    if (o.blocked) return `<div class="pl-note">${escapeHtml(o.blocked)}</div>`;
    if (!o.windowOpen) s.mode = "template";
    const template = o.templates.find((t) => String(t.id) === s.templateId) || null;
    const modes = o.windowOpen
      ? `<div class="pl-mode">
          <label><input type="radio" name="plMode" value="text" ${s.mode === "text" ? "checked" : ""} /><span>A message<small>The customer wrote in the last 24 hours.</small></span></label>
          <label><input type="radio" name="plMode" value="template" ${s.mode === "template" ? "checked" : ""} /><span>An approved template</span></label>
        </div>`
      : '<div class="pl-note">The customer has not written in the last 24 hours, so WhatsApp allows only an approved template.</div>';
    let detail;
    if (s.mode === "text") {
      detail = `<div class="field"><label for="plText">Message</label><textarea id="plText" rows="5" maxlength="4096">${escapeHtml(s.text ?? o.text)}</textarea></div>`;
    } else if (!o.templates.length) {
      detail = '<p class="pl-to">No approved template on this WhatsApp number yet (Settings → WhatsApp → Message templates).</p>';
    } else {
      const vars = template ? [
        ...(template.header?.variables || []).map((name) => ["header", name, `{{${name}}} in the heading`]),
        ...template.body.variables.map((name) => ["body", name, `{{${name}}} in the message`]),
        ...template.buttons.filter((b) => b.variables.length).map((b) => ["buttons", String(b.index), `The end of the "${b.text}" button link`]),
      ] : [];
      detail = `<div class="field"><label for="plTemplate">Template</label><select id="plTemplate"><option value="">Choose a template…</option>${o.templates
        .map((t) => `<option value="${escapeHtml(t.id)}" ${String(t.id) === s.templateId ? "selected" : ""}>${escapeHtml(t.name)} (${escapeHtml(t.language)})</option>`)
        .join("")}</select></div>
        ${vars.map(([part, name, label]) => `<div class="field"><label>${escapeHtml(label)}</label><input type="text" maxlength="1024" data-part="${part}" data-pl-var="${escapeHtml(name)}" value="${escapeHtml(template.suggested?.[part]?.[name] || "")}" /></div>`).join("")}
        ${template ? '<div class="pl-preview"><div id="plPreview"></div></div>' : ""}
        ${template && !/\{\{/.test(template.body.text) && !template.buttons.some((b) => b.variables.length) ? '<p class="pl-hint">This template has no place for the link: pick one with a variable or a link button.</p>' : ""}`;
    }
    return `<div class="pl-to">To <strong>${escapeHtml(state.link.customerName || "the customer")}</strong> · ${rupees(state.link.amountPaise - (state.link.amountPaidPaise || 0))}</div>${modes}${detail}`;
  }

  function previewText() {
    const o = state.send.options;
    const template = o.templates.find((t) => String(t.id) === state.send.templateId);
    if (!template) return "";
    const values = { header: {}, body: {}, buttons: {} };
    els.body.querySelectorAll("[data-pl-var]").forEach((input) => {
      values[input.dataset.part][input.dataset.plVar] = input.value;
    });
    const fill = (text, part) => String(text || "").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) => values[part][name] || match);
    return [template.header?.text ? fill(template.header.text, "header") : "", fill(template.body.text, "body"), template.footer].filter(Boolean).join("\n\n");
  }

  function render() {
    if (!state) return;
    const button = (action, label, cls = "btn-outline", disabled = false) => `<button class="btn ${cls}" type="button" data-pl="${action}" ${disabled || state.busy ? "disabled" : ""}>${label}</button>`;
    let body = "";
    let foot = button("close", "Close");
    switch (state.view) {
      case "loading":
        body = '<p class="pl-to">Loading…</p>';
        break;
      case "blocked":
        body = `<div class="pl-note">${escapeHtml(state.options.blocked)}</div>${history()}`;
        break;
      case "form":
        body = formView();
        foot = button("close", "Cancel") + (canEdit() ? button("create", '<i class="fa-solid fa-link"></i> Create link', "btn-primary") : "");
        break;
      case "link":
        body = linkCard(state.link) + history();
        break;
      case "send":
        body = sendView();
        foot = button("back", "Back");
        if (state.send.options && !state.send.options.blocked && (state.send.mode === "text" || state.send.templateId)) foot += button("go", '<i class="fa-brands fa-whatsapp"></i> Send', "btn-primary");
        break;
      case "done":
        body = `<div class="pl-done"><i class="fa-solid fa-circle-check"></i><p>Payment link sent on WhatsApp.</p><p class="pl-hint">When the customer pays, the order is updated, they get a receipt and you get a note under the bell.</p>${state.conversationId ? `<a class="btn btn-outline" href="Inbox.html?c=${encodeURIComponent(state.conversationId)}"><i class="fa-solid fa-comments"></i> Open the chat</a>` : ""}</div>`;
        break;
      default:
        break;
    }
    els.body.innerHTML = body;
    els.foot.innerHTML = foot;
    if (state.view === "send" && els.body.querySelector("#plPreview")) els.body.querySelector("#plPreview").textContent = previewText();
  }

  // --- actions ----------------------------------------------------------------------------
  const query = () => {
    const [key, value] = Object.entries(state.subject).find(([, v]) => v);
    return `${key}=${encodeURIComponent(value)}`;
  };

  async function load() {
    state.view = "loading";
    render();
    try {
      state.options = await crmApi(`/payment-links/options?${query()}`);
      state.link = state.options.openLink;
      state.view = state.link ? "link" : state.options.blocked ? "blocked" : "form";
    } catch (error) {
      state.options = { blocked: apiErrorMessage(error, "Couldn't load the payment details."), links: [] };
      state.view = "blocked";
    }
    render();
  }

  function changed() {
    try {
      state?.onChange?.(state.link);
    } catch {
      /* the page refreshes itself */
    }
  }

  async function create() {
    const amountPaise = toPaise(els.body.querySelector("#plAmount").value);
    if (!amountPaise) return showToast("Enter the amount to collect.", "error");
    const body = { ...Object.fromEntries(Object.entries(state.subject).filter(([, v]) => v)), amountPaise };
    const description = els.body.querySelector("#plFor").value.trim();
    if (description) body.description = description;
    if (state.options.purpose === "amount" && !description) return showToast("Say what the payment is for.", "error");
    const days = Number(els.body.querySelector("#plDays").value);
    if (days) body.expiresInDays = days;
    if (els.body.querySelector("#plPartial").checked) {
      body.acceptPartial = true;
      const min = toPaise(els.body.querySelector("#plMin").value);
      if (min) body.minPartialPaise = min;
    }
    const gateway = els.body.querySelector("#plGateway");
    if (gateway) body.connectionId = gateway.value;
    state.busy = true;
    render();
    try {
      const request = jsonRequest("POST", body);
      request.headers["Idempotency-Key"] = newIdempotencyKey();
      state.link = await crmApi("/payment-links", request);
      state.options.links = [state.link, ...(state.options.links || [])];
      state.view = "link";
      showToast("Payment link created.", "success");
      changed();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't create the link."), "error");
      if (error?.code === "OPEN_LINK_EXISTS") return load();
    } finally {
      if (state) state.busy = false;
      render();
    }
  }

  async function openSend() {
    state.view = "send";
    state.send = { options: null, mode: "text", templateId: "", text: undefined };
    render();
    try {
      const options = await crmApi(`/payment-links/${state.link.id}/send-options`);
      state.send.options = options;
      const guess = options.templates.find((t) => String(t.id) === String(options.preferredTemplateId))
        || options.templates.find((t) => /pay|link|due|invoice/i.test(t.name));
      if (guess) state.send.templateId = String(guess.id);
    } catch (error) {
      state.send.options = { blocked: apiErrorMessage(error, "Couldn't check WhatsApp.") };
    }
    render();
  }

  async function send() {
    const s = state.send;
    const body = { mode: s.mode };
    if (s.mode === "text") body.text = (s.text ?? s.options.text).trim();
    else {
      body.templateId = s.templateId;
      body.variables = { header: {}, body: {}, buttons: {} };
      els.body.querySelectorAll("[data-pl-var]").forEach((input) => {
        body.variables[input.dataset.part][input.dataset.plVar] = input.value.trim();
      });
    }
    state.busy = true;
    render();
    try {
      const request = jsonRequest("POST", body);
      request.headers["Idempotency-Key"] = newIdempotencyKey();
      const result = await crmApi(`/payment-links/${state.link.id}/send`, request);
      state.link = result.link;
      state.conversationId = result.conversationId;
      state.view = "done";
      changed();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't send the link."), "error");
    } finally {
      if (state) state.busy = false;
      render();
    }
  }

  async function refresh() {
    state.busy = true;
    render();
    try {
      state.link = await crmApi(`/payment-links/${state.link.id}/refresh`, jsonRequest("POST", {}));
      showToast(state.link.status === "paid" ? "Paid!" : "Checked with the gateway.", "success");
      changed();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't check the link."), "error");
    } finally {
      if (state) state.busy = false;
      render();
    }
  }

  async function cancel() {
    if (!window.confirm("Cancel this payment link? The customer will no longer be able to pay with it.")) return;
    state.busy = true;
    render();
    try {
      state.link = await crmApi(`/payment-links/${state.link.id}/cancel`, jsonRequest("POST", {}));
      showToast("Payment link cancelled.", "success");
      changed();
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't cancel the link."), "error");
    } finally {
      if (state) state.busy = false;
      render();
    }
  }

  async function copy(url) {
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied.", "success");
    } catch {
      const input = els.body.querySelector(".pl-url input");
      input?.select();
      showToast("Press Ctrl+C to copy the link.", "info");
    }
  }

  function onClick(e) {
    if (e.target === els.overlay) return close();
    const action = e.target.closest("[data-pl]")?.dataset.pl;
    if (!action || !state) return undefined;
    const run = {
      close, create, send: openSend, go: send, refresh, cancel, back: () => { state.view = "link"; render(); },
      copy: () => copy(e.target.closest("[data-pl]").dataset.url),
    }[action];
    return run?.();
  }

  function onChange(e) {
    if (!state) return;
    if (e.target.id === "plPartial") els.body.querySelector("#plMinField").hidden = !e.target.checked;
    if (e.target.name === "plMode") {
      state.send.mode = e.target.value;
      render();
    }
    if (e.target.id === "plTemplate") {
      state.send.templateId = e.target.value;
      render();
    }
  }

  function onInput(e) {
    if (!state || state.view !== "send") return;
    if (e.target.id === "plText") state.send.text = e.target.value;
    if (e.target.dataset.plVar !== undefined) els.body.querySelector("#plPreview").textContent = previewText();
  }

  // subject: { orderId } | { quotationId } | { contactId }; onChange(link) after a change.
  function open({ orderId, quotationId, contactId, onChange: whenChanged } = {}) {
    if (!els) build();
    state = { subject: { orderId, quotationId, contactId }, options: null, view: "loading", link: null, send: null, busy: false, onChange: whenChanged };
    els.overlay.classList.add("open");
    load();
  }

  return { open, close };
})();
