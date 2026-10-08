/**
 * login.js — signing in, like WhatsApp Web (D58).
 * - Scan to log in: the page shows a QR code; a phone where the person is signed in scans it
 *   (Settings → Your Profile → Log in on a computer) and taps Allow.
 * - Or all three: Google, then the mobile number, then a 6-digit code on WhatsApp.
 * "Stay logged in on this browser" skips the WhatsApp code here for 30 days.
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
// The two views: "Scan to log in" and "Google + phone number"
// ---------------------------------------------------------------
function showView(view) {
  const steps = view === "steps";
  $("qrView").hidden = steps;
  $("stepsView").hidden = !steps;
  $("toSteps").hidden = steps;
  $("toQr").hidden = !steps;
  if (steps) {
    qrLogin.stop();
    renderGoogleButton();
  } else {
    qrLogin.start();
  }
}

// A phone (or an invite, or a phone allowing a computer) starts with the steps: nothing to scan with.
function firstView() {
  const onPhone = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return onPhone || sessionStorage.getItem(INVITE_KEY) || sessionStorage.getItem(PENDING_LINK_KEY) ? "steps" : "qr";
}

// ---------------------------------------------------------------
// Scan to log in (QR)
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

// ---------------------------------------------------------------
// Google → mobile number → WhatsApp code (all three)
// ---------------------------------------------------------------
const steps = { challenge: "", phone: "" };

function markStep(number, state) {
  const item = $(`step${number}`);
  item.classList.toggle("active", state === "active");
  item.classList.toggle("done", state === "done");
}

function resetSteps(message) {
  steps.challenge = "";
  steps.phone = "";
  $("google-signin-slot").hidden = false;
  $("googleDone").hidden = true;
  ["loginPhone", "sendCodeBtn", "loginCode", "verifyBtn"].forEach((id) => {
    $(id).disabled = true;
  });
  $("loginCode").value = "";
  $("phoneHint").textContent = "";
  $("codeHint").textContent = "";
  $("sendCodeBtn").innerHTML = '<i class="fa-brands fa-whatsapp"></i> Get a code on WhatsApp';
  markStep(1, "active");
  markStep(2, "");
  markStep(3, "");
  if (message) setLoginNote(message);
}

async function handleGoogleCredentialResponse(response) {
  const inviteToken = sessionStorage.getItem(INVITE_KEY) || "";
  try {
    const auth = await crmApi("/auth/google", postJson({ credential: response.credential, inviteToken }));
    if (auth.step !== "whatsapp-code") {
      await completeSignIn(auth); // a remembered browser, or codes are off for this CRM
      return;
    }
    steps.challenge = auth.challenge;
    $("google-signin-slot").hidden = true;
    $("googleDone").hidden = false;
    $("googleDone").innerHTML = `<i class="fa-solid fa-circle-check"></i> ${escapeHtml(auth.user?.email || "Signed in")} <button type="button" class="wa-link" id="googleChange">Change</button>`;
    $("googleChange").addEventListener("click", () => resetSteps(""));
    markStep(1, "done");
    markStep(2, "active");
    $("loginPhone").disabled = false;
    $("sendCodeBtn").disabled = false;
    $("phoneHint").textContent = auth.phoneHint
      ? `Enter this account's number (${auth.phoneHint}).`
      : "Your WhatsApp number. It is verified now and used for every new browser.";
    $("loginPhone").focus();
  } catch (error) {
    showToast(apiErrorMessage(error, "Google sign-in failed. Please try again."), "error");
  }
}

$("phoneForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!steps.challenge) return;
  const phone = $("loginPhone").value.trim();
  $("sendCodeBtn").disabled = true;
  try {
    const sent = await crmApi("/auth/login/code", postJson({ challenge: steps.challenge, phone }));
    steps.phone = phone;
    $("codeHint").textContent = sent.devCode ? `${sent.message} (Development: the code is ${sent.devCode}.)` : sent.message;
    $("sendCodeBtn").innerHTML = '<i class="fa-brands fa-whatsapp"></i> Send again';
    markStep(2, "done");
    markStep(3, "active");
    $("loginCode").disabled = false;
    $("verifyBtn").disabled = false;
    $("loginCode").focus();
  } catch (error) {
    if (error.code === "LOGIN_EXPIRED") return resetSteps(error.message);
    showToast(apiErrorMessage(error, "Could not send a code."), "error");
  } finally {
    if (steps.challenge) $("sendCodeBtn").disabled = false;
  }
});

// A changed number needs a new code.
$("loginPhone").addEventListener("input", () => {
  if (!steps.phone || $("loginPhone").value.trim() === steps.phone) return;
  steps.phone = "";
  $("loginCode").value = "";
  $("loginCode").disabled = true;
  $("verifyBtn").disabled = true;
  $("codeHint").textContent = "";
  $("sendCodeBtn").innerHTML = '<i class="fa-brands fa-whatsapp"></i> Get a code on WhatsApp';
  markStep(2, "active");
  markStep(3, "");
});

$("loginCode").addEventListener("input", () => {
  $("loginCode").value = $("loginCode").value.replace(/\D/g, "").slice(0, 6);
});

$("codeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!steps.challenge || !steps.phone) return;
  $("verifyBtn").disabled = true;
  try {
    await completeSignIn(await crmApi("/auth/login/verify", postJson({
      challenge: steps.challenge, phone: steps.phone, code: $("loginCode").value.trim(), stayLoggedIn: stayLoggedIn(),
    })));
  } catch (error) {
    if (error.code === "LOGIN_EXPIRED") return resetSteps(error.message);
    showToast(apiErrorMessage(error, "That code did not work."), "error");
    $("loginCode").select();
    $("verifyBtn").disabled = false;
  }
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
    width: 260,
  });
}

$("toSteps").addEventListener("click", () => showView("steps"));
$("toQr").addEventListener("click", () => showView("qr"));
$("qrReload").addEventListener("click", () => qrLogin.reload());

if (!alreadySignedIn) {
  if (sessionStorage.getItem(PENDING_LINK_KEY)) setLoginNote("Log in on this phone first. Then allow the computer.");
  showInviteDetails();
  showView(firstView());
}
