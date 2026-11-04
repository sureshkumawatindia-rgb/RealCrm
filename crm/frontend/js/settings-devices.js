/**
 * settings-devices.js — Settings → Your Profile → Where you're logged in (2026-10-08)
 * Like WhatsApp's linked devices: every browser and phone with this account open, how and when
 * it logged in, when it was last used, whether it stays logged in; log out one, or all others.
 * Logging one out ends it at once (the server checks the session on every request).
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsDevices() {
  const $ = (id) => document.getElementById(id);
  const METHODS = {
    "google+whatsapp": "setdev.method.whatsapp",
    "google+sms": "setdev.method.sms",
    qr: "setdev.method.qr",
    google: "setdev.method.google",
  };
  const when = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const day = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  function ago(iso) {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 2) return t("bell.justNow");
    if (minutes < 60) return t("setdev.min-ago", { minutes });
    if (minutes < 24 * 60) return t("setdev.h-ago", { v: Math.round(minutes / 60) });
    return when(iso);
  }

  function render({ devices }) {
    const list = $("deviceList");
    if (!devices.length) {
      list.innerHTML = `<li class="device-empty">${escapeHtml(t("setdev.no-other-device"))}</li>`;
      $("devicesLogoutOthersBtn").hidden = true;
      return;
    }
    list.innerHTML = devices.map((device) => {
      const phone = /Android|iPhone/.test(device.device);
      const meta = [
        t(METHODS[device.method] || METHODS.google),
        t("setdev.logged-in", { v: when(device.loggedInAt) }),
        device.current ? "" : t("setdev.last-used", { v: ago(device.lastActiveAt) }),
        device.rememberedUntil ? t("setdev.stays-logged-in-until", { v: day(device.rememberedUntil) }) : "",
      ].filter(Boolean).join(" · ");
      return `
        <li>
          <span class="device-icon"><i class="fa-solid ${phone ? "fa-mobile-screen" : "fa-desktop"}"></i></span>
          <span class="device-text">
            <span class="device-name">${escapeHtml(device.device)}</span>${device.current ? `<span class="device-here">${escapeHtml(t("setdev.this-device"))}</span>` : ""}
            <br /><span class="device-meta">${escapeHtml(meta)}</span>
          </span>
          <button class="btn btn-outline" type="button" data-device="${escapeHtml(device.id)}" data-current="${device.current ? "1" : ""}">${escapeHtml(t("setdev.log-out"))}</button>
        </li>`;
    }).join("");
    $("devicesLogoutOthersBtn").hidden = !devices.some((device) => !device.current);
  }

  async function load() {
    try {
      render(await crmApi("/auth/devices"));
    } catch (error) {
      $("deviceList").innerHTML = `<li class="device-empty">${escapeHtml(apiErrorMessage(error, t("setdev.could-not-load-the-list")))}</li>`;
    }
    loadLoginEmails();
  }

  // D104: the new-login alert by email too (only offered when the platform sends emails).
  async function loadLoginEmails() {
    try {
      const { email, emailsOn } = await crmApi("/auth/login-alerts");
      $("loginEmailToggle").checked = email;
      $("loginEmailRow").hidden = !emailsOn;
    } catch {
      $("loginEmailRow").hidden = true;
    }
  }
  $("loginEmailToggle").addEventListener("change", async (event) => {
    try {
      const { email } = await crmApi("/auth/login-alerts", jsonRequest("PATCH", { email: event.target.checked }));
      event.target.checked = email;
      showToast(email ? t("setdev.you-ll-get-an-email-about") : t("setdev.new-logins-only-under-the-bell"), "success");
    } catch (error) {
      event.target.checked = !event.target.checked;
      showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
    }
  });

  $("deviceList").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-device]");
    if (!button) return;
    const current = Boolean(button.dataset.current);
    if (!confirm(current ? t("setdev.log-out-on-this-device") : t("setdev.log-out-on-this-device-it"))) return;
    if (current) return logout();
    button.disabled = true;
    try {
      render(await crmApi(`/auth/devices/${encodeURIComponent(button.dataset.device)}`, { method: "DELETE" }));
      showToast(t("setdev.logged-out-on-that-device"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("setdev.could-not-log-it-out")), "error");
      button.disabled = false;
    }
  });

  $("devicesLogoutOthersBtn").addEventListener("click", async () => {
    if (!confirm(t("setdev.log-out-on-every-other-browser"))) return;
    $("devicesLogoutOthersBtn").disabled = true;
    try {
      render(await crmApi("/auth/devices/logout-others", { method: "POST" }));
      showToast(t("setdev.logged-out-everywhere-else"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("setdev.could-not-log-them-out")), "error");
    } finally {
      $("devicesLogoutOthersBtn").disabled = false;
    }
  });

  // "Log in on another computer": the login page that shows the code to scan.
  const loginUrl = new URL("login.html?with=phone", window.location.href).toString();
  $("linkComputerUrl").textContent = loginUrl;
  $("linkComputerCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(loginUrl);
      showToast(t("setdev.address-copied"), "success");
    } catch {
      showToast(t("setdev.copy-it-by-hand-select-the"), "info");
    }
  });

  load();
})();
