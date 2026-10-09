/**
 * settings-phone.js — Settings → Your Profile → Mobile number and 2-step verification (D60)
 * The member verifies their mobile number with a 6-digit WhatsApp code ("Change number" verifies
 * a new one), and can switch on 2-step verification: on a new browser, after Google, a code on
 * WhatsApp to this number. Off unless switched on (or fixed for everyone by the CRM).
 * Hidden when the CRM has codes switched off. The code is never shown on screen.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsPhone() {
  const $ = (id) => document.getElementById(id);
  const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
  const DEFAULT_HINT = "Your mobile number, verified with a 6-digit code on WhatsApp.";

  function render(status) {
    $("phoneSection").hidden = !status.available && !status.phone;
    const verified = Boolean(status.phone && status.verifiedAt);
    $("phoneNumber").value = status.phone || "";
    $("phoneNumber").disabled = verified;
    $("phoneCodeField").hidden = true;
    $("phoneSendBtn").hidden = verified || !status.available;
    $("phoneVerifyBtn").hidden = true;
    $("phoneChangeBtn").hidden = !verified || !status.available;
    $("phoneHint").textContent = verified ? `${status.phone} is verified.` : DEFAULT_HINT;

    // 2-step verification: each person's choice (optional), or fixed by the CRM.
    $("twoStepRow").hidden = status.twoStepMode === "off" || !status.available;
    $("twoStepToggle").checked = Boolean(status.twoStep);
    $("twoStepToggle").disabled = status.twoStepMode === "required" || (!verified && !status.twoStep);
    $("twoStepHint").textContent = status.twoStepMode === "required"
      ? "Always on for this CRM: a new browser asks for a code on WhatsApp after Google."
      : verified
        ? "On a new browser, after Google, ask for a code sent on WhatsApp to this number. A browser where you choose \"Stay logged in\" is not asked again for 30 days."
        : "Verify your number above first.";
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
      $("phoneHint").textContent = sent.message;
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
  $("twoStepToggle").addEventListener("change", async () => {
    const enabled = $("twoStepToggle").checked;
    $("twoStepToggle").disabled = true;
    try {
      render(await crmApi("/auth/two-step", json("PUT", { enabled })));
      showToast(enabled ? "2-step verification is on." : "2-step verification is off.", "success");
    } catch (error) {
      $("twoStepToggle").checked = !enabled;
      $("twoStepToggle").disabled = false;
      showToast(apiErrorMessage(error, "That didn't work. Please try again."), "error");
    }
  });

  load();
})();
