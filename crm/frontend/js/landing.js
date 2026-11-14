/**
 * landing.js — the public home page (index.html, CP4). Draws the plans from GET /site/plans
 * (the same list as Settings → Plan & usage, from backend constants/plans.js, so prices live in
 * one place), fills in the operator's name for the footer, and runs the header and menu.
 * No sign-in and no app.js, so the page stays light.
 * D146: the same page is each CRM type's own home page (?crm=<id>: its words, and what choosing
 * the type adds, from GET /site/crm-types) and each coming product's (?product=<id>).
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
    $("langBtn").textContent = language === "hi" ? "English" : "हिंदी"; // i18n-ok: each language by its own name
    $("langBtn").lang = language === "hi" ? "en" : "hi";
    applyPage();
    document.documentElement.classList.remove("i18n-pending");
  }
  const locale = () => (language === "hi" ? "hi-IN" : "en-IN");

  // --- which page this is (D146, D148) -------------------------------------------------------
  // agreem360's products: the CRM (its 20 business types, ?crm=<id>) and ten that are coming, each
  // with ten kinds of business of its own (?product=<id>&field=<field>, texts lp.prod.<id>.*).
  const FIELDS = {
    erp: ["manufacturing", "trading", "retail", "pharma", "food", "textile", "engineering", "chemicals", "construction", "jewellery"],
    marketing: ["retail", "ecommerce", "education", "realestate", "health", "restaurants", "travel", "finance", "salon", "b2b"],
    hrm: ["factories", "it", "retail", "hospitals", "schools", "hotels", "security", "construction", "logistics", "staffing"],
    scm: ["fmcg", "manufacturing", "pharma", "ecommerce", "cold", "agri", "auto", "building", "electronics", "textile"],
    cms: ["business", "store", "schools", "hospitals", "realestate", "restaurants", "news", "ngo", "manufacturers", "professionals"],
    bi: ["retail", "manufacturing", "distribution", "finance", "health", "education", "ecommerce", "logistics", "hospitality", "sales"],
    itsm: ["it", "msp", "banks", "hospitals", "education", "manufacturing", "retail", "government", "bpo", "hotels"],
    lms: ["schools", "coaching", "colleges", "corporate", "creators", "skills", "health", "sales", "compliance", "languages"],
    pm: ["construction", "interior", "software", "agencies", "events", "manufacturing", "consulting", "architecture", "solar", "ngo"],
    bpm: ["manufacturing", "banks", "insurance", "health", "education", "retail", "logistics", "realestate", "government", "services"],
  };
  const FEATURE_ICONS = ["box", "doc", "users", "calendar", "chart", "bolt"];
  const FIXED = ["crm", "erp", "marketing", "hrm"]; // always in the bar, in this order
  const LAST_KEY = "agreem360_last_product";
  const params = new URLSearchParams(window.location.search);
  const known = (attribute, id) => Boolean(id) && Boolean(document.querySelector(`[${attribute}="${CSS.escape(id)}"]`));
  // A product that is coming (and one of its kinds of business), or one of the CRM's business types.
  const productId = params.get("product") !== "crm" && known("data-product", params.get("product")) ? params.get("product") : "";
  const fieldId = productId && (FIELDS[productId] || []).includes(params.get("field")) ? params.get("field") : "";
  const crmType = !productId && params.get("crm") !== "business" && known("data-crm", params.get("crm")) ? params.get("crm") : "";
  let crmTypes = null; // GET /site/crm-types, once

  // The bar (D148): the four that always show, then one more place for the product last chosen
  // from Other (SCM at first, kept in this browser); the product it replaces goes back into Other.
  const products = [...$("productList").querySelectorAll("[data-product]")].map((link) => link.dataset.product);
  let fifth = "scm";
  try {
    const kept = localStorage.getItem(LAST_KEY);
    if (products.includes(kept) && !FIXED.includes(kept)) fifth = kept;
  } catch {
    /* nothing kept: SCM */
  }
  if (productId && !FIXED.includes(productId) && productId !== fifth) {
    fifth = productId;
    try {
      localStorage.setItem(LAST_KEY, fifth);
    } catch {
      /* this page shows it all the same */
    }
  }
  const itemOf = (id) => {
    const item = document.createElement("li");
    item.append($("productList").querySelector(`[data-product="${id}"]`).cloneNode(true));
    return item;
  };
  const inBar = [...FIXED, fifth];
  $("barList").append(...inBar.map(itemOf));
  $("otherList").append(...products.filter((id) => !inBar.includes(id)).map(itemOf));

  // A coming product: its kinds of business in the box's first menu (all of it first), and the
  // page's sections are its own.
  if (productId) {
    $("crmTypeList").hidden = true;
    $("fieldList").hidden = false;
    $("fieldList").innerHTML = ["", ...FIELDS[productId]]
      .map((field) => `<li><a href="index.html?product=${productId}${field ? `&field=${field}` : ""}" data-field="${field || "all"}" data-i18n="${field ? `lp.prod.${productId}.field.${field}.name` : "lp.sub.every"}"></a></li>`)
      .join("");
    document.querySelectorAll("[data-sub]").forEach((link) => {
      link.href = `#p-${link.dataset.sub}`;
    });
  }
  // The header's lists, copied into the phone menu (before the texts go in, so both get them).
  document.querySelectorAll("[data-copy-of]").forEach((box) => {
    const copy = $(box.dataset.copyOf).cloneNode(true);
    copy.removeAttribute("id");
    copy.removeAttribute("class");
    copy.querySelectorAll("[id], .lp-dd-title").forEach((el) => (el.matches(".lp-dd-title") ? el.remove() : el.removeAttribute("id")));
    box.replaceWith(copy);
  });

  const show = (selector, on) => document.querySelectorAll(selector).forEach((el) => { el.hidden = !on; });
  const markCurrent = (attribute, id) =>
    document.querySelectorAll(`[${attribute}]`).forEach((link) => {
      if (link.getAttribute(attribute) === id) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  const typeName = () => t(`crmType.${crmType}`);
  // D152: "Start free trial" on a CRM type's page carries the type to sign-up (the company form
  // then has it chosen).
  const SIGNUP = "login.html?signup=1";
  const signupHref = () => (crmType && !productId ? `${SIGNUP}&crm=${encodeURIComponent(crmType)}` : SIGNUP);
  // A product's name as the Products menu shows it (most are the same in both languages).
  const productName = () => $("productList").querySelector(`[data-product="${productId}"] b`).textContent.trim();

  function applyPage() {
    document.body.classList.toggle("is-product", Boolean(productId));
    markCurrent("data-crm", productId ? "" : crmType || "business");
    markCurrent("data-product", productId || "crm");
    markCurrent("data-field", productId ? fieldId || "all" : "");
    if (productId) {
      drawProduct();
      return;
    }
    $("subbar").setAttribute("aria-label", t("lp.sub.label", { name: "CRM" }));
    if (!crmType) return;
    document.querySelectorAll(`a[href="${SIGNUP}"]`).forEach((link) => link.setAttribute("href", signupHref()));
    const type = typeName();
    $("heroEyebrow").textContent = t("lp.crm.eyebrow", { type });
    $("heroTitle").textContent = t(`lp.crm.${crmType}.h1`);
    $("heroLead").textContent = t(`lp.crm.${crmType}.lead`);
    document.title = t("lp.crm.title", { type });
    drawMadeFor();
  }

  // A coming product's page (D148): what it is for, what it will do, the kinds of business it is
  // shaped for, and honest screens, pricing and questions until it opens.
  function drawProduct() {
    const name = productName();
    const key = (part) => `lp.prod.${productId}.${part}`;
    const field = fieldId ? t(key(`field.${fieldId}.name`)) : "";
    show(".lp-crm-only", false);
    show(".lp-product-only", true);
    $("subbar").setAttribute("aria-label", t("lp.sub.label", { name }));
    $("typesTitle").textContent = t("lp.sub.fieldsTitle", { name });
    $("heroEyebrow").textContent = field ? t("lp.prod.fieldEyebrow", { name, field }) : t("lp.prod.eyebrow", { name });
    $("heroTitle").textContent = t(key(fieldId ? `field.${fieldId}.h1` : "h1"));
    $("heroLead").textContent = t(key(fieldId ? `field.${fieldId}.lead` : "about"));
    $("productNote").textContent = t("lp.prod.note", { name });
    $("productCardTitle").textContent = t("lp.prod.covers", { name });
    $("productPoints").innerHTML = [1, 2, 3, 4].map((n) => `<li>${icon("check")}<span>${escapeText(t(key(`p${n}`)))}</span></li>`).join("");
    // What it will do: six parts, three things in each.
    $("pFeaturesTitle").textContent = t("lp.prod.featuresTitle", { name });
    $("pFeaturesSub").textContent = t("lp.prod.featuresSub");
    $("pFeatures").innerHTML = FEATURE_ICONS.map((iconName, index) => {
      const part = (p) => escapeText(t(key(`f${index + 1}.${p}`)));
      return `<article class="lp-card">
          <div class="lp-card-icon">${icon(iconName)}</div>
          <h3>${part("title")}</h3>
          <p>${part("text")}</p>
          <ul class="lp-ticks">${["t1", "t2", "t3"].map((p) => `<li>${icon("check")}<span>${part(p)}</span></li>`).join("")}</ul>
        </article>`;
    }).join("");
    // Its kinds of business, each with its own page.
    $("pFieldsTitle").textContent = t("lp.prod.fieldsTitle", { name });
    $("pFieldsSub").textContent = t("lp.prod.fieldsSub", { name });
    $("pFields").innerHTML = FIELDS[productId]
      .map((id) => `<a class="lp-field" href="index.html?product=${productId}&field=${id}"${id === fieldId ? ' aria-current="page"' : ""}>
          <b>${escapeText(t(key(`field.${id}.name`)))}</b>
          <span>${escapeText(t(key(`field.${id}.h1`)))}</span>
        </a>`)
      .join("");
    $("pScreensTitle").textContent = t("lp.prod.screensTitle", { name });
    $("pScreensText").textContent = t("lp.prod.screensText", { name });
    $("pPricingTitle").textContent = t("lp.prod.pricingTitle", { name });
    $("pPricingText").textContent = t("lp.prod.pricingText", { name });
    $("pFaqTitle").textContent = t("lp.prod.faqTitle", { name });
    $("pFaq").innerHTML = [1, 2, 3, 4]
      .map((n) => `<details>
          <summary><span>${escapeText(t(`lp.prod.q${n}`, { name }))}</span> ${icon("plus")}</summary>
          <p>${escapeText(t(`lp.prod.a${n}`, { name }))}</p>
        </details>`)
      .join("");
    $("finalTitle").textContent = t("lp.prod.finalTitle");
    $("finalText").textContent = t("lp.prod.finalText");
    document.title = field ? t("lp.prod.fieldTitle", { name, field }) : t("lp.prod.title", { name });
  }

  // What choosing this CRM type on the company form adds, card by card (only the ones it has).
  function drawMadeFor() {
    const setup = crmTypes?.find((entry) => entry.id === crmType);
    if (!setup) return;
    const names = (list) => list.map((words) => words[language] || words.en);
    const chips = (list) => `<ul class="lp-chips">${list.map((name) => `<li>${escapeText(name)}</li>`).join("")}</ul>`;
    const card = (iconName, key, list, extra) =>
      list.length
        ? `<article class="lp-card">
            <div class="lp-card-icon">${icon(iconName)}</div>
            <h3>${escapeText(t(`lp.made.${key}`))}</h3>
            <p>${escapeText(t(`lp.made.${key}Text`))}</p>
            ${extra || chips(names(list))}
          </article>`
        : "";
    const stages = `<ul class="lp-chips lp-stages">${names(setup.stages).map((name) => `<li>${escapeText(name)}</li>`).join("")}<li class="is-end">${escapeText(t("lp.made.won"))}</li></ul>`;
    $("madeTitle").textContent = t("lp.made.title", { type: typeName() });
    $("madeSub").textContent = t("lp.made.sub", { type: typeName() });
    $("madeGrid").innerHTML = [
      card("funnel", "stages", setup.stages, stages),
      card("list", "fields", setup.fields),
      card("box", "products", setup.products),
      card("doc", "records", setup.records),
      card("calendar", "templates", setup.templates),
      card("reply", "replies", setup.quickReplies),
    ].join("");
    $("madeNote").textContent = t("lp.made.note");
    $("made-for").hidden = false;
  }
  async function loadCrmTypes() {
    if (!crmType) return;
    try {
      crmTypes = await getJson("/site/crm-types");
      drawMadeFor();
    } catch {
      /* the page reads well without it */
    }
  }

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
    const key = `lp.limit.${metric}${n === 1 ? "One" : ""}`; // i18n-ok: part of a text key
    if (!has(key)) return "";
    return t(key, { n: count(n) }) + (metric === "whatsappNumbers" && n >= 20 ? t("lp.limit.metaMax") : "");
  };
  // plans.js names features and "every plan has" in English; the page has them translated,
  // else (a new or changed one) shows the English.
  const featureLabel = (feature, label) => (has(`lp.feature.${feature}`) ? t(`lp.feature.${feature}`) : label);
  const includedSlug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 6).join("-");
  const includedLabel = (text) => (has(`lp.included.${includedSlug(text)}`) && texts.en?.[`lp.included.${includedSlug(text)}`] === text ? t(`lp.included.${includedSlug(text)}`) : text);
  const icon = (name) => `<svg class="lp-ico" aria-hidden="true"><use href="#i-${name}" /></svg>`;

  // Monthly or yearly prices (D125), switched above the plans.
  let interval = "monthly";
  let shownCatalog = null;

  function planCard(plan, catalog) {
    const trial = plan.key === catalog.trialPlan;
    const yearly = interval === "yearly" && plan.yearly;
    const price = yearly ? plan.yearly : plan;
    const save = yearly && plan.yearly.savePct > 0 ? `<span class="lp-save">${escapeText(t("lp.save", { pct: plan.yearly.savePct }))}</span>` : "";
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
        <p class="lp-price">${rupees(price.pricePaise)}<small>${escapeText(t(yearly ? "lp.perYear" : "lp.perMonth"))}</small>${save}</p>
        <p class="lp-gst">${escapeText(t("lp.withGst", { total: rupees(price.totalPaise), gst: catalog.gstPct }))}</p>
        <ul>${limits.map((text) => `<li>${escapeText(text)}</li>`).join("")}</ul>
        <ul class="lp-features">${features.join("")}</ul>
        <a class="lp-btn ${trial ? "lp-btn-dark" : "lp-btn-light"} lp-btn-block" href="${escapeText(signupHref())}">${escapeText(t("lp.startTrial"))}</a>
      </article>`;
  }

  // The cards and the line above them, in the chosen interval.
  function drawPlans() {
    const catalog = shownCatalog;
    if (!catalog) return;
    $("plans").innerHTML = catalog.plans.map((plan) => planCard(plan, catalog)).join("");
    const trialPlan = catalog.plans.find((plan) => plan.key === catalog.trialPlan);
    if (trialPlan) {
      const every = Object.values(trialPlan.features).every(Boolean) ? t("lp.everyFeature") : "";
      $("pricingSub").textContent = t(interval === "yearly" ? "lp.pricingSubYearly" : "lp.pricingSub", { gst: catalog.gstPct, days: catalog.trialDays, plan: trialPlan.name, every });
    }
    document.querySelectorAll("#planInterval [data-interval]").forEach((button) => {
      const on = button.dataset.interval === interval;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-pressed", String(on));
    });
  }
  $("planInterval").addEventListener("click", (event) => {
    const button = event.target.closest("[data-interval]");
    if (!button || button.dataset.interval === interval) return;
    interval = button.dataset.interval;
    drawPlans();
  });

  async function loadPlans() {
    const box = $("plans");
    box.innerHTML = `<p class="lp-loading">${escapeText(t("lp.loading-the-plans"))}</p>`;
    try {
      shownCatalog = await getJson("/site/plans");
      drawPlans();
      $("includedList").innerHTML = shownCatalog.included.map((text) => `<li>${icon("check")}<span>${escapeText(includedLabel(text))}</span></li>`).join("");
      $("included").hidden = !shownCatalog.included.length;
      const trialPlan = shownCatalog.plans.find((plan) => plan.key === shownCatalog.trialPlan);
      if (trialPlan) $("trialNote").textContent = t("lp.trialNote", { days: shownCatalog.trialDays, plan: trialPlan.name });
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
  const menus = [menu, ...document.querySelectorAll(".lp-dd")];
  menus.forEach((box) => {
    box.addEventListener("toggle", () => {
      if (box.open) menus.forEach((other) => { if (other !== box) other.open = false; });
    });
    box.addEventListener("click", (event) => {
      if (event.target.closest("a")) box.open = false;
    });
  });
  document.addEventListener("click", (event) => {
    menus.forEach((box) => { if (box.open && !box.contains(event.target)) box.open = false; });
  });
  document.addEventListener("keydown", (event) => {
    const open = menus.find((box) => box.open);
    if (event.key === "Escape" && open) {
      open.open = false;
      open.querySelector("summary").focus();
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
    if (!productId) loadPlans();
  });

  $("year").textContent = String(new Date().getFullYear());
  Promise.all([loadTexts("en"), language === "en" ? null : loadTexts(language)]).then(() => {
    applyTexts();
    if (!productId) loadPlans();
    loadCrmTypes();
  });
  loadOperator();
})();
