/**
 * settings-pages.js — Settings → Team & Access → "Pages your company uses" (D76, owners and admins)
 * One switch per page, saved at once. A page switched off leaves everyone's menu and the global
 * search; it still opens from a link, since it is tidying, not a permission. The menu follows
 * through js/app.js (pageSwitchedOff): on this page at once, on the others from /auth/me.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsPages() {
  const section = document.getElementById("pagesSection");
  if (!section || !isOrgManager()) return;
  const list = document.getElementById("pagesList");
  // In menu order. Dashboard, Customers and Settings are always on
  // (backend/src/constants/permissions.js HIDEABLE_MODULES).
  const PAGES = [
    ["inbox", "nav.inbox", "fa-solid fa-inbox"],
    ["leads", "nav.leads", "fa-solid fa-bullseye"],
    ["accounts", "nav.accounts", "fa-solid fa-building"],
    ["deals", "nav.deals", "fa-solid fa-handshake"],
    ["marketing", "nav.marketing", "fa-solid fa-bullhorn"],
    ["automation", "nav.automation", "fa-solid fa-gears"],
    ["tasks", "nav.tasks", "fa-solid fa-list-check"],
    ["calendar", "nav.calendar", "fa-solid fa-calendar-days"],
    ["documents", "nav.documents", "fa-solid fa-file-lines"],
    ["support", "nav.support", "fa-solid fa-headset"],
    ["reports", "nav.reports", "fa-solid fa-chart-line"],
    ["insights", "nav.aiInsights", "fa-solid fa-brain"],
    ["products", "nav.products", "fa-solid fa-box-open"],
  ];
  let hidden = [];
  let saving = Promise.resolve();

  function render() {
    list.innerHTML = PAGES.map(([module, key, icon]) => `
      <label class="page-switch">
        <i class="${icon}" aria-hidden="true"></i>
        <span class="page-switch-name">${escapeHtml(t(key))}</span>
        <input type="checkbox" role="switch" data-module="${module}"${hidden.includes(module) ? "" : " checked"} />
        <span class="page-switch-track" aria-hidden="true"></span>
      </label>`).join("");
  }

  // The menu on this page changes at once; the other pages read it from /auth/me.
  function applyToMenu() {
    saveCompanyInfo({ ...(getCompanyInfo() || {}), hiddenModules: hidden });
    hideUnavailableModules();
  }

  async function load() {
    try {
      ({ hiddenModules: hidden = [] } = await crmApi("/organization/settings"));
      render();
      section.hidden = false;
      applyToMenu();
    } catch {
      section.hidden = true;
    }
  }

  // Each click is saved in turn, so quick clicks on several switches all count.
  list.addEventListener("change", (event) => {
    const toggle = event.target.closest("input[data-module]");
    if (!toggle) return;
    const { module } = toggle.dataset;
    const on = toggle.checked;
    const name = t(PAGES.find(([key]) => key === module)[1]);
    saving = saving.then(async () => {
      const next = on ? hidden.filter((key) => key !== module) : [...new Set([...hidden, module])];
      try {
        ({ hiddenModules: hidden } = await crmApi("/organization/settings", jsonRequest("PATCH", { hiddenModules: next })));
        applyToMenu();
        showToast(t(on ? "pages.shown" : "pages.hidden", { page: name }), "success");
      } catch (error) {
        toggle.checked = !on;
        showToast(apiErrorMessage(error, t("pages.err.save")), "error");
      }
    });
  });

  // Read once the texts are in, so the switches carry the page names in the chosen language.
  crmI18n.ready.then(load);
})();
