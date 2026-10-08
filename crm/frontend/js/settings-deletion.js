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
      ? `This company will be deleted on ${day(status.scheduledFor)}, with all its customers, leads, chats, quotations, orders, files and settings. Download the data above before then. Until then everything works, and you can keep the company.`
      : "Deletes this company and all its data for good: customers, leads, WhatsApp chats, quotations, orders, files, settings and the team's access. It happens 7 days after you ask; until then you can change your mind. The paid plan stops. Download the data first.";
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
      showToast("Type the company name to confirm.", "error");
      return;
    }
    if (!confirm("Delete this company and all its data after the 7-day waiting period?")) return;
    try {
      render(await crmApi("/organization", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmName }) }));
      showToast("The company will be deleted after the waiting period.", "success");
      crmPlan.forget();
      crmPlan.mountBanner();
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not ask for the deletion."), "error");
    }
  });

  $("orgKeepBtn").addEventListener("click", async () => {
    try {
      await crmApi("/organization/deletion/cancel", { method: "POST" });
      render(null);
      $("orgDeleteName").value = "";
      showToast("The company will not be deleted.", "success");
      crmPlan.forget();
      crmPlan.mountBanner();
    } catch (error) {
      showToast(apiErrorMessage(error, "Could not cancel the deletion."), "error");
    }
  });

  load();
})();
