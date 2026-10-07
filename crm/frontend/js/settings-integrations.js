/**
 * settings-integrations.js — Settings → API & webhooks (Phase 10C, owners and admins)
 * The public API's keys (made with ticked permissions, shown once, revoked), the outbound
 * webhooks (address, events, test, delivery log with retry, new secret, on/off, remove) and the
 * Meta Conversions API (dataset, token checked with Meta, stages, test event, counts).
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
    box.innerHTML = `<input type="text" readonly value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}" /><button class="btn btn-primary" type="button" data-copy="${escapeHtml(value)}"><i class="fa-regular fa-copy"></i> Copy</button>`;
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
      showToast("Copied.", "success");
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
        <thead><tr><th>Name</th><th>Key</th><th>Permissions</th><th>Last used</th><th></th></tr></thead>
        <tbody>${items.map((k) => `<tr${k.revokedAt ? ' style="opacity: 0.55"' : ""}>
          <td>${escapeHtml(k.name)}<div class="settings-hint" style="margin: 0">by ${escapeHtml(k.createdBy || "—")}, ${escapeHtml(when(k.createdAt))}</div></td>
          <td><code>${escapeHtml(k.preview)}</code></td>
          <td>${k.scopes.map((s) => `<span class="badge badge-neutral" style="margin: 1px">${escapeHtml(s)}</span>`).join(" ")}</td>
          <td>${k.revokedAt ? `Revoked ${escapeHtml(when(k.revokedAt))}` : escapeHtml(when(k.lastUsedAt) || "Never")}</td>
          <td>${k.revokedAt ? "" : `<button class="btn btn-danger-outline" type="button" data-revoke="${escapeHtml(k.id)}" data-name="${escapeHtml(k.name)}">Revoke</button>`}</td>
        </tr>`).join("")}</tbody>
      </table></div>` : '<p class="settings-hint">No API keys yet.</p>';
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
      ? (h.lastStatus === "failed" ? '<span class="badge badge-warning">Failing</span>' : '<span class="badge badge-success">On</span>')
      : '<span class="badge badge-danger">Off</span>';
    return `
      <div class="pay-gateway" data-hook="${escapeHtml(h.id)}">
        <div class="pay-gateway-top"><strong style="word-break: break-all">${escapeHtml(h.url)}</strong><span>${status}</span></div>
        ${h.description ? `<div class="pay-gateway-meta">${escapeHtml(h.description)}</div>` : ""}
        <div class="pay-gateway-meta">${h.events.map((e) => `<span class="badge badge-neutral" style="margin: 1px">${escapeHtml(e)}</span>`).join(" ")}</div>
        ${h.disabledReason ? `<div class="pay-gateway-meta">${escapeHtml(h.disabledReason)}</div>` : ""}
        <div class="pay-gateway-meta">${h.lastDeliveryAt ? `Last call ${escapeHtml(when(h.lastDeliveryAt))}: ${h.lastStatus === "delivered" ? "delivered" : "failed"}${h.lastResponseCode ? ` (${h.lastResponseCode})` : ""}` : "Nothing sent yet."}</div>
        <div class="pl-buttons">
          <button class="btn btn-outline" type="button" data-act="test"><i class="fa-solid fa-paper-plane"></i> Send a test</button>
          <button class="btn btn-outline" type="button" data-act="log">Delivery log</button>
          <button class="btn btn-outline" type="button" data-act="edit">Change</button>
          <button class="btn btn-outline" type="button" data-act="secret">New secret</button>
          <button class="btn btn-outline" type="button" data-act="toggle">${h.active ? "Switch off" : "Switch on"}</button>
          <button class="btn btn-danger-outline" type="button" data-act="remove">Remove</button>
        </div>
        <div data-log hidden></div>
      </div>`;
  }

  async function loadHooks() {
    const data = await crmApi("/outbound-webhooks");
    hooks = data.items;
    events = data.events;
    $("intHooks").innerHTML = hooks.length ? hooks.map(hookCard).join("") : '<p class="settings-hint">No webhooks yet.</p>';
  }

  function eventBoxes(selected = []) {
    $("intHookEvents").innerHTML = events.map((e) => `<label class="ls-check" title="${escapeHtml(e.label)}"><input type="checkbox" value="${escapeHtml(e.event)}" ${selected.includes(e.event) ? "checked" : ""} /> ${escapeHtml(e.event)}</label>`).join("")
      + '<p class="settings-hint" style="margin: 4px 0 0">lead.created · lead.stage_changed · contact.created · message.received (a customer writes on WhatsApp) · quotation.status_changed · order.created · order.stage_changed · payment.received</p>';
  }

  function openHookForm(hook) {
    editing = hook || null;
    $("intHookFormTitle").textContent = hook ? "Change the webhook" : "Add a webhook";
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
        <thead><tr><th>When</th><th>Event</th><th>Result</th><th>Tries</th><th></th></tr></thead>
        <tbody>${items.map((d) => `<tr>
          <td>${escapeHtml(when(d.createdAt))}</td><td>${escapeHtml(d.event)}</td>
          <td>${d.status === "delivered" ? `<span class="badge badge-success">Delivered</span> ${d.responseCode || ""}` : d.status === "pending" ? `<span class="badge badge-info">Trying again ${escapeHtml(when(d.nextAttemptAt))}</span>` : `<span class="badge badge-danger">${escapeHtml(d.status === "cancelled" ? "Cancelled" : "Failed")}</span> ${escapeHtml(d.error || d.responseCode || "")}`}</td>
          <td>${d.attempts}</td>
          <td>${["failed", "cancelled"].includes(d.status) ? `<button class="btn btn-outline" type="button" data-retry="${escapeHtml(d.id)}">Send again</button>` : ""}</td>
        </tr>`).join("")}</tbody></table></div>` : '<p class="settings-hint" style="margin-top: 10px">Nothing sent in the last 30 days.</p>';
    box.hidden = false;
  }

  // --- Meta Conversions API ------------------------------------------------------------------------
  function renderCapi() {
    const c = capi;
    const off = !c.available;
    $("intCapiForm").querySelectorAll("input, button[type=submit]").forEach((el) => { el.disabled = off; });
    $("intCapiStages").innerHTML = c.stagesAvailable.map((stage) => `<label class="ls-check"><input type="checkbox" value="${escapeHtml(stage)}" ${(c.stages || c.stagesAvailable).includes(stage) ? "checked" : ""} ${off ? "disabled" : ""} /> ${escapeHtml(stage)}</label>`).join("");
    $("intCapiDataset").value = c.datasetId || "";
    $("intCapiToken").value = "";
    $("intCapiToken").placeholder = c.connected ? `•••• ${c.accessToken.last4} (leave empty to keep)` : "";
    $("intCapiTest").value = c.testEventCode || "";
    $("intCapiEnabled").checked = c.connected ? c.enabled : true;
    $("intCapiAll").checked = Boolean(c.allSources);
    $("intCapiRemove").hidden = !c.connected;
    $("intCapiTestBtn").hidden = !c.connected;
    const s = c.stats;
    $("intCapiStatus").innerHTML = off
      ? 'The Conversions API comes with the Pro plan and above. <a href="Settings.html?tab=plan">See plans</a>'
      : c.connected
        ? `<span class="badge ${c.enabled ? "badge-success" : "badge-neutral"}">${c.enabled ? "On" : "Off"}</span> ${escapeHtml(c.datasetName || c.datasetId)}${c.testEventCode ? ' · <span class="badge badge-warning">Test mode: events go to Test events only</span>' : ""}<br>Sent ${s.sent}, skipped ${s.skipped}, failed ${s.failed}${s.lastSentAt ? ` · last sent ${escapeHtml(when(s.lastSentAt))}` : ""}${s.lastError ? `<br>Last problem (${escapeHtml(when(s.lastErrorAt))}): ${escapeHtml(s.lastError)}` : ""}`
        : "Not connected.";
  }

  async function loadCapi() {
    capi = await crmApi("/meta-conversions");
    renderCapi();
  }

  async function load() {
    $("intApiBase").textContent = `${CRM_API_BASE.replace(/\/api\/v1$/, "")}/api/public/v1`;
    try {
      const { plan, subscription } = await crmPlan.state();
      const note = $("intPlanNote");
      if (!plan.features.api || subscription.locked) {
        note.innerHTML = `${subscription.locked ? "Your plan is not active, so API keys and webhooks are paused." : `API keys and webhooks come with the Growth plan and above (you are on ${escapeHtml(plan.name)}).`} <a href="Settings.html?tab=plan">See plans</a>`;
        note.hidden = false;
      }
    } catch {
      /* the server still checks */
    }
    await Promise.all([
      loadKeys().catch((error) => { $("intKeys").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, "Could not load the keys."))}</p>`; }),
      loadHooks().catch((error) => { $("intHooks").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, "Could not load the webhooks."))}</p>`; }),
      loadCapi().catch((error) => { $("intCapiStatus").textContent = apiErrorMessage(error, "Could not load the Conversions API."); }),
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
      reveal($("intNewKey"), "API key", made.key);
      $("intKeyForm").hidden = true;
      $("intKeyAddBtn").hidden = false;
      $("intKeyName").value = "";
      await loadKeys();
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not make the key."), "error");
    }
  });
  $("intKeys").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-revoke]");
    if (!button || !confirm(`Revoke the key "${button.dataset.name}"? Anything using it stops working at once.`)) return;
    try {
      await crmApi(`/api-keys/${encodeURIComponent(button.dataset.revoke)}`, { method: "DELETE" });
      showToast("Key revoked.", "success");
      await loadKeys();
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not revoke the key."), "error");
    }
  });
  [$("intNewKey"), $("intNewSecret")].forEach((box) => box.addEventListener("click", copyFrom));

  $("intHookAddBtn").addEventListener("click", () => openHookForm(null));
  $("intHookCancel").addEventListener("click", closeHookForm);
  $("intHookForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = { url: $("intHookUrl").value.trim(), description: $("intHookDesc").value.trim(), events: [...$("intHookEvents").querySelectorAll("input:checked")].map((input) => input.value) };
    $("intHookSave").disabled = true;
    try {
      if (editing) {
        await crmApi(`/outbound-webhooks/${encodeURIComponent(editing.id)}`, json("PATCH", body));
        showToast("Webhook saved.", "success");
      } else {
        const made = await crmApi("/outbound-webhooks", json("POST", body));
        reveal($("intNewSecret"), "webhook secret", made.secret);
      }
      closeHookForm();
      await loadHooks();
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not save the webhook."), "error");
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
        showToast("Sending again.", "success");
        card.querySelector("[data-log]").hidden = true;
        setTimeout(() => showLog(card, hook).catch(() => {}), 1500);
      } catch (error) {
        showToast(apiErrorMessage(error, "Could not send it again."), "error");
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
          showToast(result.status === "delivered" ? `Delivered (${result.responseCode}).` : `Not delivered: ${result.error || result.responseCode}.`, result.status === "delivered" ? "success" : "error");
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
          if (!confirm("Make a new secret? The old one stops working at once; put the new one in your system.")) return;
          const made = await crmApi(`${path}/rotate-secret`, { method: "POST" });
          reveal($("intNewSecret"), "webhook secret", made.secret);
          break;
        }
        case "toggle":
          await crmApi(path, json("PATCH", { active: !hook.active }));
          await loadHooks();
          break;
        case "remove":
          if (!confirm(`Remove the webhook to ${hook.url}?`)) return;
          await crmApi(path, { method: "DELETE" });
          showToast("Webhook removed.", "success");
          await loadHooks();
          break;
        default:
      }
    } catch (error) {
      showToast(apiErrorMessage(error, "That did not work."), "error");
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
      stages: [...$("intCapiStages").querySelectorAll("input:checked")].map((input) => input.value),
    };
    const token = $("intCapiToken").value.trim();
    if (token) body.accessToken = token;
    try {
      capi = await crmApi("/meta-conversions", json("PUT", body));
      renderCapi();
      showToast("Conversions API saved.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not save."), "error");
    }
  });
  $("intCapiTestBtn").addEventListener("click", async () => {
    try {
      const result = await crmApi("/meta-conversions/test", { method: "POST" });
      showToast(result.message, "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "The test did not go through."), "error");
    }
  });
  $("intCapiRemove").addEventListener("click", async () => {
    if (!confirm("Remove the Conversions API? Lead stages stop going to Meta.")) return;
    try {
      await crmApi("/meta-conversions", { method: "DELETE" });
      await loadCapi();
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not remove it."), "error");
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
