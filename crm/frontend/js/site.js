/**
 * site.js — agreem360's own website (agreem360.html, D149), the "mother" of the product pages.
 * Puts the page in English or Hindi (i18n/en.json and hi.json, "site." and the home page's "lp."
 * texts), fills the trial's length from GET /site/plans and the support WhatsApp and hours from
 * GET /site, runs the header's menus, and lets the sections come in as the page scrolls.
 * No sign-in and no app.js, so the page stays light.
 */
(function agreem360Site() {
  // Like app.js: the API is on the same origin, except under VS Code Live Server.
  const API =
    /^https?:$/.test(window.location.protocol) && !["5500", "5501"].includes(window.location.port)
      ? `${window.location.origin}/api/v1`
      : "http://127.0.0.1:3000/api/v1";
  const $ = (id) => document.getElementById(id);

  // --- language (the same choice as the CRM's pages: crm_prefs in this browser) ----------------
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
  function escapeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // What the server said (kept, so a change of language can write it again).
  let trialDays = null;
  let support = null;

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
    document.title = t("site.title");
    $("langBtn").textContent = language === "hi" ? "English" : "हिंदी"; // i18n-ok: each language by its own name
    $("langBtn").lang = language === "hi" ? "en" : "hi";
    applyServer();
    applySession();
    document.documentElement.classList.remove("i18n-pending");
  }

  // The trial's length (D147) and how to reach support, once the server has said.
  function applyServer() {
    if (trialDays) {
      document.querySelectorAll(".js-trial-days").forEach((el) => {
        el.textContent = String(trialDays);
      });
    }
    const whatsapp = support?.whatsapp ? String(support.whatsapp).replace(/\D/g, "") : "";
    $("whatsappLink").hidden = !whatsapp;
    if (whatsapp) $("whatsappLink").href = `https://wa.me/${whatsapp}?text=${encodeURIComponent(t("site.final.whatsappText"))}`;
    $("supportHours").hidden = !support?.hours;
    if (support?.hours) $("supportHours").textContent = t("site.final.hours", { hours: support.hours });
  }

  // Signed in on this browser: the header opens the CRM instead of asking to sign up again.
  function applySession() {
    let signedIn = false;
    try {
      const session = localStorage.getItem("crm_session");
      signedIn = Boolean(session) && session.split(".").length === 3;
    } catch {
      /* storage blocked: as if signed out */
    }
    if (!signedIn) return;
    $("signInLink").hidden = true;
    $("startLink").href = "dashboard.html";
    $("startLink").innerHTML = `<span class="s-long">${escapeText(t("site.openCrm"))}</span><span class="s-short">${escapeText(t("site.openCrm"))}</span>`;
  }

  async function getJson(path) {
    const response = await fetch(API + path, { credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).data;
  }
  async function loadServer() {
    const [plans, site] = await Promise.allSettled([getJson("/site/plans"), getJson("/site")]);
    if (plans.status === "fulfilled" && plans.value?.trialDays) trialDays = plans.value.trialDays;
    if (site.status === "fulfilled") support = site.value?.support || null;
    applyServer();
  }

  // --- the header: its menus, one open at a time, closed by a click outside or Escape -----------
  document.querySelectorAll("[data-copy-of]").forEach((box) => {
    const list = $(box.dataset.copyOf).cloneNode(true);
    list.removeAttribute("id");
    list.removeAttribute("class");
    box.replaceWith(list);
  });
  const header = $("header");
  const markScrolled = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", markScrolled, { passive: true });
  markScrolled();
  const menus = [...document.querySelectorAll(".s-dd, .s-menu")];
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

  // --- the sections come in as they scroll into view (all at once without the browser's help) --
  const reveals = [...document.querySelectorAll("[data-reveal]")];
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("is-in"));
  } else {
    const watcher = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          watcher.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
    );
    reveals.forEach((el) => watcher.observe(el));
  }

  // --- a different language: the texts at once ----------------------------------------------
  $("langBtn").addEventListener("click", async () => {
    language = language === "hi" ? "en" : "hi";
    try {
      localStorage.setItem("crm_prefs", JSON.stringify({ ...readPrefs(), language }));
    } catch {
      /* the choice is just not remembered */
    }
    await loadTexts(language);
    applyTexts();
  });

  $("year").textContent = String(new Date().getFullYear());
  Promise.all([loadTexts("en"), language === "en" ? null : loadTexts(language)]).then(applyTexts);
  loadServer().catch(() => {
    /* the page reads well with its own words */
  });
})();
