/**
 * connect-whatsapp.js — "Connect WhatsApp" (D60), owners and admins.
 * Meta's Embedded Signup, checked 2026-10-08 against Meta's docs: the Facebook JS SDK opens
 * Meta's popup with FB.login({ config_id, response_type: 'code', override_default_response_type,
 * extras: { setup, sessionInfoVersion: '3', featureType: 'whatsapp_business_app_onboarding' } }).
 * The popup tells this page what was chosen with a window message (type WA_EMBEDDED_SIGNUP:
 * FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING with the WABA id, FINISH with the WABA and phone number
 * ids for a new number, CANCEL, ERROR), and FB.login hands over a code valid 30 seconds. Both go
 * to POST /whatsapp/accounts/embedded-signup; the server does the rest. Then the import of the
 * chats is shown as it happens (Socket.IO whatsapp:sync, and a check every few seconds).
 */
// Starts once the page's texts are in (i18n/*.json, CP5).
crmI18n.ready.then(function connectWhatsApp() {
  const $ = (id) => document.getElementById(id);
  if (!isOrgManager()) {
    window.location.replace("Inbox.html"); // connecting WhatsApp is an owner's or admin's job
    return;
  }
  const VIEWS = ["loadingView", "notReadyView", "connectView", "progressView"];
  const show = (id) => VIEWS.forEach((view) => {
    $(view).hidden = view !== id;
  });
  const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const FRIENDLY = {
    CONNECT_NOT_AVAILABLE: t("cw.err.notAvailable"),
    WHATSAPP_CONNECT_FAILED: t("cw.err.connectFailed"),
    NUMBER_IN_USE: t("cw.err.numberInUse"),
    WHATSAPP_UNREACHABLE: t("cw.err.unreachable"),
  };

  let config = null;
  let mode = "coexistence";
  let session = {};
  let watching = null;

  // After this page: Invite your team (once), then an empty company profile, else the dashboard.
  const afterPage = () => onboardingNextPage();
  async function continueToCrm(event) {
    event?.preventDefault();
    window.location.href = await afterPage();
  }
  $("skipBtn").addEventListener("click", (event) => {
    setPreference("whatsappConnectSkippedAt", Date.now());
    continueToCrm(event);
  });
  document.querySelectorAll("[data-continue]").forEach((el) => el.addEventListener("click", continueToCrm));

  function showError(message, details = "") {
    const box = $("connectError");
    box.innerHTML = `${escapeHtml(message)}${details && details !== message ? `<details><summary>${escapeHtml(t("cw.details"))}</summary>${escapeHtml(details)}</details>` : ""}`;
    box.hidden = false;
    show("connectView");
  }

  // --- Meta's popup ---------------------------------------------------------------------------
  function loadSdk() {
    if (window.FB) return Promise.resolve();
    return new Promise((resolve, reject) => {
      window.fbAsyncInit = () => {
        window.FB.init({ appId: config.appId, autoLogAppEvents: true, xfbml: false, version: config.graphVersion });
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

  // What the popup chose (it can arrive before or after FB.login's code).
  window.addEventListener("message", (event) => {
    let host = "";
    try {
      host = new URL(event.origin).hostname;
    } catch {
      return;
    }
    if (!/(^|\.)facebook\.com$/.test(host)) return;
    let data;
    try {
      data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
    if (data.event === "CANCEL") session.cancelledAt = data.data?.current_step || "start";
    else if (data.event === "ERROR") session.error = data.data?.error_message || t("cw.err.metaProblem");
    else if (String(data.event || "").startsWith("FINISH")) {
      session.event = data.event;
      session.wabaId = String(data.data?.waba_id || "");
      session.phoneNumberId = String(data.data?.phone_number_id || "");
    }
    finish();
  });

  async function openPopup(chosenMode) {
    mode = chosenMode;
    session = {};
    $("connectError").hidden = true;
    $("connectBtn").disabled = true;
    try {
      await loadSdk();
    } catch (error) {
      $("connectBtn").disabled = false;
      showError(error.message);
      return;
    }
    window.FB.login((response) => {
      session.code = response?.authResponse?.code || "";
      session.loginDone = true;
      finish();
    }, {
      config_id: config.configId,
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {}, sessionInfoVersion: "3", ...(mode === "coexistence" && { featureType: "whatsapp_business_app_onboarding" }) },
    });
  }

  function finish() {
    if (!session.loginDone || session.submitting) return;
    $("connectBtn").disabled = false;
    if (session.code && session.wabaId) {
      submit();
      return;
    }
    if (session.code && !session.waitedForMessage) {
      // The popup's message can come a moment after the code.
      session.waitedForMessage = true;
      setTimeout(finish, 3000);
      return;
    }
    if (session.code) return showError(t("cw.err.noAccount"));
    if (session.error) return showError(t("cw.err.notFinished"), session.error);
    return showError(session.cancelledAt ? t("cw.err.closedAt", { step: String(session.cancelledAt).replace(/_/g, " ").toLowerCase() }) : t("cw.err.closed"));
  }

  async function submit() {
    session.submitting = true;
    $("progressTitle").textContent = t("cw.connecting");
    $("progressText").textContent = t("cw.settingUp");
    $("importBox").hidden = true;
    $("openInboxBtn").hidden = true;
    $("retrySyncBtn").hidden = true;
    $("numberName").textContent = "";
    $("numberPhone").textContent = "";
    show("progressView");
    const isAppNumber = session.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
    try {
      const account = await crmApi("/whatsapp/accounts/embedded-signup", json({
        code: session.code,
        wabaId: session.wabaId,
        ...(session.phoneNumberId && { phoneNumberId: session.phoneNumberId }),
        mode: isAppNumber ? "coexistence" : "new",
      }));
      showAccount(account);
    } catch (error) {
      showError(FRIENDLY[error.code] || t("cw.err.generic"), error.message);
    } finally {
      session.submitting = false;
    }
  }

  // --- connected: the import of the chats ----------------------------------------------------------
  function overallPercent(sync) {
    if (sync.status === "done") return 100;
    const phase = Number(sync.phase) || 0;
    const progress = Math.min(Math.max(Number(sync.progress) || 0, 0), 100);
    return Math.round(((phase * 100) + progress) / 3);
  }

  function showAccount(account) {
    show("progressView");
    $("retrySyncBtn").dataset.accountId = account.id;
    $("numberName").textContent = account.verifiedName || account.name || "WhatsApp";
    $("numberPhone").textContent = account.displayPhone || "";
    $("openInboxBtn").hidden = false;
    const sync = account.sync;
    if (account.connectionType !== "coexistence" || !sync) {
      $("progressTitle").textContent = t("cw.connected.title");
      $("progressText").textContent = t("cw.connected.text", { phone: account.displayPhone || t("cw.yourNumber") });
      $("importBox").hidden = true;
      return stopWatching();
    }
    $("importBox").hidden = false;
    $("importBar").style.width = `${overallPercent(sync)}%`;
    $("countChats").textContent = sync.chats.toLocaleString(crmI18n.locale());
    $("countMessages").textContent = sync.messages.toLocaleString(crmI18n.locale());
    $("countContacts").textContent = sync.contacts.toLocaleString(crmI18n.locale());
    $("retrySyncBtn").hidden = !["failed", "declined"].includes(sync.status);
    const texts = {
      pending: [t("cw.sync.importing"), t("cw.sync.pendingText")],
      importing: [t("cw.sync.importing"), t("cw.sync.importingText")],
      done: [t("cw.sync.doneTitle"), t("cw.sync.doneText")],
      declined: [t("cw.sync.declinedTitle"), t("cw.sync.declinedText")],
      failed: [t("cw.sync.failedTitle"), sync.error ? t("cw.sync.metaSaid", { error: sync.error }) : t("cw.sync.failedText")],
    };
    const [title, text] = texts[sync.status] || texts.pending;
    $("progressTitle").textContent = title;
    $("progressText").textContent = text;
    $("importNote").hidden = !["pending", "importing"].includes(sync.status);
    if (["pending", "importing"].includes(sync.status)) watch(account.id);
    else stopWatching();
    return undefined;
  }

  // Live over Socket.IO when it is available, and a check every few seconds either way.
  function stopWatching() {
    clearInterval(watching?.timer);
    watching?.socket?.disconnect();
    watching = null;
  }
  function watch(accountId) {
    if (watching?.accountId === accountId) return;
    stopWatching();
    watching = { accountId };
    const refresh = async () => {
      try {
        const status = await crmApi("/whatsapp/connect");
        const account = status.accounts.find((item) => String(item.id) === String(accountId));
        if (account) showAccount(account);
      } catch {
        /* try again at the next tick */
      }
    };
    watching.timer = setInterval(refresh, 5000);
    const origin = CRM_API_BASE.replace(/\/api\/v1$/, "");
    const start = () => {
      if (!watching || !window.io) return;
      watching.socket = window.io(origin, { auth: (cb) => cb({ token: localStorage.getItem(KEYS.SESSION) || "" }), transports: ["websocket", "polling"] });
      watching.socket.on("whatsapp:sync", ({ accountId: id }) => {
        if (String(id) === String(accountId)) refresh();
      });
    };
    if (window.io) start();
    else {
      const script = document.createElement("script");
      script.src = `${origin}/socket.io/socket.io.min.js`;
      script.onload = start;
      document.head.appendChild(script);
    }
  }

  $("retrySyncBtn").addEventListener("click", async () => {
    $("retrySyncBtn").disabled = true;
    try {
      showAccount(await crmApi(`/whatsapp/accounts/${$("retrySyncBtn").dataset.accountId}/sync`, { method: "POST" }));
    } catch (error) {
      showToast(apiErrorMessage(error, t("cw.err.retry")), "error");
    } finally {
      $("retrySyncBtn").disabled = false;
    }
  });

  $("connectBtn").addEventListener("click", () => openPopup("coexistence"));
  $("newNumberBtn").addEventListener("click", () => openPopup("new"));

  async function load() {
    try {
      config = await crmApi("/whatsapp/connect");
    } catch (error) {
      showError(apiErrorMessage(error, t("cw.err.load")));
      return;
    }
    // ?add=1 (Settings → WhatsApp → Connect another number, or Reconnect): straight to the button.
    const adding = new URLSearchParams(window.location.search).has("add");
    const connected = config.accounts.find((account) => account.status === "connected");
    if (connected && !(adding && config.available)) {
      showAccount(connected);
    } else if (!config.available) {
      show("notReadyView");
    } else {
      show("connectView");
    }
  }

  load();
});
