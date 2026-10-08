/**
 * login.js — logging in (D58), one step at a time in one card:
 *   1. Google  →  2. the mobile number  →  3. the 6-digit code sent on WhatsApp.
 * All three are needed on a new browser. "Stay logged in on this browser" skips the code here
 * for 30 days. Or "Log in with QR code": a phone where the person is signed in scans the code
 * (Settings → Your Profile → Log in on a computer) and taps Allow.
 * The backend returns a short-lived access token (kept in localStorage) and sets the refresh
 * token as an httpOnly cookie. An invite link (login.html?invite=...) adds the user to the
 * inviting company.
 */

const GOOGLE_CLIENT_ID =
  "910305219970-gimdha8ojccrddq4oocivgg8ha32kurl.apps.googleusercontent.com";
const INVITE_KEY = "crm_pending_invite";
const PENDING_LINK_KEY = "crm_pending_link"; // a computer's QR code scanned before signing in
const QR_POLL_MS = 2000;
const QR_AUTO_REFRESHES = 4; // then "Click to reload", like WhatsApp Web
const RESEND_WAIT_S = 30;

// Take the invite token out of the address bar right away, so it is not kept in history
// or sent to the server as a Referer.
(function captureInviteToken() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get("invite");
  if (invite) sessionStorage.setItem(INVITE_KEY, invite);
  if (invite || params.has("expired")) {
    if (params.has("expired")) sessionStorage.setItem("crm_session_expired", "1");
    window.history.replaceState({}, document.title, window.location.pathname);
  }
})();

// Where a phone goes after signing in to allow a computer.
function pendingLinkPage() {
  const link = sessionStorage.getItem(PENDING_LINK_KEY);
  if (!link) return "";
  sessionStorage.removeItem(PENDING_LINK_KEY);
  return `link-device.html#${link}`;
}

// Already signed in (and no invite to accept)? Skip straight to the right place.
const alreadySignedIn = isAuthenticated() && !sessionStorage.getItem(INVITE_KEY);
if (alreadySignedIn) {
  window.location.replace(pendingLinkPage() || (hasCompanyInfo() ? "dashboard.html" : "company.html"));
}

const $ = (id) => document.getElementById(id);
const postJson = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const stayLoggedIn = () => Boolean($("stayLoggedIn")?.checked);
const onPhone = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

function setLoginNote(message) {
  const note = $("login-note");
  if (!note) return;
  note.textContent = message;
  note.hidden = !message;
}

async function showInviteDetails() {
  const token = sessionStorage.getItem(INVITE_KEY);
  if (!token) {
    if (sessionStorage.getItem("crm_session_expired")) {
      sessionStorage.removeItem("crm_session_expired");
      setLoginNote("Your session ended. Please log in again.");
    }
    return;
  }
  try {
    const invite = await crmApi("/invites/lookup", postJson({ token }));
    setLoginNote(`You're invited to join ${invite.organizationName} as ${invite.role}. Log in with ${invite.email}.`);
  } catch (error) {
    sessionStorage.removeItem(INVITE_KEY);
    setLoginNote(error.message || "This invite link is no longer valid. Ask for a new one.");
  }
}

// Where to go after sign-in: owners/admins set up an empty company profile first;
// agents and viewers without the dashboard start on the first page they may open.
async function nextPage(member) {
  const managers = ["owner", "admin"];
  if (!managers.includes(member?.role) && !(member?.modules || []).includes("dashboard")) {
    const first = Object.entries(PAGE_MODULES).find(([, module]) => [].concat(module).some((key) => (member?.modules || []).includes(key)));
    return first ? encodeURI(first[0]) : "Settings.html";
  }
  try {
    const { company } = await loadCompanyProfile();
    return companyHasDetails(company) || !managers.includes(member?.role) ? "dashboard.html" : "company.html";
  } catch {
    return "dashboard.html";
  }
}

// Signed in (WhatsApp code, QR, or Google on a remembered browser): keep the session and open
// the first allowed page.
async function completeSignIn(auth) {
  qrLogin.stop();
  // A different company than last time on this browser: drop the old company cache.
  const previousMember = getCurrentMember();
  if (previousMember && String(previousMember.organizationId) !== String(auth.organizationId)) {
    localStorage.removeItem(KEYS.COMPANY);
  }
  localStorage.setItem(KEYS.SESSION, auth.token);
  localStorage.setItem(KEYS.USER, JSON.stringify(auth.user));
  localStorage.setItem(KEYS.MEMBER, JSON.stringify({ ...auth.member, organizationId: auth.organizationId }));
  sessionStorage.removeItem(INVITE_KEY);

  if (auth.inviteError) {
    showToast(auth.inviteError.message, "error");
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  window.location.href = pendingLinkPage() || await nextPage(auth.member);
}

// ---------------------------------------------------------------
// The card: one step at a time
// ---------------------------------------------------------------
const STEPS = {
  google: { panel: "googleStep", number: 1, sub: "Sign in with your Google account to continue" },
  phone: { panel: "phoneStep", number: 2, sub: "Now your mobile number. A code comes on WhatsApp." },
  code: { panel: "codeStep", number: 3, sub: "Enter the 6-digit code from WhatsApp." },
  qr: { panel: "qrStep", number: 0, sub: "Scan this code with your phone to log in." },
};
const login = { challenge: "", phone: "" };
let resendTimer = null;

function showStep(name) {
  const step = STEPS[name];
  Object.values(STEPS).forEach(({ panel }) => {
    $(panel).hidden = panel !== step.panel;
  });
  $("loginSub").textContent = step.sub;
  $("loginProgress").hidden = !step.number;
  $("progressLabel").textContent = `Step ${step.number} of 3`;
  document.querySelectorAll(".login-progress-bars i").forEach((bar) => {
    bar.classList.toggle("on", Number(bar.dataset.step) <= step.number);
  });
  $("stayRow").hidden = !["code", "qr"].includes(name);
  $("toQr").hidden = name === "qr" || onPhone; // a phone has nothing to scan with
  $("toGoogle").hidden = name !== "qr";
  if (name === "qr") qrLogin.start();
  else qrLogin.stop();
  if (name === "google") renderGoogleButton();
  if (name === "phone") $("loginPhone").focus();
  if (name === "code") $("loginCode").focus();
}

function backToGoogle(message) {
  login.challenge = "";
  login.phone = "";
  $("loginCode").value = "";
  clearInterval(resendTimer);
  if (message) setLoginNote(message);
  showStep("google");
}

// Step 1 → 2
async function handleGoogleCredentialResponse(response) {
  const inviteToken = sessionStorage.getItem(INVITE_KEY) || "";
  try {
    const auth = await crmApi("/auth/google", postJson({ credential: response.credential, inviteToken }));
    if (auth.step !== "whatsapp-code") {
      await completeSignIn(auth); // a remembered browser, or codes are off for this CRM
      return;
    }
    login.challenge = auth.challenge;
    $("whoEmail").textContent = auth.user?.email || "Signed in with Google";
    $("phoneHint").textContent = auth.phoneHint
      ? `Use this account's number (${auth.phoneHint}).`
      : "Your WhatsApp number. It is verified now and asked on every new browser.";
    setLoginNote("");
    showStep("phone");
  } catch (error) {
    showToast(apiErrorMessage(error, "Google sign-in failed. Please try again."), "error");
  }
}

// "Send the code again" waits a little, so codes are not asked for by accident.
function startResendWait() {
  let left = RESEND_WAIT_S;
  const button = $("resendBtn");
  const tick = () => {
    button.disabled = left > 0;
    button.textContent = left > 0 ? `Send the code again (${left}s)` : "Send the code again";
    if (left <= 0) clearInterval(resendTimer);
    left -= 1;
  };
  clearInterval(resendTimer);
  tick();
  resendTimer = setInterval(tick, 1000);
}

// Step 2 → 3 (and "Send the code again")
async function sendCode(phone) {
  const sent = await crmApi("/auth/login/code", postJson({ challenge: login.challenge, phone }));
  login.phone = phone;
  $("codeHint").textContent = sent.devCode
    ? `Sent to ${phone} on WhatsApp. (Development: the code is ${sent.devCode}.)`
    : `Sent to ${phone} on WhatsApp. It works for ${Math.round((sent.expiresInSeconds || 300) / 60)} minutes.`;
  startResendWait();
}

$("phoneForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!login.challenge) return backToGoogle("");
  $("sendCodeBtn").disabled = true;
  try {
    await sendCode($("loginPhone").value.trim());
    $("loginCode").value = "";
    showStep("code");
  } catch (error) {
    if (error.code === "LOGIN_EXPIRED") return backToGoogle(error.message);
    showToast(apiErrorMessage(error, "Could not send a code."), "error");
  } finally {
    $("sendCodeBtn").disabled = false;
  }
});

$("resendBtn").addEventListener("click", async () => {
  $("resendBtn").disabled = true;
  try {
    await sendCode(login.phone);
    showToast("A new code is on its way.", "success");
  } catch (error) {
    if (error.code === "LOGIN_EXPIRED") return backToGoogle(error.message);
    showToast(apiErrorMessage(error, "Could not send a code."), "error");
    $("resendBtn").disabled = false;
  }
});

$("loginCode").addEventListener("input", () => {
  $("loginCode").value = $("loginCode").value.replace(/\D/g, "").slice(0, 6);
});

// Step 3 → signed in
$("codeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!login.challenge || !login.phone) return backToGoogle("");
  $("verifyBtn").disabled = true;
  try {
    await completeSignIn(await crmApi("/auth/login/verify", postJson({
      challenge: login.challenge, phone: login.phone, code: $("loginCode").value.trim(), stayLoggedIn: stayLoggedIn(),
    })));
  } catch (error) {
    $("verifyBtn").disabled = false;
    if (error.code === "LOGIN_EXPIRED") return backToGoogle(error.message);
    showToast(apiErrorMessage(error, "That code did not work."), "error");
    $("loginCode").select();
  }
});

$("changeGoogle").addEventListener("click", () => backToGoogle(""));
$("changePhone").addEventListener("click", () => {
  clearInterval(resendTimer);
  showStep("phone");
});

let googleRendered = false;
function renderGoogleButton() {
  if (googleRendered) return;
  if (typeof google === "undefined" || !google.accounts?.id) {
    // GSI script not loaded yet (ad-blocker / offline) — retry shortly.
    setTimeout(renderGoogleButton, 300);
    return;
  }
  googleRendered = true;
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredentialResponse,
  });
  google.accounts.id.renderButton($("google-signin-slot"), {
    theme: "outline",
    size: "large",
    shape: "pill",
    text: "continue_with",
    width: 300,
  });
}

// ---------------------------------------------------------------
// Log in with QR code (the phone allows this computer)
// ---------------------------------------------------------------
const qrLogin = (() => {
  let current = null; // { id, secret, expiresAt }
  let pollTimer = null;
  let polling = false;
  let refreshes = 0;
  let running = false;

  const showState = (state) => {
    $("qrWait").hidden = state !== "wait";
    $("qrImage").hidden = state !== "code";
    $("qrReload").hidden = state !== "reload";
    $("qrBox").classList.toggle("is-stale", state === "reload");
  };

  async function newCode() {
    clearTimeout(pollTimer);
    current = null;
    showState("wait");
    try {
      const code = await crmApi("/auth/qr", postJson({}));
      if (!running) return;
      current = { id: code.id, secret: code.secret, expiresAt: new Date(code.expiresAt).getTime() };
      $("qrImage").src = code.image;
      showState("code");
      schedule();
    } catch {
      showState("reload");
    }
  }

  function expired() {
    refreshes += 1;
    if (refreshes > QR_AUTO_REFRESHES) {
      current = null;
      showState("reload");
    } else {
      newCode();
    }
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (running && current) pollTimer = setTimeout(poll, QR_POLL_MS);
  }

  async function poll() {
    if (!running || !current || polling) return;
    if (document.hidden) return schedule(); // asks again when the tab is back
    if (Date.now() > current.expiresAt) return expired();
    polling = true;
    try {
      const result = await crmApi(`/auth/qr/${current.id}/poll`, postJson({ secret: current.secret, stayLoggedIn: stayLoggedIn() }));
      if (result.status === "approved") {
        running = false;
        showState("wait");
        await completeSignIn(result);
        return;
      }
      if (result.status === "declined") {
        setLoginNote("Your phone did not allow this computer. Scan the new code to try again.");
        refreshes = 0;
        newCode();
        return;
      }
      if (result.status === "expired") return expired();
      schedule();
    } catch (error) {
      if (error.code === "QR_NOT_FOUND") return expired();
      schedule(); // offline for a moment: keep asking
    } finally {
      polling = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      refreshes = 0;
      newCode();
    },
    stop() {
      running = false;
      current = null;
      clearTimeout(pollTimer);
    },
    reload() {
      running = true;
      refreshes = 0;
      setLoginNote("");
      newCode();
    },
  };
})();

$("toQr").addEventListener("click", () => showStep("qr"));
$("toGoogle").addEventListener("click", () => showStep(login.challenge ? (login.phone ? "code" : "phone") : "google"));
$("qrReload").addEventListener("click", () => qrLogin.reload());

if (!alreadySignedIn) {
  if (sessionStorage.getItem(PENDING_LINK_KEY)) setLoginNote("Log in on this phone first. Then allow the computer.");
  showInviteDetails();
  showStep("google");
}
