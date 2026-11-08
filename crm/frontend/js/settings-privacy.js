/**
 * settings-privacy.js — Settings → Data & Privacy (Phase 8, D120; India's DPDP Act 2023): the
 * company's privacy settings (who answers customers' questions about their data, the privacy
 * notice, chats kept on team phones, who may give or erase a customer's data), finding the
 * customer a request is about (deleted ones too), and the register of requests answered.
 * Owners and admins. The copy and the erasure are js/customer-privacy.js.
 */
(() => {
  const $s = (id) => document.getElementById(id);
  if (!$s("privacySettingsSection") || !isOrgManager()) return;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short", year: "numeric" }) : "");
  const PAGE = 20;
  let settings = null;
  let page = 1;
  let found = [];

  // --- the settings ------------------------------------------------------------------------------
  function fill(value) {
    settings = value;
    $s("privContactName").value = value.contactName || "";
    $s("privContactEmail").value = value.contactEmail || "";
    $s("privContactPhone").value = value.contactPhone || "";
    // Left empty, customers see the company's own email and phone: shown as the hint inside.
    $s("privContactEmail").placeholder = value.company?.email || "";
    $s("privContactPhone").placeholder = value.company?.phone || "";
    $s("privNoticeUrl").value = value.noticeUrl || "";
    $s("privDeviceCopies").checked = value.deviceCopies !== false;
    $s("privRequestsBy").value = value.requestsBy || "managers";
    $s("privRequestsBy").disabled = !value.canChangeWho;
    $s("privWhoHint").hidden = Boolean(value.canChangeWho);
  }

  async function loadSettings() {
    try {
      fill(await crmApi("/organization/privacy"));
      $s("privacySettingsSection").hidden = false;
    } catch {
      $s("privacySettingsSection").hidden = true;
    }
  }

  function settingsError(message) {
    $s("privSettingsError").textContent = message;
    $s("privSettingsError").hidden = !message;
  }

  $s("privacyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    settingsError("");
    const body = {
      contactName: $s("privContactName").value.trim(),
      contactEmail: $s("privContactEmail").value.trim(),
      contactPhone: $s("privContactPhone").value.trim(),
      noticeUrl: $s("privNoticeUrl").value.trim(),
      deviceCopies: $s("privDeviceCopies").checked,
      ...(settings?.canChangeWho && { requestsBy: $s("privRequestsBy").value }),
    };
    if (body.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.contactEmail)) return settingsError(t("priv.set.badEmail"));
    if (body.contactPhone && !/^[0-9+()\-\s]{6,30}$/.test(body.contactPhone)) return settingsError(t("priv.set.badPhone"));
    if (body.noticeUrl && !/^https?:\/\/\S+\.\S+/.test(body.noticeUrl)) return settingsError(t("priv.set.badUrl"));
    const button = $s("privSave");
    button.disabled = true;
    try {
      fill(await crmApi("/organization/privacy", jsonRequest("PUT", body)));
      // This browser follows the phones switch at once (the others on their next page).
      saveCompanyInfo({ ...(getCompanyInfo() || {}), deviceCopies: settings.deviceCopies });
      if (!settings.deviceCopies) crmDevice.forgetCopies();
      showToast(t("priv.set.saved"), "success");
    } catch (error) {
      settingsError(apiErrorMessage(error, t("priv.set.failed")));
    } finally {
      button.disabled = false;
    }
  });

  // --- finding the customer ------------------------------------------------------------------------
  function drawFound() {
    $s("privResults").innerHTML = found.map((c, index) => `
      <li>
        <div class="priv-who">
          <strong>${escapeHtml(c.name)}${c.deleted ? `<span class="priv-badge">${escapeHtml(t("priv.req.deleted"))}</span>` : ""}</strong>
          <span>${escapeHtml([c.phone, c.email, c.company].filter(Boolean).join(" · ") || "—")}</span>
        </div>
        <div class="priv-actions">
          <button class="btn btn-outline" type="button" data-priv="download" data-index="${index}"><i class="fa-solid fa-file-arrow-down"></i> ${escapeHtml(t("priv.panel.download"))}</button>
          <button class="btn btn-danger-outline" type="button" data-priv="erase" data-index="${index}"><i class="fa-solid fa-user-slash"></i> ${escapeHtml(t("priv.panel.erase"))}</button>
        </div>
      </li>`).join("");
  }

  $s("privFindForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const q = $s("privFindInput").value.trim();
    const note = $s("privFindNote");
    found = [];
    drawFound();
    if (q.length < 2) {
      note.textContent = t("priv.req.tooShort");
      note.hidden = false;
      return;
    }
    note.textContent = t("cf.loading");
    note.hidden = false;
    try {
      found = await crmApi(`/organization/privacy/customers?q=${encodeURIComponent(q)}`);
      note.textContent = found.length ? "" : t("priv.req.none");
      note.hidden = Boolean(found.length);
      drawFound();
    } catch (error) {
      note.textContent = error.status === 403 ? t("priv.err.notAllowed") : apiErrorMessage(error, t("priv.req.findFailed"));
    }
  });

  $s("privResults").addEventListener("click", (event) => {
    const button = event.target.closest("[data-priv]");
    if (!button) return;
    const customer = found[Number(button.dataset.index)];
    if (!customer) return;
    if (button.dataset.priv === "download") crmCustomerPrivacy.download({ id: customer.id, name: customer.name });
    else {
      crmCustomerPrivacy.erase({ id: customer.id, name: customer.name }, {
        onErased: () => {
          found = found.filter((c) => c !== customer);
          drawFound();
        },
      });
    }
  });

  // --- the register --------------------------------------------------------------------------------
  const TYPE = { access: "priv.type.access", erasure: "priv.type.erasure" };
  async function loadRegister(reset = false) {
    if (reset) page = 1;
    const box = $s("privRegister");
    let body;
    try {
      body = await crmRequest(`/organization/privacy/requests?page=${page}&limit=${PAGE}`);
    } catch (error) {
      if (error.status === 403) {
        // The company keeps it to owners: an admin sees why instead of the tools.
        $s("privacyRequestsSection").hidden = false;
        $s("privFindForm").hidden = true;
        box.innerHTML = `<p class="settings-hint">${escapeHtml(t("priv.err.notAllowed"))}</p>`;
        $s("privMore").hidden = true;
        return;
      }
      box.innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("priv.req.loadFailed")))}</p>`;
      return;
    }
    $s("privacyRequestsSection").hidden = false;
    $s("privFindForm").hidden = false;
    const rows = (body.data || []).map((r) => `
      <tr>
        <td data-label="${escapeHtml(t("priv.req.asked"))}">${escapeHtml(day(r.askedAt))}</td>
        <td data-label="${escapeHtml(t("priv.req.done"))}">${escapeHtml(day(r.doneAt))}</td>
        <td data-label="${escapeHtml(t("priv.req.type"))}">${escapeHtml(t(TYPE[r.type] || TYPE.access))}</td>
        <td data-label="${escapeHtml(t("priv.req.customer"))}">${escapeHtml(r.contactName || t("pdata.erasedCustomer"))}</td>
        <td data-label="${escapeHtml(t("priv.req.by"))}">${escapeHtml(r.byName || "—")}</td>
        <td data-label="${escapeHtml(t("priv.req.took"))}">${escapeHtml(t("priv.req.days", { n: r.days }))}</td>
      </tr>`).join("");
    const head = `<thead><tr><th>${escapeHtml(t("priv.req.asked"))}</th><th>${escapeHtml(t("priv.req.done"))}</th><th>${escapeHtml(t("priv.req.type"))}</th><th>${escapeHtml(t("priv.req.customer"))}</th><th>${escapeHtml(t("priv.req.by"))}</th><th>${escapeHtml(t("priv.req.took"))}</th></tr></thead>`;
    if (page === 1) {
      box.innerHTML = rows ? `<table class="priv-register">${head}<tbody>${rows}</tbody></table>` : `<p class="settings-hint">${escapeHtml(t("priv.req.empty"))}</p>`;
    } else {
      box.querySelector("tbody")?.insertAdjacentHTML("beforeend", rows);
    }
    $s("privMore").hidden = !(body.pagination && body.pagination.page < body.pagination.pages);
  }
  $s("privMore").addEventListener("click", () => {
    page += 1;
    loadRegister();
  });
  document.addEventListener("crm:privacy-request", () => loadRegister(true));

  crmI18n.ready.catch(() => {}).then(() => {
    loadSettings();
    loadRegister(true);
  });
})();
