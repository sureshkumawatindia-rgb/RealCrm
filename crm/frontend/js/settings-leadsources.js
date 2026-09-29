/**
 * settings-leadsources.js — Settings → Lead sources (owners and admins)
 * Website enquiry forms (/lead-sources): embed code, options, a live preview, what arrived and
 * what became of it; in development a test lead. IndiaMART, Facebook and others follow.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsLeadSources() {
  if (!isOrgManager()) return;
  document.getElementById("leadSourcesTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const TYPE_ICON = { website: "fa-globe", indiamart: "fa-store", facebook: "fa-brands fa-facebook", googleads: "fa-brands fa-google", justdial: "fa-phone", tradeindia: "fa-industry" };
  const OUTCOME = {
    created: ["badge-success", "new lead"],
    attached: ["badge-info", "added to open lead"],
    duplicate: ["badge-neutral", "already received"],
    rejected: ["badge-danger", "refused"],
    failed: ["badge-danger", "failed"],
    processing: ["badge-warning", "in progress"],
  };
  let sources = [];
  const openLogs = new Set();

  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const embedCode = (s) => `<div data-yellow-crm-form="${s.form.publicKey}"></div>\n<script src="${s.form.embedUrl}" async></script>`;
  const htmlCode = (s) =>
    `<form action="${s.form.submitUrl}" method="post">\n  <input name="name" placeholder="Your name" required>\n  <input name="phone" type="tel" placeholder="Mobile number" required>\n  <textarea name="message" placeholder="Your requirement"></textarea>\n  <input name="website_url" style="display:none" tabindex="-1" autocomplete="off">\n  <button type="submit">Send</button>\n</form>`;

  function statsLine(stats = {}) {
    return `${stats.received || 0} received · ${stats.created || 0} new leads · ${stats.attached || 0} added to open leads · ${stats.duplicate || 0} repeats · ${stats.rejected || 0} refused`;
  }

  function websiteHtml(s) {
    const set = s.settings;
    const ask = set.askFor || {};
    const check = (key, label) => `<label class="ls-check"><input type="checkbox" data-ask="${key}" ${ask[key] ? "checked" : ""} /> ${label}</label>`;
    return `
      <div class="sub" style="margin-top:10px"><strong>Put this on your website</strong> where the form should appear:</div>
      <div style="display:flex;gap:8px;align-items:flex-start;margin-top:6px">
        <textarea class="ls-code" readonly rows="2">${escapeHtml(embedCode(s))}</textarea>
        <button class="btn btn-outline" type="button" data-ls-copy="${escapeHtml(s.id)}" title="Copy the code"><i class="fa-solid fa-copy"></i></button>
      </div>
      <details style="margin-top:6px"><summary class="sub" style="cursor:pointer">Website without JavaScript? Use a plain HTML form</summary>
        <textarea class="ls-code" readonly rows="7" style="margin-top:6px">${escapeHtml(htmlCode(s))}</textarea>
      </details>
      <details style="margin-top:10px" data-ls-options="${escapeHtml(s.id)}"><summary class="sub" style="cursor:pointer"><strong>Form options</strong></summary>
        <div class="field-row" style="margin-top:10px">
          <div class="field"><label>Title</label><input type="text" data-opt="title" maxlength="120" value="${escapeHtml(set.title)}" /></div>
          <div class="field"><label>Button</label><input type="text" data-opt="buttonText" maxlength="40" value="${escapeHtml(set.buttonText)}" /></div>
        </div>
        <div class="field"><label>Thank-you message</label><input type="text" data-opt="successMessage" maxlength="300" value="${escapeHtml(set.successMessage)}" /></div>
        <div class="field"><label>Also ask for</label><div>${check("email", "Email")}${check("company", "Company")}${check("city", "City")}${check("product", "Product")}${check("message", "Requirement")}</div></div>
        <div class="field"><label>Only on these websites (optional, one per line)</label><textarea data-opt="allowedOrigins" rows="2" placeholder="https://www.yourshop.in">${escapeHtml((set.allowedOrigins || []).join("\n"))}</textarea></div>
        <div class="field"><label>After a plain HTML form, go to (optional)</label><input type="url" data-opt="redirectUrl" maxlength="500" placeholder="https://www.yourshop.in/thank-you" value="${escapeHtml(set.redirectUrl)}" /></div>
        <div class="data-actions" style="justify-content:flex-end"><button class="btn btn-primary" type="button" data-ls-save="${escapeHtml(s.id)}">Save options</button></div>
      </details>
      <details style="margin-top:10px" data-ls-preview="${escapeHtml(s.id)}"><summary class="sub" style="cursor:pointer"><strong>Preview</strong> (sending it creates a real enquiry)</summary>
        <div class="ls-preview"></div>
      </details>`;
  }

  // --- IndiaMART ---
  const IM_TYPES = { W: "Direct enquiries", B: "Buy-leads", P: "Phone calls (PNS)", WA: "WhatsApp enquiries", BIZ: "Catalogue views" };
  const IM_DEFAULT = ["W", "B", "P", "WA"];
  const typeBoxes = (selected, attr) =>
    Object.entries(IM_TYPES)
      .map(([code, label]) => `<label class="ls-check"><input type="checkbox" ${attr}="${code}" ${selected.includes(code) ? "checked" : ""} /> ${label}</label>`)
      .join("");
  // IndiaMART can only push to a public HTTPS address.
  const isLocal = (url) => !/^https:\/\//.test(url) || /\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);

  function indiamartHtml(s) {
    const pushHint = isLocal(s.pushUrl)
      ? `<div class="sub" style="margin-top:4px">IndiaMART can only push to a public <strong>https</strong> address. On a server with HTTPS (or through a tunnel while testing) the address becomes <strong>https://&lt;your address&gt;${escapeHtml(new URL(s.pushUrl).pathname)}</strong>. Pulling every 5 minutes works without it.</div>`
      : "";
    return `
      <div class="sub" style="margin-top:8px">${s.lastPulledUntil ? `Leads pulled up to ${escapeHtml(when(s.lastPulledUntil))}. ` : "The first pull brings the last 24 hours. "}The CRM pulls again every 5 minutes.</div>
      <div class="sub" style="margin-top:10px"><strong>Instant leads (optional):</strong> in IndiaMART Lead Manager → Import/Export Leads → <strong>Push API</strong>, enter this address:</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px;min-width:0">
        <code style="word-break:break-all;font-size:12px;flex:1">${escapeHtml(s.pushUrl)}</code>
        <button class="btn btn-outline" type="button" data-ls-copy-push="${escapeHtml(s.id)}" title="Copy the address"><i class="fa-solid fa-copy"></i></button>
      </div>
      ${pushHint}
      <details style="margin-top:10px"><summary class="sub" style="cursor:pointer"><strong>Kinds of leads to take</strong></summary>
        <div style="margin-top:8px">${typeBoxes(s.settings.queryTypes || IM_DEFAULT, "data-im-type")}</div>
        <div class="data-actions" style="justify-content:flex-end;margin-top:8px"><button class="btn btn-primary" type="button" data-im-save="${escapeHtml(s.id)}">Save</button></div>
      </details>`;
  }

  function sourceHtml(s) {
    const paused = s.status !== "active";
    return `
      <div class="settings-summary-row" style="align-items:flex-start;flex-wrap:wrap" data-ls-id="${escapeHtml(s.id)}">
        <div class="info" style="min-width:0;flex:1">
          <div class="name"><i class="fa-solid ${TYPE_ICON[s.type] || "fa-inbox"}"></i> ${escapeHtml(s.name || s.source)}
            <span class="badge badge-neutral">${escapeHtml(s.source)}</span>
            ${s.status === "error" ? '<span class="badge badge-danger">Needs attention</span>' : paused ? '<span class="badge badge-warning">Paused</span>' : '<span class="badge badge-success">Active</span>'}
            ${s.credentials.configured ? `<span class="sub">key …${escapeHtml(s.credentials.hint)}</span>` : ""}</div>
          <div class="sub">${escapeHtml(statsLine(s.stats))}${s.lastLeadAt ? ` · last lead ${escapeHtml(when(s.lastLeadAt))}` : ""}</div>
          ${s.statusMessage ? `<div class="sub" style="color:var(--danger)">${escapeHtml(s.statusMessage)}</div>` : s.lastError ? `<div class="sub" style="color:var(--danger)">${escapeHtml(s.lastError)}</div>` : ""}
          <div class="ls-actions">
            ${s.type === "indiamart" ? `<button class="btn btn-outline" type="button" data-ls-pull="${escapeHtml(s.id)}"><i class="fa-solid fa-rotate"></i> Pull now</button><button class="btn btn-outline" type="button" data-ls-key="${escapeHtml(s.id)}"><i class="fa-solid fa-key"></i> New key</button>` : ""}
            <button class="btn btn-outline" type="button" data-ls-log-toggle="${escapeHtml(s.id)}"><i class="fa-solid fa-list"></i> Recent</button>
            <button class="btn btn-outline" type="button" data-ls-status="${escapeHtml(s.id)}">${paused ? "Resume" : "Pause"}</button>
            <button class="icon-btn danger" type="button" data-ls-remove="${escapeHtml(s.id)}" title="Remove"><i class="fa-solid fa-trash"></i></button>
          </div>
          <div class="ls-log" data-ls-log="${escapeHtml(s.id)}" hidden></div>
          ${s.type === "website" ? websiteHtml(s) : ""}
          ${s.type === "indiamart" ? indiamartHtml(s) : ""}
        </div>
      </div>`;
  }

  function render() {
    $("lsCount").textContent = sources.length ? `${sources.length} source${sources.length === 1 ? "" : "s"}` : "";
    $("lsList").innerHTML = sources.length ? sources.map(sourceHtml).join("") : '<p class="settings-hint" style="margin:0">No lead source yet. Start with a form for your website.</p>';
    openLogs.forEach((id) => showLog(id));
  }

  async function load() {
    try {
      sources = await crmApi("/lead-sources");
      render();
    } catch (error) {
      $("lsList").innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, "Couldn't load the lead sources."))}</p>`;
    }
  }

  async function showLog(id) {
    const box = document.querySelector(`[data-ls-log="${CSS.escape(id)}"]`);
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<p class="sub">Loading…</p>';
    try {
      const items = await crmApi(`/lead-sources/${id}/intakes?limit=15`);
      box.innerHTML = items.length
        ? items
            .map((i) => {
              const [badge, label] = OUTCOME[i.outcome] || ["badge-neutral", i.outcome];
              return `<div class="ls-log-row"><span class="sub">${escapeHtml(when(i.receivedAt))}</span> <span class="badge ${badge}">${escapeHtml(label)}</span> ${escapeHtml(i.summary || "")}${i.reason ? ` <span style="color:var(--danger)">(${escapeHtml(i.reason)})</span>` : ""}</div>`;
            })
            .join("")
        : '<p class="sub">Nothing received yet.</p>';
    } catch (error) {
      box.innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, "Couldn't load the enquiries."))}</p>`;
    }
  }

  function showPreview(details, source) {
    const area = details.querySelector(".ls-preview");
    if (area.childElementCount) return;
    const mount = document.createElement("div");
    mount.setAttribute("data-yellow-crm-form", source.form.publicKey);
    const script = document.createElement("script");
    script.src = `${source.form.embedUrl}?preview=${Date.now()}`;
    script.async = true;
    area.append(mount, script);
  }

  function readOptions(row) {
    const value = (key) => row.querySelector(`[data-opt="${key}"]`).value.trim();
    const askFor = {};
    row.querySelectorAll("[data-ask]").forEach((box) => {
      askFor[box.dataset.ask] = box.checked;
    });
    return {
      title: value("title"),
      buttonText: value("buttonText"),
      successMessage: value("successMessage"),
      redirectUrl: value("redirectUrl"),
      allowedOrigins: value("allowedOrigins").split(/[\s,]+/).map((o) => o.replace(/\/+$/, "")).filter(Boolean),
      askFor,
    };
  }

  $("lsList").addEventListener("click", async (e) => {
    const target = (attr) => e.target.closest(`[${attr}]`);
    const copy = target("data-ls-copy");
    const logToggle = target("data-ls-log-toggle");
    const status = target("data-ls-status");
    const remove = target("data-ls-remove");
    const save = target("data-ls-save");
    const pull = target("data-ls-pull");
    const key = target("data-ls-key");
    const copyPush = target("data-ls-copy-push");
    const saveTypes = target("data-im-save");
    if (pull) {
      pull.disabled = true;
      try {
        const result = await crmApi(`/lead-sources/${pull.dataset.lsPull}/pull`, { method: "POST" });
        const o = result.outcomes || {};
        showToast(
          result.error === "KEY_REFUSED"
            ? "IndiaMART refused the key. Paste a new one."
            : `Pulled ${result.fetched || 0} lead${result.fetched === 1 ? "" : "s"}: ${o.created || 0} new, ${o.attached || 0} added to open leads, ${o.duplicate || 0} already here${o.skipped ? `, ${o.skipped} skipped` : ""}.`,
          result.error ? "error" : "success",
        );
      } catch (error) {
        showToast(apiErrorMessage(error, "Couldn't pull from IndiaMART."), "error");
      }
      await load();
      return;
    }
    if (key) {
      const value = (window.prompt("Paste the new IndiaMART CRM API key (it is stored encrypted):") || "").trim();
      if (!value) return;
      try {
        await crmApi(`/lead-sources/${key.dataset.lsKey}`, jsonRequest("PATCH", { apiKey: value }));
        showToast("Key saved. The next pull uses it.", "success");
      } catch (error) {
        showToast(apiErrorMessage(error, "Couldn't save the key."), "error");
      }
      await load();
      return;
    }
    if (copyPush) {
      const source = sources.find((s) => s.id === copyPush.dataset.lsCopyPush);
      try {
        await navigator.clipboard.writeText(source.pushUrl);
        showToast("Address copied.", "success");
      } catch {
        showToast("Copy failed — select the address and copy it by hand.", "error");
      }
      return;
    }
    if (saveTypes) {
      const row = saveTypes.closest("[data-ls-id]");
      const queryTypes = [...row.querySelectorAll("[data-im-type]:checked")].map((box) => box.dataset.imType);
      if (!queryTypes.length) {
        showToast("Choose at least one kind of lead.", "error");
        return;
      }
      try {
        await crmApi(`/lead-sources/${saveTypes.dataset.imSave}`, jsonRequest("PATCH", { settings: { queryTypes } }));
        showToast("Saved. The next pull takes these kinds of leads.", "success");
      } catch (error) {
        showToast(apiErrorMessage(error, "Couldn't save."), "error");
      }
      await load();
      return;
    }
    if (copy) {
      const source = sources.find((s) => s.id === copy.dataset.lsCopy);
      try {
        await navigator.clipboard.writeText(embedCode(source));
        showToast("Code copied. Paste it into your website.", "success");
      } catch {
        showToast("Copy failed — select the code and copy it by hand.", "error");
      }
    } else if (logToggle) {
      const id = logToggle.dataset.lsLogToggle;
      if (openLogs.has(id)) {
        openLogs.delete(id);
        document.querySelector(`[data-ls-log="${CSS.escape(id)}"]`).hidden = true;
      } else {
        // Fresh counters too (render() also reopens the log).
        openLogs.add(id);
        await load();
      }
    } else if (status) {
      const source = sources.find((s) => s.id === status.dataset.lsStatus);
      try {
        await crmApi(`/lead-sources/${source.id}`, jsonRequest("PATCH", { status: source.status === "active" ? "paused" : "active" }));
        showToast(source.status === "active" ? "Paused: enquiries are refused until you resume." : "Taking enquiries again.", "success");
      } catch (error) {
        showToast(apiErrorMessage(error, "That didn't work."), "error");
      }
      await load();
    } else if (remove) {
      if (!confirm("Remove this lead source? A website form stops working at once. Leads already received stay.")) return;
      try {
        await crmApi(`/lead-sources/${remove.dataset.lsRemove}`, { method: "DELETE" });
        showToast("Lead source removed.", "success");
      } catch (error) {
        showToast(apiErrorMessage(error, "Couldn't remove it."), "error");
      }
      await load();
    } else if (save) {
      const row = save.closest("[data-ls-id]");
      try {
        await crmApi(`/lead-sources/${save.dataset.lsSave}`, jsonRequest("PATCH", { settings: readOptions(row) }));
        showToast("Form options saved. Websites pick them up within 5 minutes.", "success");
        await load();
      } catch (error) {
        showToast(apiErrorMessage(error, "Couldn't save the options."), "error");
      }
    }
  });
  // The preview loads the real embed script the first time it is opened.
  $("lsList").addEventListener("toggle", (e) => {
    const details = e.target.closest?.("[data-ls-preview]");
    if (details && details.open) showPreview(details, sources.find((s) => s.id === details.dataset.lsPreview));
  }, true);

  $("lsAddWebsite").addEventListener("click", async () => {
    try {
      await crmApi("/lead-sources", jsonRequest("POST", { type: "website", name: "Website form" }));
      showToast("Website form ready. Copy its code into your website.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't add the form."), "error");
    }
    await load();
  });

  // Connect IndiaMART.
  $("lsImTypes").innerHTML = typeBoxes(IM_DEFAULT, "data-new-im-type");
  $("lsAddIndiamart").addEventListener("click", () => {
    $("lsIndiamartForm").hidden = false;
    $("lsImKey").focus();
  });
  $("lsImCancel").addEventListener("click", () => {
    $("lsIndiamartForm").hidden = true;
    $("lsImKey").value = "";
  });
  $("lsIndiamartForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const queryTypes = [...document.querySelectorAll("[data-new-im-type]:checked")].map((box) => box.dataset.newImType);
    try {
      await crmApi("/lead-sources", jsonRequest("POST", { type: "indiamart", name: $("lsImName").value.trim(), apiKey: $("lsImKey").value.trim(), settings: { queryTypes } }));
      showToast("IndiaMART connected. The first pull runs within a minute and brings the last 24 hours.", "success");
      $("lsImKey").value = "";
      $("lsIndiamartForm").hidden = true;
      // Show the first pull's result once it is in.
      setTimeout(load, 8000);
    } catch (error) {
      showToast(apiErrorMessage(error, "Couldn't connect IndiaMART."), "error");
    }
    await load();
  });

  $("lsSimulateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = (id) => $(id).value.trim();
    try {
      const result = await crmApi("/dev/simulate/lead", jsonRequest("POST", {
        source: value("lsSimSource"), name: value("lsSimName"), phone: value("lsSimPhone"), product: value("lsSimProduct"), message: value("lsSimMessage"),
      }));
      showToast(result.outcome === "attached" ? "Test enquiry added to the open lead of this number." : "Test lead received. See Leads.", "success");
      e.target.reset();
    } catch (error) {
      showToast(error.status === 404 ? "Test leads are turned off on this server." : apiErrorMessage(error, "Couldn't receive the test lead."), "error");
    }
    await load();
  });

  load();
})();
