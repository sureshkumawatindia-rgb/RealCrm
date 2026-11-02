/**
 * settings-social.js — Settings → WhatsApp → Instagram and Messenger (G8, D112, owners and admins)
 * Connects the company's Facebook Pages with Facebook Login for Business (the platform's Meta app):
 * each Page's Messenger, and the Instagram business account linked to it, then come into the
 * Inbox. Lists them with their last message from Meta; disconnects one. Developer test tools add a
 * test Page. One IIFE: no globals.
 */
(function settingsSocial() {
  const box = document.getElementById("socialSection");
  if (!box || !isOrgManager()) return;
  const $ = (id) => document.getElementById(id);
  const ICON = { instagram: "fa-brands fa-instagram", messenger: "fa-brands fa-facebook-messenger" };
  let data = null; // { accounts, connect: { available, appId, configId, graphVersion }, devTools }

  const when = (iso) => (iso ? new Date(iso).toLocaleString(crmI18n.locale(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

  function accountHtml(a) {
    const title = a.channel === "instagram" ? `${a.username ? `@${a.username}` : a.name}` : a.name;
    const badge = a.status === "connected"
      ? `<span class="badge badge-success">${escapeHtml(t("soc.status.connected"))}</span>`
      : a.status === "error" ? `<span class="badge badge-danger">${escapeHtml(t("soc.status.error"))}</span>` : `<span class="badge badge-neutral">${escapeHtml(t("soc.status.disconnected"))}</span>`;
    const detail = [
      t(a.channel === "instagram" ? "soc.kind.instagram" : "soc.kind.messenger"),
      a.lastWebhookAt ? t("soc.lastMessage", { when: when(a.lastWebhookAt) }) : t("soc.noMessage"),
    ].join(" · ");
    return `<div class="social-card ${escapeHtml(a.channel)}">
      <i class="${ICON[a.channel]} social-mark" aria-hidden="true"></i>
      <div class="social-main">
        <div class="social-name"><strong>${escapeHtml(title || a.externalId)}</strong>${badge}${a.provider === "mock" ? `<span class="badge badge-neutral">${escapeHtml(t("soc.testPage"))}</span>` : ""}</div>
        <div class="settings-hint">${escapeHtml(detail)}</div>
        ${a.statusMessage ? `<div class="social-error">${escapeHtml(a.statusMessage)}</div>` : ""}
      </div>
      ${a.status !== "disconnected" ? `<button class="btn btn-outline" type="button" data-social-off="${escapeHtml(a.id)}">${escapeHtml(t("wa.disconnect"))}</button>` : ""}
    </div>`;
  }

  function render() {
    const accounts = data.accounts || [];
    $("socialList").innerHTML = accounts.length ? accounts.map(accountHtml).join("") : `<p class="settings-hint">${escapeHtml(t("soc.none"))}</p>`;
    $("socialConnect").hidden = !data.connect.available;
    $("socialNotReady").hidden = data.connect.available;
    $("socialTest").hidden = !data.devTools;
    const live = accounts.some((a) => a.status !== "disconnected");
    $("socialConnect").querySelector("span").textContent = t(live ? "soc.connectMore" : "soc.connect");
  }

  async function load() {
    try {
      data = await crmApi("/social");
      box.hidden = false;
      render();
    } catch (error) {
      box.hidden = false;
      $("socialList").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("soc.loadFailed")))}</p>`;
    }
  }

  // --- Facebook Login for Business (Meta's popup) gives a code; the server does the rest ---
  function loadSdk() {
    if (window.FB) return Promise.resolve();
    return new Promise((resolve, reject) => {
      window.fbAsyncInit = () => {
        window.FB.init({ appId: data.connect.appId, autoLogAppEvents: true, xfbml: false, version: data.connect.graphVersion });
        resolve();
      };
      const script = document.createElement("script");
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.async = true;
      script.defer = true;
      script.crossOrigin = "anonymous";
      script.onerror = () => reject(new Error(t("cw.err.sdk")));
      document.body.appendChild(script);
    });
  }

  async function connect() {
    const button = $("socialConnect");
    button.disabled = true;
    try {
      await loadSdk();
    } catch (error) {
      button.disabled = false;
      showToast(error.message, "error");
      return;
    }
    window.FB.login(async (response) => {
      const code = response?.authResponse?.code || "";
      if (!code) {
        button.disabled = false;
        showToast(t("soc.cancelled"), "info");
        return;
      }
      try {
        data = await crmApi("/social/connect", jsonRequest("POST", { code }));
        render();
        showToast(t("soc.connected"), "success");
      } catch (error) {
        showToast(apiErrorMessage(error, t("soc.failed")), "error");
      } finally {
        button.disabled = false;
      }
    }, { config_id: data.connect.configId, response_type: "code", override_default_response_type: true });
  }

  $("socialConnect").addEventListener("click", connect);
  $("socialTest").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      data = await crmApi("/social/test", { method: "POST" });
      render();
      showToast(t("soc.testAdded"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("soc.failed")), "error");
    } finally {
      $("socialTest").disabled = false;
    }
  });
  $("socialList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-social-off]");
    if (!button || !confirm(t("soc.disconnectConfirm"))) return;
    button.disabled = true;
    try {
      await crmApi(`/social/accounts/${button.dataset.socialOff}`, { method: "DELETE" });
      showToast(t("soc.disconnected"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("soc.failed")), "error");
    }
    await load();
  });

  // Loaded the first time the tab opens (or now, when the page opens on it).
  let loaded = false;
  const loadOnce = () => {
    if (loaded) return;
    loaded = true;
    load();
  };
  document.querySelector('.settings-tab[data-panel="whatsapp"]')?.addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="whatsapp"]')?.classList.contains("active")) crmI18n.ready.then(loadOnce);
})();
