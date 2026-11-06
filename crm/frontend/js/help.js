/**
 * help.js — help inside the CRM (100 phases, phase 6, D118, docs/HELP.md)
 * The "?" box of each page (app.js loads this file the first time "?" is pressed) and the help
 * centre (help.html): common questions, each page's help with a search, and the platform's
 * support on WhatsApp (GET /help/support, set on the platform admin page). Texts in
 * i18n/*.json: help.<topic>.intro and .p1…, help.faq.<id>.q and .a.
 */
(function crmHelpModule() {
  // Each page's help: its file, topic, icon and how many points it has, in the menu's order.
  const TOPICS = [
    ["dashboard.html", "dashboard", "fa-chart-pie", 3],
    ["Inbox.html", "inbox", "fa-comments", 4],
    ["customers.html", "customers", "fa-users", 3],
    ["customer-360.html", "customer360", "fa-address-card", 2],
    ["leads.html", "leads", "fa-bullseye", 4],
    ["Deals.html", "deals", "fa-handshake", 2],
    ["Quotations.html", "quotations", "fa-file-invoice", 3],
    ["Orders.html", "orders", "fa-box", 3],
    ["Products.html", "products", "fa-box-open", 2],
    ["boards.html", "boards", "fa-table-columns", 1],
    ["dialer.html", "dialer", "fa-phone", 1],
    ["Tasks.html", "tasks", "fa-list-check", 2],
    ["Calendar.html", "calendar", "fa-calendar-days", 1],
    ["projects.html", "projects", "fa-briefcase", 1],
    ["Documents.html", "documents", "fa-file-lines", 1],
    ["Support.html", "support", "fa-headset", 1],
    ["Marketing.html", "marketing", "fa-bullhorn", 1],
    ["Sales Automation.html", "automation", "fa-gears", 1],
    ["workflow-builder.html", "workflowBuilder", "fa-diagram-project", 2],
    ["Reports & Analytics.html", "reports", "fa-chart-line", 2],
    ["Al Insights.html", "aiInsights", "fa-brain", 1],
    ["team-live.html", "teamLive", "fa-signal", 1],
    ["my-performance.html", "myPerformance", "fa-user-check", 1],
    ["accounts.html", "accounts", "fa-building", 1],
    ["Settings.html", "settings", "fa-gear", 3],
  ];
  const FAQ = ["whatsapp", "import", "quotation", "payment", "leadSources", "team", "hindi", "phone", "plan", "data"];

  const topicOf = (page) => TOPICS.find(([file]) => file.toLowerCase() === page);
  const titleOf = ([file]) => t(NAV_KEYS[file.toLowerCase()]);
  const pointsHtml = ([, topic, , count]) =>
    `<ol class="help-points">${Array.from({ length: count }, (_, index) => `<li>${escapeHtml(t(`help.${topic}.p${index + 1}`))}</li>`).join("")}</ol>`;

  // The platform's support contact, asked once per page.
  let asked = null;
  const support = () => asked || (asked = crmApi("/help/support").catch(() => ({ whatsapp: "", email: "", hours: "", company: {} })));

  // A WhatsApp chat with support whose first message says the page and the company.
  function whatsappLink(info, about) {
    const digits = String(info.whatsapp || "").replace(/\D/g, "");
    if (!digits) return "";
    const { name, code } = info.company || {};
    const company = name ? t(code ? "help.wa.company" : "help.wa.companyName", { name, code }) : "";
    return `https://wa.me/${digits}?text=${encodeURIComponent(t("help.wa.text", { about, company }))}`;
  }
  const whatsappButton = (link) =>
    `<a class="btn btn-whatsapp" href="${escapeHtml(link)}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("help.askWhatsApp"))}</a>`;
  // Email and hours, if support has them.
  const contactLines = (info) => [
    info.email ? `<a href="mailto:${escapeHtml(info.email)}">${escapeHtml(info.email)}</a>` : "",
    info.hours ? escapeHtml(t("help.hours", { hours: info.hours })) : "",
  ].filter(Boolean).join(" · ");

  // --- the "?" box -------------------------------------------------------------------------
  let opener = null;
  function overlay() {
    let box = document.getElementById("helpOverlay");
    if (box) return box;
    box = document.createElement("div");
    box.className = "modal-overlay";
    box.id = "helpOverlay";
    box.innerHTML = `
      <div class="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
        <div class="modal-head">
          <h3 id="helpTitle"></h3>
          <button class="icon-btn" id="helpClose" type="button" aria-label="${escapeHtml(t("common.close"))}"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="modal-body" id="helpBody"></div>
      </div>`;
    document.body.appendChild(box);
    box.addEventListener("click", (event) => {
      if (event.target === box) close();
    });
    box.querySelector("#helpClose").addEventListener("click", close);
    return box;
  }
  function close() {
    document.getElementById("helpOverlay")?.classList.remove("open");
    if (opener?.isConnected) opener.focus();
  }
  async function open(from) {
    opener = from || null;
    const box = overlay();
    const topic = topicOf(currentPageName());
    const about = topic ? titleOf(topic) : t("help.general.about");
    box.querySelector("#helpTitle").textContent = topic ? t("help.title", { page: about }) : t("nav.help");
    const body = box.querySelector("#helpBody");
    body.innerHTML = `
      <p class="help-intro">${escapeHtml(topic ? t(`help.${topic[1]}.intro`) : t("help.general.intro"))}</p>
      ${topic ? pointsHtml(topic) : ""}
      <div class="help-actions">
        <a class="btn btn-outline" href="help.html${topic ? `#topic-${topic[1]}` : ""}"><i class="fa-solid fa-book-open"></i> ${escapeHtml(t("help.openCentre"))}</a>
        <span data-help-whatsapp></span>
      </div>
      <p class="help-contact" hidden></p>`;
    box.classList.add("open");
    box.querySelector("#helpClose").focus();
    const info = await support();
    const link = whatsappLink(info, about);
    if (link) body.querySelector("[data-help-whatsapp]").outerHTML = whatsappButton(link);
    const lines = contactLines(info);
    if (lines) {
      body.querySelector(".help-contact").innerHTML = lines;
      body.querySelector(".help-contact").hidden = false;
    }
  }
  window.crmHelpPanel = { open };

  // --- the help centre (help.html) -----------------------------------------------------------
  function renderCentre() {
    const $ = (id) => document.getElementById(id);
    $("helpFaq").innerHTML = FAQ.map((id) => `
      <details class="help-item" id="faq-${id}">
        <summary>${escapeHtml(t(`help.faq.${id}.q`))}</summary>
        <p>${escapeHtml(t(`help.faq.${id}.a`))}</p>
      </details>`).join("");
    $("helpTopics").innerHTML = TOPICS.map((topic) => {
      const [file, id, icon] = topic;
      return `
      <details class="help-item" id="topic-${id}">
        <summary><i class="fa-solid ${icon}" aria-hidden="true"></i> ${escapeHtml(titleOf(topic))}</summary>
        <p>${escapeHtml(t(`help.${id}.intro`))}</p>
        ${pointsHtml(topic)}
        <a class="help-open-page" href="${encodeURI(file)}">${escapeHtml(t("help.openPage", { page: titleOf(topic) }))} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>
      </details>`;
    }).join("");
    $("helpStart").hidden = !isOrgManager();

    support().then((info) => {
      const link = whatsappLink(info, t("help.general.about"));
      const lines = contactLines(info);
      if (!link && !lines) return;
      $("helpContactActions").innerHTML = link ? whatsappButton(link) : "";
      $("helpContactLines").innerHTML = lines;
      $("helpContactLines").hidden = !lines;
      $("helpContact").hidden = false;
    });

    // Every word typed must be in the question or the topic (its answer or points too).
    $("helpSearch").addEventListener("input", () => {
      const words = $("helpSearch").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      document.querySelectorAll(".help-item").forEach((item) => {
        const match = words.every((word) => item.textContent.toLowerCase().includes(word));
        item.hidden = !match;
        item.open = Boolean(words.length) && match;
        if (match) shown += 1;
      });
      document.querySelectorAll(".help-section").forEach((section) => {
        section.hidden = !section.querySelector(".help-item:not([hidden])");
      });
      $("helpNoMatch").hidden = shown > 0;
    });

    // help.html#topic-leads (from a page's "?" box) opens that topic.
    const openFromAddress = () => {
      const item = window.location.hash ? document.getElementById(decodeURIComponent(window.location.hash.slice(1))) : null;
      if (!item?.classList.contains("help-item")) return;
      item.open = true;
      item.scrollIntoView({ block: "start" });
      item.querySelector("summary").focus();
    };
    openFromAddress();
    window.addEventListener("hashchange", openFromAddress);
  }
  if (document.getElementById("helpCentre")) crmI18n.ready.then(renderCentre);
})();
