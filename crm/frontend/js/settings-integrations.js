/**
 * settings-integrations.js — Settings → API & webhooks (Phase 10C, owners and admins)
 * The public API's keys (made with ticked permissions, shown once, revoked), the outbound
 * webhooks (address, events, test, delivery log with retry, new secret, on/off, remove) and the
 * Meta Conversions API (dataset, token checked with Meta, stages, test event, counts).
 * D78: each event's example payload, and "New secret" keeps the old one working for 24 hours.
 * The API and webhooks come with the Growth plan, the Conversions API with Pro; the server
 * checks it, this page says so.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsIntegrations() {
  if (!isOrgManager()) return leaveManagerTab("integrations");
  document.getElementById("integrationsTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
  let scopes = [];
  let events = [];
  let hooks = [];
  let editing = null; // the webhook being changed, or null for a new one
  let capi = null;
  let loaded = false;

  // A value shown once (a new key or secret), with Copy.
  function reveal(box, label, value) {
    box.innerHTML = `<input type="text" readonly value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}" /><button class="btn btn-primary" type="button" data-copy="${escapeHtml(value)}"><i class="fa-regular fa-copy"></i> ${escapeHtml(t("app.icon.copy"))}</button>`;
    box.hidden = false;
    box.insertAdjacentHTML("beforeend", `<p class="settings-hint" style="flex-basis: 100%; margin: 6px 0 0">Copy the ${escapeHtml(label)} now and keep it safe: it is not shown again.</p>`);
    box.style.flexWrap = "wrap";
    box.style.marginBottom = "10px";
  }

  async function copyFrom(event) {
    const button = event.target.closest("[data-copy]");
    if (!button) return false;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      showToast(t("wa.copied"), "success");
    } catch {
      button.previousElementSibling?.select();
    }
    return true;
  }

  // --- API keys ---------------------------------------------------------------------------------
  function renderKeys(items) {
    const active = items.filter((k) => !k.revokedAt);
    $("intKeys").innerHTML = items.length ? `
      <div style="overflow-x: auto"><table>
        <thead><tr><th>${escapeHtml(t("ap.name"))}</th><th>${escapeHtml(t("setint.key"))}</th><th>${escapeHtml(t("setint.permissions"))}</th><th>${escapeHtml(t("setint.last-used"))}</th><th></th></tr></thead>
        <tbody>${items.map((k) => `<tr${k.revokedAt ? ' style="opacity: 0.55"' : ""}>
          <td>${escapeHtml(k.name)}<div class="settings-hint" style="margin: 0">by ${escapeHtml(k.createdBy || "—")}, ${escapeHtml(when(k.createdAt))}</div></td>
          <td><code>${escapeHtml(k.preview)}</code></td>
          <td>${k.scopes.map((s) => `<span class="badge badge-neutral" style="margin: 1px">${escapeHtml(s)}</span>`).join(" ")}</td>
          <td>${k.revokedAt ? t("setint.revoked", { v: escapeHtml(when(k.revokedAt)) }) : escapeHtml(when(k.lastUsedAt) || t("setint.never"))}</td>
          <td>${k.revokedAt ? "" : `<button class="btn btn-danger-outline" type="button" data-revoke="${escapeHtml(k.id)}" data-name="${escapeHtml(k.name)}">${escapeHtml(t("setint.revoke"))}</button>`}</td>
        </tr>`).join("")}</tbody>
      </table></div>` : `<p class="settings-hint">${escapeHtml(t("setint.noKeys"))}</p>`;
    if (!active.length && items.length) $("intKeys").insertAdjacentHTML("beforeend", '<p class="settings-hint">All keys are revoked.</p>');
  }

  async function loadKeys() {
    const data = await crmApi("/api-keys");
    scopes = data.scopes;
    renderKeys(data.items);
    $("intKeyScopes").innerHTML = scopes.map((s) => `<label class="ls-check"><input type="checkbox" value="${escapeHtml(s.scope)}" ${s.scope.endsWith(":read") ? "checked" : ""} /> ${escapeHtml(s.label)}</label>`).join("");
  }

  // --- webhooks ---------------------------------------------------------------------------------
  function hookCard(h) {
    const status = h.active
      ? (h.lastStatus === "failed" ? `<span class="badge badge-warning">${escapeHtml(t("setint.failing"))}</span>` : `<span class="badge badge-success">${escapeHtml(t("setroute.on"))}</span>`)
      : `<span class="badge badge-danger">${escapeHtml(t("setint.off"))}</span>`;
    return `
      <div class="pay-gateway" data-hook="${escapeHtml(h.id)}">
        <div class="pay-gateway-top"><strong style="word-break: break-all">${escapeHtml(h.url)}</strong><span>${status}</span></div>
        ${h.description ? `<div class="pay-gateway-meta">${escapeHtml(h.description)}</div>` : ""}
        <div class="pay-gateway-meta">${h.events.map((e) => `<span class="badge badge-neutral" style="margin: 1px">${escapeHtml(e)}</span>`).join(" ")}</div>
        ${h.disabledReason ? `<div class="pay-gateway-meta">${escapeHtml(h.disabledReason)}</div>` : ""}
        ${h.overlapUntil ? `<div class="pay-gateway-meta int-overlap"><i class="fa-solid fa-key" aria-hidden="true"></i> ${escapeHtml(t("int.overlap", { time: when(h.overlapUntil) }))} <button class="btn btn-outline" type="button" data-act="endOverlap">${escapeHtml(t("int.endOverlap"))}</button></div>` : ""}
        <div class="pay-gateway-meta">${h.lastDeliveryAt ? t("setint.last-call", { v: escapeHtml(when(h.lastDeliveryAt)), v2: h.lastStatus === "delivered" ? "delivered" : "failed", v3: h.lastResponseCode ? ` (${h.lastResponseCode})` : "" }) : t("setint.nothing-sent-yet")}</div>
        <div class="pl-buttons">
          <button class="btn btn-outline" type="button" data-act="test"><i class="fa-solid fa-paper-plane"></i> ${escapeHtml(t("teams.test"))}</button>
          <button class="btn btn-outline" type="button" data-act="log">${escapeHtml(t("setint.delivery-log"))}</button>
          <button class="btn btn-outline" type="button" data-act="edit">${escapeHtml(t("inbox.tpl.change"))}</button>
          <button class="btn btn-outline" type="button" data-act="secret">${escapeHtml(t("setint.new-secret"))}</button>
          <button class="btn btn-outline" type="button" data-act="toggle">${h.active ? t("teams.switchOff") : t("teams.switchOn")}</button>
          <button class="btn btn-danger-outline" type="button" data-act="remove">${escapeHtml(t("app.icon.remove"))}</button>
        </div>
        <div data-log hidden></div>
      </div>`;
  }

  async function loadHooks() {
    const data = await crmApi("/outbound-webhooks");
    hooks = data.items;
    events = data.events;
    $("intHooks").innerHTML = hooks.length ? hooks.map(hookCard).join("") : `<p class="settings-hint">${escapeHtml(t("setint.noHooks"))}</p>`;
    renderExamples();
  }

  // What each event sends (D78): the whole call as your system receives it, with Copy.
  function renderExamples() {
    $("intHookExampleList").innerHTML = events
      .map((e) => {
        const text = JSON.stringify({ id: "evt_3f1c9a7d2b6e4a10c8f5d2e1", type: e.event, createdAt: "2026-10-21T06:15:00.000Z", data: e.example || {} }, null, 2);
        return `<details class="int-example"><summary><code>${escapeHtml(e.event)}</code> <small>${escapeHtml(e.label)}</small></summary>
          <pre>${escapeHtml(text)}</pre>
          <button class="btn btn-outline" type="button" data-copy="${escapeHtml(text)}"><i class="fa-regular fa-copy"></i> ${escapeHtml(t("int.ex.copy"))}</button></details>`;
      })
      .join("");
    $("intHookExamples").hidden = !events.length;
  }

  function eventBoxes(selected = []) {
    // Each event with what it means (D78: the list grows, so it is not written out by hand).
    $("intHookEvents").innerHTML = events.map((e) => `<label class="ls-check int-event"><input type="checkbox" value="${escapeHtml(e.event)}" ${selected.includes(e.event) ? "checked" : ""} /> <span><code>${escapeHtml(e.event)}</code><small>${escapeHtml(e.label)}</small></span></label>`).join("");
  }

  function openHookForm(hook) {
    editing = hook || null;
    $("intHookFormTitle").textContent = hook ? t("setint.change-the-webhook") : t("set.add-a-webhook");
    $("intHookUrl").value = hook?.url || "";
    $("intHookDesc").value = hook?.description || "";
    eventBoxes(hook?.events || ["lead.created"]);
    $("intHookForm").hidden = false;
    $("intHookAddBtn").hidden = true;
    $("intHookUrl").focus();
  }
  function closeHookForm() {
    editing = null;
    $("intHookForm").hidden = true;
    $("intHookAddBtn").hidden = false;
  }

  async function showLog(card, hook) {
    const box = card.querySelector("[data-log]");
    if (!box.hidden) {
      box.hidden = true;
      return;
    }
    const items = await crmApi(`/outbound-webhooks/${encodeURIComponent(hook.id)}/deliveries?limit=20`);
    box.innerHTML = items.length ? `<div style="overflow-x: auto; margin-top: 10px"><table>
        <thead><tr><th>${escapeHtml(t("inbox.later.when"))}</th><th>${escapeHtml(t("dash.add.event"))}</th><th>${escapeHtml(t("setint.result"))}</th><th>${escapeHtml(t("setint.tries"))}</th><th></th></tr></thead>
        <tbody>${items.map((d) => `<tr>
          <td>${escapeHtml(when(d.createdAt))}</td><td>${escapeHtml(d.event)}</td>
          <td>${d.status === "delivered" ? `<span class="badge badge-success">${escapeHtml(t("inbox.tick.delivered"))}</span> ${d.responseCode || ""}` : d.status === "pending" ? `<span class="badge badge-info">${escapeHtml(t("setint.tryingAgain", { when: when(d.nextAttemptAt) }))}</span>` : `<span class="badge badge-danger">${escapeHtml(t(d.status === "cancelled" ? "setplan.st.cancelled" : "call.status.failed"))}</span> ${escapeHtml(d.error || d.responseCode || "")}`}</td>
          <td>${d.attempts}</td>
          <td>${["failed", "cancelled"].includes(d.status) ? `<button class="btn btn-outline" type="button" data-retry="${escapeHtml(d.id)}">${escapeHtml(t("setint.send-again"))}</button>` : ""}</td>
        </tr>`).join("")}</tbody></table></div>` : `<p class="settings-hint" style="margin-top: 10px">${escapeHtml(t("setint.nothingSent"))}</p>`;
    box.hidden = false;
  }

  // --- Meta Conversions API ------------------------------------------------------------------------
  function renderCapi() {
    const c = capi;
    const off = !c.available;
    $("intCapiForm").querySelectorAll("input, button[type=submit]").forEach((el) => { el.disabled = off; });
    $("intCapiStages").innerHTML = c.stagesAvailable.map((stage) => `<label class="ls-check"><input type="checkbox" value="${escapeHtml(stage)}" ${(c.stages || c.stagesAvailable).includes(stage) ? "checked" : ""} ${off ? "disabled" : ""} /> ${escapeHtml(crmLabel("stage", stage))}</label>`).join("");
    $("intCapiDataset").value = c.datasetId || "";
    $("intCapiToken").value = "";
    $("intCapiToken").placeholder = c.connected ? t("setint.leave-empty-to-keep", { last4: c.accessToken.last4 }) : "";
    $("intCapiTest").value = c.testEventCode || "";
    $("intCapiEnabled").checked = c.connected ? c.enabled : true;
    $("intCapiAll").checked = Boolean(c.allSources);
    // D102: Click-to-WhatsApp ad leads.
    $("intCapiCtwa").checked = Boolean(c.ctwa?.enabled);
    $("intCapiCtwaDataset").value = c.ctwa?.datasetId || "";
    $("intCapiCtwaFind").hidden = !c.connected;
    $("intCapiRemove").hidden = !c.connected;
    $("intCapiTestBtn").hidden = !c.connected;
    const s = c.stats;
    $("intCapiStatus").innerHTML = off
      ? 'The Conversions API comes with the Pro plan and above. <a href="Settings.html?tab=plan">See plans</a>'
      : c.connected
        ? `<span class="badge ${c.enabled ? "badge-success" : "badge-neutral"}">${escapeHtml(t(c.enabled ? "setroute.on" : "setint.off"))}</span> ${escapeHtml(c.datasetName || c.datasetId)}${c.testEventCode ? ` · <span class="badge badge-warning">${escapeHtml(t("setint.testMode"))}</span>` : ""}<br>${escapeHtml(t("setint.capiStats", { sent: s.sent, skipped: s.skipped, failed: s.failed }))}${s.lastSentAt ? escapeHtml(t("setint.lastSent", { when: when(s.lastSentAt) })) : ""}${s.lastError ? `<br>${escapeHtml(t("setint.lastProblem", { when: when(s.lastErrorAt), error: s.lastError }))}` : ""}`
        : t("smsset.notConnected");
  }

  async function loadCapi() {
    capi = await crmApi("/meta-conversions");
    renderCapi();
  }

  // --- Excel and Power BI (D82): one web address per table, read with an API key ------------------
  const FEEDS = [["contacts", "contacts:read"], ["leads", "leads:read"], ["quotations", "quotations:read"], ["orders", "orders:read"], ["products", "products:read"]];
  function renderFeeds(base) {
    const steps = (key) => [1, 2, 3].map((n) => `<li>${escapeHtml(t(`xl.feed.${key}.${n}`))}</li>`).join("");
    $("intFeeds").innerHTML = `
      <p class="settings-hint">${escapeHtml(t("xl.feed.hint"))}</p>
      ${FEEDS.map(([table, scope]) => {
        const url = `${base}/feeds/${table}?format=csv`;
        return `<div class="int-feed"><div class="int-feed-name"><strong>${escapeHtml(t(`xl.feed.table.${table}`))}</strong> <span class="settings-hint">${escapeHtml(t("xl.feed.needs", { scope }))}</span></div>
          <div class="pl-url"><input type="text" readonly value="${escapeHtml(url)}" aria-label="${escapeHtml(t(`xl.feed.table.${table}`))}" /><button class="btn btn-outline" type="button" data-copy="${escapeHtml(url)}"><i class="fa-regular fa-copy"></i> ${escapeHtml(t("int.ex.copy"))}</button></div></div>`;
      }).join("")}
      <div class="int-feed-steps">
        <div><strong>Excel</strong><ol>${steps("excel")}</ol></div>
        <div><strong translate="no">Power BI</strong><ol>${steps("pbi")}</ol></div>
      </div>
      <p class="settings-hint">${escapeHtml(t("xl.feed.more"))}</p>`;
  }

  async function load() {
    $("intApiBase").textContent = `${CRM_API_BASE.replace(/\/api\/v1$/, "")}/api/public/v1`;
    await crmI18n.ready;
    renderFeeds($("intApiBase").textContent);
    try {
      const { plan, subscription } = await crmPlan.state();
      const note = $("intPlanNote");
      if (!plan.features.api || subscription.locked) {
        note.innerHTML = `${escapeHtml(subscription.locked ? t("setint.planLocked") : t("setint.needsGrowth", { name: plan.name }))} <a href="Settings.html?tab=plan">${escapeHtml(t("setint.seePlans"))}</a>`;
        note.hidden = false;
      }
    } catch {
      /* the server still checks */
    }
    await Promise.all([
      loadKeys().catch((error) => { $("intKeys").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("setint.could-not-load-the-keys")))}</p>`; }),
      loadHooks().catch((error) => { $("intHooks").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("setint.could-not-load-the-webhooks")))}</p>`; }),
      loadCapi().catch((error) => { $("intCapiStatus").textContent = apiErrorMessage(error, t("setint.could-not-load-the-conversions-api")); }),
    ]);
  }

  // --- events -----------------------------------------------------------------------------------
  $("intKeyAddBtn").addEventListener("click", () => {
    $("intKeyForm").hidden = false;
    $("intKeyAddBtn").hidden = true;
    $("intKeyName").focus();
  });
  $("intKeyCancel").addEventListener("click", () => {
    $("intKeyForm").hidden = true;
    $("intKeyAddBtn").hidden = false;
  });
  $("intKeyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const picked = [...$("intKeyScopes").querySelectorAll("input:checked")].map((input) => input.value);
    try {
      const made = await crmApi("/api-keys", json("POST", { name: $("intKeyName").value.trim(), scopes: picked }));
      reveal($("intNewKey"), t("tel.key"), made.key);
      $("intKeyForm").hidden = true;
      $("intKeyAddBtn").hidden = false;
      $("intKeyName").value = "";
      await loadKeys();
    } catch (error) {
      showToast(apiErrorMessage(error, t("setint.could-not-make-the-key")), "error");
    }
  });
  $("intKeys").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-revoke]");
    if (!button || !confirm(t("setint.revoke-the-key-anything-using-it", { name: button.dataset.name }))) return;
    try {
      await crmApi(`/api-keys/${encodeURIComponent(button.dataset.revoke)}`, { method: "DELETE" });
      showToast(t("setint.key-revoked"), "success");
      await loadKeys();
    } catch (error) {
      showToast(apiErrorMessage(error, t("setint.could-not-revoke-the-key")), "error");
    }
  });
  [$("intNewKey"), $("intNewSecret"), $("intHookExampleList"), $("intFeeds")].forEach((box) => box.addEventListener("click", copyFrom));

  $("intHookAddBtn").addEventListener("click", () => openHookForm(null));
  $("intHookCancel").addEventListener("click", closeHookForm);
  $("intHookForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = { url: $("intHookUrl").value.trim(), description: $("intHookDesc").value.trim(), events: [...$("intHookEvents").querySelectorAll("input:checked")].map((input) => input.value) };
    $("intHookSave").disabled = true;
    try {
      if (editing) {
        await crmApi(`/outbound-webhooks/${encodeURIComponent(editing.id)}`, json("PATCH", body));
        showToast(t("setint.webhook-saved"), "success");
      } else {
        const made = await crmApi("/outbound-webhooks", json("POST", body));
        reveal($("intNewSecret"), t("setint.webhook-secret"), made.secret);
      }
      closeHookForm();
      await loadHooks();
    } catch (error) {
      showToast(apiErrorMessage(error, t("setint.could-not-save-the-webhook")), "error");
    } finally {
      $("intHookSave").disabled = false;
    }
  });
  $("intHooks").addEventListener("click", async (event) => {
    const retry = event.target.closest("[data-retry]");
    const card = event.target.closest("[data-hook]");
    if (!card) return;
    const hook = hooks.find((h) => h.id === card.dataset.hook);
    if (retry) {
      retry.disabled = true;
      try {
        await crmApi(`/outbound-webhooks/deliveries/${encodeURIComponent(retry.dataset.retry)}/retry`, { method: "POST" });
        showToast(t("setint.sending-again"), "success");
        card.querySelector("[data-log]").hidden = true;
        setTimeout(() => showLog(card, hook).catch(() => {}), 1500);
      } catch (error) {
        showToast(apiErrorMessage(error, t("setint.could-not-send-it-again")), "error");
      }
      return;
    }
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const path = `/outbound-webhooks/${encodeURIComponent(hook.id)}`;
    try {
      switch (button.dataset.act) {
        case "test": {
          button.disabled = true;
          const result = await crmApi(`${path}/test`, { method: "POST" });
          showToast(result.status === "delivered" ? t("setint.delivered", { responseCode: result.responseCode }) : t("setint.not-delivered", { v: result.error || result.responseCode }), result.status === "delivered" ? "success" : "error");
          await loadHooks();
          break;
        }
        case "log":
          await showLog(card, hook);
          break;
        case "edit":
          openHookForm(hook);
          break;
        case "secret": {
          // D78: the old secret keeps working for 24 hours, so nothing is lost while you update.
          if (!confirm(t("int.secret.confirm"))) return;
          const made = await crmApi(`${path}/rotate-secret`, json("POST", { overlapHours: 24 }));
          reveal($("intNewSecret"), t("setint.webhook-secret"), made.secret);
          await loadHooks();
          break;
        }
        case "endOverlap":
          if (!confirm(t("int.endOverlap.confirm"))) return;
          await crmApi(`${path}/end-overlap`, { method: "POST" });
          showToast(t("int.endOverlap.done"), "success");
          await loadHooks();
          break;
        case "toggle":
          await crmApi(path, json("PATCH", { active: !hook.active }));
          await loadHooks();
          break;
        case "remove":
          if (!confirm(t("setint.remove-the-webhook-to", { url: hook.url }))) return;
          await crmApi(path, { method: "DELETE" });
          showToast(t("setint.webhook-removed"), "success");
          await loadHooks();
          break;
        default:
      }
    } catch (error) {
      showToast(apiErrorMessage(error, t("dialer.failed")), "error");
    } finally {
      button.disabled = false;
    }
  });

  $("intCapiForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      datasetId: $("intCapiDataset").value.trim(),
      testEventCode: $("intCapiTest").value.trim(),
      enabled: $("intCapiEnabled").checked,
      allSources: $("intCapiAll").checked,
      ctwaEnabled: $("intCapiCtwa").checked,
      ctwaDatasetId: $("intCapiCtwaDataset").value.trim(),
      stages: [...$("intCapiStages").querySelectorAll("input:checked")].map((input) => input.value),
    };
    const token = $("intCapiToken").value.trim();
    if (token) body.accessToken = token;
    try {
      capi = await crmApi("/meta-conversions", json("PUT", body));
      renderCapi();
      showToast(t("setint.conversions-api-saved"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("setai.could-not-save")), "error");
    }
  });
  // D102: the dataset of the WhatsApp Business Account, read from Meta.
  $("intCapiCtwaFind").addEventListener("click", async () => {
    $("intCapiCtwaFind").disabled = true;
    try {
      const found = await crmApi("/meta-conversions/ctwa-dataset", { method: "POST" });
      $("intCapiCtwaDataset").value = found.datasetId;
      showToast(t("setint.found-dataset-press-check-and-save", { datasetId: found.datasetId }), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("setint.meta-did-not-give-the-dataset")), "error");
    } finally {
      $("intCapiCtwaFind").disabled = false;
    }
  });
  $("intCapiTestBtn").addEventListener("click", async () => {
    try {
      const result = await crmApi("/meta-conversions/test", { method: "POST" });
      showToast(result.message, "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("setint.the-test-did-not-go-through")), "error");
    }
  });
  $("intCapiRemove").addEventListener("click", async () => {
    if (!confirm(t("setint.remove-the-conversions-api-lead-stages"))) return;
    try {
      await crmApi("/meta-conversions", { method: "DELETE" });
      await loadCapi();
    } catch (error) {
      showToast(apiErrorMessage(error, t("setint.could-not-remove-it")), "error");
    }
  });

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    load();
  }
  document.querySelector('.settings-tab[data-panel="integrations"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="integrations"]').classList.contains("active")) loadOnce();
})();
