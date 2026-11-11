/**
 * marketing-broadcasts.js — Marketing → WhatsApp broadcasts and Segments (Phase 7, owners and
 * admins). Broadcasts: an approved template, filled in per customer, sent to a segment now or
 * later (/broadcasts); the results per customer. Segments: saved audiences with a live preview
 * (/segments). The Campaigns tab stays js/marketing.js. Uses app.js: crmApi, crmRequest,
 * jsonRequest, newIdempotencyKey, escapeHtml, isOrgManager, showToast, apiErrorMessage,
 * LEAD_STAGES. Runs once the page texts (English or Hindi) are loaded.
 */
crmI18n.ready.then(function marketingBroadcasts() {
  if (!isOrgManager()) return;
  const T = crmI18n.t;
  const $ = (id) => document.getElementById(id);
  const idOf = (value) => String(value || "");
  const when = (iso) => (iso ? new Date(iso).toLocaleString(crmI18n.locale(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString(crmI18n.locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const num = (n) => Number(n || 0).toLocaleString(crmI18n.locale());
  const splitList = (text) => [...new Set(String(text || "").split(",").map((s) => s.trim()).filter(Boolean))];
  const SOURCES = ["WhatsApp", "IndiaMART", "JustDial", "TradeIndia", "Facebook", "Google Ads", "Website", "Manual", "Import"];
  // [what fills a variable, its text key]
  const VALUES = [
    ["contact.name", "bc.val.name"], ["contact.company", "bc.val.company"], ["contact.city", "bc.val.city"],
    ["lead.product", "bc.val.product"], ["owner.name", "bc.val.owner"], ["org.name", "bc.val.org"], ["text:", "bc.val.text"],
  ];
  // [badge class, text key]: a broadcast's status, then one customer's.
  const STATUS_BADGE = {
    draft: ["badge-neutral", "bcStatus.draft"], scheduled: ["badge-info", "bcStatus.scheduled"], sending: ["badge-warning", "bcStatus.sending"], paused: ["badge-neutral", "bcStatus.paused"],
    completed: ["badge-success", "bcStatus.completed"], cancelled: ["badge-neutral", "bcStatus.cancelled"], failed: ["badge-danger", "bcPerson.failed"],
    pending: ["badge-neutral", "bcPerson.pending"], sent: ["badge-info", "bcPerson.sent"], delivered: ["badge-info", "bcPerson.delivered"], read: ["badge-success", "bcPerson.read"],
    replied: ["badge-success", "bcPerson.replied"], skipped: ["badge-neutral", "bcPerson.skipped"],
  };
  const statusName = (status) => (STATUS_BADGE[status] ? T(STATUS_BADGE[status][1]) : status);
  const badge = (status) => `<span class="badge ${(STATUS_BADGE[status] || ["badge-neutral"])[0]}">${escapeHtml(statusName(status))}</span>`;
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

  let templates = [];
  let segments = [];
  let broadcasts = [];
  let options = { tags: [], states: [], cities: [], productCategories: [] };
  let loaded = false;

  // ===========================================================================================
  // Tabs
  // ===========================================================================================
  $("mkTabs").hidden = false;
  const panels = { campaigns: "campaignsPanel", broadcasts: "broadcastsPanel", segments: "segmentsPanel" };
  async function showTab(tab) {
    Object.entries(panels).forEach(([key, panel]) => ($(panel).hidden = key !== tab));
    document.querySelectorAll(".mk-tab").forEach((button) => button.classList.toggle("active", button.dataset.mk === tab));
    if (tab === "campaigns") return;
    await load();
    if (tab === "broadcasts") renderBroadcasts();
    if (tab === "segments") renderSegments();
  }
  $("mkTabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-mk]");
    if (tab) showTab(tab.dataset.mk);
  });

  async function load({ force = false } = {}) {
    if (loaded && !force) return;
    try {
      const [b, s, tpls, o, q] = await Promise.all([
        crmRequest("/broadcasts?limit=50"), crmApi("/segments"), crmApi("/templates").catch(() => []), crmApi("/segments/options"), crmApi("/broadcasts/quota"),
      ]);
      broadcasts = b.data;
      segments = s;
      templates = tpls.filter((x) => x.sendable);
      options = o;
      $("bcQuota").textContent = T("bc.quota", { plan: q.plan, used: q.used, limit: q.limit });
      loaded = true;
    } catch (error) {
      showToast(apiErrorMessage(error, T("bc.err.load")), "error");
    }
  }

  // ===========================================================================================
  // Broadcast list
  // ===========================================================================================
  function renderBroadcasts() {
    $("bcList").innerHTML = broadcasts.length
      ? `<table><thead><tr><th>${escapeHtml(T("inbox.auto.broadcast"))}</th><th>${escapeHtml(T("bc.col.segment"))}</th><th>${escapeHtml(T("col.status"))}</th><th>${escapeHtml(T("bcPerson.sent"))}</th><th>${escapeHtml(T("bcPerson.delivered"))}</th><th>${escapeHtml(T("bcPerson.read"))}</th><th>${escapeHtml(T("bcPerson.replied"))}</th><th>${escapeHtml(T("bcPerson.failed"))}</th><th>${escapeHtml(T("bc.col.when"))}</th></tr></thead><tbody>
        ${broadcasts.map((b) => {
          const s = b.stats;
          return `<tr data-bc="${escapeHtml(b.id)}">
            <td><strong>${escapeHtml(b.name)}</strong><div class="mk-sub">${escapeHtml(b.template.name)}</div></td>
            <td>${escapeHtml(b.segment.name)}</td>
            <td>${badge(b.status)}</td>
            <td>${s.sent}</td>
            <td>${s.delivered} <span class="mk-sub">${pct(s.delivered, s.sent)}%</span></td>
            <td>${s.read} <span class="mk-sub">${pct(s.read, s.sent)}%</span></td>
            <td>${s.replied}</td>
            <td>${s.failed}</td>
            <td class="mk-sub">${escapeHtml(when(b.startedAt || b.scheduledAt || b.createdAt))}</td>
          </tr>`;
        }).join("")}</tbody></table>`
      : `<div class="empty-state"><i class="fa-brands fa-whatsapp"></i><p>${escapeHtml(T("bc.empty"))}</p></div>`;
  }

  $("bcList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-bc]");
    if (!row) return;
    const b = broadcasts.find((x) => idOf(x.id) === row.dataset.bc);
    if (b) (["draft", "scheduled"].includes(b.status) ? openComposer(b) : openResults(b.id));
  });

  // ===========================================================================================
  // Composer
  // ===========================================================================================
  let editing = null; // the saved draft, once saved

  const templateOf = (id) => templates.find((t) => idOf(t.id) === idOf(id));
  function templateVariables(template) {
    if (!template) return [];
    return [
      ...(template.header?.variables || []).map((name) => ["header", name, T("quotes.var.header", { name })]),
      ...template.body.variables.map((name) => ["body", name, T("quotes.var.body", { name })]),
      ...template.buttons.filter((b) => b.variables.length).map((b) => ["buttons", String(b.index), T("quotes.var.button", { text: b.text })]),
    ];
  }

  function renderVariables(variables = {}) {
    const template = templateOf($("bcTemplate").value);
    $("bcTemplateText").textContent = template ? T("bc.tplText", { category: template.category, text: template.body.text }) : "";
    $("bcVariables").innerHTML = templateVariables(template)
      .map(([part, name, label]) => {
        const spec = variables?.[part]?.[name] || "";
        const isText = String(spec).startsWith("text:");
        return `<div class="field"><label>${escapeHtml(label)}</label><div class="mk-inline">
          <select data-var-part="${part}" data-var-name="${escapeHtml(name)}"><option value="">${escapeHtml(T("bc.choose"))}</option>${VALUES.map(([value, key]) => `<option value="${value}" ${spec === value || (value === "text:" && isText) ? "selected" : ""}>${escapeHtml(T(key))}</option>`).join("")}</select>
          <input type="text" data-var-text maxlength="200" placeholder="${escapeHtml(T("bc.fixedWords"))}" value="${isText ? escapeHtml(spec.slice(5)) : ""}" ${isText ? "" : "hidden"} /></div></div>`;
      })
      .join("");
  }
  function readVariables() {
    const out = { header: {}, body: {}, buttons: {} };
    $("bcVariables").querySelectorAll("[data-var-part]").forEach((select) => {
      const text = select.parentElement.querySelector("[data-var-text]").value.trim();
      const spec = select.value === "text:" ? (text ? `text:${text}` : "") : select.value;
      if (spec) out[select.dataset.varPart][select.dataset.varName] = spec;
    });
    return out;
  }

  async function renderEstimate() {
    if (!editing) {
      $("bcEstimate").hidden = true;
      return;
    }
    try {
      const e = await crmApi(`/broadcasts/${editing.id}/estimate`);
      const daily = e.dailyLimit.limit == null ? T("bc.noDaily") : T("bc.daily", { limit: num(e.dailyLimit.limit), left: num(e.dailyLimit.leftToday) });
      $("bcEstimate").innerHTML = `
        <div>${T("bc.est.recipients", { n: `<strong>${num(e.recipients)}</strong>` })}</div>
        <div>${T("bc.est.cost", { cost: `<strong>${rupees(e.cost.paise)}</strong>`, gst: rupees(e.cost.gstPaise), each: `₹${(e.cost.perMessagePaise / 100).toFixed(4)}`, asOf: escapeHtml(e.cost.asOf) })}</div>
        <div>${escapeHtml(daily)}.</div>
        <div>${escapeHtml(T("bc.est.quota", { plan: e.quota.plan, left: e.quota.left, limit: e.quota.limit }))}</div>`;
      $("bcEstimate").hidden = false;
      $("bcSendBtn").disabled = !e.recipients || !e.quota.left;
    } catch (error) {
      $("bcEstimate").hidden = true;
    }
  }

  function openComposer(b = null) {
    editing = b;
    if (!templates.length || !segments.length) {
      showToast(T(!templates.length ? "bc.noTemplates" : "bc.needSegment"), "error");
      if (!segments.length) showTab("segments");
      return;
    }
    $("bcEditTitle").textContent = b ? T("bc.editNamed", { name: b.name }) : T("mkt.new-broadcast");
    $("bcName").value = b?.name || "";
    $("bcTemplate").innerHTML = templates.map((t) => `<option value="${escapeHtml(t.id)}" ${idOf(t.id) === idOf(b?.template.id) ? "selected" : ""}>${escapeHtml(t.name)} (${escapeHtml(t.language)}, ${escapeHtml(t.category)})</option>`).join("");
    $("bcSegment").innerHTML = segments.map((s) => `<option value="${escapeHtml(s.id)}" ${idOf(s.id) === idOf(b?.segment.id) ? "selected" : ""}>${escapeHtml(s.name)} (${s.count})</option>`).join("");
    renderVariables(b?.variables);
    $("bcScheduleField").hidden = !b;
    $("bcScheduleAt").value = "";
    $("bcDeleteBtn").style.display = b ? "inline-flex" : "none";
    $("bcSendBtn").disabled = true;
    $("bcEstimate").hidden = true;
    $("bcEditOverlay").classList.add("open");
    renderEstimate();
  }
  const closeComposer = () => $("bcEditOverlay").classList.remove("open");

  async function saveDraft() {
    const body = { name: $("bcName").value.trim(), templateId: $("bcTemplate").value, segmentId: $("bcSegment").value, variables: readVariables() };
    if (!body.name) {
      showToast(T("bc.needName"), "error");
      $("bcName").focus();
      return false;
    }
    try {
      editing = await crmApi(editing ? `/broadcasts/${editing.id}` : "/broadcasts", jsonRequest(editing ? "PATCH" : "POST", body));
      $("bcScheduleField").hidden = false;
      $("bcDeleteBtn").style.display = "inline-flex";
      showToast(T("bc.draftSaved"), "success");
      await load({ force: true });
      renderBroadcasts();
      await renderEstimate();
      return true;
    } catch (error) {
      showToast(apiErrorMessage(error, T("bc.err.save")), "error");
      return false;
    }
  }

  $("bcTemplate").addEventListener("change", () => renderVariables());
  $("bcVariables").addEventListener("change", (event) => {
    if (!event.target.matches("[data-var-part]")) return;
    const text = event.target.parentElement.querySelector("[data-var-text]");
    text.hidden = event.target.value !== "text:";
    if (!text.hidden) text.focus();
  });
  $("bcSaveBtn").addEventListener("click", saveDraft);
  $("bcSendBtn").addEventListener("click", async () => {
    if (!(await saveDraft())) return;
    const at = $("bcScheduleAt").value ? new Date($("bcScheduleAt").value).toISOString() : null;
    const question = at ? T("bc.confirmSchedule", { name: editing.name, when: when(at) }) : T("bc.confirmSend", { name: editing.name });
    if (!confirm(question)) return;
    try {
      const result = await crmRequest(`/broadcasts/${editing.id}/send`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() }, body: JSON.stringify({ scheduledAt: at }),
      });
      showToast(result.message, "success");
      closeComposer();
      await load({ force: true });
      renderBroadcasts();
      if (!at) openResults(editing.id);
    } catch (error) {
      showToast(apiErrorMessage(error, T("bc.err.send")), "error");
    }
  });
  $("bcDeleteBtn").addEventListener("click", async () => {
    if (!editing || !confirm(T("bc.confirmDelete", { name: editing.name }))) return;
    try {
      if (editing.status === "scheduled") await crmApi(`/broadcasts/${editing.id}/cancel`, { method: "POST" });
      await crmApi(`/broadcasts/${editing.id}`, { method: "DELETE" });
      closeComposer();
      await load({ force: true });
      renderBroadcasts();
    } catch (error) {
      showToast(apiErrorMessage(error, T("common.deleteFailed")), "error");
    }
  });
  $("bcNewBtn").addEventListener("click", () => openComposer(null));
  $("bcEditClose").addEventListener("click", closeComposer);
  $("bcEditOverlay").addEventListener("click", (event) => {
    if (event.target.id === "bcEditOverlay") closeComposer();
  });

  // ===========================================================================================
  // Results of one broadcast
  // ===========================================================================================
  let viewing = null;
  let people = [];
  let peoplePage = 1;
  let refreshTimer = null;

  function renderResults(b) {
    viewing = b;
    const s = b.stats;
    $("bcViewTitle").textContent = b.name;
    $("bcViewSub").textContent = `${b.template.name} → ${b.segment.name} · ${statusName(b.status)}${b.startedAt ? ` · ${T("bc.startedAt", { when: when(b.startedAt) })}` : b.scheduledAt ? ` · ${T("bc.forAt", { when: when(b.scheduledAt) })}` : ""}`;
    const note = b.error || (b.waitUntil ? T("bc.waitNote", { when: when(b.waitUntil) }) : b.status === "scheduled" ? T("bc.goesAt", { when: when(b.scheduledAt) }) : "");
    $("bcViewNote").hidden = !note;
    $("bcViewNote").textContent = note;
    const steps = [["total", s.total], ["sent", s.sent], ["delivered", s.delivered], ["read", s.read], ["replied", s.replied]];
    const stepName = (step) => T(step === "total" ? "bc.recipients" : `bcPerson.${step}`);
    $("bcFunnel").innerHTML = `${steps.map(([step, n]) => `<div class="mk-step"><div class="n">${num(n)}</div><div class="l">${escapeHtml(stepName(step))}${step !== "total" && s.sent ? ` · ${pct(n, step === "sent" ? s.total : s.sent)}%` : ""}</div><div class="bar"><span style="width:${pct(n, s.total)}%"></span></div></div>`).join("")}
      <div class="mk-step muted"><div class="n">${s.failed + s.skipped}</div><div class="l">${escapeHtml(T("bc.failedSkipped", { failed: s.failed, skipped: s.skipped }))}${s.pending ? ` · ${escapeHtml(T("bc.waitingN", { n: s.pending }))}` : ""}</div></div>`;
    $("bcPauseBtn").hidden = b.status !== "sending";
    $("bcResumeBtn").hidden = b.status !== "paused";
    $("bcCancelBtn").hidden = !["scheduled", "sending", "paused"].includes(b.status);
  }

  async function loadPeople({ more = false } = {}) {
    peoplePage = more ? peoplePage + 1 : 1;
    const params = new URLSearchParams({ page: String(peoplePage), limit: "50" });
    if ($("bcPeopleFilter").value) params.set("status", $("bcPeopleFilter").value);
    const body = await crmRequest(`/broadcasts/${viewing.id}/recipients?${params}`);
    people = more ? people.concat(body.data) : body.data;
    $("bcPeopleMore").hidden = !body.pagination?.hasNextPage;
    $("bcPeople").innerHTML = people.length
      ? `<table><thead><tr><th>${escapeHtml(T("orders.customer"))}</th><th>${escapeHtml(T("col.status"))}</th><th>${escapeHtml(T("bc.col.when"))}</th><th></th></tr></thead><tbody>${people.map((p) => `
        <tr><td>${escapeHtml(p.name)}<div class="mk-sub">${escapeHtml(p.phone)}</div></td>
          <td>${badge(p.status)}${p.reason ? `<div class="mk-sub">${escapeHtml(p.reason)}</div>` : ""}</td>
          <td class="mk-sub">${escapeHtml(when(p.repliedAt || p.readAt || p.deliveredAt || p.sentAt || p.failedAt))}</td>
          <td>${p.conversationId ? `<a href="Inbox.html?c=${encodeURIComponent(p.conversationId)}">${escapeHtml(T("bc.chat"))}</a>` : ""}</td></tr>`).join("")}</tbody></table>`
      : `<p class="mk-hint">${escapeHtml(T("bc.nobody"))}</p>`;
  }

  async function openResults(id) {
    clearTimeout(refreshTimer);
    try {
      renderResults(await crmApi(`/broadcasts/${id}`));
      $("bcPeopleFilter").value = "";
      $("bcViewOverlay").classList.add("open");
      await loadPeople();
    } catch (error) {
      showToast(apiErrorMessage(error, T("bc.err.open")), "error");
      return;
    }
    // While it sends, the numbers move on their own.
    const tick = async () => {
      if (!$("bcViewOverlay").classList.contains("open") || idOf(viewing?.id) !== idOf(id)) return;
      try {
        renderResults(await crmApi(`/broadcasts/${id}`));
        await loadPeople(); // the list moves on too
      } catch {
        return;
      }
      if (["scheduled", "sending"].includes(viewing.status)) refreshTimer = setTimeout(tick, 4000);
    };
    if (["scheduled", "sending"].includes(viewing.status)) refreshTimer = setTimeout(tick, 2500);
  }
  const closeResults = async () => {
    clearTimeout(refreshTimer);
    $("bcViewOverlay").classList.remove("open");
    await load({ force: true });
    renderBroadcasts();
  };
  async function act(action) {
    if (action === "cancel" && !confirm(T("bc.confirmCancel"))) return;
    try {
      renderResults(await crmApi(`/broadcasts/${viewing.id}/${action}`, { method: "POST" }));
      await loadPeople();
    } catch (error) {
      showToast(apiErrorMessage(error, T("bc.err.act")), "error");
    }
  }
  $("bcPauseBtn").addEventListener("click", () => act("pause"));
  $("bcResumeBtn").addEventListener("click", () => act("resume"));
  $("bcCancelBtn").addEventListener("click", () => act("cancel"));
  $("bcPeopleFilter").addEventListener("change", () => loadPeople());
  $("bcPeopleMore").addEventListener("click", () => loadPeople({ more: true }));
  $("bcViewClose").addEventListener("click", closeResults);
  $("bcViewDone").addEventListener("click", closeResults);
  $("bcViewOverlay").addEventListener("click", (event) => {
    if (event.target.id === "bcViewOverlay") closeResults();
  });

  // ===========================================================================================
  // Segments
  // ===========================================================================================
  let segmentId = "";
  let previewTimer = null;

  function filterSummary(f) {
    const bits = [];
    if (f.tagsAll?.length) bits.push(T("bc.f.tags", { list: f.tagsAll.join(" + ") }));
    if (f.tagsAny?.length) bits.push(T("bc.f.any", { list: f.tagsAny.join(" / ") }));
    if (f.tagsNone?.length) bits.push(T("bc.f.not", { list: f.tagsNone.join(" / ") }));
    if (f.states?.length) bits.push(f.states.join(", "));
    if (f.cities?.length) bits.push(f.cities.join(", "));
    if (f.sources?.length) bits.push(T("bc.f.from", { list: f.sources.map((x) => crmLabel("source", x)).join(", ") }));
    if (f.lifecycles?.length) bits.push(f.lifecycles.map((x) => crmLabel("bcLife", x)).join(T("bc.f.or")));
    if (f.productCategories?.length) bits.push(T("bc.f.buys", { list: f.productCategories.join(", ") }));
    if (f.leadStages?.length) bits.push(T("bc.f.leadAt", { list: f.leadStages.map((x) => crmLabel("stage", x)).join(" / ") }));
    if (f.consent === "opted_in") bits.push(T("bc.f.agreed"));
    return bits.length ? bits : [T("bc.f.everyone")];
  }

  function renderSegments() {
    $("sgList").innerHTML = segments.length
      ? segments.map((s) => `
        <div class="mk-card" data-sg="${escapeHtml(s.id)}">
          <div class="mk-card-head"><strong>${escapeHtml(s.name)}</strong><span class="mk-count">${escapeHtml(T("bc.nCustomers", { n: num(s.count) }))}</span></div>
          ${s.description ? `<div class="mk-sub">${escapeHtml(s.description)}</div>` : ""}
          <div class="mk-chips">${filterSummary(s.filters).map((b) => `<span class="badge badge-neutral">${escapeHtml(b)}</span>`).join("")}</div>
        </div>`).join("")
      : `<div class="empty-state"><i class="fa-solid fa-users-viewfinder"></i><p>${escapeHtml(T("bc.sgEmpty"))}</p></div>`;
  }

  const checks = (id, values, selected = []) => {
    $(id).innerHTML = values.map(([value, label]) => `<label class="mk-check"><input type="checkbox" value="${escapeHtml(value)}" ${selected.includes(value) ? "checked" : ""} /> ${escapeHtml(label)}</label>`).join("");
  };
  const ticked = (id) => [...$(id).querySelectorAll("input:checked")].map((input) => input.value);
  const datalist = (id, values) => {
    $(id).innerHTML = values.map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
  };

  function readFilters() {
    return {
      tagsAll: splitList($("sgTagsAll").value), tagsAny: splitList($("sgTagsAny").value), tagsNone: splitList($("sgTagsNone").value),
      states: splitList($("sgStates").value), cities: splitList($("sgCities").value), productCategories: splitList($("sgCategories").value),
      sources: ticked("sgSources"), lifecycles: ticked("sgLifecycles"), leadStages: ticked("sgStages"),
      consent: document.querySelector('input[name="sgConsent"]:checked').value,
    };
  }

  async function renderPreview() {
    try {
      const p = await crmApi("/segments/preview", jsonRequest("POST", { filters: readFilters() }));
      $("sgPreview").innerHTML = `<div>${T("bc.pv.total", { total: `<strong>${num(p.total)}</strong>` })} · ${escapeHtml(T("bc.pv.mobile", { n: num(p.withWhatsApp) }))}${p.optedOut ? ` · ${escapeHtml(T("bc.pv.out", { n: p.optedOut }))}` : ""}</div>
        ${p.sample.length ? `<div class="mk-sub">${p.sample.map((c) => escapeHtml(`${c.name}${c.city ? ` (${c.city})` : ""}`)).join(", ")}${p.total > p.sample.length ? " …" : ""}</div>` : ""}`;
    } catch (error) {
      $("sgPreview").textContent = apiErrorMessage(error, T("bc.err.count"));
    }
  }
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 300);
  };

  function openSegment(s = null) {
    segmentId = s ? s.id : "";
    const f = s?.filters || {};
    $("sgTitle").textContent = s ? T("bc.editNamed", { name: s.name }) : T("mkt.new-segment");
    $("sgName").value = s?.name || "";
    $("sgDescription").value = s?.description || "";
    $("sgTagsAll").value = (f.tagsAll || []).join(", ");
    $("sgTagsAny").value = (f.tagsAny || []).join(", ");
    $("sgTagsNone").value = (f.tagsNone || []).join(", ");
    $("sgStates").value = (f.states || []).join(", ");
    $("sgCities").value = (f.cities || []).join(", ");
    $("sgCategories").value = (f.productCategories || []).join(", ");
    checks("sgLifecycles", [["customer", T("nav.customers")], ["lead", T("nav.leads")]], f.lifecycles);
    checks("sgSources", SOURCES.map((x) => [x, crmLabel("source", x)]), f.sources);
    checks("sgStages", LEAD_STAGES.map((x) => [x, crmLabel("stage", x)]), f.leadStages);
    document.querySelector(`input[name="sgConsent"][value="${f.consent === "opted_in" ? "opted_in" : "not_opted_out"}"]`).checked = true;
    datalist("sgTagOptions", options.tags);
    datalist("sgStateOptions", options.states);
    datalist("sgCityOptions", options.cities);
    datalist("sgCategoryOptions", options.productCategories);
    $("sgDeleteBtn").style.display = s ? "inline-flex" : "none";
    $("sgOverlay").classList.add("open");
    $("sgName").focus();
    renderPreview();
  }
  const closeSegment = () => $("sgOverlay").classList.remove("open");

  $("sgOverlay").addEventListener("input", (event) => {
    if (event.target.closest(".modal-body") && event.target.id !== "sgName" && event.target.id !== "sgDescription") schedulePreview();
  });
  $("sgOverlay").addEventListener("change", (event) => {
    if (event.target.matches('input[type="checkbox"], input[type="radio"]')) schedulePreview();
  });
  $("sgSaveBtn").addEventListener("click", async () => {
    const body = { name: $("sgName").value.trim(), description: $("sgDescription").value.trim(), filters: readFilters() };
    if (!body.name) {
      showToast(T("bc.sgNeedName"), "error");
      $("sgName").focus();
      return;
    }
    try {
      await crmApi(segmentId ? `/segments/${segmentId}` : "/segments", jsonRequest(segmentId ? "PATCH" : "POST", body));
      closeSegment();
      showToast(T("bc.sgSaved"), "success");
      await load({ force: true });
      renderSegments();
    } catch (error) {
      showToast(apiErrorMessage(error, T("bc.err.sgSave")), "error");
    }
  });
  $("sgDeleteBtn").addEventListener("click", async () => {
    if (!segmentId || !confirm(T("bc.sgConfirmDelete"))) return;
    try {
      await crmApi(`/segments/${segmentId}`, { method: "DELETE" });
      closeSegment();
      await load({ force: true });
      renderSegments();
    } catch (error) {
      showToast(apiErrorMessage(error, T("bc.err.sgDelete")), "error");
    }
  });
  $("sgList").addEventListener("click", (event) => {
    const card = event.target.closest("[data-sg]");
    if (card) openSegment(segments.find((s) => idOf(s.id) === card.dataset.sg));
  });
  $("sgNewBtn").addEventListener("click", () => openSegment(null));
  $("sgClose").addEventListener("click", closeSegment);
  $("sgCancelBtn").addEventListener("click", closeSegment);
  $("sgOverlay").addEventListener("click", (event) => {
    if (event.target.id === "sgOverlay") closeSegment();
  });

  // A bell notification opens one broadcast: Marketing.html?broadcast=<id>.
  const deepLink = new URLSearchParams(window.location.search).get("broadcast");
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (deepLink) showTab("broadcasts").then(() => openResults(deepLink));
  else if (tab === "broadcasts" || tab === "segments") showTab(tab);
});
