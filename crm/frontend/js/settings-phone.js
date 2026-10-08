/**
 * settings-phone.js — Settings → Your Profile → Your mobile number for logging in (D58)
 * A new browser logs in with Google, this number and a 6-digit WhatsApp code; the number is
 * verified there the first time, or here. "Change number" verifies a new one with a code.
 * Hidden when the CRM has codes switched off.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsPhone() {
  const $ = (id) => document.getElementById(id);
  const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
  const DEFAULT_HINT = "On a new browser you log in with Google, this number and a 6-digit code on WhatsApp.";

  function render(status) {
    $("phoneSection").hidden = !status.available && !status.phone;
    const verified = Boolean(status.phone && status.verifiedAt);
    $("phoneNumber").value = status.phone || "";
    $("phoneNumber").disabled = verified;
    $("phoneCodeField").hidden = true;
    $("phoneSendBtn").hidden = verified || !status.available;
    $("phoneVerifyBtn").hidden = true;
    $("phoneChangeBtn").hidden = !verified || !status.available;
    $("phoneHint").textContent = verified
      ? `${status.phone} is verified. A new browser asks for it, with a code on WhatsApp.`
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
  // The old number stays until the new one is verified.
  $("phoneChangeBtn").addEventListener("click", () => {
    $("phoneNumber").disabled = false;
    $("phoneNumber").value = "";
    $("phoneNumber").focus();
    $("phoneChangeBtn").hidden = true;
    $("phoneSendBtn").hidden = false;
    $("phoneHint").textContent = "Enter the new number. It replaces the old one once you enter the code from WhatsApp.";
  });

  load();
})();
