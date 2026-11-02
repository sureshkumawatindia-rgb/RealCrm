/**
 * orders.js — Orders page (Phase 5; payments Phase 8)
 * The list (stage tabs with counts, search, what is paid) and one order: the stage stepper,
 * moving it on (with dispatch details, a cancel reason), the dispatch form, items and totals,
 * notes, the history, and a WhatsApp update to the customer after a move. Payments: the
 * order's payment card (payment link through js/payment-links.js, payments entered by hand)
 * and the "Payment due" tab (GET /orders/dues). Tax invoices (D101): the order's invoice card
 * (make it, credit notes for owners and admins, PDFs, send on WhatsApp) and a receipt for each
 * payment (GET /orders/:id/invoices).
 * Addresses: Orders.html, Orders.html?id=<order>, Orders.html?tab=dues. One function, run once the
 * page texts (English or Hindi) are loaded: no globals.
 */
crmI18n.ready.then(function ordersPage() {
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
  const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString(crmI18n.locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(crmI18n.locale(), { day: "2-digit", month: "short", year: "numeric" }) : "");
  const when = (iso) => (iso ? new Date(iso).toLocaleString(crmI18n.locale(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const stageName = (stage) => crmLabel("orderStage", stage);
  const badge = (stage) => `<span class="badge ${BADGE[stage] || "badge-neutral"}">${escapeHtml(stageName(stage))}</span>`;
  const nOrders = (n) => t(n === 1 ? "orders.n.one" : "orders.n.many", { n });
  const nDays = (n) => t(n === 1 ? "orders.days.one" : "orders.days.many", { n });
  const DUES = "__dues";
  // How a payment came in: text keys (UPI and EMI are the same in every language).
  const METHODS = { cash: "orders.cash", bank_transfer: "orders.method.bank", cheque: "orders.cheque", card: "orders.card", other: "orders.other", netbanking: "orders.method.netbanking", wallet: "orders.method.wallet" };
  const methodName = (method) => (METHODS[method] ? t(METHODS[method]) : { upi: "UPI", emi: "EMI" }[method] || method);
  function paymentBadge(o) {
    if (o.stage === "Cancelled") return '<span class="q-muted">—</span>';
    if (o.paymentStatus === "paid") return `<span class="badge badge-success">${escapeHtml(t("orders.badge.paid"))}</span>`;
    if (o.paymentStatus === "partly_paid") return `<span class="badge badge-warning">${escapeHtml(t("orders.badge.due", { amount: rupees(o.duePaise) }))}</span>`;
    return `<span class="badge badge-neutral">${escapeHtml(t("orders.badge.unpaid"))}</span>`;
  }

  // ------------------------------------------------------------------------------------------
  // List
  // ------------------------------------------------------------------------------------------
  const list = { stage: "", page: 1, items: [], more: false, seq: 0 };

  async function loadTabs() {
    try {
      const [{ counts, total }, dues] = await Promise.all([crmApi("/orders/summary"), crmApi("/orders/dues").catch(() => null)]);
      $("oTabs").innerHTML = [["", t("orders.tab.all"), total], ...STAGES.map((s) => [s, stageName(s), counts[s] || 0]), ...(dues ? [[DUES, t("orders.tab.dues"), dues.summary.count]] : [])]
        .map(([value, label, count]) => `<button class="o-tab ${list.stage === value ? "active" : ""}" type="button" role="tab" data-stage="${escapeHtml(value)}">${escapeHtml(label)}<span class="count">${count}</span></button>`)
        .join("");
    } catch {
      $("oTabs").innerHTML = "";
    }
  }

  // --- what is due (Phase 8): unpaid and part-paid orders, oldest first ---
  async function loadDues() {
    const seq = ++list.seq;
    $("oMore").hidden = true;
    const q = $("oSearch").value.trim();
    try {
      const dues = await crmApi(`/orders/dues${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      if (seq !== list.seq) return;
      const s = dues.summary;
      $("oDuesSummary").hidden = false;
      $("oDuesSummary").innerHTML = [
        `<div class="dues-chip total"><span>${escapeHtml(t("orders.dues.total", { orders: nOrders(s.count) }))}</span><strong>${rupees(s.duePaise)}</strong></div>`,
        ...Object.entries(s.buckets).map(([name, b]) => `<div class="dues-chip"><span>${escapeHtml(t("orders.dues.bucket", { range: name }))}</span><strong>${rupees(b.duePaise)}</strong> <span>${escapeHtml(nOrders(b.count))}</span></div>`),
      ].join("");
      if (!dues.items.length) {
        $("oTable").innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-check"></i><p>${escapeHtml(t(q ? "orders.dues.noMatch" : "orders.dues.none"))}</p></div>`;
        return;
      }
      $("oTable").innerHTML = `
        <table>
          <thead><tr><th>${escapeHtml(t("orders.col.order"))}</th><th>${escapeHtml(t("quotes.col.customer"))}</th><th>${escapeHtml(t("quotes.col.date"))}</th><th>${escapeHtml(t("orders.col.waiting"))}</th><th class="q-amount">${escapeHtml(t("orders.col.paid"))}</th><th class="q-amount">${escapeHtml(t("orders.col.due"))}</th><th>${escapeHtml(t("quotes.act.paylink"))}</th><th></th></tr></thead>
          <tbody>${dues.items
            .map(
              (d) => `
            <tr data-open="${escapeHtml(d.id)}" tabindex="0">
              <td><div class="q-num">${escapeHtml(d.number)}</div><div class="q-muted">${escapeHtml(stageName(d.stage))}</div></td>
              <td><div>${escapeHtml(d.customer.name || "—")}</div>${d.customer.company && d.customer.company !== d.customer.name ? `<div class="q-muted">${escapeHtml(d.customer.company)}</div>` : ""}</td>
              <td>${escapeHtml(day(d.orderDate))}</td>
              <td class="dues-days ${d.daysOutstanding > 30 ? "late" : ""}">${escapeHtml(nDays(d.daysOutstanding))}</td>
              <td class="q-amount">${rupees(d.amountPaidPaise)}</td>
              <td class="q-amount"><strong>${rupees(d.duePaise)}</strong></td>
              <td class="q-muted">${d.openLink ? escapeHtml(d.openLink.sentAt ? t("orders.link.sent", { date: day(d.openLink.sentAt) }) : t("orders.link.made")) : "—"}</td>
              <td>${can("edit") ? `<button class="btn btn-outline" type="button" data-pay-link="${escapeHtml(d.id)}"><i class="fa-solid fa-indian-rupee-sign"></i> ${escapeHtml(t(d.openLink ? "orders.sendLink" : "quotes.act.paylink"))}</button>` : ""}</td>
            </tr>`,
            )
            .join("")}</tbody>
        </table>${dues.truncated ? `<p class="q-muted">${escapeHtml(t("orders.dues.truncated"))}</p>` : ""}`;
    } catch (error) {
      $("oTable").innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(error, t("orders.err.dues")))}</p></div>`;
    }
  }

  async function loadList(reset = true) {
    $("oDuesSummary").hidden = list.stage !== DUES;
    if (list.stage === DUES) return loadDues();
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
      $("oTable").innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(error, t("orders.err.list")))}</p></div>`;
    }
  }

  function renderList() {
    $("oMore").hidden = !list.more;
    if (!list.items.length) {
      $("oTable").innerHTML = `<div class="empty-state"><i class="fa-solid fa-truck-fast"></i><p>${escapeHtml(t(list.stage || $("oSearch").value.trim() ? "orders.empty.filtered" : "orders.empty.none"))}</p></div>`;
      return;
    }
    $("oTable").innerHTML = `
      <table>
        <thead><tr><th>${escapeHtml(t("orders.col.order"))}</th><th>${escapeHtml(t("quotes.col.customer"))}</th><th>${escapeHtml(t("quotes.col.date"))}</th><th>${escapeHtml(t("orders.dispatch"))}</th><th class="q-amount">${escapeHtml(t("quotes.col.amount"))}</th><th>${escapeHtml(t("orders.stage"))}</th><th>${escapeHtml(t("orders.col.payment"))}</th></tr></thead>
        <tbody>${list.items
          .map(
            (o) => `
          <tr data-open="${escapeHtml(o.id)}" tabindex="0">
            <td><div class="q-num">${escapeHtml(o.number)}</div><div class="q-muted">${o.source === "catalog" ? `<i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("orders.catalog"))}` : escapeHtml(o.quotationNumber || "")}</div></td>
            <td><div>${escapeHtml(o.billTo?.name || "—")}</div>${o.billTo?.company ? `<div class="q-muted">${escapeHtml(o.billTo.company)}</div>` : ""}</td>
            <td>${escapeHtml(day(o.orderDate))}</td>
            <td class="q-muted">${escapeHtml([o.dispatch?.transporter, o.dispatch?.lrNumber].filter(Boolean).join(" · ") || "—")}</td>
            <td class="q-amount">${rupees(o.totals?.grandTotalPaise)}</td>
            <td>${badge(o.stage)}</td>
            <td>${paymentBadge(o)}</td>
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
    const payLink = e.target.closest("[data-pay-link]");
    if (payLink) return crmPaymentLinks.open({ orderId: payLink.dataset.payLink, onChange: () => { loadTabs(); loadDues(); } });
    const row = e.target.closest("[data-open]");
    if (row) go(`id=${encodeURIComponent(row.dataset.open)}`);
    return undefined;
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
      $("oSteps").innerHTML = `<div class="o-cancelled"><i class="fa-solid fa-ban"></i> ${escapeHtml(t("orders.cancelledOn", { date: day(order.cancelledAt) }))}${order.cancelReason ? ` — ${escapeHtml(order.cancelReason)}` : ""}</div>`;
      return;
    }
    const at = FLOW.indexOf(order.stage);
    const reached = (stage) => [...order.history].reverse().find((h) => h.stage === stage)?.at;
    $("oSteps").innerHTML = FLOW.map((stage, i) => {
      const cls = i < at ? "done" : i === at ? "current" : "";
      const date = i <= at ? reached(stage) : "";
      return `<div class="o-step ${cls}">${escapeHtml(stageName(stage))}${date ? `<small>${escapeHtml(day(date))}</small>` : ""}</div>`;
    }).join("");
  }

  function renderDetail() {
    const o = order;
    $("pageTitle").textContent = t("orders.col.order");
    $("oNumber").textContent = o.number;
    $("oSub").innerHTML = [badge(o.stage), escapeHtml(t("quotes.dated", { date: day(o.orderDate) })), o.paidAt ? escapeHtml(t("orders.paidOn", { date: day(o.paidAt) })) : ""].filter(Boolean).join(" · ");
    renderSteps();
    $("oTransporter").value = o.dispatch?.transporter || "";
    $("oLr").value = o.dispatch?.lrNumber || "";
    $("oVehicle").value = o.dispatch?.vehicleNumber || "";
    $("oExpected").value = o.dispatch?.expectedDeliveryDate ? String(o.dispatch.expectedDeliveryDate).slice(0, 10) : "";
    $("oDispatchedAt").textContent = o.dispatch?.dispatchedAt ? t("orders.dispatchedAt", { date: when(o.dispatch.dispatchedAt) }) : "";
    $("oNotes").value = o.notes || "";
    $("oQuoteLink").innerHTML = o.quotationId
      ? `<a href="Quotations.html?id=${encodeURIComponent(o.quotationId)}">${escapeHtml(o.quotationNumber || crmLabel("quoteType", "Quotation"))}</a>`
      : o.source === "catalog"
        ? `<a href="Inbox.html?c=${encodeURIComponent(o.catalogOrder?.conversationId || "")}"><i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("orders.fromCatalog"))}</a>`
        : o.source === "form" // D110: from a WhatsApp order form
          ? `<a href="Inbox.html?c=${encodeURIComponent(o.formOrder?.conversationId || "")}"><i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("orders.fromForm", { name: o.formOrder?.formName || "" }))}</a>`
          : "";
    const b = o.billTo || {};
    $("oCustomer").innerHTML = `<strong>${escapeHtml(b.name || "—")}</strong><div class="q-muted">${[b.company && b.company !== b.name ? b.company : "", b.address, [b.city, b.state].filter(Boolean).join(", "), b.gstin ? `GSTIN ${b.gstin}` : "", b.phone].filter(Boolean).map(escapeHtml).join("<br>")}</div>`;
    // A cart from the WhatsApp catalog may need a look (an unknown item, a price that changed).
    const checks = (o.catalogOrder?.warnings || []).map((w) => `<div class="q-warning">${escapeHtml(w)}</div>`).join("");
    $("oItems").innerHTML = `${checks}<table><thead><tr><th>${escapeHtml(t("quotes.item"))}</th><th class="q-amount">${escapeHtml(t("quotes.qty"))}</th><th class="q-amount">${escapeHtml(t("quotes.taxableCol"))}</th><th class="q-amount">GST</th><th class="q-amount">${escapeHtml(t("quotes.col.amount"))}</th></tr></thead><tbody>${(o.items || [])
      .map((item) => `<tr><td>${escapeHtml(item.name)}${item.hsnSac ? `<div class="q-muted">HSN ${escapeHtml(item.hsnSac)}</div>` : ""}</td><td class="q-amount">${escapeHtml(String(item.quantity))} ${escapeHtml(item.unit || "")}</td><td class="q-amount">${rupees(item.taxablePaise)}</td><td class="q-amount">${escapeHtml(String(item.gstRatePct))}%</td><td class="q-amount">${rupees(item.totalPaise)}</td></tr>`)
      .join("")}</tbody></table>`;
    const sums = o.totals || {};
    const s = o.supply || {};
    const row = (label, value, cls = "") => `<div class="q-sum-row ${cls}"><span>${label}</span><span>${value}</span></div>`;
    $("oTotals").innerHTML = [
      row(escapeHtml(t("quotes.taxable")), rupees(sums.taxablePaise)),
      s.interState ? row("IGST", rupees(sums.igstPaise)) : row("CGST", rupees(sums.cgstPaise)) + row(escapeHtml(s.taxLabel || "SGST"), rupees(sums.sgstPaise)),
      sums.roundOffPaise ? row(escapeHtml(t("quotes.roundOff")), `${sums.roundOffPaise > 0 ? "+" : "−"} ${rupees(Math.abs(sums.roundOffPaise))}`, "muted") : "",
      row(escapeHtml(t("quotes.total")), rupees(sums.grandTotalPaise), "grand"),
    ].join("");
    $("oHistory").innerHTML = [...(o.history || [])]
      .reverse()
      .map((h) => `<div class="o-history"><span class="when">${escapeHtml(when(h.at))}</span><span>${h.from ? `${escapeHtml(stageName(h.from))} → ` : ""}<strong>${escapeHtml(stageName(h.stage))}</strong>${h.byName ? ` · ${escapeHtml(h.byName)}` : ""}${h.note ? `<div class="q-muted">${escapeHtml(h.note)}</div>` : ""}${h.notified ? `<div class="q-muted"><i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("orders.notified"))}</div>` : ""}</span></div>`)
      .join("");
    renderPayment();
    renderInvoice();
    renderActions();
    const locked = !can("edit") || o.stage === "Cancelled";
    document.querySelectorAll("#oDispatchForm input, #oDispatchForm button, #oNotes, #oSaveNotes").forEach((field) => { field.disabled = locked; });
  }

  // --- payments (Phase 8): what is paid, the payment link, payments entered by hand ---
  // What the customer owes in all: once invoiced, the invoices less credit notes (D101).
  const owed = (o) => o.billedPaise ?? (o.totals?.grandTotalPaise || 0);
  function renderPayment() {
    const o = order;
    const open = o.stage !== "Cancelled" && o.duePaise > 0;
    const paymentRow = (p) => {
      const how = p.source === "link" ? `${escapeHtml(t("quotes.act.paylink"))} · ${p.provider === "mock" ? escapeHtml(t("orders.testGateway")) : escapeHtml(p.provider)}${p.method ? ` · ${escapeHtml(methodName(p.method))}` : ""}` : `${escapeHtml(p.method ? methodName(p.method) : t("orders.byHand"))}${p.reference ? ` · ${escapeHtml(p.reference)}` : ""}`;
      const remove = p.source === "manual" && can("edit") ? `<button class="icon-btn danger" type="button" data-remove-payment="${escapeHtml(p.id)}" title="${escapeHtml(t("orders.removePayment"))}" aria-label="${escapeHtml(t("orders.removePayment"))}"><i class="fa-solid fa-trash"></i></button>` : "";
      return `<div class="pl-payment"><span><strong>${rupees(p.amountPaise)}</strong><small>${escapeHtml(day(p.paidAt))} · ${how}${p.recordedByName && p.source === "manual" ? ` · ${escapeHtml(p.recordedByName)}` : ""}</small>${receiptLine(p)}</span>${remove}</div>`;
    };
    const cancelled = (docs?.receipts || []).filter((r) => r.status === "cancelled");
    $("oPayment").innerHTML = `
      <div class="q-card-head"><h3>${escapeHtml(t("orders.col.payment"))}</h3>${paymentBadge(o)}</div>
      <div class="pl-figures">
        <div class="pl-figure"><span>${escapeHtml(t("orders.col.paid"))}</span><strong>${rupees(o.amountPaidPaise)}</strong></div>
        <div class="pl-figure"><span>${escapeHtml(t("orders.col.due"))}</span><strong>${rupees(o.duePaise)}</strong></div>
      </div>
      ${o.stage === "Payment Collected" && o.amountPaidPaise < owed(o) ? `<p class="q-muted">${escapeHtml(t("orders.collectedOutside"))}</p>` : ""}
      ${(o.payments || []).map(paymentRow).join("")}
      ${cancelled.length ? `<p class="q-muted inv-cancelled">${escapeHtml(t("inv.cancelledReceipts"))} ${cancelled.map((r) => `<button class="inv-link" type="button" data-doc-pdf="${escapeHtml(r.id)}" data-kind="receipt">${escapeHtml(r.number)}</button>`).join(", ")}</p>` : ""}
      ${can("edit") && open ? `<div class="pl-buttons">
        <button class="btn btn-primary" type="button" data-pay="link"><i class="fa-solid fa-indian-rupee-sign"></i> ${escapeHtml(t("quotes.act.paylink"))}</button>
        <button class="btn btn-outline" type="button" data-pay="record">${escapeHtml(t("orders.record-payment"))}</button>
      </div>` : can("view") && (o.payments || []).some((p) => p.source === "link") ? `<div class="pl-buttons"><button class="btn btn-outline" type="button" data-pay="link">${escapeHtml(t("orders.paymentLinks"))}</button></div>` : ""}`;
  }

  async function reloadOrder() {
    try {
      order = await crmApi(`/orders/${encodeURIComponent(order.id)}`);
      renderDetail();
      loadInvoices();
    } catch {
      /* stays as it was */
    }
  }

  function openRecord() {
    $("payDue").textContent = t("orders.stillDue", { due: rupees(order.duePaise), total: rupees(owed(order)) });
    $("payAmount").value = (order.duePaise / 100).toFixed(2);
    $("payDate").value = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    $("payDate").max = $("payDate").value;
    $("payMethod").value = "bank_transfer";
    $("payRef").value = "";
    $("payOverlay").classList.add("open");
    $("payAmount").focus();
  }
  const closeRecord = () => $("payOverlay").classList.remove("open");
  $("payClose").addEventListener("click", closeRecord);
  $("payCancel").addEventListener("click", closeRecord);
  $("payGo").addEventListener("click", async () => {
    const amountPaise = Math.round(Number($("payAmount").value.replace(/[₹,\s]/g, "")) * 100);
    if (!(amountPaise > 0)) return showToast(t("orders.needAmount"), "error");
    $("payGo").disabled = true;
    try {
      const body = { amountPaise, method: $("payMethod").value, reference: $("payRef").value.trim() };
      // An earlier day is kept as noon India time; today is "now".
      if ($("payDate").value && $("payDate").value !== $("payDate").max) body.paidAt = `${$("payDate").value}T12:00:00+05:30`;
      const request = jsonRequest("POST", body);
      request.headers["Idempotency-Key"] = newIdempotencyKey();
      order = await crmApi(`/orders/${order.id}/payments`, request);
      closeRecord();
      renderDetail();
      loadInvoices(); // its receipt
      showToast(order.paymentStatus === "paid" ? t("orders.recorded.paid") : t("orders.recorded.due", { due: rupees(order.duePaise) }), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("orders.err.record")), "error");
    } finally {
      $("payGo").disabled = false;
    }
    return undefined;
  });
  $("oPayment").addEventListener("click", async (e) => {
    const action = e.target.closest("[data-pay]")?.dataset.pay;
    if (action === "link") return crmPaymentLinks.open({ orderId: order.id, onChange: reloadOrder });
    if (action === "record") return openRecord();
    if (docAction(e)) return undefined;
    const make = e.target.closest("[data-receipt-make]");
    if (make) return makeReceipt(make.dataset.receiptMake);
    const remove = e.target.closest("[data-remove-payment]");
    if (remove && window.confirm(t("orders.confirmRemove"))) {
      try {
        order = await crmApi(`/orders/${order.id}/payments/${encodeURIComponent(remove.dataset.removePayment)}`, { method: "DELETE" });
        renderDetail();
        loadInvoices(); // its receipt is now cancelled
        showToast(t("orders.removed"), "success");
      } catch (error) {
        showToast(apiErrorMessage(error, t("orders.err.remove")), "error");
      }
    }
    return undefined;
  });

  function renderActions() {
    const o = order;
    const buttons = [];
    if (can("edit") && o.stage !== "Cancelled") {
      const next = FLOW[FLOW.indexOf(o.stage) + 1];
      if (next) buttons.push(`<button class="btn btn-primary" type="button" data-move="${escapeHtml(next)}"><i class="fa-solid fa-arrow-right"></i> ${escapeHtml(t("orders.moveTo", { stage: stageName(next) }))}</button>`);
      buttons.push(`<button class="btn btn-outline" type="button" data-move="">${escapeHtml(t("orders.changeStage"))}</button>`);
      if (o.nextStages.includes("Cancelled")) buttons.push(`<button class="btn btn-danger-outline" type="button" data-move="Cancelled"><i class="fa-solid fa-ban"></i> ${escapeHtml(t("orders.cancelOrder"))}</button>`);
    }
    if (canChat() && can("edit")) buttons.push(`<button class="btn btn-outline" type="button" data-notify><i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("orders.update-the-customer"))}</button>`);
    $("oActions").innerHTML = buttons.join("");
  }

  async function openOrder(id) {
    $("oListView").hidden = true;
    $("oDetailView").hidden = false;
    $("oNumber").textContent = t("cw.loading");
    window.scrollTo(0, 0);
    docs = null;
    try {
      order = await crmApi(`/orders/${encodeURIComponent(id)}`);
      renderDetail();
      loadInvoices();
    } catch (error) {
      showToast(apiErrorMessage(error, t("orders.err.open")), "error");
      go("", { replace: true });
    }
  }

  function showList() {
    order = null;
    $("oDetailView").hidden = true;
    $("oListView").hidden = false;
    $("pageTitle").textContent = t("nav.orders");
    loadTabs();
    loadList();
  }

  $("oDispatchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      order = await crmApi(`/orders/${order.id}`, jsonRequest("PATCH", { dispatch: { transporter: $("oTransporter").value.trim(), lrNumber: $("oLr").value.trim(), vehicleNumber: $("oVehicle").value.trim(), expectedDeliveryDate: $("oExpected").value || null } }));
      renderDetail();
      showToast(t("orders.dispatchSaved"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("orders.err.save")), "error");
    }
  });
  $("oSaveNotes").addEventListener("click", async () => {
    try {
      order = await crmApi(`/orders/${order.id}`, jsonRequest("PATCH", { notes: $("oNotes").value }));
      renderDetail();
      showToast(t("orders.notesSaved"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("orders.err.save")), "error");
    }
  });

  // --- moving the order ---
  function openStage(target) {
    const options = order.nextStages;
    $("stageSelect").innerHTML = options.map((s) => `<option value="${escapeHtml(s)}" ${s === target ? "selected" : ""}>${escapeHtml(stageName(s))}</option>`).join("");
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
    $("stageTitle").textContent = stage === "Cancelled" ? t("orders.cancelTheOrder") : t("orders.moveTo", { stage: stageName(stage) });
    $("stageDispatch").hidden = stage !== "Dispatched";
    $("stageReasonField").hidden = stage !== "Cancelled";
    $("stageNoteField").hidden = stage === "Cancelled";
    $("stageGo").textContent = t(stage === "Cancelled" ? "orders.cancelTheOrder" : "orders.move");
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
      showToast(`${t("orders.moved", { stage: stageName(order.stage) })}${order.stage === "Payment Collected" ? ` ${t("orders.leadWon")}` : ""}`, "success");
      if (order.invoiceMade) showToast(t("inv.madeOnDispatch", { number: order.invoiceMade.number }), "success");
      if (order.invoiceError) showToast(t("inv.notMadeOnDispatch", { reason: order.invoiceError }));
      loadInvoices();
      if (canChat() && $("stageNotify").checked) openNotify();
    } catch (error) {
      showToast(apiErrorMessage(error, t("orders.err.move")), "error");
    } finally {
      $("stageGo").disabled = false;
    }
  });
  $("oActions").addEventListener("click", (e) => {
    const move = e.target.closest("[data-move]");
    if (move) return openStage(move.dataset.move || order.nextStages[0]);
    if (e.target.closest("[data-notify]")) openNotify();
  });

  // --- WhatsApp: an order update (a text in the 24-hour window, else an approved template), or
  // an invoice, credit note or receipt (D101: the PDF in the window, else a template) ---
  const send = { options: null, mode: "text", templateId: "", done: "", target: null };
  function templateVars(template) {
    if (!template) return [];
    return [
      ...(template.header?.variables || []).map((name) => ["header", name, t("quotes.var.header", { name })]),
      ...template.body.variables.map((name) => ["body", name, t("quotes.var.body", { name })]),
      ...template.buttons.filter((b) => b.variables.length).map((b) => ["buttons", String(b.index), t("quotes.var.button", { text: b.text })]),
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
    const doc = send.target;
    if (send.done) {
      $("sendBody").innerHTML = `<div class="q-send-done"><i class="fa-solid fa-circle-check"></i><p>${escapeHtml(t(doc ? "quotes.send.sent" : "orders.sent"))}</p><a class="btn btn-outline" href="Inbox.html?c=${encodeURIComponent(send.done)}"><i class="fa-solid fa-comments"></i> ${escapeHtml(t("quotes.send.openChat"))}</a></div>`;
      $("sendCancel").textContent = t("common.close");
      return;
    }
    if (!o) {
      $("sendBody").innerHTML = `<p class="q-muted">${escapeHtml(t("cw.loading"))}</p>`;
      return;
    }
    if (o.blocked) {
      $("sendBody").innerHTML = `<div class="q-warning">${escapeHtml(o.blocked)}</div>`;
      return;
    }
    if (!o.windowOpen) send.mode = "template";
    const template = o.templates.find((tpl) => String(tpl.id) === send.templateId) || null;
    const own = doc ? "document" : "text";
    const modes = o.windowOpen
      ? `<div class="q-send-mode">
          <label><input type="radio" name="sendMode" value="${own}" ${send.mode === own ? "checked" : ""} /><span>${escapeHtml(t(doc ? "quotes.send.pdfMode" : "orders.mode.text"))}<small>${escapeHtml(t(doc ? "quotes.send.pdfModeHint" : "orders.mode.textHint"))}</small></span></label>
          <label><input type="radio" name="sendMode" value="template" ${send.mode === "template" ? "checked" : ""} /><span>${escapeHtml(t("quotes.send.tplMode"))}</span></label>
        </div>`
      : `<div class="q-warning">${escapeHtml(t("orders.closed"))}</div>`;
    let detail;
    if (send.mode === "text") {
      detail = `<div class="field"><label for="sendText">${escapeHtml(t("c360.message"))}</label><textarea id="sendText" rows="4" maxlength="4096">${escapeHtml(send.text ?? o.text)}</textarea></div>`;
    } else if (send.mode === "document") {
      detail = `<div class="field"><label for="sendText">${escapeHtml(t("quotes.send.caption"))}</label><textarea id="sendText" rows="3" maxlength="1024">${escapeHtml(send.text ?? o.caption)}</textarea></div>`;
    } else if (!o.templates.length) {
      detail = `<p class="q-muted">${escapeHtml(t(doc ? "quotes.send.noTemplates" : "orders.noTemplates"))}</p>`;
    } else {
      detail = `<div class="field"><label for="sendTemplate">${escapeHtml(t("inbox.template"))}</label><select id="sendTemplate"><option value="">${escapeHtml(t("quotes.send.chooseTpl"))}</option>${o.templates
        .map((tpl) => `<option value="${escapeHtml(tpl.id)}" ${String(tpl.id) === send.templateId ? "selected" : ""}>${escapeHtml(tpl.name)} (${escapeHtml(tpl.language)})${doc && tpl.documentHeader ? escapeHtml(t("quotes.send.withPdf")) : ""}</option>`)
        .join("")}</select></div>
        ${templateVars(template).map(([part, name, label]) => `<div class="field"><label>${escapeHtml(label)}</label><input type="text" maxlength="1024" data-part="${part}" data-send-var="${escapeHtml(name)}" value="${escapeHtml(template.suggested?.[part]?.[name] || "")}" /></div>`).join("")}
        ${template ? '<div class="q-send-preview"><div id="sendPreview"></div></div>' : ""}
        ${doc && template && !template.documentHeader ? `<p class="q-muted" style="margin-top:8px">${escapeHtml(t("inv.noPdfHeader"))}</p>` : ""}`;
    }
    const to = t("quotes.send.to", { name: `<strong>${escapeHtml(order.billTo?.name || "")}</strong>` });
    const what = doc ? doc.label : `${t("orders.orderNumber", { number: order.number })} · ${stageName(order.stage)}`;
    $("sendBody").innerHTML = `<div class="q-send-to">${to} · ${escapeHtml(what)}</div>${modes}${detail}`;
    if (template) $("sendPreview").textContent = preview(template);
    $("sendGo").hidden = send.mode === "template" && !template;
  }
  async function openNotify() {
    Object.assign(send, { options: null, mode: "text", templateId: "", done: "", text: undefined, target: null });
    $("sendTitle").textContent = t("orders.update-the-customer");
    $("sendCancel").textContent = t("orders.not-now");
    $("sendOverlay").classList.add("open");
    renderSend();
    try {
      send.options = await crmApi(`/orders/${order.id}/notify-options`);
      const guess = send.options.templates.find((tpl) => /order|dispatch|ship|deliver/i.test(tpl.name)) || send.options.templates[0];
      if (guess) send.templateId = String(guess.id);
    } catch (error) {
      send.options = { blocked: apiErrorMessage(error, t("quotes.send.checkFailed")) };
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
    if (e.target.dataset.sendVar !== undefined) $("sendPreview").textContent = preview(send.options.templates.find((tpl) => String(tpl.id) === send.templateId));
  });
  $("sendGo").addEventListener("click", async () => {
    const doc = send.target;
    const body = { mode: send.mode };
    if (send.mode === "text") body.text = (send.text ?? send.options.text).trim();
    else if (send.mode === "document") body.caption = (send.text ?? send.options.caption).trim();
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
      const result = await crmApi(doc ? `/${doc.kind === "receipt" ? "receipts" : "invoices"}/${encodeURIComponent(doc.id)}/send` : `/orders/${order.id}/notify`, request);
      if (doc) loadInvoices();
      else {
        order = result.order;
        renderDetail();
      }
      send.done = String(result.conversationId);
      renderSend();
    } catch (error) {
      showToast(apiErrorMessage(error, t(doc ? "quotes.send.failed" : "orders.err.send")), "error");
    } finally {
      $("sendGo").disabled = false;
    }
  });

  // ------------------------------------------------------------------------------------------
  // Tax invoice, credit notes and receipts (D101)
  // ------------------------------------------------------------------------------------------
  let docs = null; // GET /orders/:id/invoices: { invoices (with creditNotes), receipts, canInvoice … }
  const SHIPPED = ["Dispatched", "Delivered", "Payment Collected"];
  const fileOf = (number) => `${String(number || "document").replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;
  const pathOf = (kind, id) => `/${kind === "receipt" ? "receipts" : "invoices"}/${encodeURIComponent(id)}`;
  // The backend's notes on a new invoice or credit note, in the page's language when known.
  const WARNINGS = { HSN_MISSING: "inv.warn.hsn", GST_TIME_LIMIT: "inv.warn.timeLimit" };
  const warn = (warnings) => (warnings || []).forEach((w) => showToast(WARNINGS[w.code] ? t(WARNINGS[w.code]) : w.message));

  async function loadInvoices() {
    const id = order?.id;
    if (!id) return;
    try {
      const result = await crmApi(`/orders/${encodeURIComponent(id)}/invoices`);
      if (order?.id !== id) return; // another order was opened meanwhile
      docs = result;
    } catch {
      docs = null;
    }
    renderInvoice();
    renderPayment();
  }

  function docOf(kind, id) {
    if (!docs) return null;
    if (kind === "receipt") return docs.receipts.find((r) => String(r.id) === String(id)) || null;
    for (const invoice of docs.invoices) {
      if (String(invoice.id) === String(id)) return invoice;
      const note = invoice.creditNotes.find((c) => String(c.id) === String(id));
      if (note) return note;
    }
    return null;
  }

  function docButtons(kind, d) {
    const pdf = `<button class="icon-btn" type="button" data-doc-pdf="${escapeHtml(d.id)}" data-kind="${kind}" title="${escapeHtml(t("quotes.act.pdf"))}" aria-label="${escapeHtml(t("quotes.act.pdf"))}"><i class="fa-solid fa-file-pdf"></i></button>`;
    const wa = canChat() && can("edit") ? `<button class="icon-btn" type="button" data-doc-send="${escapeHtml(d.id)}" data-kind="${kind}" title="${escapeHtml(t("inv.sendTitle"))}" aria-label="${escapeHtml(t("inv.sendTitle"))}"><i class="fa-brands fa-whatsapp"></i></button>` : "";
    return `<span class="inv-doc-actions">${pdf}${wa}</span>`;
  }

  function docRow(d) {
    const credit = d.kind === "credit_note";
    const notes = [
      day(d.invoiceDate),
      credit ? t("inv.cnShort") : "",
      d.auto ? t("inv.auto") : "",
      d.sentAt ? t("inv.sentOn", { date: day(d.sentAt) }) : "",
    ].filter(Boolean).join(" · ");
    return `<div class="inv-doc ${credit ? "credit" : ""}">
      <span class="inv-doc-main"><strong>${escapeHtml(d.number)}</strong><small>${escapeHtml(notes)}</small>${d.reason ? `<small>${escapeHtml(d.reason)}</small>` : ""}</span>
      <span class="inv-doc-amount">${credit ? "− " : ""}${rupees(d.totals?.grandTotalPaise)}</span>
      ${docButtons("invoice", d)}
    </div>`;
  }

  function renderInvoice() {
    const el = $("oInvoice");
    if (!order) return;
    const live = docs?.invoices.find((i) => i.status === "issued");
    const status = live
      ? `<span class="badge badge-success">${escapeHtml(t("inv.issued"))}</span>`
      : docs?.invoices.length ? `<span class="badge badge-neutral">${escapeHtml(t("inv.credited"))}</span>` : "";
    const head = `<div class="q-card-head"><h3>${escapeHtml(t("inv.title"))}</h3>${status}</div>`;
    if (!docs) {
      el.innerHTML = `${head}<p class="q-muted">${escapeHtml(t("cw.loading"))}</p>`;
      return;
    }
    const blocks = docs.invoices.map((invoice) => {
      const left = invoice.totals.grandTotalPaise - invoice.creditedPaise;
      const creditButton = invoice.status === "issued" && isOrgManager()
        ? `<div class="pl-buttons"><button class="btn btn-outline" type="button" data-credit="${escapeHtml(invoice.id)}"><i class="fa-solid fa-file-circle-minus"></i> ${escapeHtml(t("inv.cn.make"))}</button></div>`
        : "";
      return `${docRow(invoice)}${invoice.creditNotes.map(docRow).join("")}${invoice.creditNotes.length && invoice.status === "issued" ? `<p class="q-muted inv-left">${escapeHtml(t("inv.netLeft", { amount: rupees(left) }))}</p>` : ""}${creditButton}`;
    }).join("");
    let make = "";
    if (docs.canInvoice && can("edit")) {
      const later = docs.invoiceOnDispatch && !SHIPPED.includes(order.stage) ? `<p class="q-muted">${escapeHtml(t("inv.onDispatchNote"))}</p>` : "";
      make = docs.sellerReady
        ? `${later}<div class="pl-buttons"><button class="btn ${later ? "btn-outline" : "btn-primary"}" type="button" data-inv-make><i class="fa-solid fa-file-invoice"></i> ${escapeHtml(t(docs.invoices.length ? "inv.makeAgain" : "inv.make"))}</button></div>`
        : `<div class="q-warning">${escapeHtml(t("inv.sellerFirst"))} <a href="Settings.html?tab=company">${escapeHtml(t("inv.openCompany"))}</a></div>`;
    }
    const none = docs.invoices.length ? "" : `<p class="q-muted">${escapeHtml(t(order.stage === "Cancelled" ? "inv.noneCancelled" : "inv.none"))}</p>`;
    el.innerHTML = `${head}${none}${blocks}${make}`;
  }

  // A payment's receipt (made when it was recorded; one recorded before D101 gets it on a click).
  function receiptLine(p) {
    if (!docs) return "";
    const receipt = docs.receipts.find((r) => String(r.paymentId) === String(p.id));
    if (!receipt) {
      return can("edit") ? `<button class="inv-link" type="button" data-receipt-make="${escapeHtml(p.id)}"><i class="fa-solid fa-receipt"></i> ${escapeHtml(t("inv.makeReceipt"))}</button>` : "";
    }
    const wa = canChat() && can("edit") ? `<button class="inv-link" type="button" data-doc-send="${escapeHtml(receipt.id)}" data-kind="receipt" title="${escapeHtml(t("inv.sendTitle"))}" aria-label="${escapeHtml(t("inv.sendTitle"))}"><i class="fa-brands fa-whatsapp"></i></button>` : "";
    return `<span class="inv-receipt"><button class="inv-link" type="button" data-doc-pdf="${escapeHtml(receipt.id)}" data-kind="receipt" title="${escapeHtml(t("quotes.act.pdf"))}"><i class="fa-solid fa-receipt"></i> ${escapeHtml(receipt.number)}</button>${wa}</span>`;
  }

  async function makeReceipt(paymentId) {
    try {
      const receipt = await crmApi(`/orders/${order.id}/payments/${encodeURIComponent(paymentId)}/receipt`, { method: "POST" });
      await loadInvoices();
      await crmDownload(`${pathOf("receipt", receipt.id)}/pdf`, fileOf(receipt.number));
    } catch (error) {
      showToast(apiErrorMessage(error, t("inv.err.receipt")), "error");
    }
  }

  // PDF and WhatsApp buttons of invoices, credit notes and receipts. true: it was one of them.
  function docAction(e) {
    const pdf = e.target.closest("[data-doc-pdf]");
    if (pdf) {
      const d = docOf(pdf.dataset.kind, pdf.dataset.docPdf);
      crmDownload(`${pathOf(pdf.dataset.kind, pdf.dataset.docPdf)}/pdf`, fileOf(d?.number)).catch((error) => showToast(apiErrorMessage(error, t("inv.err.pdf")), "error"));
      return true;
    }
    const wa = e.target.closest("[data-doc-send]");
    if (wa) {
      openSendDoc(wa.dataset.kind, wa.dataset.docSend);
      return true;
    }
    return false;
  }

  async function openSendDoc(kind, id) {
    const d = docOf(kind, id);
    const label = t(kind === "receipt" ? "inv.receiptNo" : d?.kind === "credit_note" ? "inv.cnNo" : "inv.invoiceNo", { number: d?.number || "" });
    Object.assign(send, { options: null, mode: "document", templateId: "", done: "", text: undefined, target: { kind, id, label } });
    $("sendTitle").textContent = t("inv.sendTitle");
    $("sendCancel").textContent = t("orders.not-now");
    $("sendOverlay").classList.add("open");
    renderSend();
    try {
      const options = await crmApi(`${pathOf(kind, id)}/send-options`);
      send.options = { ...options, windowOpen: Boolean(options.conversation?.windowOpen) };
      const withPdf = options.templates.filter((tpl) => tpl.documentHeader);
      const guess = withPdf.find((tpl) => /invoice|bill|receipt|payment|credit/i.test(tpl.name)) || withPdf[0] || options.templates[0];
      if (guess) send.templateId = String(guess.id);
    } catch (error) {
      send.options = { blocked: apiErrorMessage(error, t("quotes.send.checkFailed")) };
    }
    renderSend();
  }

  // --- making the invoice: the customer's details checked first ---
  let states = null;
  async function openMakeInvoice() {
    const b = order.billTo || {};
    if (!states) states = await crmApi("/pricing/states").catch(() => []);
    $("invState").innerHTML = `<option value="">${escapeHtml(t("inv.f.chooseState"))}</option>${states.map((s) => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.name)} (${escapeHtml(s.code)})</option>`).join("")}`;
    $("invName").value = b.name || "";
    $("invCompany").value = b.company || "";
    $("invGstin").value = b.gstin || "";
    $("invState").value = b.stateCode || "";
    $("invAddress").value = b.address || "";
    $("invCity").value = b.city || "";
    $("invPin").value = b.postalCode || "";
    $("invOverlay").classList.add("open");
    $("invName").focus();
  }
  const closeMakeInvoice = () => $("invOverlay").classList.remove("open");
  $("invClose").addEventListener("click", closeMakeInvoice);
  $("invCancel").addEventListener("click", closeMakeInvoice);
  $("invGo").addEventListener("click", async () => {
    const billTo = {
      name: $("invName").value.trim(), company: $("invCompany").value.trim(), gstin: $("invGstin").value.trim().toUpperCase(),
      state: $("invState").value, address: $("invAddress").value.trim(), city: $("invCity").value.trim(), postalCode: $("invPin").value.trim(),
    };
    if (!billTo.name) return showToast(t("inv.err.name"), "error");
    $("invGo").disabled = true;
    try {
      const request = jsonRequest("POST", { billTo });
      request.headers["Idempotency-Key"] = newIdempotencyKey();
      const result = await crmApi(`/orders/${order.id}/invoice`, request);
      closeMakeInvoice();
      showToast(t("inv.made", { number: result.invoice.number }), "success");
      warn(result.warnings);
      await reloadOrder(); // what the order owes now follows the invoice
    } catch (error) {
      showToast(apiErrorMessage(error, t("inv.err.make")), "error");
    } finally {
      $("invGo").disabled = false;
    }
    return undefined;
  });

  // --- credit notes (owners and admins): the whole invoice, or a quantity or amount of lines ---
  let crediting = null;
  const creditMode = () => document.querySelector('input[name="cnMode"]:checked')?.value || "full";
  function openCredit(id) {
    crediting = docs?.invoices.find((i) => String(i.id) === String(id)) || null;
    if (!crediting) return;
    $("cnTitle").textContent = t("inv.cn.against", { number: crediting.number });
    document.querySelector('input[name="cnMode"][value="full"]').checked = true;
    $("cnReason").value = "";
    renderCreditLines();
    $("cnOverlay").classList.add("open");
  }
  function renderCreditLines() {
    const lines = creditMode() === "lines";
    $("cnLines").hidden = !lines;
    if (!lines) return;
    const rows = crediting.items.map((item, index) => {
      const left = crediting.remaining[index];
      if (!(left.taxablePaise > 0)) return "";
      const byQty = left.quantity > 0;
      return `<tr data-line="${index}">
        <td>${escapeHtml(item.name)}<div class="q-muted">GST ${escapeHtml(String(item.gstRatePct))}%</div></td>
        <td class="q-amount">${byQty ? `${escapeHtml(String(left.quantity))} ${escapeHtml(item.unit || "")}<br>` : ""}<span class="q-muted">${rupees(left.taxablePaise)}</span></td>
        <td><div class="cn-input"><select data-cn-how aria-label="${escapeHtml(t("inv.cn.how"))}">${byQty ? `<option value="quantity">${escapeHtml(t("inv.cn.qty"))}</option>` : ""}<option value="amount">${escapeHtml(t("inv.cn.amount"))}</option></select><input type="text" inputmode="decimal" data-cn-value aria-label="${escapeHtml(t("inv.cn.takeBack"))}" placeholder="0" /></div></td>
      </tr>`;
    }).join("");
    $("cnLines").innerHTML = `<div class="q-table-wrap"><table class="cn-table"><thead><tr><th>${escapeHtml(t("quotes.item"))}</th><th class="q-amount">${escapeHtml(t("inv.cn.left"))}</th><th>${escapeHtml(t("inv.cn.takeBack"))}</th></tr></thead><tbody>${rows}</tbody></table></div><p class="q-muted">${escapeHtml(t("inv.cn.linesNote"))}</p>`;
  }
  document.querySelectorAll('input[name="cnMode"]').forEach((input) => input.addEventListener("change", renderCreditLines));
  const closeCredit = () => $("cnOverlay").classList.remove("open");
  $("cnClose").addEventListener("click", closeCredit);
  $("cnCancel").addEventListener("click", closeCredit);
  $("cnGo").addEventListener("click", async () => {
    const full = creditMode() === "full";
    const body = { full, reason: $("cnReason").value.trim() };
    if (body.reason.length < 3) return showToast(t("inv.err.reason"), "error");
    if (!full) {
      body.lines = [];
      document.querySelectorAll("#cnLines tr[data-line]").forEach((row) => {
        const raw = row.querySelector("[data-cn-value]").value.replace(/[₹,\s]/g, "");
        if (!raw) return;
        const value = Number(raw);
        const index = Number(row.dataset.line);
        body.lines.push(row.querySelector("[data-cn-how]").value === "quantity" ? { index, quantity: value } : { index, taxablePaise: Math.round(value * 100) });
      });
      if (!body.lines.length) return showToast(t("inv.err.pickLine"), "error");
      if (body.lines.some((line) => !((line.quantity || line.taxablePaise) > 0))) return showToast(t("inv.err.badValue"), "error");
    } else if (!window.confirm(t("inv.cn.confirmFull", { number: crediting.number }))) {
      return undefined;
    }
    $("cnGo").disabled = true;
    try {
      const request = jsonRequest("POST", body);
      request.headers["Idempotency-Key"] = newIdempotencyKey();
      const result = await crmApi(`/invoices/${encodeURIComponent(crediting.id)}/credit-notes`, request);
      closeCredit();
      showToast(t("inv.cn.made", { number: result.creditNote.number, amount: rupees(result.creditNote.totals.grandTotalPaise) }), "success");
      warn(result.warnings);
      await reloadOrder(); // the credit note lowers what the order owes
    } catch (error) {
      showToast(apiErrorMessage(error, t("inv.err.credit")), "error");
    } finally {
      $("cnGo").disabled = false;
    }
    return undefined;
  });

  $("oInvoice").addEventListener("click", (e) => {
    if (docAction(e)) return;
    if (e.target.closest("[data-inv-make]")) openMakeInvoice();
    const credit = e.target.closest("[data-credit]");
    if (credit) openCredit(credit.dataset.credit);
  });

  // --- page addresses ---
  function route() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (params.get("tab") === "dues") list.stage = DUES;
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
    $("oListView").innerHTML = `<div class="empty-state"><p>${escapeHtml(t("orders.noAccess"))}</p></div>`;
    return;
  }
  route();
});
