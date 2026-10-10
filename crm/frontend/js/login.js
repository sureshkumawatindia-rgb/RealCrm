/**
 * login.js — logging in (D60): Google. People who switched on 2-step verification (Settings →
 * Your Profile) then confirm a 6-digit code sent on WhatsApp (or by SMS) on a new browser; "Stay
 * logged in on this browser" skips it there for 30 days. A computer can also be logged in from a
 * phone where the person is signed in: login.html?with=phone shows the code to scan.
 * After signing in, an owner or admin whose company has no WhatsApp yet is offered "Connect
 * WhatsApp" (connect-whatsapp.html).
 * The page speaks English or Hindi (the choice is kept in crm_prefs). An invite link shows the
 * inviting company's logo and name.
 * The company comes first (D66): its name or workspace code is checked before Google, and only
 * that company's team gets in. "Create your company" is the sign-up: Google alone, and a new
 * company for someone who has none. The last company is remembered on this browser (crm_prefs).
 * The backend returns a short-lived access token (kept in localStorage) and sets the refresh
 * token as an httpOnly cookie. An invite link (login.html?invite=...) adds the user to the
 * inviting company.
 */

const GOOGLE_CLIENT_ID =
  "910305219970-gimdha8ojccrddq4oocivgg8ha32kurl.apps.googleusercontent.com";
const INVITE_KEY = "crm_pending_invite";
const PENDING_LINK_KEY = "crm_pending_link"; // a computer's code scanned before signing in
const QR_POLL_MS = 2000;
const QR_AUTO_REFRESHES = 4; // then "Click to show a new code"
const RESEND_WAIT_S = 30;
const CONNECT_SKIP_DAYS = 7; // "Skip for now" on connect-whatsapp.html is asked again after this
const COMPANY_PREF = "loginCompany"; // the company last signed in to on this browser
const COMPANY_CHECK_MS = 600; // the company is checked once typing pauses this long
// login.html?company=sharma-traders (a link an admin shares) fills in the company.
const companyFromLink = new URLSearchParams(window.location.search).get("company") || "";

// Take the invite token (and ?with=phone) out of the address bar right away, so it is not kept
// in history or sent to the server as a Referer.
const withPhone = (function captureParams() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get("invite");
  if (invite) sessionStorage.setItem(INVITE_KEY, invite);
  if (params.has("expired")) sessionStorage.setItem("crm_session_expired", "1");
  if (invite || params.has("expired") || params.has("with")) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  return params.get("with") === "phone";
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
  // The same next page as after signing in (an agent never lands on the company setup); run once
  // this whole script has loaded.
  Promise.resolve()
    .then(async () => window.location.replace(pendingLinkPage() || (await nextPage(getCurrentMember()))))
    .catch(() => window.location.replace("dashboard.html"));
}

const $ = (id) => document.getElementById(id);
const postJson = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const stayLoggedIn = () => Boolean($("stayLoggedIn")?.checked);

// ---------------------------------------------------------------
// English / Hindi
// ---------------------------------------------------------------
const TEXT = {
  en: {
    pitchTitle: "Every WhatsApp enquiry, one team inbox.",
    pitchText: "Chats, leads, quotations, orders and payments of your business — in one place, for your whole team.",
    point1: "Works with your WhatsApp Business app number",
    point2: "Your team replies from one shared inbox",
    point3: "GST quotations and payment links in the chat",
    subGoogle: "Sign in to your workspace",
    subSignup: "Create your company's workspace",
    googleHint: "Use the Google account your company added you with.",
    signupHint: "Sign in with Google. Your company is set up next, then you can add your team.",
    companyLabel: "Company name",
    companyPlaceholder: "e.g. Sharma Traders",
    companyHelp: "Enter the name your company registered with Yellow CRM.",
    companyFound: "{name} found. Continue with Google.",
    companyFirst: "Enter your company name first.",
    continueGoogle: "Continue with Google",
    newHere: "New to Yellow CRM?",
    createCompany: "Create your company",
    haveCompany: "Already on Yellow CRM?",
    logInCompany: "Log in to your company",
    errCompanyNotFound: "We couldn't find this company. Check the name or ask your admin.",
    errCompanyAmbiguous: "More than one company has this name. Enter your workspace code instead. Your admin finds it in Settings → Company.",
    errNotInWorkspace: "This Google account hasn't been added to {company}. Ask your admin to add you.",
    errTooMany: "Too many tries. Wait a minute and try again.",
    errCompanyCheck: "Could not check the company. Check your internet and try again.",
    subPhone: "2-step verification is on for your account. We'll send a code on WhatsApp.",
    subCode: "Enter the 6-digit code from WhatsApp.",
    subCodeSms: "Enter the 6-digit code from the SMS.",
    subQr: "Scan this code with your phone to log in on this computer.",
    signingIn: "Signing you in…",
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
    stayInfo: "On this browser, the code is not asked again for 30 days. Logging out ends it. Don't tick it on a shared computer.",
    toGoogle: "Log in with Google instead",
    qrReload: "Click to show a new code",
    qr1: "Open <strong>YELLOW CRM</strong> on your phone, where you are signed in",
    qr2: "Tap <strong>Settings → Your Profile → Log in on another computer</strong>",
    qr3: "Point your phone at this code and tap <strong>Allow</strong>",
    legal: 'By continuing you agree to the <a href="terms.html">Terms of Service</a> and <a href="privacy.html">Privacy Policy</a>.',
    privacy: "Privacy Policy",
    terms: "Terms of Service",
    hintFilled: "Your verified number is filled in.",
    hintNew: "Your WhatsApp number. It is verified with the code.",
    sentWhatsapp: "We sent a code to {phone} on WhatsApp.",
    sentSms: "We sent a code to {phone} by SMS.",
    expires: "It works for {m} minutes.",
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
    pitchTitle: "हर WhatsApp पूछताछ, एक टीम इनबॉक्स में।",
    pitchText: "आपके कारोबार की चैट, लीड, कोटेशन, ऑर्डर और पेमेंट — एक ही जगह, पूरी टीम के लिए।",
    point1: "आपके WhatsApp Business ऐप वाले नंबर के साथ चलता है",
    point2: "आपकी टीम एक साझा इनबॉक्स से जवाब देती है",
    point3: "चैट में ही GST कोटेशन और पेमेंट लिंक",
    subGoogle: "अपने वर्कस्पेस में साइन इन करें",
    subSignup: "अपनी कंपनी का वर्कस्पेस बनाएँ",
    googleHint: "वही Google खाता इस्तेमाल करें जिससे आपकी कंपनी ने आपको जोड़ा है।",
    signupHint: "Google से साइन इन करें। फिर आपकी कंपनी बनेगी और आप अपनी टीम को जोड़ सकेंगे।",
    companyLabel: "कंपनी का नाम",
    companyPlaceholder: "जैसे शर्मा ट्रेडर्स",
    companyHelp: "अपनी कंपनी का नाम दर्ज करें जो Yellow CRM में रजिस्टर है।",
    companyFound: "{name} मिल गई। Google से आगे बढ़ें।",
    companyFirst: "पहले अपनी कंपनी का नाम डालें।",
    continueGoogle: "Google के साथ जारी रखें",
    newHere: "Yellow CRM पर नए हैं?",
    createCompany: "अपनी कंपनी बनाएँ",
    haveCompany: "पहले से Yellow CRM पर हैं?",
    logInCompany: "अपनी कंपनी में लॉग इन करें",
    errCompanyNotFound: "यह कंपनी नहीं मिली। नाम जाँचें या अपने एडमिन से पूछें।",
    errCompanyAmbiguous: "इस नाम की एक से ज़्यादा कंपनियाँ हैं। अपना वर्कस्पेस कोड डालें। यह आपके एडमिन को Settings → Company में मिलेगा।",
    errNotInWorkspace: "यह Google खाता {company} में नहीं जोड़ा गया है। अपने एडमिन से आपको जोड़ने के लिए कहें।",
    errTooMany: "बहुत बार कोशिश हुई। एक मिनट रुककर फिर कोशिश करें।",
    errCompanyCheck: "कंपनी की जाँच नहीं हो सकी। इंटरनेट देखें और फिर कोशिश करें।",
    subPhone: "आपके खाते पर 2-स्टेप वेरिफ़िकेशन चालू है। हम WhatsApp पर एक कोड भेजेंगे।",
    subCode: "WhatsApp पर आया 6 अंकों का कोड डालें।",
    subCodeSms: "SMS से आया 6 अंकों का कोड डालें।",
    subQr: "इस कंप्यूटर पर लॉग इन करने के लिए यह कोड अपने फ़ोन से स्कैन करें।",
    signingIn: "साइन इन हो रहा है…",
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
    stayInfo: "इस ब्राउज़र पर 30 दिन तक कोड दोबारा नहीं माँगा जाएगा। लॉग आउट करने पर यह ख़त्म हो जाता है। किसी साझा कंप्यूटर पर इसे न चुनें।",
    toGoogle: "Google से लॉग इन करें",
    qrReload: "नया कोड दिखाने के लिए क्लिक करें",
    qr1: "अपने फ़ोन पर <strong>YELLOW CRM</strong> खोलें, जहाँ आप साइन इन हैं",
    qr2: "<strong>Settings → Your Profile → Log in on another computer</strong> पर टैप करें",
    qr3: "फ़ोन को इस कोड की ओर करें और <strong>Allow</strong> पर टैप करें",
    legal: 'आगे बढ़कर आप <a href="terms.html">सेवा की शर्तों</a> और <a href="privacy.html">गोपनीयता नीति</a> से सहमत होते हैं।',
    privacy: "गोपनीयता नीति",
    terms: "सेवा की शर्तें",
    hintFilled: "आपका सत्यापित नंबर भरा हुआ है।",
    hintNew: "आपका WhatsApp नंबर। यह कोड से सत्यापित होगा।",
    sentWhatsapp: "{phone} पर WhatsApp से कोड भेजा गया है।",
    sentSms: "{phone} पर SMS से कोड भेजा गया है।",
    expires: "यह {m} मिनट तक चलेगा।",
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
  const letter = () => {
    $("loginMark").textContent = (name || "A").trim().charAt(0).toUpperCase();
    $("loginMark").classList.add("is-letter");
  };
  if (!logoUrl) return letter();
  const img = document.createElement("img");
  img.src = logoUrl;
  img.alt = "";
  img.addEventListener("error", letter);
  $("loginMark").replaceChildren(img);
  $("loginMark").classList.add("has-logo");
  return undefined;
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
    if (invite.workspace) useCompany({ name: invite.organizationName, logoUrl: invite.logoUrl, slug: invite.workspace });
    else fillCompany(invite.organizationName);
  } catch (error) {
    sessionStorage.removeItem(INVITE_KEY);
    setLoginNote(error.message || "This invite link is no longer valid. Ask for a new one.");
    fillCompany(companyFromLink || getPreference(COMPANY_PREF, ""));
  }
}

// An owner or admin whose company has no WhatsApp yet is offered "Connect WhatsApp" — once the
// platform has set it up, and not again for a week after "Skip for now".
async function shouldConnectWhatsApp() {
  try {
    const status = await crmApi("/whatsapp/connect");
    if (!status.available || status.connected) return false;
    const skippedAt = Number(getPreference("whatsappConnectSkippedAt", 0)) || 0;
    return Date.now() - skippedAt > CONNECT_SKIP_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

// Where to go after sign-in: owners/admins connect WhatsApp, then set up an empty company
// profile; agents and viewers without the dashboard start on the first page they may open.
async function nextPage(member) {
  const managers = ["owner", "admin"];
  if (!managers.includes(member?.role) && !(member?.modules || []).includes("dashboard")) return firstAllowedPage(member);
  if (!managers.includes(member?.role)) return "dashboard.html";
  if (await shouldConnectWhatsApp()) return "connect-whatsapp.html";
  return onboardingNextPage(); // Invite your team, then company details (D64)
}

// Signed in (Google, the 2-step code, or the phone): keep the session and open the first page.
async function completeSignIn(auth) {
  qrLogin.stop();
  showStep("busy");
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
  google: { panel: "googleStep", sub: "subGoogle" },
  phone: { panel: "phoneStep", sub: "subPhone" },
  code: { panel: "codeStep", sub: "subCode" },
  qr: { panel: "qrStep", sub: "subQr" },
  busy: { panel: "busyStep", sub: "subGoogle" },
};
const login = { challenge: "", phone: "", channel: "whatsapp", smsBackup: false, step: "google", sent: null, phoneHintKey: "" };
let resendTimer = null;
let resendLeft = 0;

function renderStepTexts() {
  const step = STEPS[login.step];
  const signingUp = ["google", "busy"].includes(login.step) && company.mode === "signup";
  $("loginSub").textContent = t(signingUp ? "subSignup" : login.step === "code" && login.channel === "sms" ? "subCodeSms" : step.sub);
  $("smsBtn").textContent = t(login.channel === "sms" ? "byWhatsapp" : "bySms");
  if (login.sent) {
    const { phone, channel, minutes } = login.sent;
    $("codeHint").textContent = `${t(channel === "sms" ? "sentSms" : "sentWhatsapp", { phone })} ${t("expires", { m: minutes })}`;
  }
  $("phoneHint").textContent = login.phoneHintKey ? t(login.phoneHintKey) : "";
  renderResend();
}

function showStep(name) {
  login.step = name;
  const step = STEPS[name];
  Object.values(STEPS).forEach(({ panel }) => {
    $(panel).hidden = panel !== step.panel;
  });
  $("stayRow").hidden = !["code", "qr"].includes(name);
  $("smsRow").hidden = name !== "code" || !login.smsBackup;
  $("toGoogle").hidden = name !== "qr";
  renderStepTexts();
  if (name === "qr") qrLogin.start();
  else qrLogin.stop();
  if (name === "google") renderCompany();
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

// Google → signed in, or (2-step verification) the number and the code.
async function handleGoogleCredentialResponse(response) {
  const inviteToken = sessionStorage.getItem(INVITE_KEY) || "";
  const workspace = company.mode === "login" ? company.found?.slug || "" : "";
  if (company.mode === "login" && !workspace) return showStep("google"); // the company was changed meanwhile
  company.googleError = null;
  showStep("busy");
  try {
    const auth = await crmApi("/auth/google", postJson({ credential: response.credential, inviteToken, workspace }));
    if (auth.step !== "whatsapp-code") {
      rememberCompany();
      await completeSignIn(auth);
      return;
    }
    Object.assign(login, { challenge: auth.challenge, smsBackup: Boolean(auth.smsBackup), channel: "whatsapp", sent: null });
    $("whoEmail").textContent = auth.user?.email || t("signedInGoogle");
    $("loginPhone").value = prettyPhone(auth.phone);
    login.phoneHintKey = auth.phone ? "hintFilled" : "hintNew";
    if (note.key !== "noteInvite") setLoginNote("");
    showStep("phone");
  } catch (error) {
    showStep("google");
    if (!companyRefused(error)) showToast(errorText(error, "errGoogle"), "error");
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

// The number → the code (and "Send the code again", and the SMS backup).
async function sendCode(phone, channel) {
  const sent = await crmApi("/auth/login/code", postJson({ challenge: login.challenge, phone, channel }));
  login.phone = phone;
  login.channel = channel;
  login.sent = { phone, channel, minutes: Math.round((sent.expiresInSeconds || 300) / 60) };
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

$("codeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!login.challenge || !login.phone) return backToGoogle("");
  $("verifyBtn").disabled = true;
  try {
    const auth = await crmApi("/auth/login/verify", postJson({
      challenge: login.challenge, phone: login.phone, code: $("loginCode").value.trim(), stayLoggedIn: stayLoggedIn(),
    }));
    rememberCompany();
    await completeSignIn(auth);
  } catch (error) {
    $("verifyBtn").disabled = false;
    if (error.code === "LOGIN_EXPIRED") return backToGoogle(errorText(error));
    if (["NOT_IN_WORKSPACE", "WORKSPACE_NOT_FOUND"].includes(error.code)) {
      backToGoogle("");
      return companyRefused(error);
    }
    showStep("code");
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
  showStep("phone");
});

// ---------------------------------------------------------------
// The company (D66): checked as it is typed, before Google. Google's button cannot be switched
// off, so a plain look-alike (#googleWait) stands in until the company is found.
// ---------------------------------------------------------------
const company = {
  mode: "login", // or "signup": "Create your company" (Google alone, the old way)
  found: null, // { name, logoUrl, slug } from POST /auth/workspace (or the invite)
  typed: "", // what was found, as typed
  state: "", // "checking" | "found" | "error"
  error: null, // why the company was not found
  googleError: null, // Google's account is not on that company's team
  seq: 0, // only the answer to the latest check counts
  timer: null,
};
const defaultMark = { title: $("loginTitle").textContent, mark: $("loginMark").innerHTML };
const tidyCompany = (text) => String(text || "").trim().replace(/\s+/g, " ");

// The found company's logo and name on the card; back to YELLOW CRM when it is cleared.
function setFound(found) {
  company.found = found;
  if (found) {
    showCompany(found.name, found.logoUrl);
    return;
  }
  $("loginTitle").textContent = defaultMark.title;
  $("loginMark").className = "login-mark";
  $("loginMark").innerHTML = defaultMark.mark; // the CRM's own icon from the page
}

function companyErrorText() {
  const code = company.error?.code;
  if (!code && !company.error) return "";
  if (code === "COMPANY_EMPTY") return t("companyFirst");
  if (code === "WORKSPACE_NOT_FOUND") return t("errCompanyNotFound");
  if (code === "WORKSPACE_AMBIGUOUS") return t("errCompanyAmbiguous");
  if (code === "RATE_LIMITED") return t("errTooMany");
  return company.error.status ? errorText(company.error) : t("errCompanyCheck"); // no answer: offline
}

function renderCompany() {
  const signup = company.mode === "signup";
  const ready = signup || Boolean(company.found);
  const input = $("loginCompany");
  $("companyForm").hidden = signup;
  input.placeholder = t("companyPlaceholder");
  input.setAttribute("aria-invalid", String(company.state === "error"));
  input.setAttribute("aria-busy", String(company.state === "checking"));
  $("companyField").className = `login-company-field${company.state ? ` is-${company.state}` : ""}`;
  const icon = { checking: "fa-spinner fa-spin", found: "fa-circle-check" }[company.state];
  $("companyState").innerHTML = icon ? `<i class="fa-solid ${icon}"></i>` : "";
  $("companyHelp").textContent = company.found ? t("companyFound", { name: company.found.name }) : t("companyHelp");
  const error = companyErrorText();
  $("companyError").textContent = error;
  $("companyError").hidden = !error;
  const refused = company.googleError ? t("errNotInWorkspace", { company: company.googleError.company }) : "";
  $("googleError").textContent = refused;
  $("googleError").hidden = !refused;
  $("googleWait").hidden = ready;
  $("googleWait").title = ready ? "" : t("companyFirst");
  $("google-signin-slot").hidden = !ready;
  $("googleHint").textContent = t(signup ? "signupHint" : "googleHint");
  $("signupAsk").textContent = t(signup ? "haveCompany" : "newHere");
  $("signupLink").textContent = t(signup ? "logInCompany" : "createCompany");
  if (ready && login.step === "google") renderGoogleButton();
}

async function checkCompany(typed) {
  clearTimeout(company.timer);
  company.timer = null;
  company.seq += 1;
  const seq = company.seq;
  Object.assign(company, { state: "checking", error: null, googleError: null });
  renderCompany();
  let found = null;
  let failure = null;
  try {
    found = await crmApi("/auth/workspace", postJson({ company: typed }));
  } catch (error) {
    failure = { code: error.code, status: error.status, message: error.message, errors: error.errors };
  }
  if (seq !== company.seq) return; // typed on since: a newer check is coming
  Object.assign(company, { typed, state: found ? "found" : "error", error: failure });
  setFound(found);
  renderCompany();
}

// The company as typed (the last one, or from a link): checked straight away.
function fillCompany(text) {
  const typed = tidyCompany(text);
  if (!typed) return;
  $("loginCompany").value = typed;
  checkCompany(typed);
}

// An invite link knows its company already.
function useCompany(found) {
  company.seq += 1; // any check on the way is for something else
  clearTimeout(company.timer);
  $("loginCompany").value = found.name;
  Object.assign(company, { typed: found.name, state: "found", error: null, googleError: null });
  setFound(found);
  renderCompany();
}

// Signed in through the company: it is filled in next time on this browser.
function rememberCompany() {
  if (company.mode === "login" && company.found) setPreference(COMPANY_PREF, company.typed);
}

// Google's answer refused for this company → true when it was shown here.
function companyRefused(error) {
  if (error.code === "NOT_IN_WORKSPACE") {
    company.googleError = { company: company.found?.name || tidyCompany($("loginCompany").value) };
  } else if (error.code === "WORKSPACE_NOT_FOUND") {
    Object.assign(company, { state: "error", error: { code: error.code, status: error.status } });
    setFound(null);
  } else {
    return false;
  }
  renderCompany();
  return true;
}

$("loginCompany").addEventListener("input", () => {
  const typed = tidyCompany($("loginCompany").value);
  if (company.found && typed.toLowerCase() === company.typed.toLowerCase()) return;
  clearTimeout(company.timer);
  company.seq += 1;
  Object.assign(company, { state: typed.length >= 2 ? "checking" : "", error: null, googleError: null });
  setFound(null);
  renderCompany();
  if (typed.length >= 2) company.timer = setTimeout(() => checkCompany(typed), COMPANY_CHECK_MS);
});
// Leaving the field or pressing Enter checks it now.
$("loginCompany").addEventListener("blur", () => {
  if (company.timer) checkCompany(tidyCompany($("loginCompany").value));
});
$("companyForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const typed = tidyCompany($("loginCompany").value);
  if (!typed) {
    Object.assign(company, { state: "error", error: { code: "COMPANY_EMPTY" } });
    renderCompany();
  } else if (company.timer || (!company.found && company.state !== "checking")) {
    checkCompany(typed);
  }
});
// The stand-in button says what is missing.
$("googleWait").addEventListener("click", () => {
  if (!tidyCompany($("loginCompany").value)) {
    Object.assign(company, { state: "error", error: { code: "COMPANY_EMPTY" } });
    renderCompany();
  }
  $("loginCompany").focus();
});
$("signupLink").addEventListener("click", () => {
  company.mode = company.mode === "signup" ? "login" : "signup";
  company.googleError = null;
  renderStepTexts();
  renderCompany();
  if (company.mode === "login") $("loginCompany").focus();
});

// The Google button follows the page's language and fits the card: Google draws it at a fixed
// width (200–400 px), so it is drawn again when the language or the room for it changes (a
// phone turned sideways).
let googleReady = false;
let googleLang = "";
let googleWidth = 0;
function googleButtonWidth() {
  const room = $("google-signin-slot").parentElement?.clientWidth || 300;
  return Math.max(200, Math.min(400, Math.floor(room)));
}
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
  if ($("google-signin-slot").hidden) return; // drawn when the company is found (or for a sign-up)
  // The room comes from the card (its grid column never grows with the button, style.css).
  const width = googleButtonWidth();
  if (googleLang === lang && Math.abs(googleWidth - width) < 8) return;
  googleLang = lang;
  googleWidth = width;
  $("google-signin-slot").replaceChildren();
  google.accounts.id.renderButton($("google-signin-slot"), {
    theme: "outline",
    size: "large",
    shape: "pill",
    text: "continue_with",
    width,
    locale: lang,
  });
}
let googleResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(googleResizeTimer);
  googleResizeTimer = setTimeout(() => {
    if (googleReady && Math.abs(googleButtonWidth() - googleWidth) >= 8) renderGoogleButton();
  }, 250);
});

$("langBtn").addEventListener("click", () => {
  lang = lang === "hi" ? "en" : "hi";
  setPreference("loginLanguage", lang);
  applyLanguage();
  renderStepTexts();
  renderNote();
  if (login.step === "google") renderCompany();
});

// ---------------------------------------------------------------
// A computer logged in from the phone (login.html?with=phone)
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

$("toGoogle").addEventListener("click", () => showStep(login.challenge ? (login.sent ? "code" : "phone") : "google"));
$("qrReload").addEventListener("click", () => qrLogin.reload());

if (!alreadySignedIn) {
  applyLanguage();
  if (sessionStorage.getItem(PENDING_LINK_KEY)) setLoginNoteText("notePendingLink");
  // With an invite, its company is filled in once the invite is looked up.
  if (!sessionStorage.getItem(INVITE_KEY)) fillCompany(companyFromLink || getPreference(COMPANY_PREF, ""));
  showInviteDetails();
  showStep(withPhone ? "qr" : "google");
  if (!$("loginCompany").value && !withPhone && window.matchMedia("(pointer: fine)").matches) $("loginCompany").focus();
}
