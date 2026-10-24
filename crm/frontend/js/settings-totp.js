/**
 * settings-totp.js — Settings → Your Profile: 2-step login with an authenticator app (F7).
 * Says whether it is on (and how many backup codes are left) and links to two-factor.html.
 */
(function settingsTotp() {
  const status = document.getElementById("totpStatus");
  if (!status) return;

  async function load() {
    await crmI18n.ready;
    try {
      const tf = await crmApi("/auth/totp");
      if (tf.enabled) {
        status.textContent = t("tfa.onLeft", { n: tf.backupCodesLeft });
      } else if (tf.required && tf.requiredBy) {
        status.textContent = t("tfa.banner", { date: new Date(tf.requiredBy).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "long" }) });
      }
      document.querySelector("#totpLink span").textContent = t(tf.enabled ? "tfa.manageOn" : "tfa.manage");
    } catch {
      /* the card keeps its general text */
    }
  }
  load();
})();
