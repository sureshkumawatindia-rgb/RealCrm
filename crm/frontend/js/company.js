/**
 * company.js — first-time Company Profile setup (company.html).
 * Saves to the organization on the backend, so every teammate sees the same profile.
 * Reuses shared helpers from app.js (requireAuth, loadCompanyProfile, saveCompanyProfile,
 * fillCompanyForm, readCompanyForm, isOrgManager, showToast).
 */

requireAuth();

const companyForm = document.getElementById("companyForm");
const saveBtn = document.getElementById("saveBtn");

async function prefillForm() {
  try {
    const { company } = await loadCompanyProfile();
    fillCompanyForm(company);
  } catch (error) {
    fillCompanyForm(getCompanyInfo());
    showToast(apiErrorMessage(error, t("company.couldn-t-load-the-company-profile")), "error");
  }
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
