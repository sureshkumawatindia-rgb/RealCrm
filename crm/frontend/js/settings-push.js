/**
 * settings-push.js — Settings → Your Profile → Notifications on this device (Phase 10E)
 * Every member switches web push on or off for the browser or installed app they are using;
 * the bell's notes then arrive there even when the CRM is closed (crmPush in app.js).
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsPush() {
  const $ = (id) => document.getElementById(id);
  const on = $("pushOnBtn");
  const off = $("pushOffBtn");
  const test = $("pushTestBtn");

  async function render() {
    if (!crmPush.supported()) {
      $("pushHint").textContent = "This browser cannot show notifications from the CRM here. They work in Chrome, Edge, Firefox and Safari over https, and in the installed app.";
      [on, off, test].forEach((button) => { button.hidden = true; });
      return;
    }
    let subscribed = false;
    try {
      subscribed = Boolean(await crmPush.current());
    } catch {
      /* treated as off */
    }
    const blocked = Notification.permission === "denied";
    on.hidden = subscribed;
    off.hidden = !subscribed;
    test.hidden = !subscribed;
    on.disabled = blocked;
    if (blocked) $("pushHint").textContent = "Notifications are blocked for this site. Allow them in the browser's site settings (the lock icon next to the address), then come back.";
  }

  on.addEventListener("click", async () => {
    on.disabled = true;
    try {
      await crmPush.enable();
      showToast("Notifications are on for this device.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not switch on notifications."), "error");
    } finally {
      on.disabled = false;
      render();
    }
  });
  off.addEventListener("click", async () => {
    try {
      await crmPush.disable();
      showToast("Notifications are off for this device.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not switch off notifications."), "error");
    }
    render();
  });
  test.addEventListener("click", async () => {
    try {
      const result = await crmApi("/push/test", { method: "POST" });
      showToast(result.sent ? "Sent. It should appear in a moment." : "Not delivered: switch notifications off and on again here.", result.sent ? "success" : "error");
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not send a test."), "error");
    }
  });

  render();
})();
