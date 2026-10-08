/**
 * login.js — logging in (D58), one step at a time in one card:
 *   1. Google  →  2. the mobile number (filled in when verified)  →  3. the 6-digit code sent on
 *   WhatsApp (or, as a backup, by SMS).
 * All three are needed on a new browser. "Stay logged in on this browser" skips the code here
 * for 30 days. Or "Log in with QR code": a phone where the person is signed in scans the code
 * (Settings → Your Profile → Log in on a computer) and taps Allow.
 * The page speaks English or Hindi (the choice is kept in crm_prefs). An invite link shows the
 * inviting company's logo and name.
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

// ---------------------------------------------------------------
// English / Hindi
// ---------------------------------------------------------------
const TEXT = {
  en: {
    subGoogle: "Sign in with your Google account to continue",
    subPhone: "Now your mobile number. A code comes on WhatsApp.",
    subCode: "Enter the 6-digit code from WhatsApp.",
    subCodeSms: "Enter the 6-digit code from the SMS.",
    subQr: "Scan this code with your phone to log in.",
    step: "Step {n} of 3",
    change: "Change",
    phonePlaceholder: "Your mobile number",
    getCode: "Get a code on WhatsApp",
    codePlaceholder: "6-digit code",
    logIn: "Log in",
    resend: "Send the code again",
    resendIn: "Send the code again ({s}s)",
    changeNumber: "Change number",
    bySms: "Get the code by SMS instead",
    byWhatsapp: "Get the code on WhatsApp instead",
    stay: "Stay logged in on this browser",
    stayInfo: "On this browser, the WhatsApp code is not asked again for 30 days. Logging out ends it. Don't tick it on a shared computer.",
    foot: "By continuing you agree to YELLOW CRM's usage policy.",
    toQr: "Log in with QR code",
    toGoogle: "Log in with Google and phone number",
    qrReload: "Click to reload the QR code",
    qr1: "Open <strong>YELLOW CRM</strong> on your phone, where you are signed in",
    qr2: "Tap <strong>Settings → Your Profile → Log in on a computer</strong>",
    qr3: "Point your phone at this code and tap <strong>Allow</strong>",
    hintFilled: "This account's number is filled in. Tap “Get a code on WhatsApp”.",
    hintNew: "Your WhatsApp number. It is verified now and asked on every new browser.",
    sentWhatsapp: "Sent to {phone} on WhatsApp.",
    sentSms: "Sent to {phone} by SMS.",
    expires: "It works for {m} minutes.",
    dev: "(Development: the code is {code}.)",
    newCode: "A new code is on its way.",
    signedInGoogle: "Signed in with Google",
    noteExpired: "Your session ended. Please log in again.",
    noteInvite: "You're invited to join {org} as {role}. Log in with {email}.",
    notePendingLink: "Log in on this phone first. Then allow the computer.",
    noteDeclined: "Your phone did not allow this computer. Scan the new code to try again.",
    errGoogle: "Google sign-in failed. Please try again.",
    errSend: "Could not send a code.",
    errCode: "That code did not work.",
  },
  hi: {
    subGoogle: "आगे बढ़ने के लिए अपने Google खाते से साइन इन करें",
    subPhone: "अब अपना मोबाइल नंबर डालें। WhatsApp पर एक कोड आएगा।",
    subCode: "WhatsApp पर आया 6 अंकों का कोड डालें।",
    subCodeSms: "SMS से आया 6 अंकों का कोड डालें।",
    subQr: "लॉग इन करने के लिए यह कोड अपने फ़ोन से स्कैन करें।",
    step: "चरण {n} / 3",
    change: "बदलें",
    phonePlaceholder: "आपका मोबाइल नंबर",
    getCode: "WhatsApp पर कोड पाएँ",
    codePlaceholder: "6 अंकों का कोड",
    logIn: "लॉग इन करें",
    resend: "कोड फिर से भेजें",
    resendIn: "कोड फिर से भेजें ({s} सेकंड)",
    changeNumber: "नंबर बदलें",
    bySms: "कोड SMS पर मँगाएँ",
    byWhatsapp: "कोड WhatsApp पर मँगाएँ",
    stay: "इस ब्राउज़र पर लॉग इन रहें",
    stayInfo: "इस ब्राउज़र पर 30 दिन तक WhatsApp कोड दोबारा नहीं माँगा जाएगा। लॉग आउट करने पर यह ख़त्म हो जाता है। किसी साझा कंप्यूटर पर इसे न चुनें।",
    foot: "आगे बढ़कर आप YELLOW CRM की उपयोग नीति से सहमत होते हैं।",
    toQr: "QR कोड से लॉग इन करें",
    toGoogle: "Google और फ़ोन नंबर से लॉग इन करें",
    qrReload: "QR कोड फिर से लोड करने के लिए क्लिक करें",
    qr1: "अपने फ़ोन पर <strong>YELLOW CRM</strong> खोलें, जहाँ आप साइन इन हैं",
    qr2: "<strong>Settings → Your Profile → Log in on a computer</strong> पर टैप करें",
    qr3: "फ़ोन को इस कोड की ओर करें और <strong>Allow</strong> पर टैप करें",
    hintFilled: "इस खाते का नंबर भरा हुआ है। “WhatsApp पर कोड पाएँ” दबाएँ।",
    hintNew: "आपका WhatsApp नंबर। यह अभी सत्यापित होगा और हर नए ब्राउज़र पर पूछा जाएगा।",
    sentWhatsapp: "{phone} पर WhatsApp से भेजा गया।",
    sentSms: "{phone} पर SMS से भेजा गया।",
    expires: "यह {m} मिनट तक चलेगा।",
    dev: "(डेवलपमेंट: कोड {code} है।)",
    newCode: "नया कोड भेज दिया गया है।",
    signedInGoogle: "Google से साइन इन हो गया",
    noteExpired: "आपका सेशन ख़त्म हो गया। कृपया फिर से लॉग इन करें।",
    noteInvite: "आपको {org} में {role} के रूप में जुड़ने का न्योता मिला है। {email} से लॉग इन करें।",
    notePendingLink: "पहले इस फ़ोन पर लॉग इन करें। फिर कंप्यूटर को अनुमति दें।",
    noteDeclined: "आपके फ़ोन ने इस कंप्यूटर को अनुमति नहीं दी। दोबारा कोशिश के लिए नया कोड स्कैन करें।",
    errGoogle: "Google साइन इन नहीं हो सका। कृपया फिर कोशिश करें।",
    errSend: "कोड नहीं भेजा जा सका।",
    errCode: "यह कोड काम नहीं किया।",
  },
};
// The server answers in English; in Hindi the usual login errors are shown in Hindi.
const HINDI_ERRORS = {
  OTP_INVALID: "कोड गलत है या उसका समय निकल गया। नया कोड मँगाएँ।",
  OTP_LOCKED: "बहुत बार गलत कोड डाला गया। नया कोड मँगाएँ।",
  OTP_TOO_MANY: "इस नंबर पर बहुत सारे कोड भेजे जा चुके हैं। 15 मिनट बाद फिर कोशिश करें।",
  PHONE_MISMATCH: "इस खाते का अपना मोबाइल नंबर डालें।",
  PHONE_IN_USE: "यह नंबर किसी दूसरे खाते से जुड़ा है।",
  LOGIN_EXPIRED: "साइन इन में बहुत देर हो गई। Google से फिर से साइन इन करें।",
  SMS_OFF: "SMS से कोड अभी चालू नहीं है।",
};

let lang = getPreference("loginLanguage", /^hi\b/i.test(navigator.language || "") ? "hi" : "en") === "hi" ? "hi" : "en";
const t = (key, values = {}) => (TEXT[lang][key] || TEXT.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));

function errorText(error, fallbackKey) {
  if (lang === "hi") {
    if (HINDI_ERRORS[error?.code]) return HINDI_ERRORS[error.code];
    if (error?.code === "VALIDATION_ERROR") return error.errors?.[0]?.field === "code" ? "कोड 6 अंकों का होता है।" : "सही मोबाइल नंबर डालें।";
  }
  return apiErrorMessage(error, fallbackKey ? t(fallbackKey) : "");
}

function applyLanguage() {
  document.documentElement.lang = lang;
  $("langLabel").textContent = lang === "hi" ? "English" : "हिंदी";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml); // our own fixed texts, not user data
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
    el.setAttribute("aria-label", el.placeholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
}

// ---------------------------------------------------------------
// Notes, invite, where to go after signing in
// ---------------------------------------------------------------
const note = { key: "", values: {}, raw: "" }; // kept so a language switch can redo it

function setLoginNote(message) {
  note.key = "";
  note.raw = message;
  renderNote();
}
function setLoginNoteText(key, values = {}) {
  note.key = key;
  note.values = values;
  note.raw = "";
  renderNote();
}
function renderNote() {
  const el = $("login-note");
  if (!el) return;
  const message = note.key ? t(note.key, note.values) : note.raw;
  el.textContent = message;
  el.hidden = !message;
}

// An invite link: the inviting company's logo and name on the card.
function showCompany(name, logoUrl) {
  $("loginTitle").textContent = name;
  if (!logoUrl) {
    $("loginMark").textContent = (name || "A").trim().charAt(0).toUpperCase();
    return;
  }
  const img = document.createElement("img");
  img.src = logoUrl;
  img.alt = "";
  img.addEventListener("error", () => {
    $("loginMark").textContent = (name || "A").trim().charAt(0).toUpperCase();
  });
  $("loginMark").replaceChildren(img);
  $("loginMark").classList.add("has-logo");
}

async function showInviteDetails() {
  const token = sessionStorage.getItem(INVITE_KEY);
  if (!token) {
    if (sessionStorage.getItem("crm_session_expired")) {
      sessionStorage.removeItem("crm_session_expired");
      setLoginNoteText("noteExpired");
    }
    return;
  }
  try {
    const invite = await crmApi("/invites/lookup", postJson({ token }));
    showCompany(invite.organizationName, invite.logoUrl);
    setLoginNoteText("noteInvite", { org: invite.organizationName, role: invite.role, email: invite.email });
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

// Signed in (WhatsApp/SMS code, QR, or Google on a remembered browser): keep the session and
// open the first allowed page.
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
  google: { panel: "googleStep", number: 1, sub: "subGoogle" },
  phone: { panel: "phoneStep", number: 2, sub: "subPhone" },
  code: { panel: "codeStep", number: 3, sub: "subCode" },
  qr: { panel: "qrStep", number: 0, sub: "subQr" },
};
const login = { challenge: "", phone: "", channel: "whatsapp", smsBackup: false, step: "google", sent: null, phoneHintKey: "" };
let resendTimer = null;
let resendLeft = 0;

function renderStepTexts() {
  const step = STEPS[login.step];
  $("loginSub").textContent = t(login.step === "code" && login.channel === "sms" ? "subCodeSms" : step.sub);
  $("progressLabel").textContent = t("step", { n: step.number });
  $("smsBtn").textContent = t(login.channel === "sms" ? "byWhatsapp" : "bySms");
  if (login.sent) {
    const { phone, channel, devCode, minutes } = login.sent;
    $("codeHint").textContent = [t(channel === "sms" ? "sentSms" : "sentWhatsapp", { phone }), devCode ? t("dev", { code: devCode }) : t("expires", { m: minutes })].join(" ");
  }
  if (login.phoneHintKey) $("phoneHint").textContent = t(login.phoneHintKey);
  renderResend();
}

function showStep(name) {
  login.step = name;
  const step = STEPS[name];
  Object.values(STEPS).forEach(({ panel }) => {
    $(panel).hidden = panel !== step.panel;
  });
  $("loginProgress").hidden = !step.number;
  document.querySelectorAll(".login-progress-bars i").forEach((bar) => {
    bar.classList.toggle("on", Number(bar.dataset.step) <= step.number);
  });
  $("stayRow").hidden = !["code", "qr"].includes(name);
  $("smsRow").hidden = name !== "code" || !login.smsBackup;
  $("toQr").hidden = name === "qr" || onPhone; // a phone has nothing to scan with
  $("toGoogle").hidden = name !== "qr";
  renderStepTexts();
  if (name === "qr") qrLogin.start();
  else qrLogin.stop();
  if (name === "google") renderGoogleButton();
  if (name === "phone") ($("loginPhone").value ? $("sendCodeBtn") : $("loginPhone")).focus();
  if (name === "code") $("loginCode").focus();
}

function backToGoogle(message) {
  Object.assign(login, { challenge: "", phone: "", channel: "whatsapp", sent: null, phoneHintKey: "" });
  $("loginCode").value = "";
  $("loginPhone").value = "";
  clearInterval(resendTimer);
  if (message) setLoginNote(message);
  showStep("google");
}

// "+919829022222" → "+91 98290 22222" (what people are used to reading).
function prettyPhone(e164) {
  const match = /^\+91(\d{5})(\d{5})$/.exec(e164 || "");
  return match ? `+91 ${match[1]} ${match[2]}` : e164 || "";
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
    Object.assign(login, { challenge: auth.challenge, smsBackup: Boolean(auth.smsBackup), channel: "whatsapp", sent: null });
    $("whoEmail").textContent = auth.user?.email || t("signedInGoogle");
    $("loginPhone").value = prettyPhone(auth.phone);
    login.phoneHintKey = auth.phone ? "hintFilled" : "hintNew";
    if (note.key !== "noteInvite") setLoginNote("");
    showStep("phone");
  } catch (error) {
    showToast(errorText(error, "errGoogle"), "error");
  }
}

// "Send the code again" waits a little, so codes are not asked for by accident.
function renderResend() {
  const button = $("resendBtn");
  button.disabled = resendLeft > 0;
  button.textContent = resendLeft > 0 ? t("resendIn", { s: resendLeft }) : t("resend");
}
function startResendWait() {
  clearInterval(resendTimer);
  resendLeft = RESEND_WAIT_S;
  renderResend();
  resendTimer = setInterval(() => {
    resendLeft -= 1;
    renderResend();
    if (resendLeft <= 0) clearInterval(resendTimer);
  }, 1000);
}

// Step 2 → 3 (and "Send the code again", and the SMS backup)
async function sendCode(phone, channel) {
  const sent = await crmApi("/auth/login/code", postJson({ challenge: login.challenge, phone, channel }));
  login.phone = phone;
  login.channel = channel;
  login.sent = { phone, channel, devCode: sent.devCode, minutes: Math.round((sent.expiresInSeconds || 300) / 60) };
  startResendWait();
  renderStepTexts();
}

$("phoneForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!login.challenge) return backToGoogle("");
  $("sendCodeBtn").disabled = true;
  try {
    await sendCode($("loginPhone").value.trim(), "whatsapp");
    $("loginCode").value = "";
    showStep("code");
  } catch (error) {
    if (error.code === "LOGIN_EXPIRED") return backToGoogle(errorText(error));
    showToast(errorText(error, "errSend"), "error");
  } finally {
    $("sendCodeBtn").disabled = false;
  }
});

async function sendAgain(channel) {
  try {
    await sendCode(login.phone, channel);
    showToast(t("newCode"), "success");
    $("loginCode").value = "";
    $("loginCode").focus();
  } catch (error) {
    if (error.code === "LOGIN_EXPIRED") return backToGoogle(errorText(error));
    showToast(errorText(error, "errSend"), "error");
  }
}
$("resendBtn").addEventListener("click", () => {
  $("resendBtn").disabled = true;
  sendAgain(login.channel).finally(renderResend);
});
$("smsBtn").addEventListener("click", () => sendAgain(login.channel === "sms" ? "whatsapp" : "sms"));

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
    if (error.code === "LOGIN_EXPIRED") return backToGoogle(errorText(error));
    showToast(errorText(error, "errCode"), "error");
    $("loginCode").select();
  }
});

$("changeGoogle").addEventListener("click", () => backToGoogle(""));
$("changePhone").addEventListener("click", () => {
  clearInterval(resendTimer);
  resendLeft = 0;
  login.sent = null;
  login.phoneHintKey = "";
  $("phoneHint").textContent = "";
  showStep("phone");
});

// The Google button follows the page's language (it is drawn again when it changes).
let googleReady = false;
let googleLang = "";
function renderGoogleButton() {
  if (typeof google === "undefined" || !google.accounts?.id) {
    // GSI script not loaded yet (ad-blocker / offline) — retry shortly.
    setTimeout(renderGoogleButton, 300);
    return;
  }
  if (!googleReady) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredentialResponse,
    });
    googleReady = true;
  }
  if (googleLang === lang) return;
  googleLang = lang;
  $("google-signin-slot").replaceChildren();
  google.accounts.id.renderButton($("google-signin-slot"), {
    theme: "outline",
    size: "large",
    shape: "pill",
    text: "continue_with",
    width: 300,
    locale: lang,
  });
}

$("langBtn").addEventListener("click", () => {
  lang = lang === "hi" ? "en" : "hi";
  setPreference("loginLanguage", lang);
  applyLanguage();
  renderStepTexts();
  renderNote();
  if (login.step === "google") renderGoogleButton();
});

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
        setLoginNoteText("noteDeclined");
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
$("toGoogle").addEventListener("click", () => showStep(login.challenge ? (login.sent ? "code" : "phone") : "google"));
$("qrReload").addEventListener("click", () => qrLogin.reload());

if (!alreadySignedIn) {
  applyLanguage();
  if (sessionStorage.getItem(PENDING_LINK_KEY)) setLoginNoteText("notePendingLink");
  showInviteDetails();
  showStep("google");
}
