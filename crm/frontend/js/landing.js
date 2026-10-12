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

  function escapeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  async function getJson(path) {
    const response = await fetch(API + path, { credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).data;
  }

  const count = (n) => new Intl.NumberFormat("en-IN").format(n);
  function rupees(paise) {
    const digits = paise % 100 ? 2 : 0;
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(paise / 100);
  }
  // The same words as Settings → Plan & usage (js/settings-plan.js).
  const LIMIT_TEXT = {
    users: (n) => `${count(n)} user${n === 1 ? "" : "s"} (admins, agents, viewers)`,
    agents: (n) => `Up to ${count(n)} agent${n === 1 ? "" : "s"}`,
    whatsappNumbers: (n) => `${count(n)} WhatsApp number${n === 1 ? "" : "s"}${n >= 20 ? " (Meta's maximum)" : ""}`,
    contacts: (n) => `${count(n)} contacts`,
    broadcastsPerMonth: (n) => `${count(n)} broadcasts a month`,
    quotesPerMonth: (n) => `${count(n)} quotations a month`,
    templates: (n) => `${count(n)} message templates`,
  };
  const UNLIMITED_TEXT = {
    users: "Unlimited users",
    agents: "Unlimited agents",
    whatsappNumbers: "Unlimited WhatsApp numbers",
    contacts: "Unlimited contacts",
    broadcastsPerMonth: "Unlimited broadcasts",
    quotesPerMonth: "Unlimited quotations",
    templates: "Unlimited message templates",
  };
  const icon = (name) => `<svg class="lp-ico" aria-hidden="true"><use href="#i-${name}" /></svg>`;

  function planCard(plan, catalog) {
    const trial = plan.key === catalog.trialPlan;
    const limits = catalog.limits
      .map(({ metric }) => (plan.limits[metric] === null ? UNLIMITED_TEXT[metric] : LIMIT_TEXT[metric]?.(plan.limits[metric])))
      .filter(Boolean);
    const features = catalog.features.map(({ feature, label }) => {
      const has = plan.features[feature];
      return `<li class="${has ? "yes" : "no"}">${icon(has ? "check" : "dash")}<span>${escapeText(label)}${has ? "" : '<span class="lp-sr"> (not in this plan)</span>'}</span></li>`;
    });
    const id = `plan-${escapeText(plan.key)}`;
    return `
      <article class="lp-plan${trial ? " is-trial" : ""}" aria-labelledby="${id}">
        <div class="lp-plan-head">
          <h3 id="${id}">${escapeText(plan.name)}</h3>
          ${trial ? '<span class="lp-badge">Free trial plan</span>' : ""}
        </div>
        <p class="lp-price">${rupees(plan.pricePaise)}<small> /month</small></p>
        <p class="lp-gst">${rupees(plan.totalPaise)} with ${escapeText(catalog.gstPct)}% GST</p>
        <ul>${limits.map((text) => `<li>${escapeText(text)}</li>`).join("")}</ul>
        <ul class="lp-features">${features.join("")}</ul>
        <a class="lp-btn ${trial ? "lp-btn-dark" : "lp-btn-light"} lp-btn-block" href="login.html?signup=1">Start free trial</a>
      </article>`;
  }

  async function loadPlans() {
    const box = $("plans");
    box.innerHTML = '<p class="lp-loading">Loading the plans…</p>';
    try {
      const catalog = await getJson("/site/plans");
      const trialPlan = catalog.plans.find((plan) => plan.key === catalog.trialPlan);
      box.innerHTML = catalog.plans.map((plan) => planCard(plan, catalog)).join("");
      $("includedList").innerHTML = catalog.included.map((text) => `<li>${icon("check")}<span>${escapeText(text)}</span></li>`).join("");
      $("included").hidden = !catalog.included.length;
      if (trialPlan) {
        const everything = Object.values(trialPlan.features).every(Boolean) ? ", with every feature" : "";
        $("pricingSub").textContent = `Monthly prices in rupees, plus ${catalog.gstPct}% GST. Every new company gets ${catalog.trialDays} days of ${trialPlan.name} free${everything}; choose a plan whenever you are ready, and the rest of the trial stays free.`;
        $("trialNote").textContent = `${catalog.trialDays}-day free trial of ${trialPlan.name}. Sign in with Google to start; no card needed.`;
      }
    } catch {
      box.innerHTML = `
        <div class="lp-error" role="alert">
          The plans could not be loaded. Check the internet connection and try again.<br />
          <button class="lp-btn lp-btn-light" type="button" id="plansRetry">Try again</button>
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

  $("year").textContent = String(new Date().getFullYear());
  loadPlans();
  loadOperator();
})();
