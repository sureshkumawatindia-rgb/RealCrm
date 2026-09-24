/**
 * login.js — Google Sign-In for the CRM.
 * The Google credential is verified by the backend, which returns a short-lived access token
 * (kept in localStorage) and sets the refresh token as an httpOnly cookie.
 * An invite link (login.html?invite=...) adds the user to the inviting company.
 */

const GOOGLE_CLIENT_ID =
  "910305219970-gimdha8ojccrddq4oocivgg8ha32kurl.apps.googleusercontent.com";
const INVITE_KEY = "crm_pending_invite";

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

// Already signed in (and no invite to accept)? Skip straight to the right place.
if (isAuthenticated() && !sessionStorage.getItem(INVITE_KEY)) {
  window.location.replace(hasCompanyInfo() ? "dashboard.html" : "company.html");
}

function setLoginNote(message) {
  const note = document.getElementById("login-note");
  if (!note) return;
  note.textContent = message;
  note.hidden = !message;
}

async function showInviteDetails() {
  const token = sessionStorage.getItem(INVITE_KEY);
  if (!token) {
    if (sessionStorage.getItem("crm_session_expired")) {
      sessionStorage.removeItem("crm_session_expired");
      setLoginNote("Your session ended. Please sign in again.");
    }
    return;
  }
  try {
    const invite = await crmApi("/invites/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setLoginNote(`You're invited to join ${invite.organizationName} as ${invite.role}. Sign in with ${invite.email}.`);
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
    const first = Object.entries(PAGE_MODULES).find(([, module]) => (member?.modules || []).includes(module));
    return first ? encodeURI(first[0]) : "Settings.html";
  }
  try {
    const { company } = await loadCompanyProfile();
    return companyHasDetails(company) || !managers.includes(member?.role) ? "dashboard.html" : "company.html";
  } catch {
    return "dashboard.html";
  }
}

async function handleGoogleCredentialResponse(response) {
  const inviteToken = sessionStorage.getItem(INVITE_KEY) || "";
  try {
    const auth = await crmApi("/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential, inviteToken }),
    });

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
    window.location.href = await nextPage(auth.member);
  } catch (error) {
    showToast(error.message || "Google sign-in failed. Please try again.", "error");
  }
}

function initGoogleSignIn() {
  if (typeof google === "undefined" || !google.accounts?.id) {
    // GSI script not loaded yet (ad-blocker / offline) — retry shortly.
    setTimeout(initGoogleSignIn, 300);
    return;
  }

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredentialResponse,
  });

  google.accounts.id.renderButton(
    document.getElementById("google-signin-slot"),
    {
      theme: "outline",
      size: "large",
      shape: "pill",
      text: "continue_with",
      width: 260,
    },
  );
}

showInviteDetails();
initGoogleSignIn();
