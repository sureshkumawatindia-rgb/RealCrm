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
// login.html?signup=1 ("Start free trial" on the home page) opens "Create your company".
const signupFromLink = new URLSearchParams(window.location.search).get("signup") === "1";

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
// The texts are in i18n/en.json and i18n/hi.json under "login." (CP5), like every page's.

const lt = (key, values) => t(`login.${key}`, values);

// The server answers in English; in Hindi the usual login errors are shown in Hindi.
function errorText(error, fallbackKey) {
  if (crmI18n.language() === "hi") {
    if (crmI18n.has(`login.error.${error?.code}`)) return lt(`error.${error.code}`);
    if (error?.code === "VALIDATION_ERROR") return lt(error.errors?.[0]?.field === "code" ? "error.codeDigits" : "error.mobile");
  }
  return apiErrorMessage(error, fallbackKey ? lt(fallbackKey) : "");
}

function applyLanguage() {
  $("langLabel").textContent = crmI18n.language() === "hi" ? "English" : "हिंदी";
  crmI18n.apply(document);
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("aria-label", el.placeholder);
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
  const message = note.key ? lt(note.key, note.values) : note.raw;
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
  $("loginSub").textContent = lt(signingUp ? "subSignup" : login.step === "code" && login.channel === "sms" ? "subCodeSms" : step.sub);
  $("smsBtn").textContent = lt(login.channel === "sms" ? "byWhatsapp" : "bySms");
  if (login.sent) {
    const { phone, channel, minutes } = login.sent;
    $("codeHint").textContent = `${lt(channel === "sms" ? "sentSms" : "sentWhatsapp", { phone })} ${lt("expires", { m: minutes })}`;
  }
  $("phoneHint").textContent = login.phoneHintKey ? lt(login.phoneHintKey) : "";
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
    const auth = await crmApi("/auth/google", postJson({ credential: response.credential, inviteToken, workspace, language: crmI18n.language() }));
    if (auth.step !== "whatsapp-code") {
      rememberCompany();
      await completeSignIn(auth);
      return;
    }
    Object.assign(login, { challenge: auth.challenge, smsBackup: Boolean(auth.smsBackup), channel: "whatsapp", sent: null });
    $("whoEmail").textContent = auth.user?.email || lt("signedInGoogle");
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
  button.textContent = resendLeft > 0 ? lt("resendIn", { s: resendLeft }) : lt("resend");
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
    showToast(lt("newCode"), "success");
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
  mode: signupFromLink && !sessionStorage.getItem(INVITE_KEY) ? "signup" : "login", // or "signup": "Create your company" (Google alone, the old way)
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
  if (code === "COMPANY_EMPTY") return lt("companyFirst");
  if (code === "WORKSPACE_NOT_FOUND") return lt("errCompanyNotFound");
  if (code === "WORKSPACE_AMBIGUOUS") return lt("errCompanyAmbiguous");
  if (code === "RATE_LIMITED") return lt("errTooMany");
  return company.error.status ? errorText(company.error) : lt("errCompanyCheck"); // no answer: offline
}

function renderCompany() {
  const signup = company.mode === "signup";
  const ready = signup || Boolean(company.found);
  const input = $("loginCompany");
  $("companyForm").hidden = signup;
  input.placeholder = lt("companyPlaceholder");
  input.setAttribute("aria-invalid", String(company.state === "error"));
  input.setAttribute("aria-busy", String(company.state === "checking"));
  $("companyField").className = `login-company-field${company.state ? ` is-${company.state}` : ""}`;
  const icon = { checking: "fa-spinner fa-spin", found: "fa-circle-check" }[company.state];
  $("companyState").innerHTML = icon ? `<i class="fa-solid ${icon}"></i>` : "";
  $("companyHelp").textContent = company.found ? lt("companyFound", { name: company.found.name }) : lt("companyHelp");
  const error = companyErrorText();
  $("companyError").textContent = error;
  $("companyError").hidden = !error;
  const refused = company.googleError ? lt("errNotInWorkspace", { company: company.googleError.company }) : "";
  $("googleError").textContent = refused;
  $("googleError").hidden = !refused;
  $("googleWait").hidden = ready;
  $("googleWait").title = ready ? "" : lt("companyFirst");
  $("google-signin-slot").hidden = !ready;
  $("googleHint").textContent = lt(signup ? "signupHint" : "googleHint");
  $("signupAsk").textContent = lt(signup ? "haveCompany" : "newHere");
  $("signupLink").textContent = lt(signup ? "logInCompany" : "createCompany");
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
  if (googleLang === crmI18n.language() && Math.abs(googleWidth - width) < 8) return;
  googleLang = crmI18n.language();
  googleWidth = width;
  $("google-signin-slot").replaceChildren();
  google.accounts.id.renderButton($("google-signin-slot"), {
    theme: "outline",
    size: "large",
    shape: "pill",
    text: "continue_with",
    width,
    locale: crmI18n.language(),
  });
}
let googleResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(googleResizeTimer);
  googleResizeTimer = setTimeout(() => {
    if (googleReady && Math.abs(googleButtonWidth() - googleWidth) >= 8) renderGoogleButton();
  }, 250);
});

// Before signing in the choice is this browser's; it is saved on the account at sign-in (CP5).
$("langBtn").addEventListener("click", async () => {
  await crmI18n.setLanguage(crmI18n.language() === "hi" ? "en" : "hi");
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

// The page's texts first (i18n/*.json), then the card.
if (!alreadySignedIn) crmI18n.ready.then(() => {
  applyLanguage();
  if (sessionStorage.getItem(PENDING_LINK_KEY)) setLoginNoteText("notePendingLink");
  // With an invite, its company is filled in once the invite is looked up.
  if (!sessionStorage.getItem(INVITE_KEY)) fillCompany(companyFromLink || getPreference(COMPANY_PREF, ""));
  showInviteDetails();
  showStep(withPhone ? "qr" : "google");
  if (!$("loginCompany").value && !withPhone && window.matchMedia("(pointer: fine)").matches) $("loginCompany").focus();
});
