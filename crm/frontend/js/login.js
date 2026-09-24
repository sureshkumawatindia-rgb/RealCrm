/**
 * login.js — pure client-side Google Sign-In.
 * Google Sign-In establishes the backend-authenticated session used by API calls.
 */

const GOOGLE_CLIENT_ID =
  "910305219970-gimdha8ojccrddq4oocivgg8ha32kurl.apps.googleusercontent.com";

// Already signed in? Skip straight to the right place —
// dashboard if company details exist, the company form if not.
if (isAuthenticated()) {
  window.location.replace(hasCompanyInfo() ? "dashboard.html" : "company.html");
}

function parseJwt(token) {
  const base64Url = token.split(".")[1];
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const jsonPayload = decodeURIComponent(
    atob(base64)
      .split("")
      .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
      .join(""),
  );
  return JSON.parse(jsonPayload);
}

async function handleGoogleCredentialResponse(response) {
  try {
    const payload = parseJwt(response.credential);
    const auth = await crmApi("/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential }),
    });

    localStorage.setItem("crm_session", auth.token);
    localStorage.setItem("crm_user", JSON.stringify(auth.user || {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    }));

    // First-time sign-in → collect company details before the dashboard.
    window.location.href = hasCompanyInfo() ? "dashboard.html" : "company.html";
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

initGoogleSignIn();
