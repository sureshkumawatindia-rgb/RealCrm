/**
 * marketing-broadcasts.js — Marketing → WhatsApp broadcasts and Segments (Phase 7, owners and
 * admins). Broadcasts: an approved template, filled in per customer, sent to a segment now or
 * later (/broadcasts); the results per customer. Segments: saved audiences with a live preview
 * (/segments). The Campaigns tab stays js/marketing.js. Uses app.js: crmApi, crmRequest,
 * jsonRequest, newIdempotencyKey, escapeHtml, isOrgManager, showToast, apiErrorMessage,
 * LEAD_STAGES.
 */
(function marketingBroadcasts() {
  if (!isOrgManager()) return;
  const $ = (id) => document.getElementById(id);
  const idOf = (value) => String(value || "");
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const splitList = (text) => [...new Set(String(text || "").split(",").map((s) => s.trim()).filter(Boolean))];
  const SOURCES = ["WhatsApp", "IndiaMART", "JustDial", "TradeIndia", "Facebook", "Google Ads", "Website", "Manual", "Import"];
  const VALUES = [
    ["contact.name", "Customer's name"], ["contact.company", "Customer's company"], ["contact.city", "Customer's city"],
    ["lead.product", "Lead title (product)"], ["owner.name", "Name of the customer's owner"], ["org.name", "Your business name"], ["text:", "Fixed words…"],
  ];
  const STATUS_BADGE = {
    draft: ["badge-neutral", "Draft"], scheduled: ["badge-info", "Scheduled"], sending: ["badge-warning", "Sending"], paused: ["badge-neutral", "Paused"],
    completed: ["badge-success", "Sent"], cancelled: ["badge-neutral", "Cancelled"], failed: ["badge-danger", "Failed"],
    pending: ["badge-neutral", "Waiting"], sent: ["badge-info", "Sent"], delivered: ["badge-info", "Delivered"], read: ["badge-success", "Read"],
    replied: ["badge-success", "Replied"], skipped: ["badge-neutral", "Skipped"],
  };
  const badge = (status) => {
    const [cls, label] = STATUS_BADGE[status] || ["badge-neutral", status];
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
  };
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
      const [b, s, t, o, q] = await Promise.all([
        crmRequest("/broadcasts?limit=50"), crmApi("/segments"), crmApi("/templates").catch(() => []), crmApi("/segments/options"), crmApi("/broadcasts/quota"),
      ]);
      broadcasts = b.data;
      segments = s;
      templates = t.filter((x) => x.sendable);
      options = o;
      $("bcQuota").textContent = `${q.plan} plan: ${q.used} of ${q.limit} broadcasts used this month`;
      loaded = true;
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't load the broadcasts."), "error");
    }
  }

  // ===========================================================================================
  // Broadcast list
  // ===========================================================================================
  function renderBroadcasts() {
    $("bcList").innerHTML = broadcasts.length
      ? `<table><thead><tr><th>Broadcast</th><th>Segment</th><th>Status</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Replied</th><th>Failed</th><th>When</th></tr></thead><tbody>
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
      : '<div class="empty-state"><i class="fa-brands fa-whatsapp"></i><p>No broadcasts yet. Make a segment, then send an approved template to it.</p></div>';
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
      ...(template.header?.variables || []).map((name) => ["header", name, `{{${name}}} in the heading`]),
      ...template.body.variables.map((name) => ["body", name, `{{${name}}} in the message`]),
      ...template.buttons.filter((b) => b.variables.length).map((b) => ["buttons", String(b.index), `The end of the "${b.text}" button link`]),
    ];
  }

  function renderVariables(variables = {}) {
    const template = templateOf($("bcTemplate").value);
    $("bcTemplateText").textContent = template ? `${template.category} template: ${template.body.text}` : "";
    $("bcVariables").innerHTML = templateVariables(template)
      .map(([part, name, label]) => {
        const spec = variables?.[part]?.[name] || "";
        const isText = String(spec).startsWith("text:");
        return `<div class="field"><label>${escapeHtml(label)}</label><div class="mk-inline">
          <select data-var-part="${part}" data-var-name="${escapeHtml(name)}"><option value="">Choose…</option>${VALUES.map(([value, text]) => `<option value="${value}" ${spec === value || (value === "text:" && isText) ? "selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select>
          <input type="text" data-var-text maxlength="200" placeholder="The fixed words" value="${isText ? escapeHtml(spec.slice(5)) : ""}" ${isText ? "" : "hidden"} /></div></div>`;
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
      const daily = e.dailyLimit.limit == null ? "no daily limit" : `Meta lets this number reach ${e.dailyLimit.limit.toLocaleString("en-IN")} people a day (${e.dailyLimit.leftToday.toLocaleString("en-IN")} left today; the rest goes later)`;
      $("bcEstimate").innerHTML = `
        <div><strong>${e.recipients.toLocaleString("en-IN")}</strong> customers will get it (with a mobile number, not opted out).</div>
        <div>Estimated Meta cost: <strong>${rupees(e.cost.paise)}</strong> + GST ${rupees(e.cost.gstPaise)} (₹${(e.cost.perMessagePaise / 100).toFixed(4)} each, rates of ${escapeHtml(e.cost.asOf)}; your Meta invoice is what counts).</div>
        <div>${escapeHtml(daily)}.</div>
        <div>${escapeHtml(e.quota.plan)} plan: ${e.quota.left} of ${e.quota.limit} broadcasts left this month.</div>`;
      $("bcEstimate").hidden = false;
      $("bcSendBtn").disabled = !e.recipients || !e.quota.left;
    } catch (error) {
      $("bcEstimate").hidden = true;
    }
  }

  function openComposer(b = null) {
    editing = b;
    if (!templates.length || !segments.length) {
      showToast(!templates.length ? "No approved WhatsApp template yet: sync them in Settings → WhatsApp." : "Make a segment first (the Segments tab).", "error");
      if (!segments.length) showTab("segments");
      return;
    }
    $("bcEditTitle").textContent = b ? `Edit "${b.name}"` : "New broadcast";
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
      showToast("Give the broadcast a name.", "error");
      $("bcName").focus();
      return false;
    }
    try {
      editing = await crmApi(editing ? `/broadcasts/${editing.id}` : "/broadcasts", jsonRequest(editing ? "PATCH" : "POST", body));
      $("bcScheduleField").hidden = false;
      $("bcDeleteBtn").style.display = "inline-flex";
      showToast("Draft saved: check the numbers, then send", "success");
      await load({ force: true });
      renderBroadcasts();
      await renderEstimate();
      return true;
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the broadcast."), "error");
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
    const question = at ? `Schedule "${editing.name}" for ${when(at)}?` : `Send "${editing.name}" now?`;
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
      showToast(apiErrorMessage(error, "Couldn't send the broadcast."), "error");
    }
  });
  $("bcDeleteBtn").addEventListener("click", async () => {
    if (!editing || !confirm(`Delete the draft "${editing.name}"?`)) return;
    try {
      if (editing.status === "scheduled") await crmApi(`/broadcasts/${editing.id}/cancel`, { method: "POST" });
      await crmApi(`/broadcasts/${editing.id}`, { method: "DELETE" });
      closeComposer();
      await load({ force: true });
      renderBroadcasts();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't delete it."), "error");
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
    $("bcViewSub").textContent = `${b.template.name} → ${b.segment.name} · ${STATUS_BADGE[b.status]?.[1] || b.status}${b.startedAt ? ` · started ${when(b.startedAt)}` : b.scheduledAt ? ` · for ${when(b.scheduledAt)}` : ""}`;
    const note = b.error || (b.waitUntil ? `Meta's daily limit for this number is used up: the rest goes after ${when(b.waitUntil)}.` : b.status === "scheduled" ? `Goes at ${when(b.scheduledAt)}.` : "");
    $("bcViewNote").hidden = !note;
    $("bcViewNote").textContent = note;
    const steps = [["Recipients", s.total], ["Sent", s.sent], ["Delivered", s.delivered], ["Read", s.read], ["Replied", s.replied]];
    $("bcFunnel").innerHTML = `${steps.map(([label, n]) => `<div class="mk-step"><div class="n">${n.toLocaleString("en-IN")}</div><div class="l">${label}${label !== "Recipients" && s.sent ? ` · ${pct(n, label === "Sent" ? s.total : s.sent)}%` : ""}</div><div class="bar"><span style="width:${pct(n, s.total)}%"></span></div></div>`).join("")}
      <div class="mk-step muted"><div class="n">${s.failed + s.skipped}</div><div class="l">Failed ${s.failed} · skipped ${s.skipped}${s.pending ? ` · waiting ${s.pending}` : ""}</div></div>`;
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
      ? `<table><thead><tr><th>Customer</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>${people.map((p) => `
        <tr><td>${escapeHtml(p.name)}<div class="mk-sub">${escapeHtml(p.phone)}</div></td>
          <td>${badge(p.status)}${p.reason ? `<div class="mk-sub">${escapeHtml(p.reason)}</div>` : ""}</td>
          <td class="mk-sub">${escapeHtml(when(p.repliedAt || p.readAt || p.deliveredAt || p.sentAt || p.failedAt))}</td>
          <td>${p.conversationId ? `<a href="Inbox.html?c=${encodeURIComponent(p.conversationId)}">Chat</a>` : ""}</td></tr>`).join("")}</tbody></table>`
      : '<p class="mk-hint">Nobody here.</p>';
  }

  async function openResults(id) {
    clearTimeout(refreshTimer);
    try {
      renderResults(await crmApi(`/broadcasts/${id}`));
      $("bcPeopleFilter").value = "";
      $("bcViewOverlay").classList.add("open");
      await loadPeople();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't open the broadcast."), "error");
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
    if (action === "cancel" && !confirm("Cancel this broadcast? Customers it has not reached yet will not get it.")) return;
    try {
      renderResults(await crmApi(`/broadcasts/${viewing.id}/${action}`, { method: "POST" }));
      await loadPeople();
    } catch (error) {
      showToast(apiErrorMessage(error, "That did not work."), "error");
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
    if (f.tagsAll?.length) bits.push(`tags ${f.tagsAll.join(" + ")}`);
    if (f.tagsAny?.length) bits.push(`any of ${f.tagsAny.join(" / ")}`);
    if (f.tagsNone?.length) bits.push(`not ${f.tagsNone.join(" / ")}`);
    if (f.states?.length) bits.push(f.states.join(", "));
    if (f.cities?.length) bits.push(f.cities.join(", "));
    if (f.sources?.length) bits.push(`from ${f.sources.join(", ")}`);
    if (f.lifecycles?.length) bits.push(f.lifecycles.join(" or "));
    if (f.productCategories?.length) bits.push(`buys ${f.productCategories.join(", ")}`);
    if (f.leadStages?.length) bits.push(`lead at ${f.leadStages.join(" / ")}`);
    if (f.consent === "opted_in") bits.push("only who agreed");
    return bits.length ? bits : ["everyone"];
  }

  function renderSegments() {
    $("sgList").innerHTML = segments.length
      ? segments.map((s) => `
        <div class="mk-card" data-sg="${escapeHtml(s.id)}">
          <div class="mk-card-head"><strong>${escapeHtml(s.name)}</strong><span class="mk-count">${s.count.toLocaleString("en-IN")} customers</span></div>
          ${s.description ? `<div class="mk-sub">${escapeHtml(s.description)}</div>` : ""}
          <div class="mk-chips">${filterSummary(s.filters).map((b) => `<span class="badge badge-neutral">${escapeHtml(b)}</span>`).join("")}</div>
        </div>`).join("")
      : '<div class="empty-state"><i class="fa-solid fa-users-viewfinder"></i><p>No segments yet. For example "Tier A – Rajasthan": tag Tier A, state Rajasthan.</p></div>';
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
      $("sgPreview").innerHTML = `<div><strong>${p.total.toLocaleString("en-IN")}</strong> customers · ${p.withWhatsApp.toLocaleString("en-IN")} with a mobile number${p.optedOut ? ` · ${p.optedOut} left out (said no to offers)` : ""}</div>
        ${p.sample.length ? `<div class="mk-sub">${p.sample.map((c) => escapeHtml(`${c.name}${c.city ? ` (${c.city})` : ""}`)).join(", ")}${p.total > p.sample.length ? " …" : ""}</div>` : ""}`;
    } catch (error) {
      $("sgPreview").textContent = apiErrorMessage(error, "Couldn't count the customers.");
    }
  }
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 300);
  };

  function openSegment(s = null) {
    segmentId = s ? s.id : "";
    const f = s?.filters || {};
    $("sgTitle").textContent = s ? `Edit "${s.name}"` : "New segment";
    $("sgName").value = s?.name || "";
    $("sgDescription").value = s?.description || "";
    $("sgTagsAll").value = (f.tagsAll || []).join(", ");
    $("sgTagsAny").value = (f.tagsAny || []).join(", ");
    $("sgTagsNone").value = (f.tagsNone || []).join(", ");
    $("sgStates").value = (f.states || []).join(", ");
    $("sgCities").value = (f.cities || []).join(", ");
    $("sgCategories").value = (f.productCategories || []).join(", ");
    checks("sgLifecycles", [["customer", "Customers"], ["lead", "Leads"]], f.lifecycles);
    checks("sgSources", SOURCES.map((x) => [x, x]), f.sources);
    checks("sgStages", LEAD_STAGES.map((x) => [x, x]), f.leadStages);
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
      showToast("Give the segment a name.", "error");
      $("sgName").focus();
      return;
    }
    try {
      await crmApi(segmentId ? `/segments/${segmentId}` : "/segments", jsonRequest(segmentId ? "PATCH" : "POST", body));
      closeSegment();
      showToast("Segment saved", "success");
      await load({ force: true });
      renderSegments();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't save the segment."), "error");
    }
  });
  $("sgDeleteBtn").addEventListener("click", async () => {
    if (!segmentId || !confirm("Delete this segment? Broadcasts already sent keep their results.")) return;
    try {
      await crmApi(`/segments/${segmentId}`, { method: "DELETE" });
      closeSegment();
      await load({ force: true });
      renderSegments();
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't delete the segment."), "error");
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
})();
