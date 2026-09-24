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
    showToast(apiErrorMessage(error, "Couldn't load the company profile."), "error");
  }
  if (!isOrgManager()) {
    companyForm.querySelectorAll("input, select, textarea").forEach((input) => { input.disabled = true; });
    saveBtn.disabled = true;
    showToast("Only an owner or admin can edit the company profile.", "info");
  }
}
prefillForm();

companyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = readCompanyForm();
  if (!data.name) {
    showToast("Company name is required.", "error");
    return;
  }
  saveBtn.disabled = true;
  try {
    await saveCompanyProfile(data);
    showToast("Company profile saved.", "success");
    window.location.href = "dashboard.html";
  } catch (error) {
    saveBtn.disabled = false;
    showToast(apiErrorMessage(error, "Couldn't save the company profile."), "error");
  }
});

document.getElementById("skipBtn").addEventListener("click", () => {
  window.location.href = "dashboard.html";
});
