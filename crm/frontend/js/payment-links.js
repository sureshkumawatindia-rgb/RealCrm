/**
 * payment-links.js — the "Payment link" dialog (Phase 8), shared by Orders, Quotations and the
 * Inbox. It makes a link through the company's payment gateway for an order (what is still
 * due), a quotation (its total) or an amount for a customer, then sends it into the customer's
 * WhatsApp chat (a ready message inside the 24-hour window, else an approved template) or copies
 * it. The subject's open link and earlier links show with their status, "Check now" and "Cancel".
 * One global: crmPaymentLinks.open({ orderId | quotationId | contactId, onChange? }).
 */
const crmPaymentLinks = (function paymentLinks() {
  // [badge class, text key]
  const STATUS = {
    created: ["badge-info", "pl.status.created"], partially_paid: ["badge-warning", "pl.status.partly"], paid: ["badge-success", "pl.status.paid"],
    expired: ["badge-neutral", "pl.status.expired"], cancelled: ["badge-neutral", "pl.status.cancelled"],
  };
  const OPEN = ["created", "partially_paid"];
  const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString(crmI18n.locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short", year: "numeric" }) : "");
  const when = (iso) => (iso ? new Date(iso).toLocaleString(crmI18n.locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const badge = (status) => {
    const [cls, key] = STATUS[status] || ["badge-neutral", ""];
    return `<span class="badge ${cls}">${escapeHtml(key ? t(key) : status)}</span>`;
  };
  const testMark = (mode) => (mode === "test" ? ` (${t("pl.test")})` : "");
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
          <h3 id="plTitle"><i class="fa-solid fa-indian-rupee-sign"></i> ${escapeHtml(t("quotes.act.paylink"))}</h3>
          <button class="icon-btn" type="button" data-pl="close" title="${escapeHtml(t("common.close"))}" aria-label="${escapeHtml(t("common.close"))}"><i class="fa-solid fa-xmark"></i></button>
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
      escapeHtml(`${link.providerName || link.provider}${testMark(link.mode)}`),
      link.amountPaidPaise ? escapeHtml(t("pl.paidOf", { paid: rupees(link.amountPaidPaise), total: rupees(link.amountPaise) })) : "",
      open && link.expiresAt ? escapeHtml(t("pl.validTill", { date: day(link.expiresAt) })) : "",
      escapeHtml(link.sentAt ? t("pl.sentAt", { date: when(link.sentAt) }) : t("pl.notSent")),
      link.paidAt ? escapeHtml(t("orders.paidOn", { date: when(link.paidAt) })) : "",
    ].filter(Boolean).join(" · ");
    return `
      <div class="pl-link">
        <div class="pl-link-top"><span class="pl-amount">${rupees(open ? left : link.amountPaise)}</span>${badge(link.status)}</div>
        <div class="pl-to">${escapeHtml(link.description || "")}</div>
        ${link.shortUrl ? `<div class="pl-url"><input type="text" readonly value="${escapeHtml(link.shortUrl)}" aria-label="${escapeHtml(t("quotes.act.paylink"))}" /><button class="btn btn-outline" type="button" data-pl="copy" data-url="${escapeHtml(link.shortUrl)}"><i class="fa-regular fa-copy"></i> ${escapeHtml(t("pl.copy"))}</button></div>` : ""}
        <div class="pl-meta">${meta}</div>
        ${link.lastSyncError ? `<div class="pl-meta">${escapeHtml(t("pl.lastCheck", { error: link.lastSyncError }))}</div>` : ""}
        ${(link.receipts || []).filter((r) => r.status !== "sent").map((r) => `<div class="pl-meta">${escapeHtml(t("pl.receiptNotSent", { reason: r.reason || r.status }))}</div>`).join("")}
        ${actions ? `<div class="pl-buttons">
          ${open && canChat() && canEdit() ? `<button class="btn btn-primary" type="button" data-pl="send"><i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("quotes.act.whatsapp"))}</button>` : ""}
          <button class="btn btn-outline" type="button" data-pl="refresh"><i class="fa-solid fa-rotate"></i> ${escapeHtml(t("pl.check"))}</button>
          ${link.status === "created" && canEdit() ? `<button class="btn btn-danger-outline" type="button" data-pl="cancel">${escapeHtml(t("pl.cancelLink"))}</button>` : ""}
        </div>` : ""}
      </div>`;
  }

  function history() {
    const others = (state.options?.links || []).filter((l) => l.id !== state.link?.id);
    if (!others.length) return "";
    return `<details class="pl-history"><summary>${escapeHtml(t("pl.earlier", { n: others.length }))}</summary>${others
      .map((l) => `<div class="pl-history-row"><span>${rupees(l.amountPaise)} · ${escapeHtml(day(l.createdAt))}${l.amountPaidPaise ? ` · ${escapeHtml(t("pl.paid", { amount: rupees(l.amountPaidPaise) }))}` : ""}</span>${badge(l.status)}</div>`)
      .join("")}</details>`;
  }

  function formView() {
    const o = state.options;
    const forAmount = o.purpose === "amount";
    const gateways = o.gateways.length > 1
      ? `<div class="field"><label for="plGateway">${escapeHtml(t("pl.through"))}</label><select id="plGateway">${o.gateways.map((g) => `<option value="${escapeHtml(g.id)}" ${g.isDefault ? "selected" : ""}>${escapeHtml(`${g.name}${testMark(g.mode)}`)}</option>`).join("")}</select></div>`
      : "";
    return `
      <div class="pl-to">${forAmount ? t("pl.for", { name: `<strong>${escapeHtml(o.customerName || t("quotes.send.theCustomer"))}</strong>` }) : `${escapeHtml(o.purpose === "order" ? t("orders.col.order") : crmLabel("quoteType", "Quotation"))} <strong>${escapeHtml(o.documentNumber)}</strong> · ${escapeHtml(o.customerName || "")}`}</div>
      <div class="field-row">
        <div class="field"><label for="plAmount">${escapeHtml(t("orders.amount"))}</label><input type="text" id="plAmount" inputmode="decimal" value="${o.amountPaise ? escapeHtml((o.amountPaise / 100).toFixed(2)) : ""}" placeholder="${escapeHtml(t("pl.eg5000"))}" /></div>
        <div class="field"><label for="plDays">${escapeHtml(t("pl.validDays"))}</label><input type="number" id="plDays" min="1" max="180" value="${escapeHtml(o.expiryDays || 7)}" /></div>
      </div>
      ${o.maxPaise ? `<p class="pl-hint">${escapeHtml(t(o.purpose === "order" ? "pl.hint.due" : "pl.hint.quote", { amount: rupees(o.maxPaise) }))}</p>` : ""}
      <div class="field"><label for="plFor">${escapeHtml(t(forAmount ? "pl.whatFor" : "pl.description"))}</label><input type="text" id="plFor" maxlength="500" placeholder="${escapeHtml(t(forAmount ? "pl.eg.for" : "pl.eg.doc"))}" /></div>
      <label class="pl-check"><input type="checkbox" id="plPartial" /> <span>${escapeHtml(t("pl.partial"))}</span></label>
      <div class="field" id="plMinField" hidden><label for="plMin">${escapeHtml(t("pl.min"))}</label><input type="text" id="plMin" inputmode="decimal" placeholder="${escapeHtml(t("pl.eg1000"))}" /></div>
      ${gateways}
      ${history()}`;
  }

  function sendView() {
    const s = state.send;
    const o = s.options;
    if (!o) return `<p class="pl-to">${escapeHtml(t("pl.checking"))}</p>`;
    if (o.blocked) return `<div class="pl-note">${escapeHtml(o.blocked)}</div>`;
    if (!o.windowOpen) s.mode = "template";
    const template = o.templates.find((tpl) => String(tpl.id) === s.templateId) || null;
    const modes = o.windowOpen
      ? `<div class="pl-mode">
          <label><input type="radio" name="plMode" value="text" ${s.mode === "text" ? "checked" : ""} /><span>${escapeHtml(t("orders.mode.text"))}<small>${escapeHtml(t("orders.mode.textHint"))}</small></span></label>
          <label><input type="radio" name="plMode" value="template" ${s.mode === "template" ? "checked" : ""} /><span>${escapeHtml(t("quotes.send.tplMode"))}</span></label>
        </div>`
      : `<div class="pl-note">${escapeHtml(t("orders.closed"))}</div>`;
    let detail;
    if (s.mode === "text") {
      detail = `<div class="field"><label for="plText">${escapeHtml(t("c360.message"))}</label><textarea id="plText" rows="5" maxlength="4096">${escapeHtml(s.text ?? o.text)}</textarea></div>`;
    } else if (!o.templates.length) {
      detail = `<p class="pl-to">${escapeHtml(t("orders.noTemplates"))}</p>`;
    } else {
      const vars = template ? [
        ...(template.header?.variables || []).map((name) => ["header", name, t("quotes.var.header", { name })]),
        ...template.body.variables.map((name) => ["body", name, t("quotes.var.body", { name })]),
        ...template.buttons.filter((b) => b.variables.length).map((b) => ["buttons", String(b.index), t("quotes.var.button", { text: b.text })]),
      ] : [];
      detail = `<div class="field"><label for="plTemplate">${escapeHtml(t("inbox.template"))}</label><select id="plTemplate"><option value="">${escapeHtml(t("quotes.send.chooseTpl"))}</option>${o.templates
        .map((tpl) => `<option value="${escapeHtml(tpl.id)}" ${String(tpl.id) === s.templateId ? "selected" : ""}>${escapeHtml(tpl.name)} (${escapeHtml(tpl.language)})</option>`)
        .join("")}</select></div>
        ${vars.map(([part, name, label]) => `<div class="field"><label>${escapeHtml(label)}</label><input type="text" maxlength="1024" data-part="${part}" data-pl-var="${escapeHtml(name)}" value="${escapeHtml(template.suggested?.[part]?.[name] || "")}" /></div>`).join("")}
        ${template ? '<div class="pl-preview"><div id="plPreview"></div></div>' : ""}
        ${template && !/\{\{/.test(template.body.text) && !template.buttons.some((b) => b.variables.length) ? `<p class="pl-hint">${escapeHtml(t("pl.noLinkSpot"))}</p>` : ""}`;
    }
    return `<div class="pl-to">${t("quotes.send.to", { name: `<strong>${escapeHtml(state.link.customerName || t("quotes.send.theCustomer"))}</strong>` })} · ${rupees(state.link.amountPaise - (state.link.amountPaidPaise || 0))}</div>${modes}${detail}`;
  }

  function previewText() {
    const o = state.send.options;
    const template = o.templates.find((tpl) => String(tpl.id) === state.send.templateId);
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
    let foot = button("close", escapeHtml(t("common.close")));
    switch (state.view) {
      case "loading":
        body = `<p class="pl-to">${escapeHtml(t("cw.loading"))}</p>`;
        break;
      case "blocked":
        body = `<div class="pl-note">${escapeHtml(state.options.blocked)}</div>${history()}`;
        break;
      case "form":
        body = formView();
        foot = button("close", escapeHtml(t("common.cancel"))) + (canEdit() ? button("create", `<i class="fa-solid fa-link"></i> ${escapeHtml(t("pl.create"))}`, "btn-primary") : "");
        break;
      case "link":
        body = linkCard(state.link) + history();
        break;
      case "send":
        body = sendView();
        foot = button("back", escapeHtml(t("pl.back")));
        if (state.send.options && !state.send.options.blocked && (state.send.mode === "text" || state.send.templateId)) foot += button("go", `<i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("pl.send"))}`, "btn-primary");
        break;
      case "done":
        body = `<div class="pl-done"><i class="fa-solid fa-circle-check"></i><p>${escapeHtml(t("pl.done"))}</p><p class="pl-hint">${escapeHtml(t("pl.doneHint"))}</p>${state.conversationId ? `<a class="btn btn-outline" href="Inbox.html?c=${encodeURIComponent(state.conversationId)}"><i class="fa-solid fa-comments"></i> ${escapeHtml(t("quotes.send.openChat"))}</a>` : ""}</div>`;
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
      state.options = { blocked: apiErrorMessage(error, t("pl.err.load")), links: [] };
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
    if (!amountPaise) return showToast(t("pl.needAmount"), "error");
    const body = { ...Object.fromEntries(Object.entries(state.subject).filter(([, v]) => v)), amountPaise };
    const description = els.body.querySelector("#plFor").value.trim();
    if (description) body.description = description;
    if (state.options.purpose === "amount" && !description) return showToast(t("pl.needFor"), "error");
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
      showToast(t("pl.created"), "success");
      changed();
    } catch (error) {
      showToast(apiErrorMessage(error, t("pl.err.create")), "error");
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
      const guess = options.templates.find((tpl) => String(tpl.id) === String(options.preferredTemplateId))
        || options.templates.find((tpl) => /pay|link|due|invoice/i.test(tpl.name));
      if (guess) state.send.templateId = String(guess.id);
    } catch (error) {
      state.send.options = { blocked: apiErrorMessage(error, t("quotes.send.checkFailed")) };
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
      showToast(apiErrorMessage(error, t("pl.err.send")), "error");
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
      showToast(t(state.link.status === "paid" ? "pl.paidToast" : "pl.checked"), "success");
      changed();
    } catch (error) {
      showToast(apiErrorMessage(error, t("pl.err.check")), "error");
    } finally {
      if (state) state.busy = false;
      render();
    }
  }

  async function cancel() {
    if (!window.confirm(t("pl.confirmCancel"))) return;
    state.busy = true;
    render();
    try {
      state.link = await crmApi(`/payment-links/${state.link.id}/cancel`, jsonRequest("POST", {}));
      showToast(t("pl.cancelled"), "success");
      changed();
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, t("pl.err.cancel")), "error");
    } finally {
      if (state) state.busy = false;
      render();
    }
  }

  async function copy(url) {
    try {
      await navigator.clipboard.writeText(url);
      showToast(t("pl.copied"), "success");
    } catch {
      const input = els.body.querySelector(".pl-url input");
      input?.select();
      showToast(t("pl.ctrlC"), "info");
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
