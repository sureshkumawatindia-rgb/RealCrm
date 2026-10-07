/**
 * settings-phone.js — Settings → Your Profile → Sign in with your mobile number (Phase 10E)
 * Each member verifies their own number with a WhatsApp code; the login page can then sign them
 * in with a code sent to it. Hidden when the CRM has codes switched off.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsPhone() {
  const $ = (id) => document.getElementById(id);
  const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
  const DEFAULT_HINT = "Verify your mobile number once; then you can also sign in with a 6-digit code sent on WhatsApp, next to Google.";

  function render(status) {
    $("phoneSection").hidden = !status.available && !status.phone;
    const verified = Boolean(status.phone && status.verifiedAt);
    $("phoneNumber").value = status.phone || "";
    $("phoneNumber").disabled = verified;
    $("phoneCodeField").hidden = true;
    $("phoneSendBtn").hidden = verified || !status.available;
    $("phoneVerifyBtn").hidden = true;
    $("phoneRemoveBtn").hidden = !verified;
    $("phoneHint").textContent = verified
      ? `${status.phone} is verified. On the login page, choose “Get a code on WhatsApp” and enter this number.`
      : DEFAULT_HINT;
  }

  async function load() {
    try {
      render(await crmApi("/auth/phone"));
    } catch {
      /* the section stays hidden */
    }
  }

  $("phoneSendBtn").addEventListener("click", async () => {
    $("phoneSendBtn").disabled = true;
    try {
      const sent = await crmApi("/auth/phone/request", json("POST", { phone: $("phoneNumber").value.trim() }));
      $("phoneHint").textContent = sent.devCode ? `${sent.message} (Development: the code is ${sent.devCode}.)` : sent.message;
      $("phoneCodeField").hidden = false;
      $("phoneVerifyBtn").hidden = false;
      $("phoneCode").focus();
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not send a code."), "error");
    } finally {
      $("phoneSendBtn").disabled = false;
    }
  });
  $("phoneVerifyBtn").addEventListener("click", async () => {
    try {
      render(await crmApi("/auth/phone/verify", json("POST", { phone: $("phoneNumber").value.trim(), code: $("phoneCode").value.trim() })));
      $("phoneCode").value = "";
      showToast("Number verified.", "success");
    } catch (error) {
      showToast(apiErrorMessage(error, "That code did not work."), "error");
    }
  });
  $("phoneRemoveBtn").addEventListener("click", async () => {
    if (!confirm("Remove this number? You can then sign in with Google only.")) return;
    try {
      render(await crmApi("/auth/phone", json("DELETE")));
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not remove the number."), "error");
    }
  });

  load();
})();
