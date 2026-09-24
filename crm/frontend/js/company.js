/**
 * company-setup.js — Company Profile page
 * Persists a single object to localStorage under 'crm_company'.
 * Reuses shared helpers from app.js (requireAuth, showToast, saveCompany, getCompany).
 */

requireAuth();

const companyForm = document.getElementById("companyForm");

// If a profile already exists (user came back to edit it), prefill the form.
function prefillForm() {
  const company = getCompany();
  if (!company) return;
  document.getElementById("cName").value = company.name || "";
  document.getElementById("cIndustry").value = company.industry || "";
  document.getElementById("cSize").value = company.size || "";
  document.getElementById("cFounded").value = company.founded || "";
  document.getElementById("cLogo").value = company.logo || "";
  document.getElementById("cWebsite").value = company.website || "";
  document.getElementById("cEmail").value = company.email || "";
  document.getElementById("cPhone").value = company.phone || "";
  document.getElementById("cGst").value = company.gst || "";
  document.getElementById("cAddress").value = company.address || "";
  document.getElementById("cCity").value = company.city || "";
  document.getElementById("cState").value = company.state || "";
  document.getElementById("cCountry").value = company.country || "";
  document.getElementById("cPincode").value = company.pincode || "";
  document.getElementById("cDescription").value = company.description || "";
}
prefillForm();

companyForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("cName").value.trim();
  if (!name) {
    showToast("Company name is required.", "error");
    return;
  }

  const data = {
    name,
    industry: document.getElementById("cIndustry").value.trim(),
    size: document.getElementById("cSize").value,
    founded: document.getElementById("cFounded").value,
    logo: document.getElementById("cLogo").value.trim(),
    website: document.getElementById("cWebsite").value.trim(),
    email: document.getElementById("cEmail").value.trim(),
    phone: document.getElementById("cPhone").value.trim(),
    gst: document.getElementById("cGst").value.trim(),
    address: document.getElementById("cAddress").value.trim(),
    city: document.getElementById("cCity").value.trim(),
    state: document.getElementById("cState").value.trim(),
    country: document.getElementById("cCountry").value.trim(),
    pincode: document.getElementById("cPincode").value.trim(),
    description: document.getElementById("cDescription").value.trim(),
  };

  saveCompany(data);
  showToast("Company profile saved.", "success");
  window.location.href = "dashboard.html";
});

document.getElementById("skipBtn").addEventListener("click", () => {
  window.location.href = "dashboard.html";
});
