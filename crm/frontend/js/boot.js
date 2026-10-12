/**
 * boot.js — the first script of every page, in <head> (CP5): sets the theme and the language
 * before anything is drawn, so a dark or Hindi page never flashes light or English first.
 * The signed-in person's choice comes from their copy of the account (crm_user, saved by
 * app.js); before signing in, this browser's choice (crm_prefs) or the browser's language.
 * The same rules as crmPreferences() in app.js, which takes over once the page has loaded.
 */
(function bootPage() {
  const root = document.documentElement;
  let language = "en";
  let theme = "system";
  try {
    const session = localStorage.getItem("crm_session");
    const user = JSON.parse(localStorage.getItem("crm_user") || "null");
    const prefs = JSON.parse(localStorage.getItem("crm_prefs") || "null") || {};
    if (session && session.split(".").length === 3) {
      language = user?.preferences?.language || "en";
      theme = user?.preferences?.theme || "system";
    } else {
      language = prefs.language || prefs.loginLanguage || (/^hi\b/i.test(navigator.language || "") ? "hi" : "en");
      theme = prefs.theme || "system";
    }
  } catch {
    /* storage blocked: English and the device's theme */
  }
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  if (language === "hi") {
    root.lang = "hi";
    // Hidden until app.js has put the Hindi texts in (at most 2 seconds, e.g. when offline).
    root.classList.add("i18n-pending");
    setTimeout(() => root.classList.remove("i18n-pending"), 2000);
  }
})();
