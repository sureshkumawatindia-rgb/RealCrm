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
    "google+whatsapp": "Google + WhatsApp code",
    "google+sms": "Google + SMS code",
    qr: "QR code from your phone",
    google: "Google",
  };
  const when = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const day = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  function ago(iso) {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 2) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
    return when(iso);
  }

  function render({ devices }) {
    const list = $("deviceList");
    if (!devices.length) {
      list.innerHTML = '<li class="device-empty">No other device is logged in.</li>';
      $("devicesLogoutOthersBtn").hidden = true;
      return;
    }
    list.innerHTML = devices.map((device) => {
      const phone = /Android|iPhone/.test(device.device);
      const meta = [
        METHODS[device.method] || "Google",
        `logged in ${when(device.loggedInAt)}`,
        device.current ? "" : `last used ${ago(device.lastActiveAt)}`,
        device.rememberedUntil ? `stays logged in until ${day(device.rememberedUntil)}` : "",
      ].filter(Boolean).join(" · ");
      return `
        <li>
          <span class="device-icon"><i class="fa-solid ${phone ? "fa-mobile-screen" : "fa-desktop"}"></i></span>
          <span class="device-text">
            <span class="device-name">${escapeHtml(device.device)}</span>${device.current ? '<span class="device-here">This device</span>' : ""}
            <br /><span class="device-meta">${escapeHtml(meta)}</span>
          </span>
          <button class="btn btn-outline" type="button" data-device="${escapeHtml(device.id)}" data-current="${device.current ? "1" : ""}">Log out</button>
        </li>`;
    }).join("");
    $("devicesLogoutOthersBtn").hidden = !devices.some((device) => !device.current);
  }

  async function load() {
    try {
      render(await crmApi("/auth/devices"));
    } catch (error) {
      $("deviceList").innerHTML = `<li class="device-empty">${escapeHtml(apiErrorMessage(error, "Could not load the list."))}</li>`;
    }
  }

  $("deviceList").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-device]");
    if (!button) return;
    const current = Boolean(button.dataset.current);
    if (!confirm(current ? "Log out on this device?" : "Log out on this device? It will need Google, the number and a code again.")) return;
    if (current) return logout();
    button.disabled = true;
    try {
      render(await crmApi(`/auth/devices/${encodeURIComponent(button.dataset.device)}`, { method: "DELETE" }));
      showToast("Logged out on that device.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not log it out."), "error");
      button.disabled = false;
    }
  });

  $("devicesLogoutOthersBtn").addEventListener("click", async () => {
    if (!confirm("Log out on every other browser and phone? Only this one stays logged in.")) return;
    $("devicesLogoutOthersBtn").disabled = true;
    try {
      render(await crmApi("/auth/devices/logout-others", { method: "POST" }));
      showToast("Logged out everywhere else.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not log them out."), "error");
    } finally {
      $("devicesLogoutOthersBtn").disabled = false;
    }
  });

  load();
})();
