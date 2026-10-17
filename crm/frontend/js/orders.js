/**
 * orders.js — Orders page (Phase 5; payments Phase 8)
 * The list (stage tabs with counts, search, what is paid) and one order: the stage stepper,
 * moving it on (with dispatch details, a cancel reason), the dispatch form, items and totals,
 * notes, the history, and a WhatsApp update to the customer after a move. Payments: the
 * order's payment card (payment link through js/payment-links.js, payments entered by hand)
 * and the "Payment due" tab (GET /orders/dues).
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
    renderActions();
    const locked = !can("edit") || o.stage === "Cancelled";
    document.querySelectorAll("#oDispatchForm input, #oDispatchForm button, #oNotes, #oSaveNotes").forEach((field) => { field.disabled = locked; });
  }

  // --- payments (Phase 8): what is paid, the payment link, payments entered by hand ---
  function renderPayment() {
    const o = order;
    const open = o.stage !== "Cancelled" && o.duePaise > 0;
    const paymentRow = (p) => {
      const how = p.source === "link" ? `${escapeHtml(t("quotes.act.paylink"))} · ${p.provider === "mock" ? escapeHtml(t("orders.testGateway")) : escapeHtml(p.provider)}${p.method ? ` · ${escapeHtml(methodName(p.method))}` : ""}` : `${escapeHtml(p.method ? methodName(p.method) : t("orders.byHand"))}${p.reference ? ` · ${escapeHtml(p.reference)}` : ""}`;
      const remove = p.source === "manual" && can("edit") ? `<button class="icon-btn danger" type="button" data-remove-payment="${escapeHtml(p.id)}" title="${escapeHtml(t("orders.removePayment"))}" aria-label="${escapeHtml(t("orders.removePayment"))}"><i class="fa-solid fa-trash"></i></button>` : "";
      return `<div class="pl-payment"><span><strong>${rupees(p.amountPaise)}</strong><small>${escapeHtml(day(p.paidAt))} · ${how}${p.recordedByName && p.source === "manual" ? ` · ${escapeHtml(p.recordedByName)}` : ""}</small></span>${remove}</div>`;
    };
    $("oPayment").innerHTML = `
      <div class="q-card-head"><h3>${escapeHtml(t("orders.col.payment"))}</h3>${paymentBadge(o)}</div>
      <div class="pl-figures">
        <div class="pl-figure"><span>${escapeHtml(t("orders.col.paid"))}</span><strong>${rupees(o.amountPaidPaise)}</strong></div>
        <div class="pl-figure"><span>${escapeHtml(t("orders.col.due"))}</span><strong>${rupees(o.duePaise)}</strong></div>
      </div>
      ${o.stage === "Payment Collected" && o.amountPaidPaise < (o.totals?.grandTotalPaise || 0) ? `<p class="q-muted">${escapeHtml(t("orders.collectedOutside"))}</p>` : ""}
      ${(o.payments || []).map(paymentRow).join("")}
      ${can("edit") && open ? `<div class="pl-buttons">
        <button class="btn btn-primary" type="button" data-pay="link"><i class="fa-solid fa-indian-rupee-sign"></i> ${escapeHtml(t("quotes.act.paylink"))}</button>
        <button class="btn btn-outline" type="button" data-pay="record">${escapeHtml(t("orders.record-payment"))}</button>
      </div>` : can("view") && (o.payments || []).some((p) => p.source === "link") ? `<div class="pl-buttons"><button class="btn btn-outline" type="button" data-pay="link">${escapeHtml(t("orders.paymentLinks"))}</button></div>` : ""}`;
  }

  async function reloadOrder() {
    try {
      order = await crmApi(`/orders/${encodeURIComponent(order.id)}`);
      renderDetail();
    } catch {
      /* stays as it was */
    }
  }

  function openRecord() {
    $("payDue").textContent = t("orders.stillDue", { due: rupees(order.duePaise), total: rupees(order.totals?.grandTotalPaise) });
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
    const remove = e.target.closest("[data-remove-payment]");
    if (remove && window.confirm(t("orders.confirmRemove"))) {
      try {
        order = await crmApi(`/orders/${order.id}/payments/${encodeURIComponent(remove.dataset.removePayment)}`, { method: "DELETE" });
        renderDetail();
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
    try {
      order = await crmApi(`/orders/${encodeURIComponent(id)}`);
      renderDetail();
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

  // --- WhatsApp update: a text in the 24-hour window, else an approved template ---
  const send = { options: null, mode: "text", templateId: "", done: "" };
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
    if (send.done) {
      $("sendBody").innerHTML = `<div class="q-send-done"><i class="fa-solid fa-circle-check"></i><p>${escapeHtml(t("orders.sent"))}</p><a class="btn btn-outline" href="Inbox.html?c=${encodeURIComponent(send.done)}"><i class="fa-solid fa-comments"></i> ${escapeHtml(t("quotes.send.openChat"))}</a></div>`;
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
    const modes = o.windowOpen
      ? `<div class="q-send-mode">
          <label><input type="radio" name="sendMode" value="text" ${send.mode === "text" ? "checked" : ""} /><span>${escapeHtml(t("orders.mode.text"))}<small>${escapeHtml(t("orders.mode.textHint"))}</small></span></label>
          <label><input type="radio" name="sendMode" value="template" ${send.mode === "template" ? "checked" : ""} /><span>${escapeHtml(t("quotes.send.tplMode"))}</span></label>
        </div>`
      : `<div class="q-warning">${escapeHtml(t("orders.closed"))}</div>`;
    let detail;
    if (send.mode === "text") {
      detail = `<div class="field"><label for="sendText">${escapeHtml(t("c360.message"))}</label><textarea id="sendText" rows="4" maxlength="4096">${escapeHtml(send.text ?? o.text)}</textarea></div>`;
    } else if (!o.templates.length) {
      detail = `<p class="q-muted">${escapeHtml(t("orders.noTemplates"))}</p>`;
    } else {
      detail = `<div class="field"><label for="sendTemplate">${escapeHtml(t("inbox.template"))}</label><select id="sendTemplate"><option value="">${escapeHtml(t("quotes.send.chooseTpl"))}</option>${o.templates
        .map((tpl) => `<option value="${escapeHtml(tpl.id)}" ${String(tpl.id) === send.templateId ? "selected" : ""}>${escapeHtml(tpl.name)} (${escapeHtml(tpl.language)})</option>`)
        .join("")}</select></div>
        ${templateVars(template).map(([part, name, label]) => `<div class="field"><label>${escapeHtml(label)}</label><input type="text" maxlength="1024" data-part="${part}" data-send-var="${escapeHtml(name)}" value="${escapeHtml(template.suggested?.[part]?.[name] || "")}" /></div>`).join("")}
        ${template ? '<div class="q-send-preview"><div id="sendPreview"></div></div>' : ""}`;
    }
    const to = t("quotes.send.to", { name: `<strong>${escapeHtml(order.billTo?.name || "")}</strong>` });
    $("sendBody").innerHTML = `<div class="q-send-to">${to} · ${escapeHtml(t("orders.orderNumber", { number: order.number }))} · ${escapeHtml(stageName(order.stage))}</div>${modes}${detail}`;
    if (template) $("sendPreview").textContent = preview(template);
    $("sendGo").hidden = send.mode === "template" && !template;
  }
  async function openNotify() {
    Object.assign(send, { options: null, mode: "text", templateId: "", done: "", text: undefined });
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
      showToast(apiErrorMessage(error, t("orders.err.send")), "error");
    } finally {
      $("sendGo").disabled = false;
    }
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
