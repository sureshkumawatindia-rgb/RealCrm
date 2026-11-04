/**
 * settings-leadsources.js — Settings → Lead sources (owners and admins)
 * Website enquiry forms (/lead-sources): embed code, options, a live preview, what arrived and
 * what became of it; in development a test lead. IndiaMART, Facebook and others follow. D102: the
 * website's WhatsApp button (number, colour, corner, texts, a live preview drawn by the real
 * script, the code to copy).
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsLeadSources() {
  if (!isOrgManager()) return leaveManagerTab("leadsources");
  document.getElementById("leadSourcesTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const TYPE_ICON = { website: "fa-globe", indiamart: "fa-store", facebook: "fa-brands fa-facebook", googleads: "fa-brands fa-google", justdial: "fa-phone", tradeindia: "fa-industry", whatsapp_button: "fa-brands fa-whatsapp" };
  const OUTCOME = { // its badge and the key of its text
    created: ["badge-success", "setls.out.created"],
    attached: ["badge-info", "setls.out.attached"],
    duplicate: ["badge-neutral", "setls.out.duplicate"],
    rejected: ["badge-danger", "setls.out.rejected"],
    failed: ["badge-danger", "setls.out.failed"],
    processing: ["badge-warning", "setls.out.processing"],
  };
  let sources = [];
  let accounts = []; // the company's WhatsApp numbers, for the button (D102)
  const openLogs = new Set();

  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  // The names the CRM gives a new source ("Website form", "Website WhatsApp button") in the
  // person's language; a name someone typed stays as it is.
  const DEFAULT_NAMES = { "Website form": () => t("setls.websiteForm"), "Website WhatsApp button": () => crmLabel("source", "Website widget") };
  const sourceName = (s) => (Object.hasOwn(DEFAULT_NAMES, s.name) ? DEFAULT_NAMES[s.name]() : s.name || crmLabel("source", s.source));
  const embedCode = (s) => `<div data-yellow-crm-form="${s.form.publicKey}"></div>\n<script src="${s.form.embedUrl}" async></script>`;
  const htmlCode = (s) =>
    `<form action="${s.form.submitUrl}" method="post">\n  <input name="name" placeholder="Your name" required>\n  <input name="phone" type="tel" placeholder="Mobile number" required>\n  <textarea name="message" placeholder="Your requirement"></textarea>\n  <input name="website_url" style="display:none" tabindex="-1" autocomplete="off">\n  <button type="submit">Send</button>\n</form>`; // i18n-ok: code for the customer's own website, in its own words

  function statsLine(stats = {}, type = "") {
    if (type === "whatsapp_button") return t("setls.clicks-new-leads", { v: stats.received || 0, v2: stats.created || 0 });
    return t("setls.received-new-leads-added-to-open", { v: stats.received || 0, v2: stats.created || 0, v3: stats.attached || 0, v4: stats.duplicate || 0, v5: stats.rejected || 0 });
  }

  function websiteHtml(s) {
    const set = s.settings;
    const ask = set.askFor || {};
    const check = (key, label) => `<label class="ls-check"><input type="checkbox" data-ask="${key}" ${ask[key] ? "checked" : ""} /> ${label}</label>`;
    return `
      <div class="sub" style="margin-top:10px"><strong>${escapeHtml(t("setls.put-this-on-your-website"))}</strong> ${escapeHtml(t("setls.where-the-form-should-appear"))}</div>
      <div style="display:flex;gap:8px;align-items:flex-start;margin-top:6px">
        <textarea class="ls-code" readonly rows="2">${escapeHtml(embedCode(s))}</textarea>
        <button class="btn btn-outline" type="button" data-ls-copy="${escapeHtml(s.id)}" title="${escapeHtml(t("setls.copyCode"))}"><i class="fa-solid fa-copy"></i></button>
      </div>
      <details style="margin-top:6px"><summary class="sub" style="cursor:pointer">${escapeHtml(t("setls.website-without-javascript-use-a-plain"))}</summary>
        <textarea class="ls-code" readonly rows="7" style="margin-top:6px">${escapeHtml(htmlCode(s))}</textarea>
      </details>
      <details style="margin-top:10px" data-ls-options="${escapeHtml(s.id)}"><summary class="sub" style="cursor:pointer"><strong>${escapeHtml(t("setls.form-options"))}</strong></summary>
        <div class="field-row" style="margin-top:10px">
          <div class="field"><label>${escapeHtml(t("setls.title"))}</label><input type="text" data-opt="title" maxlength="120" value="${escapeHtml(set.title)}" /></div>
          <div class="field"><label>${escapeHtml(t("setls.button"))}</label><input type="text" data-opt="buttonText" maxlength="40" value="${escapeHtml(set.buttonText)}" /></div>
        </div>
        <div class="field"><label>${escapeHtml(t("setls.thank-you-message"))}</label><input type="text" data-opt="successMessage" maxlength="300" value="${escapeHtml(set.successMessage)}" /></div>
        <div class="field"><label>${escapeHtml(t("setls.also-ask-for"))}</label><div>${check("email", escapeHtml(t("customers.email")))}${check("company", escapeHtml(t("board.field.lead.company")))}${check("city", escapeHtml(t("customers.city")))}${check("product", escapeHtml(t("col.product")))}${check("message", escapeHtml(t("wf.field.requirement")))}</div></div>
        <div class="field">${check("consent", escapeHtml(t("ls.consent.ask")))}
          <input type="text" data-opt="consentText" maxlength="200" value="${escapeHtml(set.consentText || "")}" aria-label="${escapeHtml(t("ls.consent.text"))}" style="margin-top:6px" />
          <div class="cf-help">${escapeHtml(t("ls.consent.help"))}</div></div>
        <div class="field"><label>${escapeHtml(t("setls.only-on-these-websites-optional-one"))}</label><textarea data-opt="allowedOrigins" rows="2" placeholder="https://www.yourshop.in">${escapeHtml((set.allowedOrigins || []).join("\n"))}</textarea></div>
        <div class="field"><label>${escapeHtml(t("setls.after-a-plain-html-form-go"))}</label><input type="url" data-opt="redirectUrl" maxlength="500" placeholder="https://www.yourshop.in/thank-you" value="${escapeHtml(set.redirectUrl)}" /></div>
        <div class="data-actions" style="justify-content:flex-end"><button class="btn btn-primary" type="button" data-ls-save="${escapeHtml(s.id)}">${escapeHtml(t("setls.save-options"))}</button></div>
      </details>
      <details style="margin-top:10px" data-ls-preview="${escapeHtml(s.id)}"><summary class="sub" style="cursor:pointer"><strong>${escapeHtml(t("inbox.tpl.preview"))}</strong> ${escapeHtml(t("setls.sending-it-creates-a-real-enquiry"))}</summary>
        <div class="ls-preview"></div>
      </details>`;
  }

  // --- the website's WhatsApp button (D102) ---
  const buttonCode = (s) => `<script src="${s.widget.scriptUrl}" async></script>`;
  const option = (value, label, current) => `<option value="${escapeHtml(value)}" ${String(value) === String(current) ? "selected" : ""}>${escapeHtml(label)}</option>`;
  function widgetHtml(s) {
    const set = s.settings;
    const numbers = accounts.map((a) => option(a.id, `${a.name || a.verifiedName || "WhatsApp"} · ${a.displayPhone || t("setls.number-not-checked-yet")}`, set.accountId)).join("");
    return `
      <div class="sub" style="margin-top:10px"><strong>${escapeHtml(t("setls.put-this-on-your-website"))}</strong>${escapeHtml(t("setls.just-before-body-on-every-page"))}</div>
      <div style="display:flex;gap:8px;align-items:flex-start;margin-top:6px">
        <textarea class="ls-code" readonly rows="1">${escapeHtml(buttonCode(s))}</textarea>
        <button class="btn btn-outline" type="button" data-ls-copy-value="${escapeHtml(buttonCode(s))}" title="${escapeHtml(t("setls.copyCode"))}"><i class="fa-solid fa-copy"></i></button>
      </div>
      <div class="sub" style="margin-top:6px">${escapeHtml(t("setls.no-cookie-and-nothing-kept-on"))}</div>
      ${accounts.length ? "" : `<div class="sub" style="margin-top:6px;color:var(--danger)">${escapeHtml(t("setls.needsNumber"))}</div>`}
      <details style="margin-top:10px" data-ls-widget="${escapeHtml(s.id)}"><summary class="sub" style="cursor:pointer"><strong>${escapeHtml(t("setls.look-and-text"))}</strong> ${escapeHtml(t("setls.with-a-live-preview"))}</summary>
        <div class="ls-widget">
          <div>
            <div class="field-row">
              <div class="field"><label>${escapeHtml(t("conn.kind.whatsapp"))}</label><select data-wopt="accountId">${option("", t("setls.the-default-number"), set.accountId)}${numbers}</select></div>
              <div class="field"><label>${escapeHtml(t("setls.colour"))}</label><input type="color" data-wopt="color" value="${escapeHtml(set.color)}" /></div>
            </div>
            <div class="field-row">
              <div class="field"><label>${escapeHtml(t("setls.corner"))}</label><select data-wopt="position">${option("right", t("setls.bottom-right"), set.position)}${option("left", t("setls.bottom-left"), set.position)}</select></div>
              <div class="field"><label>${escapeHtml(t("setls.the-button-s-own-words"))}</label><select data-wopt="language">${option("en", t("setls.english"), set.language)}${option("hi", t("setls.hindi"), set.language)}</select></div>
            </div>
            <div class="field"><label>${escapeHtml(t("setls.greeting-in-the-card"))}</label><textarea data-wopt="greeting" rows="2" maxlength="300">${escapeHtml(set.greeting)}</textarea></div>
            <div class="field"><label>${escapeHtml(t("setls.ready-message-the-customer-can-change"))}</label><textarea data-wopt="message" rows="2" maxlength="300">${escapeHtml(set.message)}</textarea></div>
            <div class="field-row">
              <div class="field"><label>${escapeHtml(t("setls.name-on-the-card-optional"))}</label><input type="text" data-wopt="agentName" maxlength="60" placeholder="${escapeHtml(t("setls.yourCompanyName"))}" value="${escapeHtml(set.agentName)}" /></div>
              <div class="field"><label>${escapeHtml(t("setls.photo-optional-an-https-address"))}</label><input type="url" data-wopt="agentPhotoUrl" maxlength="500" placeholder="https://…" value="${escapeHtml(set.agentPhotoUrl)}" /></div>
            </div>
            <div class="field-row">
              <div class="field"><label>${escapeHtml(t("setls.usually-replies-within"))}</label><select data-wopt="replyTime">${option("minutes", t("setls.reply.minutes"), set.replyTime)}${option("hour", t("setls.an-hour"), set.replyTime)}${option("hours", t("setls.a-few-hours"), set.replyTime)}${option("day", t("setls.a-day"), set.replyTime)}</select></div>
              <div class="field"><label>${escapeHtml(t("setls.outside-working-hours"))}</label><label class="ls-check"><input type="checkbox" data-wopt="showHours" ${set.showHours ? "checked" : ""} /> ${escapeHtml(t("setls.say-away-now-back-at-settings"))}</label></div>
            </div>
            <div class="field"><label>${escapeHtml(t("setls.only-on-these-websites-optional-one"))}</label><textarea data-wopt="allowedOrigins" rows="2" placeholder="https://www.yourshop.in">${escapeHtml((set.allowedOrigins || []).join("\n"))}</textarea></div>
            <div class="data-actions" style="justify-content:flex-end"><button class="btn btn-primary" type="button" data-ls-widget-save="${escapeHtml(s.id)}">${escapeHtml(t("common.save"))}</button></div>
          </div>
          <div class="ls-widget-preview" data-ls-widget-preview aria-label="${escapeHtml(t("inbox.tpl.preview"))}"></div>
        </div>
      </details>`;
  }
  // The preview is drawn by the button's real script (loaded once, for its drawing function).
  let drawing = null;
  function drawingFor(source) {
    if (!drawing) {
      drawing = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `${source.widget.scriptUrl}?preview=1`;
        script.setAttribute("data-preview", "");
        script.onload = () => (window.YellowCrmWhatsAppButton ? resolve(window.YellowCrmWhatsAppButton) : reject(new Error("no drawing"))); // i18n-ok: never shown, the preview says it could not load
        script.onerror = () => reject(new Error("not loaded")); // i18n-ok: never shown
        document.head.appendChild(script);
      });
      drawing.catch(() => { drawing = null; });
    }
    return drawing;
  }
  function readWidget(row) {
    const field = (key) => row.querySelector(`[data-wopt="${key}"]`);
    return {
      accountId: field("accountId").value,
      color: field("color").value,
      position: field("position").value,
      language: field("language").value,
      greeting: field("greeting").value.trim(),
      message: field("message").value.trim(),
      agentName: field("agentName").value.trim(),
      agentPhotoUrl: field("agentPhotoUrl").value.trim(),
      replyTime: field("replyTime").value,
      showHours: field("showHours").checked,
      allowedOrigins: field("allowedOrigins").value.split(/[\s,]+/).map((o) => o.replace(/\/+$/, "")).filter(Boolean),
    };
  }
  async function previewWidget(row) {
    const source = sources.find((s) => s.id === row.dataset.lsId);
    const box = row.querySelector("[data-ls-widget-preview]");
    if (!source || !box) return;
    try {
      const button = await drawingFor(source);
      const set = readWidget(row);
      const account = accounts.find((a) => String(a.id) === set.accountId) || accounts.find((a) => a.isDefault) || accounts[0];
      box.replaceChildren();
      button.render({
        ...button.config, ...set,
        phone: String(account?.displayPhone || "").replace(/\D/g, ""),
        agentPhotoUrl: /^https:\/\//.test(set.agentPhotoUrl) ? set.agentPhotoUrl : "",
      }, { mount: box, preview: true, open: true });
    } catch {
      box.textContent = t("setls.the-preview-could-not-be-loaded");
    }
  }

  // --- IndiaMART ---
  const IM_TYPES = { W: "setls.im.W", B: "setls.im.B", P: "setls.im.P", WA: "setls.im.WA", BIZ: "setls.im.BIZ" }; // the keys of their texts
  const IM_DEFAULT = ["W", "B", "P", "WA"];
  const typeBoxes = (selected, attr) =>
    Object.entries(IM_TYPES)
      .map(([code, label]) => `<label class="ls-check"><input type="checkbox" ${attr}="${code}" ${selected.includes(code) ? "checked" : ""} /> ${escapeHtml(t(label))}</label>`)
      .join("");
  // IndiaMART can only push to a public HTTPS address.
  const isLocal = (url) => !/^https:\/\//.test(url) || /\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);

  function indiamartHtml(s) {
    const pushHint = isLocal(s.pushUrl)
      ? `<div class="sub" style="margin-top:4px">${escapeHtml(t("setls.imPublic1"))} <strong translate="no">https</strong> ${escapeHtml(t("setls.imPublic2"))} <strong>${escapeHtml(t("setls.yourAddress", { path: new URL(s.pushUrl).pathname }))}</strong>${escapeHtml(t("setls.imPublic3"))}</div>`
      : "";
    return `
      <div class="sub" style="margin-top:8px">${escapeHtml(s.lastPulledUntil ? t("setls.pulledUpTo", { when: when(s.lastPulledUntil) }) : t("setls.firstPull"))} ${escapeHtml(t("setls.pullsAgain"))}</div>
      <div class="sub" style="margin-top:10px"><strong>${escapeHtml(t("setls.instant-leads-optional"))}</strong> ${escapeHtml(t("setls.in-indiamart-lead-manager-import-export"))} <strong translate="no">Push API</strong>${escapeHtml(t("setls.enter-this-address"))}</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px;min-width:0">
        <code style="word-break:break-all;font-size:12px;flex:1">${escapeHtml(s.pushUrl)}</code>
        <button class="btn btn-outline" type="button" data-ls-copy-push="${escapeHtml(s.id)}" title="${escapeHtml(t("set.copy-the-address"))}"><i class="fa-solid fa-copy"></i></button>
      </div>
      ${pushHint}
      <details style="margin-top:10px"><summary class="sub" style="cursor:pointer"><strong>${escapeHtml(t("setls.kinds-of-leads-to-take"))}</strong></summary>
        <div style="margin-top:8px">${typeBoxes(s.settings.queryTypes || IM_DEFAULT, "data-im-type")}</div>
        <div class="data-actions" style="justify-content:flex-end;margin-top:8px"><button class="btn btn-primary" type="button" data-im-save="${escapeHtml(s.id)}">${escapeHtml(t("common.save"))}</button></div>
      </details>`;
  }

  // --- sources that push to an address: Facebook, Google Ads, JustDial, TradeIndia ---
  const copyRow = (label, value) => `
      <div class="ls-copy">
        <span class="sub ls-copy-label">${escapeHtml(label)}</span>
        <code>${escapeHtml(value)}</code>
        <button class="btn btn-outline" type="button" data-ls-copy-value="${escapeHtml(value)}" title="${escapeHtml(t("app.icon.copy"))}"><i class="fa-solid fa-copy"></i></button>
      </div>`;
  const publicNote = (s) =>
    isLocal(s.pushUrl)
      ? `<div class="sub" style="margin-top:6px">${escapeHtml(t("setls.publicOnly", { source: s.source }))}</div>`
      : "";

  function facebookHtml(s) {
    return `
      <div class="sub" style="margin-top:8px">${escapeHtml(t("setls.page"))} <strong>${escapeHtml(s.settings.pageName || s.settings.pageId)}</strong> ${escapeHtml(t("setls.subscribed-to-new-leads"))}
        <strong>${escapeHtml(t("setls.in-the-meta-app-webhooks-page"))}</strong> ${escapeHtml(t("setls.paste-these-two-values-then-subscribe"))} <strong translate="no">leadgen</strong> ${escapeHtml(t("setls.field"))}</div>
      ${copyRow(t("wa.callbackUrl"), s.pushUrl)}
      ${copyRow(t("wa.verifyToken"), s.verifyToken)}
      ${publicNote(s)}
      <div class="sub" style="margin-top:6px">${escapeHtml(t("setls.if-leads-do-not-arrive-check"))}</div>`;
  }
  function googleAdsHtml(s) {
    return `
      <div class="sub" style="margin-top:8px"><strong>${escapeHtml(t("setls.gaWhere"))}</strong> ${escapeHtml(t("setls.gaPaste"))} <em translate="no">Send test data</em>${escapeHtml(t("setls.gaTest", { recent: t("docs.recent") }))}</div>
      ${copyRow(t("setpay.webhookUrl"), s.pushUrl)}
      ${copyRow(t("setls.key"), s.googleKey)}
      ${publicNote(s)}`;
  }
  function genericHtml(s) {
    return `
      <div class="sub" style="margin-top:8px">${escapeHtml(t(s.type === "justdial" ? "setls.askJustdial" : "setls.askTradeindia", { source: s.source }))} ${escapeHtml(t("setls.afterFirstLead", { recent: t("docs.recent"), refused: t("setls.out.rejected") }))}</div>
      ${copyRow(t("setls.lead-address"), s.pushUrl)}
      ${publicNote(s)}`;
  }

  function sourceHtml(s) {
    const paused = s.status !== "active";
    return `
      <div class="settings-summary-row" style="align-items:flex-start;flex-wrap:wrap" data-ls-id="${escapeHtml(s.id)}">
        <div class="info" style="min-width:0;flex:1">
          <div class="name"><i class="fa-solid ${TYPE_ICON[s.type] || "fa-inbox"}"></i> ${escapeHtml(sourceName(s))}
            <span class="badge badge-neutral">${escapeHtml(crmLabel("source", s.source))}</span>
            ${s.status === "error" ? `<span class="badge badge-danger">${escapeHtml(t("setls.needsAttention"))}</span>` : paused ? `<span class="badge badge-warning">${escapeHtml(t("setroute.paused"))}</span>` : `<span class="badge badge-success">${escapeHtml(t("setls.active"))}</span>`}
            ${s.credentials.hint ? `<span class="sub">${escapeHtml(t(s.type === "facebook" ? "setls.tokenHint" : "setls.keyHint", { hint: s.credentials.hint }))}</span>` : ""}</div>
          <div class="sub">${escapeHtml(statsLine(s.stats, s.type))}${s.lastLeadAt ? t("setls.last-lead", { v: escapeHtml(when(s.lastLeadAt)) }) : ""}</div>
          ${s.statusMessage ? `<div class="sub" style="color:var(--danger)">${escapeHtml(s.statusMessage)}</div>` : s.lastError ? `<div class="sub" style="color:var(--danger)">${escapeHtml(s.lastError)}</div>` : ""}
          <div class="ls-actions">
            ${s.type === "indiamart" ? `<button class="btn btn-outline" type="button" data-ls-pull="${escapeHtml(s.id)}"><i class="fa-solid fa-rotate"></i> ${escapeHtml(t("setls.pull-now"))}</button><button class="btn btn-outline" type="button" data-ls-key="${escapeHtml(s.id)}"><i class="fa-solid fa-key"></i> ${escapeHtml(t("setls.new-key"))}</button>` : ""}
            ${s.type === "facebook" ? `<button class="btn btn-outline" type="button" data-ls-fb-token="${escapeHtml(s.id)}"><i class="fa-solid fa-key"></i> ${escapeHtml(t("setls.new-token"))}</button>` : ""}
            ${s.type === "whatsapp_button" ? "" : `<button class="btn btn-outline" type="button" data-ls-log-toggle="${escapeHtml(s.id)}"><i class="fa-solid fa-list"></i> ${escapeHtml(t("docs.recent"))}</button>`}
            <button class="btn btn-outline" type="button" data-ls-status="${escapeHtml(s.id)}">${paused ? t("gs.resume") : t("setls.pause")}</button>
            <button class="icon-btn danger" type="button" data-ls-remove="${escapeHtml(s.id)}" title="${escapeHtml(t("app.icon.remove"))}"><i class="fa-solid fa-trash"></i></button>
          </div>
          <div class="ls-log" data-ls-log="${escapeHtml(s.id)}" hidden></div>
          ${s.type === "website" ? websiteHtml(s) : ""}
          ${s.type === "indiamart" ? indiamartHtml(s) : ""}
          ${s.type === "facebook" ? facebookHtml(s) : ""}
          ${s.type === "googleads" ? googleAdsHtml(s) : ""}
          ${s.type === "justdial" || s.type === "tradeindia" ? genericHtml(s) : ""}
          ${s.type === "whatsapp_button" ? widgetHtml(s) : ""}
        </div>
      </div>`;
  }

  function render() {
    $("lsCount").textContent = sources.length ? t(sources.length === 1 ? "setls.sources.one" : "setls.sources.many", { n: sources.length }) : "";
    $("lsList").innerHTML = sources.length ? sources.map(sourceHtml).join("") : `<p class="settings-hint" style="margin:0">${escapeHtml(t("setls.none"))}</p>`;
    openLogs.forEach((id) => showLog(id));
  }

  async function load() {
    try {
      [sources, accounts] = await Promise.all([crmApi("/lead-sources"), crmApi("/whatsapp/accounts").catch(() => [])]);
      render();
    } catch (error) {
      $("lsList").innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, t("setls.couldn-t-load-the-lead-sources")))}</p>`;
    }
  }

  async function showLog(id) {
    const box = document.querySelector(`[data-ls-log="${CSS.escape(id)}"]`);
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `<p class="sub">${escapeHtml(t("bulkbar.loading"))}</p>`;
    try {
      const items = await crmApi(`/lead-sources/${id}/intakes?limit=15`);
      box.innerHTML = items.length
        ? items
            .map((i) => {
              const [badge, label] = OUTCOME[i.outcome] || ["badge-neutral", i.outcome];
              return `<div class="ls-log-row"><span class="sub">${escapeHtml(when(i.receivedAt))}</span> <span class="badge ${badge}">${escapeHtml(t(label))}</span> ${escapeHtml(i.summary || "")}${i.reason ? ` <span style="color:var(--danger)">(${escapeHtml(i.reason)})</span>` : ""}</div>`;
            })
            .join("")
        : `<p class="sub">${escapeHtml(t("setls.nothingYet"))}</p>`;
    } catch (error) {
      box.innerHTML = `<p class="logo-upload-error">${escapeHtml(apiErrorMessage(error, t("setls.couldn-t-load-the-enquiries")))}</p>`;
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
      consentText: value("consentText"), // D79: the WhatsApp offers box
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
    const copyValue = target("data-ls-copy-value");
    const fbToken = target("data-ls-fb-token");
    const widgetSave = target("data-ls-widget-save");
    if (widgetSave) {
      try {
        await crmApi(`/lead-sources/${widgetSave.dataset.lsWidgetSave}`, jsonRequest("PATCH", { settings: readWidget(widgetSave.closest("[data-ls-id]")) }));
        showToast(t("setls.saved-websites-show-the-new-button"), "success");
        await load();
      } catch (error) {
        showToast(apiErrorMessage(error, t("setls.couldn-t-save-the-button")), "error");
      }
      return;
    }
    if (copyValue) {
      try {
        await navigator.clipboard.writeText(copyValue.dataset.lsCopyValue);
        showToast(t("wa.copied"), "success");
      } catch {
        showToast(t("wa.copyFailed"), "error");
      }
      return;
    }
    if (fbToken) {
      const value = (window.prompt(t("setls.paste-the-new-long-lived-page")) || "").trim();
      if (!value) return;
      try {
        await crmApi(`/lead-sources/${fbToken.dataset.lsFbToken}`, jsonRequest("PATCH", { pageAccessToken: value }));
        showToast(t("setls.token-checked-and-saved"), "success");
      } catch (error) {
        showToast(apiErrorMessage(error, t("setls.facebook-did-not-accept-the-token")), "error");
      }
      await load();
      return;
    }
    if (pull) {
      pull.disabled = true;
      try {
        const result = await crmApi(`/lead-sources/${pull.dataset.lsPull}/pull`, { method: "POST" });
        const o = result.outcomes || {};
        showToast(
          result.error === "KEY_REFUSED"
            ? t("setls.indiamart-refused-the-key-paste-a")
            : t(result.fetched === 1 ? "setls.pulled.one" : "setls.pulled.many", { n: result.fetched || 0, created: o.created || 0, attached: o.attached || 0, duplicate: o.duplicate || 0, skipped: o.skipped ? t("setls.pulledSkipped", { n: o.skipped }) : "" }),
          result.error ? "error" : "success",
        );
      } catch (error) {
        showToast(apiErrorMessage(error, t("setls.couldn-t-pull-from-indiamart")), "error");
      }
      await load();
      return;
    }
    if (key) {
      const value = (window.prompt(t("setls.paste-the-new-indiamart-crm-api")) || "").trim();
      if (!value) return;
      try {
        await crmApi(`/lead-sources/${key.dataset.lsKey}`, jsonRequest("PATCH", { apiKey: value }));
        showToast(t("setls.key-saved-the-next-pull-uses"), "success");
      } catch (error) {
        showToast(apiErrorMessage(error, t("setls.couldn-t-save-the-key")), "error");
      }
      await load();
      return;
    }
    if (copyPush) {
      const source = sources.find((s) => s.id === copyPush.dataset.lsCopyPush);
      try {
        await navigator.clipboard.writeText(source.pushUrl);
        showToast(t("setdev.address-copied"), "success");
      } catch {
        showToast(t("setls.copy-failed-select-the-address-and"), "error");
      }
      return;
    }
    if (saveTypes) {
      const row = saveTypes.closest("[data-ls-id]");
      const queryTypes = [...row.querySelectorAll("[data-im-type]:checked")].map((box) => box.dataset.imType);
      if (!queryTypes.length) {
        showToast(t("setls.choose-at-least-one-kind-of"), "error");
        return;
      }
      try {
        await crmApi(`/lead-sources/${saveTypes.dataset.imSave}`, jsonRequest("PATCH", { settings: { queryTypes } }));
        showToast(t("setls.saved-the-next-pull-takes-these"), "success");
      } catch (error) {
        showToast(apiErrorMessage(error, t("orders.err.save")), "error");
      }
      await load();
      return;
    }
    if (copy) {
      const source = sources.find((s) => s.id === copy.dataset.lsCopy);
      try {
        await navigator.clipboard.writeText(embedCode(source));
        showToast(t("setls.code-copied-paste-it-into-your"), "success");
      } catch {
        showToast(t("setls.copy-failed-select-the-code-and"), "error");
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
        showToast(source.status === "active" ? t("setls.paused-enquiries-are-refused-until-you") : t("setls.taking-enquiries-again"), "success");
      } catch (error) {
        showToast(apiErrorMessage(error, t("gs.failed")), "error");
      }
      await load();
    } else if (remove) {
      if (!confirm(t("setls.remove-this-lead-source-a-website"))) return;
      try {
        await crmApi(`/lead-sources/${remove.dataset.lsRemove}`, { method: "DELETE" });
        showToast(t("setls.lead-source-removed"), "success");
      } catch (error) {
        showToast(apiErrorMessage(error, t("setls.couldn-t-remove-it")), "error");
      }
      await load();
    } else if (save) {
      const row = save.closest("[data-ls-id]");
      try {
        await crmApi(`/lead-sources/${save.dataset.lsSave}`, jsonRequest("PATCH", { settings: readOptions(row) }));
        showToast(t("setls.form-options-saved-websites-pick-them"), "success");
        await load();
      } catch (error) {
        showToast(apiErrorMessage(error, t("setls.couldn-t-save-the-options")), "error");
      }
    }
  });
  // The preview loads the real embed script the first time it is opened.
  $("lsList").addEventListener("toggle", (e) => {
    const details = e.target.closest?.("[data-ls-preview]");
    if (details && details.open) showPreview(details, sources.find((s) => s.id === details.dataset.lsPreview));
    const button = e.target.closest?.("[data-ls-widget]");
    if (button && button.open) previewWidget(button.closest("[data-ls-id]"));
  }, true);
  // The button's preview follows every change (D102).
  ["input", "change"].forEach((type) => $("lsList").addEventListener(type, (e) => {
    if (e.target.closest("[data-wopt]")) previewWidget(e.target.closest("[data-ls-id]"));
  }));

  $("lsAddWebsite").addEventListener("click", async () => {
    try {
      await crmApi("/lead-sources", jsonRequest("POST", { type: "website", name: "Website form" })); // i18n-ok: the saved name, shown in the person's language (sourceName)
      showToast(t("setls.website-form-ready-copy-its-code"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("setls.couldn-t-add-the-form")), "error");
    }
    await load();
  });

  // Connect IndiaMART.
  crmI18n.ready.then(() => { $("lsImTypes").innerHTML = typeBoxes(IM_DEFAULT, "data-new-im-type"); });
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
      showToast(t("setls.indiamart-connected-the-first-pull-runs"), "success");
      $("lsImKey").value = "";
      $("lsIndiamartForm").hidden = true;
      // Show the first pull's result once it is in.
      setTimeout(load, 8000);
    } catch (error) {
      showToast(apiErrorMessage(error, t("setls.couldn-t-connect-indiamart")), "error");
    }
    await load();
  });

  // Connect Facebook Lead Ads.
  $("lsAddFacebook").addEventListener("click", () => {
    $("lsFacebookForm").hidden = false;
    $("lsFbPageId").focus();
  });
  $("lsFbCancel").addEventListener("click", () => {
    $("lsFacebookForm").reset();
    $("lsFacebookForm").hidden = true;
  });
  $("lsFacebookForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await crmApi("/lead-sources", jsonRequest("POST", { type: "facebook", pageId: $("lsFbPageId").value.trim(), pageAccessToken: $("lsFbToken").value.trim(), appSecret: $("lsFbSecret").value.trim() }));
      showToast(t("setls.facebook-page-connected-now-set-the"), "success");
      e.target.reset();
      e.target.hidden = true;
    } catch (error) {
      showToast(apiErrorMessage(error, t("setls.couldn-t-connect-the-facebook-page")), "error");
    }
    await load();
  });

  // Google Ads, JustDial and TradeIndia only need their address.
  document.querySelectorAll("[data-ls-create]").forEach((button) =>
    button.addEventListener("click", async () => {
      try {
        await crmApi("/lead-sources", jsonRequest("POST", { type: button.dataset.lsCreate }));
        showToast(button.dataset.lsCreate === "whatsapp_button" ? t("setls.whatsapp-button-ready-set-its-look") : t("setls.added-copy-its-address-from-the"), "success");
      } catch (error) {
        showToast(apiErrorMessage(error, t("setls.couldn-t-add-it")), "error");
      }
      await load();
    }),
  );

  $("lsSimulateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = (id) => $(id).value.trim();
    try {
      const result = await crmApi("/dev/simulate/lead", jsonRequest("POST", {
        source: value("lsSimSource"), name: value("lsSimName"), phone: value("lsSimPhone"), product: value("lsSimProduct"), message: value("lsSimMessage"),
        city: value("lsSimCity"), state: value("lsSimState"),
      }));
      showToast(result.outcome === "attached" ? t("setls.test-enquiry-added-to-the-open") : t("setls.test-lead-received-the-lead-rules"), "success");
      e.target.reset();
    } catch (error) {
      showToast(error.status === 404 ? t("setls.test-leads-are-turned-off-on") : apiErrorMessage(error, t("setls.couldn-t-receive-the-test-lead")), "error");
    }
    await load();
  });

  load();
})();
