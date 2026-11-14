/**
 * company.js — first-time Company Profile setup (company.html).
 * Saves to the organization on the backend, so every teammate sees the same profile.
 * Reuses shared helpers from app.js (requireAuth, loadCompanyProfile, saveCompanyProfile,
 * fillCompanyForm, readCompanyForm, isOrgManager, showToast).
 */

requireAuth();

const companyForm = document.getElementById("companyForm");
const saveBtn = document.getElementById("saveBtn");

// D152: the CRM type chosen on the home page before sign-up (login.js keeps it for this tab) is
// chosen here while the company is still on Business; saving the form sets the company up for it.
function chooseTypeFromSignup() {
  const wanted = sessionStorage.getItem(SIGNUP_TYPE_KEY);
  const select = document.getElementById("cCrmType");
  if (!wanted || !select || select.value !== "business" || !select.querySelector(`option[value="${CSS.escape(wanted)}"]`)) return;
  select.value = wanted;
}

async function prefillForm() {
  try {
    const { company } = await loadCompanyProfile();
    fillCompanyForm(company);
  } catch (error) {
    fillCompanyForm(getCompanyInfo());
    showToast(apiErrorMessage(error, t("company.couldn-t-load-the-company-profile")), "error");
  }
  if (isOrgManager()) chooseTypeFromSignup();
  if (!isOrgManager()) {
    companyForm.querySelectorAll("input, select, textarea").forEach((input) => { input.disabled = true; });
    saveBtn.disabled = true;
    showToast(t("company.only-an-owner-or-admin-can"), "info");
  }
}
prefillForm();

companyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = readCompanyForm();
  if (!data.name) {
    showToast(t("company.company-name-is-required"), "error");
    return;
  }
  saveBtn.disabled = true;
  try {
    await saveCompanyProfile(data);
    sessionStorage.removeItem(SIGNUP_TYPE_KEY);
    showToast(t("company.company-profile-saved"), "success");
    window.location.href = "dashboard.html";
  } catch (error) {
    saveBtn.disabled = false;
    showToast(apiErrorMessage(error, t("company.couldn-t-save-the-company-profile")), "error");
  }
});

document.getElementById("skipBtn").addEventListener("click", () => {
  window.location.href = "dashboard.html";
});
