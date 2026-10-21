/**
 * settings-approvals.js — Settings → Approvals (D77, owners and admins)
 * Limits on quotations: "discount more than 10%", "total more than ₹5,00,000". A salesperson's
 * draft over one needs an owner's or admin's approval before it reaches the customer (the
 * Quotations page asks and decides). Rules are added, edited, archived and restored, up to 10.
 * Runs after settings.js; everything stays inside this function so no names clash.
 */
(function settingsApprovals() {
  if (!isOrgManager()) return leaveManagerTab("approvals");
  document.getElementById("approvalsTab").style.display = "";

  const $ = (id) => document.getElementById(id);
  const MAX_RULES = 10; // backend/src/constants/approvals.js MAX_APPROVAL_RULES
  let rules = []; // active and archived
  let editing = null;
  let loaded = false;
  let busy = false;

  const active = () => rules.filter((rule) => rule.status === "active");
  const archived = () => rules.filter((rule) => rule.status === "archived");
  const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  // "1,25,000", "₹ 2,500", "12.5" → a number; NaN when it is not one; null when empty.
  function readNumber(text) {
    const clean = String(text || "").trim().replace(/^(₹|rs\.?|inr)\s*/i, "").replace(/[,\s%]/g, "");
    if (!clean) return null;
    return /^\d+(\.\d+)?$/.test(clean) ? Number(clean) : NaN;
  }
  const errorText = (error) =>
    ["RULE_LIMIT", "VERSION_CONFLICT"].includes(error?.code)
      ? t(`ap.err.${error.code}`)
      : error?.errors?.[0]?.code === "NO_CONDITION"
        ? t("ap.err.noCondition")
        : apiErrorMessage(error, t("ap.err.save"));

  // "Discount above 10% · Total above ₹5,00,000 · Agents and admins"
  function summary(rule) {
    return [
      rule.discountPercentAbove != null && t("ap.sum.discount", { n: rule.discountPercentAbove }),
      rule.grandTotalAbovePaise != null && t("ap.sum.total", { amount: rupees(rule.grandTotalAbovePaise) }),
      t(rule.appliesTo.includes("admin") ? "ap.sum.agentsAdmins" : "ap.sum.agents"),
    ].filter(Boolean).join(" · ");
  }

  function rowHtml(rule, actions) {
    return `<div class="cf-row" data-id="${escapeHtml(rule.id)}">
      <div class="co-row-icon"><i class="fa-solid fa-circle-check" aria-hidden="true"></i></div>
      <div class="cf-row-main">
        <div class="cf-row-name">${escapeHtml(rule.name)}</div>
        <div class="cf-help">${escapeHtml(summary(rule))}</div>
      </div>
      <div class="cf-row-actions">${actions}</div>
    </div>`;
  }

  function render() {
    const list = active();
    $("apCount").textContent = t("ap.count", { used: list.length, max: MAX_RULES });
    $("apAdd").disabled = list.length >= MAX_RULES;
    const button = (act, key) => `<button type="button" class="btn btn-outline" data-act="${act}">${escapeHtml(t(key))}</button>`;
    $("apList").innerHTML = list.length
      ? list.map((rule) => rowHtml(rule, button("edit", "cf.edit") + button("archive", "cf.archive"))).join("")
      : `<p class="settings-hint">${escapeHtml(t("ap.empty"))}</p>`;
    const old = archived();
    $("apArchivedBox").hidden = !old.length;
    $("apArchivedTitle").textContent = t("ap.archivedTitle", { count: old.length });
    $("apArchived").innerHTML = old.map((rule) => rowHtml(rule, button("restore", "cf.restore"))).join("");
  }

  async function load() {
    try {
      rules = await crmApi("/approval-rules?status=all");
      render();
    } catch (error) {
      $("apList").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("cf.err.load")))}</p>`;
    }
  }

  function openForm(rule = null) {
    editing = rule;
    $("apFormTitle").textContent = t(rule ? "ap.editTitle" : "ap.addTitle");
    $("apName").value = rule?.name || "";
    $("apDiscount").value = rule?.discountPercentAbove ?? "";
    $("apTotal").value = rule?.grandTotalAbovePaise != null ? (rule.grandTotalAbovePaise / 100).toLocaleString("en-IN") : "";
    $("apAdmins").checked = Boolean(rule?.appliesTo.includes("admin"));
    $("apForm").hidden = false;
    $("apAdd").hidden = true;
    $("apName").focus();
  }

  function closeForm() {
    $("apForm").reset();
    $("apForm").hidden = true;
    $("apAdd").hidden = false;
    editing = null;
  }

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    const name = $("apName").value.trim();
    const discount = readNumber($("apDiscount").value);
    const total = readNumber($("apTotal").value);
    if (!name) {
      showToast(t("ap.err.name"), "error");
      $("apName").focus();
      return;
    }
    if (Number.isNaN(discount) || (discount != null && discount > 100)) {
      showToast(t("ap.err.discount"), "error");
      $("apDiscount").focus();
      return;
    }
    if (Number.isNaN(total)) {
      showToast(t("ap.err.total"), "error");
      $("apTotal").focus();
      return;
    }
    if (discount == null && total == null) {
      showToast(t("ap.err.noCondition"), "error");
      $("apDiscount").focus();
      return;
    }
    const body = {
      name,
      discountPercentAbove: discount == null ? null : Math.round(discount * 100) / 100,
      grandTotalAbovePaise: total == null ? null : Math.round(total * 100),
      appliesTo: $("apAdmins").checked ? ["agent", "admin"] : ["agent"],
    };
    busy = true;
    $("apSave").disabled = true;
    try {
      if (editing) await crmApi(`/approval-rules/${editing.id}`, jsonRequest("PATCH", { ...body, version: editing.version }));
      else await crmApi("/approval-rules", jsonRequest("POST", body));
      showToast(t(editing ? "ap.saved" : "ap.added"), "success");
      closeForm();
      await load();
    } catch (error) {
      showToast(errorText(error), "error");
      if (error.code === "VERSION_CONFLICT") {
        closeForm();
        await load();
      }
    } finally {
      busy = false;
      $("apSave").disabled = false;
    }
  }

  async function act(path, successKey) {
    if (busy) return;
    busy = true;
    try {
      await crmApi(path, { method: "POST" });
      showToast(t(successKey), "success");
      await load();
    } catch (error) {
      showToast(errorText(error), "error");
    } finally {
      busy = false;
    }
  }

  $("apList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    const id = button?.closest(".cf-row")?.dataset.id;
    if (!id) return;
    if (button.dataset.act === "edit") openForm(rules.find((rule) => rule.id === id));
    if (button.dataset.act === "archive") {
      if (editing?.id === id) closeForm();
      act(`/approval-rules/${id}/archive`, "ap.archived");
    }
  });
  $("apArchived").addEventListener("click", (event) => {
    const id = event.target.closest('button[data-act="restore"]')?.closest(".cf-row")?.dataset.id;
    if (id) act(`/approval-rules/${id}/restore`, "ap.restored");
  });
  $("apAdd").addEventListener("click", () => openForm());
  $("apCancel").addEventListener("click", closeForm);
  $("apForm").addEventListener("submit", save);

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    load();
  }
  document.querySelector('.settings-tab[data-panel="approvals"]').addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="approvals"]').classList.contains("active")) loadOnce();
})();
