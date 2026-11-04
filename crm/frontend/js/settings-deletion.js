/**
 * settings-deletion.js — Settings → Data & Privacy → deleting the company (Phase 10F, owners)
 * An owner types the company name to ask for deletion; the company keeps working for the waiting
 * period (7 days), every page says so, and any owner can keep the company until then. Afterwards
 * all its data is removed.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsDeletion() {
  if (getCurrentMember()?.role !== "owner") return;
  const $ = (id) => document.getElementById(id);
  const day = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

  function render(status) {
    $("orgDeleteSection").hidden = false;
    $("orgDeleteForm").hidden = Boolean(status);
    $("orgKeepBtn").hidden = !status;
    $("orgDeleteText").textContent = status
      ? t("setdel.this-company-will-be-deleted-on", { v: day(status.scheduledFor) })
      : t("setdel.deletes-this-company-and-all-its");
  }

  async function load() {
    try {
      render(await crmApi("/organization/deletion"));
    } catch {
      /* stays hidden */
    }
  }

  $("orgDeleteBtn").addEventListener("click", async () => {
    const confirmName = $("orgDeleteName").value.trim();
    if (!confirmName) {
      showToast(t("setdel.type-the-company-name-to-confirm"), "error");
      return;
    }
    if (!confirm(t("setdel.delete-this-company-and-all-its"))) return;
    try {
      render(await crmApi("/organization", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmName }) }));
      showToast(t("setdel.the-company-will-be-deleted-after"), "success");
      crmPlan.forget();
      crmPlan.mountBanner();
    } catch (error) {
      showToast(apiErrorMessage(error, t("setdel.could-not-ask-for-the-deletion")), "error");
    }
  });

  $("orgKeepBtn").addEventListener("click", async () => {
    try {
      await crmApi("/organization/deletion/cancel", { method: "POST" });
      render(null);
      $("orgDeleteName").value = "";
      showToast(t("setdel.the-company-will-not-be-deleted"), "success");
      crmPlan.forget();
      crmPlan.mountBanner();
    } catch (error) {
      showToast(apiErrorMessage(error, t("setdel.could-not-cancel-the-deletion")), "error");
    }
  });

  load();
})();
