/**
 * landing.js — the public home page (index.html, CP4). Draws the plans from GET /site/plans
 * (the same list as Settings → Plan & usage, from backend constants/plans.js, so prices live in
 * one place), fills in the operator's name for the footer, and runs the header and menu.
 * No sign-in and no app.js, so the page stays light.
 */
(function landingPage() {
  // Like app.js: the API is on the same origin, except under VS Code Live Server.
  const API =
    /^https?:$/.test(window.location.protocol) && !["5500", "5501"].includes(window.location.port)
      ? `${window.location.origin}/api/v1`
      : "http://127.0.0.1:3000/api/v1";
  const $ = (id) => document.getElementById(id);

  // Language (CP5): the texts are in i18n/en.json and i18n/hi.json ("lp."), like the CRM's. The
  // choice is this browser's (crm_prefs), so the login page opens in it too, and it is saved on
  // the account at sign-up.
  function readPrefs() {
    try {
      return JSON.parse(localStorage.getItem("crm_prefs") || "null") || {};
    } catch {
      return {};
    }
  }
  let language = (() => {
    const prefs = readPrefs();
    const code = prefs.language || prefs.loginLanguage || (/^hi\b/i.test(navigator.language || "") ? "hi" : "en");
    return code === "hi" ? "hi" : "en";
  })();
  const texts = {};
  const loadTexts = (code) =>
    texts[code]
      ? Promise.resolve()
      : fetch(`i18n/${code}.json`)
          .then((response) => (response.ok ? response.json() : {}))
          .catch(() => ({}))
          .then((data) => {
            texts[code] = data;
          });
  const lookup = (key) => texts[language]?.[key] ?? texts.en?.[key];
  function t(key, values = {}) {
    const text = lookup(key);
    return text === undefined ? key : String(text).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  }
  const has = (key) => lookup(key) !== undefined;
  // Our own texts only; a missing one leaves the page's English.
  function applyTexts() {
    const each = (attribute, set) =>
      document.querySelectorAll(`[${attribute}]`).forEach((el) => {
        const text = lookup(el.getAttribute(attribute));
        if (text !== undefined) set(el, text);
      });
    each("data-i18n-html", (el, text) => { el.innerHTML = text; });
    each("data-i18n", (el, text) => { el.textContent = text; });
    each("data-i18n-alt", (el, text) => { el.alt = text; });
    each("data-i18n-aria-label", (el, text) => { el.setAttribute("aria-label", text); });
    document.documentElement.lang = language;
    document.title = t("lp.title");
    $("langBtn").textContent = language === "hi" ? "English" : "हिंदी";
    $("langBtn").lang = language === "hi" ? "en" : "hi";
    document.documentElement.classList.remove("i18n-pending");
  }
  const locale = () => (language === "hi" ? "hi-IN" : "en-IN");

  function escapeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  async function getJson(path) {
    const response = await fetch(API + path, { credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).data;
  }

  const count = (n) => new Intl.NumberFormat(locale()).format(n);
  function rupees(paise) {
    const digits = paise % 100 ? 2 : 0;
    return new Intl.NumberFormat(locale(), { style: "currency", currency: "INR", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(paise / 100);
  }
  // The same words as Settings → Plan & usage (js/settings-plan.js), in the page's language.
  const limitText = (metric, n) => {
    if (n === null) return has(`lp.unlimited.${metric}`) ? t(`lp.unlimited.${metric}`) : "";
    const key = `lp.limit.${metric}${n === 1 ? "One" : ""}`;
    if (!has(key)) return "";
    return t(key, { n: count(n) }) + (metric === "whatsappNumbers" && n >= 20 ? t("lp.limit.metaMax") : "");
  };
  // plans.js names features and "every plan has" in English; the page has them translated,
  // else (a new or changed one) shows the English.
  const featureLabel = (feature, label) => (has(`lp.feature.${feature}`) ? t(`lp.feature.${feature}`) : label);
  const includedSlug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 6).join("-");
  const includedLabel = (text) => (has(`lp.included.${includedSlug(text)}`) && texts.en?.[`lp.included.${includedSlug(text)}`] === text ? t(`lp.included.${includedSlug(text)}`) : text);
  const icon = (name) => `<svg class="lp-ico" aria-hidden="true"><use href="#i-${name}" /></svg>`;

  function planCard(plan, catalog) {
    const trial = plan.key === catalog.trialPlan;
    const limits = catalog.limits
      .map(({ metric }) => limitText(metric, plan.limits[metric]))
      .filter(Boolean);
    const features = catalog.features.map(({ feature, label }) => {
      const included = plan.features[feature];
      return `<li class="${included ? "yes" : "no"}">${icon(included ? "check" : "dash")}<span>${escapeText(featureLabel(feature, label))}${included ? "" : `<span class="lp-sr">${escapeText(t("lp.notInPlan"))}</span>`}</span></li>`;
    });
    const id = `plan-${escapeText(plan.key)}`;
    return `
      <article class="lp-plan${trial ? " is-trial" : ""}" aria-labelledby="${id}">
        <div class="lp-plan-head">
          <h3 id="${id}">${escapeText(plan.name)}</h3>
          ${trial ? `<span class="lp-badge">${escapeText(t("lp.trialBadge"))}</span>` : ""}
        </div>
        <p class="lp-price">${rupees(plan.pricePaise)}<small>${escapeText(t("lp.perMonth"))}</small></p>
        <p class="lp-gst">${escapeText(t("lp.withGst", { total: rupees(plan.totalPaise), gst: catalog.gstPct }))}</p>
        <ul>${limits.map((text) => `<li>${escapeText(text)}</li>`).join("")}</ul>
        <ul class="lp-features">${features.join("")}</ul>
        <a class="lp-btn ${trial ? "lp-btn-dark" : "lp-btn-light"} lp-btn-block" href="login.html?signup=1">${escapeText(t("lp.startTrial"))}</a>
      </article>`;
  }

  async function loadPlans() {
    const box = $("plans");
    box.innerHTML = `<p class="lp-loading">${escapeText(t("lp.loading-the-plans"))}</p>`;
    try {
      const catalog = await getJson("/site/plans");
      const trialPlan = catalog.plans.find((plan) => plan.key === catalog.trialPlan);
      box.innerHTML = catalog.plans.map((plan) => planCard(plan, catalog)).join("");
      $("includedList").innerHTML = catalog.included.map((text) => `<li>${icon("check")}<span>${escapeText(includedLabel(text))}</span></li>`).join("");
      $("included").hidden = !catalog.included.length;
      if (trialPlan) {
        const every = Object.values(trialPlan.features).every(Boolean) ? t("lp.everyFeature") : "";
        $("pricingSub").textContent = t("lp.pricingSub", { gst: catalog.gstPct, days: catalog.trialDays, plan: trialPlan.name, every });
        $("trialNote").textContent = t("lp.trialNote", { days: catalog.trialDays, plan: trialPlan.name });
      }
    } catch {
      box.innerHTML = `
        <div class="lp-error" role="alert">
          ${escapeText(t("lp.plansFailed"))}<br />
          <button class="lp-btn lp-btn-light" type="button" id="plansRetry">${escapeText(t("lp.tryAgain"))}</button>
        </div>`;
      $("plansRetry").addEventListener("click", loadPlans);
    }
  }

  // Who runs this CRM (the details printed on the plan invoices), for the footer.
  async function loadOperator() {
    try {
      const site = await getJson("/site");
      document.querySelectorAll(".js-operator-name").forEach((el) => {
        el.textContent = site.name;
      });
      if (site.email) {
        $("operatorEmail").innerHTML = ` · <a href="mailto:${escapeText(site.email)}">${escapeText(site.email)}</a>`;
      }
    } catch {
      /* the footer reads well without it */
    }
  }

  // The header gets a line once the page scrolls; the phone menu closes after a choice.
  const header = $("header");
  const markScrolled = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", markScrolled, { passive: true });
  markScrolled();
  const menu = $("menu");
  menu.addEventListener("click", (event) => {
    if (event.target.closest("a")) menu.open = false;
  });
  document.addEventListener("click", (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });

  // A different language: the texts at once, then the plans drawn again in it.
  $("langBtn").addEventListener("click", async () => {
    language = language === "hi" ? "en" : "hi";
    try {
      localStorage.setItem("crm_prefs", JSON.stringify({ ...readPrefs(), language }));
    } catch {
      /* the choice is just not remembered */
    }
    await loadTexts(language);
    applyTexts();
    loadPlans();
  });

  $("year").textContent = String(new Date().getFullYear());
  Promise.all([loadTexts("en"), language === "en" ? null : loadTexts(language)]).then(() => {
    applyTexts();
    loadPlans();
  });
  loadOperator();
})();
