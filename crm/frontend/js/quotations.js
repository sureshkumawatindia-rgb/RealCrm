/**
 * quotations.js — Quotations page (Phase 5)
 * The list (search, status, type) and the editor: the customer, items from products,
 * discounts, and the GST breakup the server computes (POST /pricing/preview) — the browser
 * never adds up money itself. Drafts are edited; sent ones are revised.
 * Addresses: ?id=<quotation>, or ?new=1 with leadId, contactId or conversationId.
 * One IIFE: no globals.
 */
// Starts once the page's texts are in (i18n/*.json, CP5).
crmI18n.ready.then(function quotationsPage() {
  const $ = (id) => document.getElementById(id);
  const me = getCurrentMember() || {};
  // The API's rule for leads/deals: managers everything; others need the module; viewers only
  // read; deleting needs "<module>:delete".
  function can(action) {
    if (isOrgManager()) return true;
    return ["leads", "deals"].some((module) => {
      if (!(me.modules || []).includes(module)) return false;
      if (action === "view") return true;
      if (me.role === "viewer") return false;
      if (action === "delete") return (me.permissions || []).includes(`${module}:delete`);
      return true;
    });
  }

  const STATUS_BADGE = { Draft: "badge-neutral", Sent: "badge-info", Viewed: "badge-brand", Accepted: "badge-success", Rejected: "badge-danger", Expired: "badge-warning" };
  const RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];
  const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString(crmI18n.locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(crmI18n.locale(), { day: "2-digit", month: "short", year: "numeric" }) : "");
  const dateInput = (iso) => (iso ? String(iso).slice(0, 10) : "");
  const statusBadge = (status) => `<span class="badge ${STATUS_BADGE[status] || "badge-neutral"}">${escapeHtml(crmLabel("quoteStatus", status))}</span>`;
  let states = [];
  let products = [];

  // Indian numbering in words, as the PDF the customer gets prints it (so English in both languages): 1,27,13,00 paise → "Rupees One Lakh Twenty-Seven Thousand One Hundred Thirty Only".
  const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  function belowHundred(n) {
    return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  }
  function belowThousand(n) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    return [hundreds ? `${ONES[hundreds]} Hundred` : "", rest ? belowHundred(rest) : ""].filter(Boolean).join(" ");
  }
  function inWords(paise) {
    const total = Math.round(Number(paise) || 0);
    let rupeesPart = Math.floor(total / 100);
    const paisePart = total % 100;
    if (!rupeesPart && !paisePart) return "Rupees Zero Only";
    const parts = [];
    for (const [size, name] of [[10000000, "Crore"], [100000, "Lakh"], [1000, "Thousand"]]) {
      const count = Math.floor(rupeesPart / size);
      if (count) parts.push(`${count >= 1000 ? inWords(count * 100).replace(/^Rupees | Only$/g, "") : belowThousand(count)} ${name}`);
      rupeesPart %= size;
    }
    if (rupeesPart) parts.push(belowThousand(rupeesPart));
    return `Rupees ${parts.join(" ") || "Zero"}${paisePart ? ` and ${belowHundred(paisePart)} Paise` : ""} Only`;
  }

  // ------------------------------------------------------------------------------------------
  // List
  // ------------------------------------------------------------------------------------------
  const list = { page: 1, items: [], more: false, seq: 0 };

  async function loadList(reset = true) {
    if (reset) {
      list.page = 1;
      list.items = [];
    }
    const seq = ++list.seq;
    const params = new URLSearchParams({ page: String(list.page), limit: "30" });
    const q = $("qSearch").value.trim();
    if (q) params.set("q", q);
    if ($("qStatus").value) params.set("status", $("qStatus").value);
    if ($("qType").value) params.set("type", $("qType").value);
    try {
      const body = await crmRequest(`/quotations?${params}`);
      if (seq !== list.seq) return;
      list.items.push(...(body.data || []));
      list.more = Boolean(body.pagination?.hasNextPage);
      renderList();
    } catch (error) {
      $("qTable").innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(error, t("quotes.err.list")))}</p></div>`;
    }
  }

  function renderList() {
    $("qMore").hidden = !list.more;
    if (!list.items.length) {
      const filtered = $("qSearch").value.trim() || $("qStatus").value || $("qType").value;
      $("qTable").innerHTML = `<div class="empty-state"><i class="fa-solid fa-file-invoice"></i><p>${escapeHtml(t(filtered ? "quotes.empty.filtered" : "quotes.empty.none"))}</p></div>`;
      return;
    }
    $("qTable").innerHTML = `
      <table>
        <thead><tr><th>${escapeHtml(t("quotes.col.number"))}</th><th>${escapeHtml(t("quotes.col.customer"))}</th><th>${escapeHtml(t("quotes.col.date"))}</th><th>${escapeHtml(t("quotes.col.validUntil"))}</th><th class="q-amount">${escapeHtml(t("quotes.col.amount"))}</th><th>${escapeHtml(t("col.status"))}</th></tr></thead>
        <tbody>${list.items
          .map(
            (q) => `
          <tr data-open="${escapeHtml(q.id)}" tabindex="0">
            <td><div class="q-num">${escapeHtml(q.number || q.legacyNumber)}</div><div class="q-muted">${escapeHtml(crmLabel("quoteType", q.type))}${q.revision ? ` · ${escapeHtml(t("quotes.revisionN", { n: q.revision }))}` : ""}</div></td>
            <td><div>${escapeHtml(q.billTo?.name || "—")}</div>${q.billTo?.company ? `<div class="q-muted">${escapeHtml(q.billTo.company)}</div>` : ""}</td>
            <td>${escapeHtml(day(q.quotationDate))}</td>
            <td>${escapeHtml(day(q.validUntil))}</td>
            <td class="q-amount">${rupees(q.totals?.grandTotalPaise)}</td>
            <td>${statusBadge(q.status)}${q.viewCount ? ` <span class="q-muted" title="${escapeHtml(t("quotes.openedByCustomer"))}">👁 ${q.viewCount}</span>` : ""}</td>
          </tr>`,
          )
          .join("")}</tbody>
      </table>`;
  }

  let searchTimer;
  $("qSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadList(), 300);
  });
  $("qStatus").addEventListener("change", () => loadList());
  $("qType").addEventListener("change", () => loadList());
  $("qMore").addEventListener("click", () => {
    list.page += 1;
    loadList(false);
  });
  $("qTable").addEventListener("click", (e) => {
    const row = e.target.closest("[data-open]");
    if (row) go(`id=${encodeURIComponent(row.dataset.open)}`);
  });
  $("qTable").addEventListener("keydown", (e) => {
    const row = e.target.closest("[data-open]");
    if (row && e.key === "Enter") go(`id=${encodeURIComponent(row.dataset.open)}`);
  });
  $("qNewBtn").addEventListener("click", () => go("new=1"));
  $("qNewBtn").hidden = !can("create");

  // ------------------------------------------------------------------------------------------
  // Editor
  // ------------------------------------------------------------------------------------------
  const ed = {
    id: null,
    q: null, // the saved quotation
    customer: null, // { leadId | contactId | conversationId, label }
    billTo: {},
    lines: [],
    priced: null,
    dirty: false,
    seq: 0,
  };
  let lineKey = 0;
  const editable = () => can("edit") && (!ed.q || ed.q.status === "Draft") && (ed.q || can("create"));

  function stateOptions(selected, emptyLabel) {
    return `<option value="">${escapeHtml(emptyLabel)}</option>` + states.map((s) => `<option value="${s.code}" ${s.code === selected ? "selected" : ""}>${escapeHtml(s.name)} (${s.code})</option>`).join("");
  }

  function newLine(values = {}) {
    lineKey += 1;
    return { key: String(lineKey), productId: "", name: "", hsnSac: "", unit: "", quantity: "1", price: "", discountType: "amount", discount: "", gst: "", ...values };
  }
  function lineFromProduct(product, quantity = 1) {
    return newLine({
      productId: String(product.id), name: product.name, hsnSac: product.hsnSac || "", unit: product.unit || "",
      quantity: String(quantity || 1), price: String((product.pricePaise || 0) / 100), gst: String(product.gstRatePct ?? 0),
    });
  }
  function lineFromSaved(item) {
    return newLine({
      productId: item.productId ? String(item.productId) : "", name: item.name || "", hsnSac: item.hsnSac || "", unit: item.unit || "",
      quantity: String(item.quantity), price: String((item.unitPricePaise || 0) / 100), discountType: item.discountType || "amount",
      discount: item.discountType === "percent" ? String(item.discountValue || "") : item.discountValue ? String(item.discountValue / 100) : "",
      gst: String(item.gstRatePct ?? 0),
    });
  }
  const usable = (line) => Number(line.quantity) > 0 && (line.productId || line.name.trim());
  function linePayload(line) {
    return {
      productId: line.productId || null,
      name: line.name.trim(),
      hsnSac: line.hsnSac.trim(),
      unit: line.unit.trim(),
      quantity: Number(line.quantity),
      unitPricePaise: toPaise(line.price) ?? 0,
      discountType: line.discountType,
      discountValue: line.discountType === "percent" ? Math.min(Number(line.discount) || 0, 100) : toPaise(line.discount) ?? 0,
      gstRatePct: Number(line.gst) || 0,
    };
  }
  function contentPayload() {
    const b = ed.billTo;
    return {
      items: ed.lines.filter(usable).map(linePayload),
      billTo: { name: b.name || "", company: b.company || "", gstin: (b.gstin || "").toUpperCase(), stateCode: b.stateCode || "", state: "", address: b.address || "", city: b.city || "", phone: b.phone || "", email: b.email || "" },
      placeOfSupplyCode: $("qPlace").value,
      zeroRated: $("qZero").checked,
      validUntil: $("qValid").value || null,
      terms: $("qTerms").value,
      notes: $("qNotes").value,
    };
  }

  // --- rendering ---
  function renderHead() {
    const q = ed.q;
    $("qNumber").textContent = q ? `${q.number || q.legacyNumber}` : t("quotes.newOf", { type: crmLabel("quoteType", $("qDocType").value || "Quotation") });
    $("pageTitle").textContent = q ? crmLabel("quoteType", q.type) : t("nav.quotations");
    $("qSub").innerHTML = q
      ? [
          escapeHtml(crmLabel("quoteType", q.type)),
          q.revision ? escapeHtml(t("quotes.revisionN", { n: q.revision })) : "",
          statusBadge(q.status),
          escapeHtml(t("quotes.dated", { date: day(q.quotationDate) })),
          q.sentAt ? escapeHtml(t("quotes.sentOn", { date: day(q.sentAt) })) : "",
          q.viewCount ? escapeHtml(t("quotes.openedN", { n: q.viewCount })) : "",
          q.rejectedReason ? escapeHtml(t("quotes.reason", { reason: q.rejectedReason })) : "",
        ].filter(Boolean).join(" · ")
      : escapeHtml(t("quotes.notSaved"));
    $("qTypeField").hidden = Boolean(q);
  }

  function renderCustomer() {
    const c = ed.customer;
    $("qPicker").hidden = Boolean(c || ed.q);
    $("qBillTo").hidden = !(c || ed.q);
    $("qCustomerLink").innerHTML = c?.label ? escapeHtml(c.label) : "";
    const b = ed.billTo;
    document.querySelectorAll("[data-bill]").forEach((input) => {
      if (input.dataset.bill === "stateCode") input.innerHTML = stateOptions(b.stateCode || "", t("quotes.notKnown"));
      else input.value = b[input.dataset.bill] || "";
    });
  }

  function lineHtml(line) {
    const productOptions = products
      .filter((p) => p.active !== false || String(p.id) === line.productId)
      .map((p) => `<option value="${escapeHtml(p.id)}" ${String(p.id) === line.productId ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
      .join("");
    return `
      <div class="q-line" data-key="${line.key}">
        <div class="q-line-item">
          <span class="q-line-label">${escapeHtml(t("quotes.item"))}</span>
          <select data-f="productId" aria-label="${escapeHtml(t("col.product"))}"><option value="">${escapeHtml(t("quotes.otherItem"))}</option>${productOptions}</select>
          <div class="q-line-extra">
            <input type="text" data-f="name" maxlength="200" placeholder="${escapeHtml(t("quotes.itemName"))}" value="${escapeHtml(line.name)}" aria-label="${escapeHtml(t("quotes.itemName"))}" />
            <input type="text" data-f="hsnSac" maxlength="8" inputmode="numeric" placeholder="HSN/SAC" value="${escapeHtml(line.hsnSac)}" aria-label="${escapeHtml(t("quotes.hsnLabel"))}" />
          </div>
        </div>
        <div><span class="q-line-label">${escapeHtml(t("quotes.qty"))}</span><input type="number" data-f="quantity" min="0" step="any" value="${escapeHtml(line.quantity)}" aria-label="${escapeHtml(t("leads.quantity"))}" /></div>
        <div><span class="q-line-label">${escapeHtml(t("quotes.unit"))}</span><input type="text" data-f="unit" maxlength="20" placeholder="pcs" value="${escapeHtml(line.unit)}" aria-label="${escapeHtml(t("quotes.unit"))}" /></div>
        <div><span class="q-line-label">${escapeHtml(t("quotes.rate"))}</span><input type="number" data-f="price" min="0" step="0.01" value="${escapeHtml(line.price)}" aria-label="${escapeHtml(t("quotes.rateLabel"))}" /></div>
        <div><span class="q-line-label">${escapeHtml(t("quotes.discount"))}</span>
          <div class="q-disc">
            <input type="number" data-f="discount" min="0" step="0.01" placeholder="0" value="${escapeHtml(line.discount)}" aria-label="${escapeHtml(t("quotes.discount"))}" />
            <select data-f="discountType" aria-label="${escapeHtml(t("quotes.discountKind"))}"><option value="amount" ${line.discountType === "amount" ? "selected" : ""}>₹</option><option value="percent" ${line.discountType === "percent" ? "selected" : ""}>%</option></select>
          </div>
        </div>
        <div><span class="q-line-label">GST %</span><input type="number" data-f="gst" min="0" max="100" step="0.01" list="qRateList" value="${escapeHtml(line.gst)}" aria-label="${escapeHtml(t("quotes.gstLabel"))}" /></div>
        <div class="q-line-amount" data-amount="${line.key}"></div>
        <button class="icon-btn danger q-line-remove" type="button" data-remove="${line.key}" title="${escapeHtml(t("quotes.removeItem"))}"><i class="fa-solid fa-trash"></i></button>
      </div>`;
  }

  function renderLines() {
    $("qItems").innerHTML = ed.lines.length
      ? `<div class="q-line q-line-head"><div>${escapeHtml(t("quotes.item"))}</div><div>${escapeHtml(t("quotes.qty"))}</div><div>${escapeHtml(t("quotes.unit"))}</div><div>${escapeHtml(t("quotes.rate"))}</div><div>${escapeHtml(t("quotes.discount"))}</div><div>GST %</div><div style="text-align:right">${escapeHtml(t("quotes.col.amount"))}</div><div></div></div>${ed.lines.map(lineHtml).join("")}
         <datalist id="qRateList">${RATES.map((r) => `<option value="${r}"></option>`).join("")}</datalist>`
      : `<div class="q-items-empty">${escapeHtml(t("quotes.noItems"))}</div>`;
    renderAmounts();
    lockIfNeeded();
  }

  // The amounts beside each line and the totals, from the server's last answer.
  function renderAmounts() {
    const priced = ed.priced;
    const usableLines = ed.lines.filter(usable);
    ed.lines.forEach((line) => {
      const cell = document.querySelector(`[data-amount="${line.key}"]`);
      if (!cell) return;
      const index = usableLines.indexOf(line);
      const item = index >= 0 ? priced?.items?.[index] : null;
      cell.innerHTML = item
        ? `${rupees(item.taxablePaise)}${item.taxPaise ? `<small>+ GST ${rupees(item.taxPaise)}</small>` : ""}`
        : '<small>—</small>';
    });
    renderTotals();
  }

  function renderTotals() {
    const priced = ed.priced;
    const t = priced?.totals;
    const s = priced?.supply || {};
    $("qWarnings").innerHTML = (s.warnings || []).map((w) => `<div class="q-warning"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(w.message)}</div>`).join("");
    if (!t || !ed.lines.some(usable)) {
      $("qTotals").innerHTML = `<p class="q-muted" style="margin:0">${escapeHtml(crmI18n.t("quotes.addItemForTotal"))}</p>`;
      return;
    }
    const row = (label, value, cls = "") => `<div class="q-sum-row ${cls}"><span>${label}</span><span>${value}</span></div>`;
    const taxLabel = s.taxLabel || "SGST";
    const rows = [
      row(escapeHtml(crmI18n.t("quotes.subtotal")), rupees(t.subtotalPaise)),
      t.discountPaise ? row(escapeHtml(crmI18n.t("quotes.discount")), `− ${rupees(t.discountPaise)}`) : "",
      row(escapeHtml(crmI18n.t("quotes.taxable")), rupees(t.taxablePaise)),
      s.zeroRated ? row("GST", escapeHtml(crmI18n.t("quotes.nilLut")), "muted") : "",
      !s.zeroRated && s.interState ? row("IGST", rupees(t.igstPaise)) : "",
      !s.zeroRated && !s.interState ? row("CGST", rupees(t.cgstPaise)) + row(taxLabel, rupees(t.sgstPaise)) : "",
      t.roundOffPaise ? row(escapeHtml(crmI18n.t("quotes.roundOff")), `${t.roundOffPaise > 0 ? "+" : "−"} ${rupees(Math.abs(t.roundOffPaise))}`, "muted") : "",
      row(escapeHtml(crmI18n.t("quotes.total")), rupees(t.grandTotalPaise), "grand"),
    ];
    const rateRows = (t.byRate || [])
      .map((r) => `<tr><td>${r.ratePct}%</td><td>${rupees(r.taxablePaise)}</td><td>${s.interState ? rupees(r.igstPaise) : `${rupees(r.cgstPaise)} + ${rupees(r.sgstPaise)}`}</td></tr>`)
      .join("");
    $("qTotals").innerHTML = `${rows.join("")}
      <div class="q-words">${escapeHtml(inWords(t.grandTotalPaise))}</div>
      <div class="q-sum-row muted" style="margin-top:6px"><span>${escapeHtml(crmI18n.t("quotes.placeOfSupply"))}</span><span>${escapeHtml(s.placeOfSupply || "—")}${s.placeOfSupplyCode ? ` (${escapeHtml(s.placeOfSupplyCode)})` : ""}</span></div>
      ${rateRows ? `<details class="q-rates"><summary>${escapeHtml(crmI18n.t("quotes.gstByRate"))}</summary><table><thead><tr><th>${escapeHtml(crmI18n.t("quotes.rateCol"))}</th><th>${escapeHtml(crmI18n.t("quotes.taxableCol"))}</th><th>${s.interState ? "IGST" : `CGST + ${escapeHtml(taxLabel)}`}</th></tr></thead><tbody>${rateRows}</tbody></table></details>` : ""}`;
  }

  function renderHistory() {
    const revisions = ed.q?.revisions || [];
    $("qHistoryCard").hidden = !revisions.length;
    $("qHistory").innerHTML = revisions
      .slice()
      .reverse()
      .map((r) => `<div class="q-rev"><span>${escapeHtml(t("quotes.revisionCap", { n: r.revision }))} · ${statusBadge(r.status)} · ${escapeHtml(day(r.quotationDate))}</span><span>${rupees(r.totals?.grandTotalPaise)}</span></div>`)
      .join("");
  }

  function renderActions() {
    const q = ed.q;
    const buttons = [];
    const button = (id, labelKey, cls = "btn-outline", icon = "") => `<button class="btn ${cls}" type="button" data-action="${id}">${icon ? `<i class="fa-solid ${icon}"></i> ` : ""}${escapeHtml(t(labelKey))}</button>`;
    if (!q) {
      if (can("create")) buttons.push(button("create", "quotes.act.saveDraft", "btn-primary", "fa-floppy-disk"));
    } else if (can("edit")) {
      if (q.status === "Draft") {
        buttons.push(button("save", "quotes.act.save", "btn-primary", "fa-floppy-disk"));
        buttons.push(button("sent", "quotes.act.markSent", "btn-outline", "fa-paper-plane"));
      }
      if (["Draft", "Sent", "Viewed", "Expired"].includes(q.status)) {
        buttons.push(button("accepted", "quotes.act.accepted", "btn-outline", "fa-circle-check"));
        buttons.push(button("rejected", "quotes.act.rejected", "btn-outline", "fa-circle-xmark"));
      }
      if (["Sent", "Viewed", "Rejected", "Expired"].includes(q.status)) buttons.push(button("revise", "quotes.act.revise", "btn-primary", "fa-pen"));
      if (q.status === "Accepted" && !q.orderId) {
        buttons.unshift(button("order", "quotes.act.order", "btn-primary", "fa-truck-fast"));
        buttons.push(button("unaccept", "quotes.act.unaccept", "btn-outline", "fa-rotate-left"));
      }
    }
    if (q && canChat() && can("edit") && ["Draft", "Sent", "Viewed", "Accepted"].includes(q.status)) {
      // First for a draft; after the main actions once it was sent (e.g. "Create order" first).
      buttons[q.status === "Draft" ? "unshift" : "push"](button("whatsapp", q.status === "Draft" ? "quotes.act.whatsapp" : "quotes.act.whatsappAgain", q.status === "Draft" ? "btn-primary" : "btn-outline", "fa-paper-plane"));
    }
    if (q?.orderId) buttons.unshift(`<a class="btn btn-primary" href="Orders.html?id=${encodeURIComponent(q.orderId)}"><i class="fa-solid fa-truck-fast"></i> ${escapeHtml(t("inbox.openOrder"))}</a>`);
    // Phase 8: a payment link for the quotation's total (an advance is fine); paying accepts it.
    if (q && can("edit") && (q.orderId || ["Sent", "Viewed", "Accepted"].includes(q.status))) buttons.push(button("paylink", "quotes.act.paylink", "btn-outline", "fa-indian-rupee-sign"));
    if (q) {
      buttons.push(button("pdf", "quotes.act.pdf", "btn-outline", "fa-file-pdf"));
      if (q.status !== "Draft") {
        buttons.push(button("copylink", "quotes.act.copyLink", "btn-outline", "fa-link"));
        buttons.push(button("openlink", "quotes.act.openLink", "btn-outline", "fa-arrow-up-right-from-square"));
        if (isLocalLink(q.shareUrl)) buttons.push(`<p class="q-hint">${escapeHtml(t("quotes.hint.localLink"))}</p>`);
      } else {
        buttons.push(`<p class="q-hint">${escapeHtml(t("quotes.hint.linkAfterSent"))}</p>`);
      }
    }
    if (q && can("delete") && !q.orderId) buttons.push(button("delete", "common.delete", "btn-danger-outline", "fa-trash"));
    if (q && q.status !== "Draft" && can("edit")) buttons.push(`<p class="q-hint">${escapeHtml(t("quotes.hint.revise"))}</p>`);
    $("qActions").innerHTML = buttons.join("");
    // Phones (R3): the first two actions also stay at the bottom of the screen (quotations.css).
    const actions = buttons.filter((html) => !html.startsWith("<p"));
    $("qStickyActions").innerHTML = actions.length
      ? actions.slice(0, 2).join("") + (actions.length > 2 ? `<button class="btn btn-outline" type="button" data-sticky-more aria-label="${escapeHtml(t("quotes.moreActions"))}"><i class="fa-solid fa-ellipsis"></i> ${escapeHtml(t("quotes.more"))}</button>` : "")
      : "";
  }

  // Customers can only open a link to a public address.
  const isLocalLink = (url) => !/^https:\/\//.test(url || "") || /\/\/(127\.0\.0\.1|localhost)[:/]/.test(url || "");
  const pdfName = (q) => `${String(q.number).replace(/[^A-Za-z0-9-]+/g, "-")}${q.revision ? `-R${q.revision}` : ""}.pdf`;

  function lockIfNeeded() {
    const locked = !editable();
    document.querySelector("#qEditorView .q-grid").classList.toggle("q-locked", locked);
    document.querySelectorAll("#qEditorView .q-grid input, #qEditorView .q-grid select, #qEditorView .q-grid textarea").forEach((field) => {
      if (field.id === "qPickerInput") return;
      field.disabled = locked;
    });
  }

  function renderEditor() {
    renderHead();
    renderCustomer();
    renderLines();
    renderHistory();
    renderActions();
    lockIfNeeded();
  }

  // --- live totals from the server ---
  let previewTimer;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 250);
  }
  async function preview() {
    if (!editable()) return;
    const seq = ++ed.seq;
    const body = { ...contentPayload() };
    delete body.validUntil;
    delete body.terms;
    delete body.notes;
    try {
      const result = await crmApi("/pricing/preview", jsonRequest("POST", body));
      if (seq !== ed.seq) return;
      ed.priced = result;
      // A GSTIN decides the state: show what the server read from it.
      if (result.billTo?.gstin && result.billTo.stateCode && result.billTo.stateCode !== ed.billTo.stateCode) {
        ed.billTo.stateCode = result.billTo.stateCode;
        $("bState").value = result.billTo.stateCode;
      }
      renderAmounts();
    } catch (error) {
      if (seq !== ed.seq) return;
      $("qWarnings").innerHTML = `<div class="q-warning">${escapeHtml(apiErrorMessage(error, t("quotes.err.total")))}</div>`;
    }
  }

  function markDirty() {
    ed.dirty = true;
    schedulePreview();
  }

  // --- editing ---
  $("qItems").addEventListener("input", (e) => {
    const field = e.target.closest("[data-f]");
    const row = e.target.closest("[data-key]");
    if (!field || !row) return;
    const line = ed.lines.find((l) => l.key === row.dataset.key);
    if (!line || field.dataset.f === "productId") return;
    line[field.dataset.f] = field.value;
    markDirty();
  });
  $("qItems").addEventListener("change", (e) => {
    const field = e.target.closest("[data-f]");
    const row = e.target.closest("[data-key]");
    if (!field || !row) return;
    const index = ed.lines.findIndex((l) => l.key === row.dataset.key);
    if (index < 0) return;
    if (field.dataset.f === "productId") {
      const product = products.find((p) => String(p.id) === field.value);
      ed.lines[index] = product ? { ...lineFromProduct(product, ed.lines[index].quantity), key: ed.lines[index].key } : { ...ed.lines[index], productId: "" };
      renderLines();
      const next = document.querySelector(`[data-key="${ed.lines[index].key}"] [data-f="${product ? "quantity" : "name"}"]`);
      if (next) next.focus();
    } else {
      ed.lines[index][field.dataset.f] = field.value;
    }
    markDirty();
  });
  $("qItems").addEventListener("click", (e) => {
    const remove = e.target.closest("[data-remove]");
    if (!remove) return;
    ed.lines = ed.lines.filter((l) => l.key !== remove.dataset.remove);
    renderLines();
    markDirty();
  });
  $("qAddItem").addEventListener("click", () => {
    ed.lines.push(newLine());
    renderLines();
    document.querySelector(`[data-key="${ed.lines.at(-1).key}"] [data-f="productId"]`)?.focus();
  });
  document.querySelectorAll("[data-bill]").forEach((input) =>
    input.addEventListener(input.tagName === "SELECT" ? "change" : "input", () => {
      ed.billTo[input.dataset.bill] = input.value;
      markDirty();
    }),
  );
  ["qPlace", "qZero"].forEach((id) => $(id).addEventListener("change", markDirty));
  ["qValid", "qTerms", "qNotes"].forEach((id) => $(id).addEventListener("input", () => { ed.dirty = true; }));
  $("qDocType").addEventListener("change", () => {
    ed.dirty = true;
    renderHead();
  });

  // --- the customer picker (a new quotation without a lead, customer or chat) ---
  let pickTimer;
  let picks = [];
  $("qPickerInput").addEventListener("input", () => {
    clearTimeout(pickTimer);
    pickTimer = setTimeout(searchCustomers, 250);
  });
  async function searchCustomers() {
    const q = $("qPickerInput").value.trim();
    if (q.length < 2) {
      $("qPickerResults").innerHTML = "";
      return;
    }
    const term = encodeURIComponent(q);
    const [leads, contacts] = await Promise.all([
      crmApi(`/leads?q=${term}&limit=8`).catch(() => []),
      crmApi(`/contacts?q=${term}&limit=8`).catch(() => []),
    ]);
    const leadContacts = new Set(leads.map((l) => String(l.contactId)));
    picks = [
      ...leads.map((l) => ({ leadId: l.id, name: l.contact?.name || l.title, detail: `${t("dash.add.lead")} · ${l.title || t("inbox.ctx.enquiry")} · ${crmLabel("stage", l.stage)}`, label: t("quotes.leadLabel", { title: l.title || t("inbox.ctx.enquiry") }) })),
      ...contacts.filter((c) => !leadContacts.has(String(c.id))).map((c) => ({ contactId: c.id, name: c.name, detail: [t("quotes.col.customer"), c.company, c.phone].filter(Boolean).join(" · "), label: t("quotes.col.customer") })),
    ];
    $("qPickerResults").innerHTML = picks.length
      ? picks.map((p, i) => `<button class="q-pick" type="button" data-pick="${i}"><i class="fa-solid ${p.leadId ? "fa-bullseye" : "fa-user"}"></i><span class="who"><strong>${escapeHtml(p.name)}</strong><span class="q-muted">${escapeHtml(p.detail)}</span></span></button>`).join("")
      : `<p class="q-muted">${escapeHtml(t("quotes.nobodyFound"))}</p>`;
  }
  $("qPickerResults").addEventListener("click", async (e) => {
    const pick = picks[Number(e.target.closest("[data-pick]")?.dataset.pick)];
    if (!pick) return;
    ed.customer = { leadId: pick.leadId, contactId: pick.contactId, label: `${pick.label} · ${pick.name}` };
    await loadCustomer();
  });

  // The customer's details (and the document defaults) for a new quotation.
  async function loadCustomer() {
    const { leadId, contactId, conversationId } = ed.customer;
    try {
      const result = await crmApi("/pricing/preview", jsonRequest("POST", { leadId, contactId, conversationId, items: [] }));
      ed.billTo = { ...result.billTo };
      if (!$("qTerms").value) $("qTerms").value = result.defaults?.terms || "";
      if (!$("qValid").value) $("qValid").value = result.defaults?.validUntil || "";
      ed.priced = result;
    } catch (error) {
      showToast(apiErrorMessage(error, t("quotes.err.customer")), "error");
      ed.customer = null;
    }
    // A lead's product and quantity make the first line.
    if (leadId && !ed.lines.some(usable)) {
      try {
        const lead = await crmApi(`/leads/${encodeURIComponent(leadId)}`);
        const product = products.find((p) => String(p.id) === String(lead.productId));
        if (product) ed.lines = [lineFromProduct(product, lead.quantity || 1)];
        if (ed.customer) ed.customer.label = `${t("quotes.leadLabel", { title: lead.title || t("inbox.ctx.enquiry") })} · ${lead.contact?.name || ed.billTo.name || ""}`;
      } catch {
        /* the lead's product is only a convenience */
      }
    }
    if (!ed.lines.length) ed.lines = [newLine()];
    renderEditor();
    schedulePreview();
  }

  // --- opening ---
  function resetEditor() {
    ed.id = null;
    ed.q = null;
    ed.customer = null;
    ed.billTo = {};
    ed.lines = [];
    ed.priced = null;
    ed.dirty = false;
    ["qTerms", "qNotes", "qValid", "qPickerInput"].forEach((id) => { $(id).value = ""; });
    $("qPickerResults").innerHTML = "";
    $("qPlace").innerHTML = stateOptions("", t("quotes.placeAuto"));
    $("qZero").checked = false;
    $("qDocType").value = "Quotation";
  }

  function showEditor() {
    $("qListView").hidden = true;
    $("qEditorView").hidden = false;
    window.scrollTo(0, 0);
  }

  async function openNew(params) {
    resetEditor();
    if (!can("create")) {
      showToast(t("quotes.cannotCreate"), "error");
      return go("");
    }
    const type = params.get("type");
    if (["Quotation", "Estimate", "Proforma Invoice"].includes(type)) $("qDocType").value = type;
    showEditor();
    const ref = ["leadId", "contactId", "conversationId"].find((key) => params.get(key));
    if (ref) {
      ed.customer = { [ref]: params.get(ref), label: ref === "conversationId" ? t("quotes.fromChat") : "" };
      await loadCustomer();
    } else {
      renderEditor();
      $("qPickerInput").focus();
    }
  }

  function applySaved(q) {
    ed.q = q;
    ed.id = q.id;
    ed.customer = null;
    ed.billTo = { ...q.billTo };
    ed.lines = q.items.map(lineFromSaved);
    ed.priced = { items: q.items, totals: q.totals, supply: q.supply };
    ed.dirty = false;
    $("qValid").value = dateInput(q.validUntil);
    $("qTerms").value = q.terms || "";
    $("qNotes").value = q.notes || "";
    $("qPlace").innerHTML = stateOptions(q.placeOfSupplyCode || "", t("quotes.placeAuto"));
    $("qZero").checked = Boolean(q.supply?.zeroRated);
    renderEditor();
    // A draft's warnings (e.g. the state was assumed) come from a fresh preview.
    if (editable()) schedulePreview();
  }

  async function openExisting(id) {
    resetEditor();
    showEditor();
    $("qNumber").textContent = t("cw.loading");
    try {
      applySaved(await crmApi(`/quotations/${encodeURIComponent(id)}`));
    } catch (error) {
      showToast(apiErrorMessage(error, t("quotes.err.open")), "error");
      go("", { replace: true });
    }
  }

  function showList() {
    resetEditor();
    $("qEditorView").hidden = true;
    $("qListView").hidden = false;
    $("pageTitle").textContent = t("nav.quotations");
    loadList();
  }

  // --- actions ---
  async function save(extra = {}) {
    const body = { ...contentPayload(), ...extra };
    if (!body.items.length) {
      showToast(t("quotes.needItem"), "error");
      return null;
    }
    if (!body.billTo.name) {
      showToast(t("quotes.needName"), "error");
      return null;
    }
    if (ed.q) return crmApi(`/quotations/${ed.q.id}`, jsonRequest("PATCH", body));
    const { leadId, contactId, conversationId } = ed.customer || {};
    const request = jsonRequest("POST", { ...body, leadId, contactId, conversationId, type: $("qDocType").value });
    request.headers["Idempotency-Key"] = newIdempotencyKey();
    return crmApi("/quotations", request);
  }

  // The bottom bar's buttons are copies: they press the real one, and "More" goes to the full list.
  $("qStickyActions").addEventListener("click", (e) => {
    if (e.target.closest("[data-sticky-more]")) {
      $("qActions").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const copy = e.target.closest("button[data-action]");
    if (copy) $("qActions").querySelector(`[data-action="${copy.dataset.action}"]`)?.click();
  });

  $("qActions").addEventListener("click", async (e) => {
    const button = e.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    button.disabled = true;
    try {
      let saved = null;
      if (action === "create") {
        if (!ed.customer) {
          showToast(t("quotes.chooseCustomer"), "error");
          return;
        }
        saved = await save();
        if (saved) {
          ed.dirty = false;
          history.replaceState(null, "", `?id=${encodeURIComponent(saved.id)}`);
          showToast(t("quotes.savedDraft", { type: crmLabel("quoteType", saved.type), number: saved.number }), "success");
        }
      } else if (action === "save") {
        saved = await save();
        if (saved) showToast(t("quotes.saved"), "success");
      } else if (action === "sent") {
        saved = await save({ status: "Sent" });
        if (saved) showToast(t(saved.leadId ? "quotes.markedSentLead" : "quotes.markedSent"), "success");
      } else if (action === "accepted" || action === "unaccept") {
        saved = await crmApi(`/quotations/${ed.q.id}`, jsonRequest("PATCH", { status: action === "accepted" ? "Accepted" : "Sent" }));
        showToast(t(action === "accepted" ? "quotes.markedAccepted" : "quotes.backToSent"), "success");
      } else if (action === "rejected") {
        const reason = window.prompt(t("quotes.whyRejected"));
        if (reason === null) return;
        saved = await crmApi(`/quotations/${ed.q.id}`, jsonRequest("PATCH", { status: "Rejected", rejectedReason: reason.trim() }));
        showToast(t("quotes.markedRejected"), "success");
      } else if (action === "revise") {
        saved = await crmApi(`/quotations/${ed.q.id}/revise`, { method: "POST" });
        showToast(t("quotes.revisionOpened", { n: saved.revision }), "success");
      } else if (action === "order") {
        const request = jsonRequest("POST", { quotationId: ed.q.id });
        request.headers["Idempotency-Key"] = newIdempotencyKey();
        const created = await crmApi("/orders", request);
        showToast(t("quotes.orderCreated", { number: created.number }), "success");
        window.location.href = `Orders.html?id=${encodeURIComponent(created.id)}`;
        return;
      } else if (action === "whatsapp") {
        if (ed.dirty && ed.q.status === "Draft") {
          saved = await save();
          if (!saved) return;
          applySaved(saved);
          saved = null;
        }
        await openSend();
        return;
      } else if (action === "paylink") {
        crmPaymentLinks.open(ed.q.orderId ? { orderId: ed.q.orderId } : { quotationId: ed.q.id });
        return;
      } else if (action === "pdf") {
        if (ed.dirty && ed.q.status === "Draft") {
          saved = await save();
          if (!saved) return;
          applySaved(saved);
          saved = null;
        }
        await crmDownload(`/quotations/${ed.q.id}/pdf`, pdfName(ed.q));
        return;
      } else if (action === "copylink") {
        try {
          await navigator.clipboard.writeText(ed.q.shareUrl);
          showToast(t("quotes.linkCopied"), "success");
        } catch {
          window.prompt(t("quotes.copyLinkPrompt"), ed.q.shareUrl);
        }
        return;
      } else if (action === "openlink") {
        window.open(`${ed.q.shareUrl}?preview=1`, "_blank", "noopener");
        return;
      } else if (action === "delete") {
        if (!confirm(t("quotes.confirmDelete", { type: crmLabel("quoteType", ed.q.type), number: ed.q.number }))) return;
        await crmApi(`/quotations/${ed.q.id}`, { method: "DELETE" });
        ed.dirty = false;
        showToast(t("quotes.deleted"), "success");
        go("");
        return;
      }
      if (saved) applySaved(saved);
    } catch (error) {
      showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
    } finally {
      button.disabled = false;
    }
  });

  // --- send on WhatsApp ---
  // The PDF as a document while the customer's 24-hour window is open; otherwise an approved
  // template (one with a PDF header carries the quotation).
  const canChat = () => isOrgManager() || (me.modules || []).includes("inbox");
  const send = { options: null, mode: "document", templateId: "", done: false };

  function templateVars(template) {
    if (!template) return [];
    return [
      ...(template.header?.variables || []).map((name) => ["header", name, t("quotes.var.header", { name })]),
      ...template.body.variables.map((name) => ["body", name, t("quotes.var.body", { name })]),
      ...template.buttons.filter((b) => b.variables.length).map((b) => ["buttons", String(b.index), t("quotes.var.button", { text: b.text })]),
    ];
  }
  function sendPreview(template) {
    if (!template) return "";
    const values = { header: {}, body: {}, buttons: {} };
    document.querySelectorAll("#sendBody [data-send-var]").forEach((input) => {
      values[input.dataset.part][input.dataset.sendVar] = input.value;
    });
    const fill = (text, part) => String(text || "").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) => values[part][name] || match);
    return [template.documentHeader ? `📄 ${ed.q.number}.pdf` : "", template.header?.text ? fill(template.header.text, "header") : "", fill(template.body.text, "body"), template.footer].filter(Boolean).join("\n\n");
  }

  function renderSend() {
    const o = send.options;
    const body = $("sendBody");
    $("sendGo").hidden = true;
    if (send.done) {
      body.innerHTML = `<div class="q-send-done"><i class="fa-solid fa-circle-check"></i><p>${escapeHtml(t("quotes.send.done", { name: ed.q.billTo?.name || t("quotes.send.theCustomer") }))}</p>
        <a class="btn btn-outline" href="Inbox.html?c=${encodeURIComponent(send.done)}"><i class="fa-solid fa-comments"></i> ${escapeHtml(t("quotes.send.openChat"))}</a></div>`;
      $("sendCancel").textContent = t("common.close");
      return;
    }
    if (!o) {
      body.innerHTML = `<p class="q-muted">${escapeHtml(t("cw.loading"))}</p>`;
      return;
    }
    if (o.blocked) {
      body.innerHTML = `<div class="q-warning">${escapeHtml(o.blocked)}</div>`;
      return;
    }
    const windowOpen = Boolean(o.conversation?.windowOpen);
    if (!windowOpen) send.mode = "template";
    const template = o.templates.find((t) => String(t.id) === send.templateId) || null;
    const to = `${t("quotes.send.to", { name: `<strong>${escapeHtml(ed.q.billTo?.name || "")}</strong>` })} · ${escapeHtml(o.phone)}${o.account ? ` · ${escapeHtml(t("quotes.send.from", { number: o.account.name || o.account.phone }))}` : ""}`;
    const modes = windowOpen
      ? `<div class="q-send-mode">
          <label><input type="radio" name="sendMode" value="document" ${send.mode === "document" ? "checked" : ""} /><span>${escapeHtml(t("quotes.send.pdfMode"))}<small>${escapeHtml(t("quotes.send.pdfModeHint"))}</small></span></label>
          <label><input type="radio" name="sendMode" value="template" ${send.mode === "template" ? "checked" : ""} /><span>${escapeHtml(t("quotes.send.tplMode"))}<small>${escapeHtml(t("quotes.send.tplModeHint"))}</small></span></label>
        </div>`
      : `<div class="q-warning">${escapeHtml(t("quotes.send.closed"))}</div>`;
    let detail = "";
    if (send.mode === "document") {
      detail = `<div class="field"><label for="sendCaption">${escapeHtml(t("quotes.send.caption"))}</label><textarea id="sendCaption" rows="4" maxlength="1024">${escapeHtml(send.caption ?? o.caption)}</textarea></div>`;
    } else if (!o.templates.length) {
      detail = `<p class="q-muted">${escapeHtml(t("quotes.send.noTemplates"))}</p>`;
    } else {
      detail = `<div class="field"><label for="sendTemplate">${escapeHtml(t("inbox.template"))}</label><select id="sendTemplate"><option value="">${escapeHtml(t("quotes.send.chooseTpl"))}</option>${o.templates
        .map((t) => `<option value="${escapeHtml(t.id)}" ${String(t.id) === send.templateId ? "selected" : ""}>${escapeHtml(t.name)} (${escapeHtml(t.language)})${t.documentHeader ? escapeHtml(crmI18n.t("quotes.send.withPdf")) : ""}</option>`)
        .join("")}</select></div>
        ${templateVars(template)
          .map(([part, name, label]) => `<div class="field"><label>${escapeHtml(label)}</label><input type="text" maxlength="1024" data-part="${part}" data-send-var="${escapeHtml(name)}" value="${escapeHtml(template.suggested?.[part]?.[name] || "")}" /></div>`)
          .join("")}
        ${template ? `<div class="q-send-preview"><div id="sendPreview">${escapeHtml(sendPreview(template))}</div></div>${template.documentHeader ? "" : `<p class="q-muted" style="margin-top:8px">${escapeHtml(t("quotes.send.noPdfHeader"))}</p>`}` : ""}`;
    }
    body.innerHTML = `<div class="q-send-to">${to}</div>${modes}${detail}`;
    if (template) $("sendPreview").textContent = sendPreview(template);
    $("sendGo").hidden = send.mode === "template" && !template;
  }

  async function openSend() {
    send.options = null;
    send.done = false;
    send.caption = undefined;
    send.templateId = "";
    send.mode = "document";
    $("sendCancel").textContent = t("common.cancel");
    $("sendOverlay").classList.add("open");
    renderSend();
    try {
      send.options = await crmApi(`/quotations/${ed.q.id}/send-options`);
      const withPdf = send.options.templates.find((t) => t.documentHeader);
      if (withPdf) send.templateId = String(withPdf.id);
    } catch (error) {
      send.options = { blocked: apiErrorMessage(error, t("quotes.send.checkFailed")) };
    }
    renderSend();
  }
  function closeSend() {
    $("sendOverlay").classList.remove("open");
  }
  $("sendClose").addEventListener("click", closeSend);
  $("sendCancel").addEventListener("click", closeSend);
  $("sendOverlay").addEventListener("click", (e) => {
    if (e.target === $("sendOverlay")) closeSend();
  });
  $("sendBody").addEventListener("change", (e) => {
    if (e.target.name === "sendMode") {
      send.mode = e.target.value;
      renderSend();
    } else if (e.target.id === "sendTemplate") {
      send.templateId = e.target.value;
      renderSend();
    }
  });
  $("sendBody").addEventListener("input", (e) => {
    if (e.target.id === "sendCaption") send.caption = e.target.value;
    if (e.target.dataset.sendVar !== undefined) {
      const template = send.options.templates.find((t) => String(t.id) === send.templateId);
      $("sendPreview").textContent = sendPreview(template);
    }
  });
  $("sendGo").addEventListener("click", async () => {
    const body = { mode: send.mode };
    if (send.mode === "document") body.caption = (send.caption ?? send.options.caption).trim();
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
      const result = await crmApi(`/quotations/${ed.q.id}/send`, request);
      applySaved(result.quotation);
      send.done = String(result.conversationId);
      renderSend();
      showToast(t("quotes.send.sent"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("quotes.send.failed")), "error");
    } finally {
      $("sendGo").disabled = false;
    }
  });

  // --- page addresses ---
  function route() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("id")) openExisting(params.get("id"));
    else if (params.get("new")) openNew(params);
    else showList();
  }
  function go(search, { replace = false } = {}) {
    if (ed.dirty && !confirm(t("quotes.leaveUnsaved"))) return;
    ed.dirty = false;
    const url = search ? `?${search}` : window.location.pathname;
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    route();
  }
  $("qBack").addEventListener("click", () => go(""));
  window.addEventListener("popstate", route);
  window.addEventListener("beforeunload", (e) => {
    if (!ed.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });

  if (!can("view")) {
    $("qListView").innerHTML = `<div class="empty-state"><p>${escapeHtml(t("quotes.noAccess"))}</p></div>`;
    return undefined;
  }
  crmReady(["products"], async () => {
    products = cached("products");
    try {
      states = await crmApi("/pricing/states");
    } catch {
      states = [];
    }
    route();
  });
  return undefined;
});
