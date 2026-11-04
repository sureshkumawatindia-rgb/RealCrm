/**
 * invite-team.js — "Invite your team" (D64): the step after Connect WhatsApp for a new company.
 * Owners and admins add people (email, role, the pages they may open); each invite is the same
 * POST /invites as Settings → Team & Access (same seat limit). The CRM does not email yet, so
 * the links are shown to send on WhatsApp or copy. "Skip for now" ends the step for good.
 */
(function inviteTeam() {
  const $ = (id) => document.getElementById(id);
  if (!isOrgManager()) {
    window.location.replace("dashboard.html");
    return;
  }

  const PAGES = [
    ["dashboard", "Dashboard"], ["inbox", "Inbox"], ["customers", "Customers"], ["leads", "Leads"], ["deals", "Deals"],
    ["tasks", "Tasks"], ["calendar", "Calendar"], ["support", "Support"], ["documents", "Documents"], ["products", "Products"],
    ["marketing", "Marketing"], ["automation", "Sales Automation"], ["reports", "Reports & Analytics"], ["insights", "AI Insights"],
  ];
  // What a new agent or viewer starts with (the same as the server's defaults).
  const DEFAULT_PAGES = {
    agent: ["dashboard", "inbox", "customers", "leads", "deals", "tasks", "calendar", "support", "documents", "products"],
    viewer: ["dashboard", "customers", "leads", "deals", "reports"],
  };
  const isOwner = getCurrentMember()?.role === "owner";
  let rowCount = 0;
  // The company's name for the WhatsApp message (a new company has no profile saved yet).
  let companyName = getCompanyInfo()?.name || "";
  loadCompanyProfile()
    .then(({ organization }) => {
      companyName = organization?.name || companyName;
    })
    .catch(() => {});

  function pagesFor(role) {
    return PAGES.map(
      ([key, label]) => `<label><input type="checkbox" value="${key}" ${DEFAULT_PAGES[role]?.includes(key) ? "checked" : ""} /> ${escapeHtml(label)}</label>`,
    ).join("");
  }

  function addRow() {
    rowCount += 1;
    const id = `invite${rowCount}`;
    const row = document.createElement("div");
    row.className = "invite-row";
    row.innerHTML = `
      <div class="invite-row-main">
        <div class="field">
          <label for="${id}Email">${escapeHtml(t("set.their-google-email"))}</label>
          <input type="email" id="${id}Email" class="invite-email" placeholder="name@gmail.com" autocomplete="off" />
        </div>
        <div class="field role-field">
          <label for="${id}Role">${escapeHtml(t("set.role"))}</label>
          <select id="${id}Role" class="invite-role">
            <option value="agent" selected>${escapeHtml(t("role.Agent"))}</option>
            <option value="viewer">${escapeHtml(t("role.Viewer"))}</option>
            ${isOwner ? `<option value="admin">${escapeHtml(t("role.Admin"))}</option>` : ""}
          </select>
        </div>
        <button type="button" class="icon-btn invite-remove" aria-label="${escapeHtml(t("invite.removePerson"))}" title="${escapeHtml(t("invite.removePerson"))}"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <details class="invite-pages">
        <summary>${escapeHtml(t("invite.pages-they-can-open"))}</summary>
        <div class="invite-pages-grid">${pagesFor("agent")}</div>
      </details>
      <p class="invite-admin-note" hidden>${escapeHtml(t("invite.an-admin-can-open-every-page"))}</p>`;
    const role = row.querySelector(".invite-role");
    role.addEventListener("change", () => {
      const admin = role.value === "admin";
      row.querySelector(".invite-pages").hidden = admin;
      row.querySelector(".invite-admin-note").hidden = !admin;
      if (!admin) row.querySelector(".invite-pages-grid").innerHTML = pagesFor(role.value);
    });
    row.querySelector(".invite-remove").addEventListener("click", () => {
      if ($("inviteRows").children.length > 1) row.remove();
      else row.querySelector(".invite-email").value = "";
    });
    $("inviteRows").appendChild(row);
    row.querySelector(".invite-email").focus();
  }

  function showError(message) {
    $("inviteError").textContent = message;
    $("inviteError").hidden = !message;
  }

  async function finishStep(skipped) {
    try {
      await crmApi("/organization/onboarding/team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skipped }) });
    } catch {
      /* the step only decides what comes next */
    }
  }
  async function next() {
    window.location.href = await onboardingNextPage({ after: "team" });
  }

  function showLinks(sent, failure = "") {
    const company = companyName || t("invite.our-company");
    $("inviteLinks").innerHTML = sent
      .map(({ email, role, link, emailed }, index) => {
        const message = t("invite.join-on-yellow-crm", { company, link });
        return `
        <li>
          <span class="who"><strong>${escapeHtml(email)}</strong><span>${escapeHtml(crmLabel("role", role.charAt(0).toUpperCase() + role.slice(1)))}${emailed ? t("invite.invite-emailed") : ""}</span></span>
          <span class="actions">
            <a class="btn btn-outline" href="https://wa.me/?text=${encodeURIComponent(message)}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> ${escapeHtml(t("inv.sendTitle"))}</a>
            <button type="button" class="btn btn-outline" data-copy="${index}"><i class="fa-regular fa-copy"></i> ${escapeHtml(t("cal.teams.copy"))}</button>
          </span>
        </li>`;
      })
      .join("");
    $("inviteLinks").querySelectorAll("[data-copy]").forEach((button) =>
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(sent[Number(button.dataset.copy)].link);
          showToast(t("invite.link-copied"), "success");
        } catch {
          showToast(t("invite.couldn-t-copy-use-send-on"), "error");
        }
      }),
    );
    $("inviteDoneError").textContent = failure;
    $("inviteDoneError").hidden = !failure;
    document.querySelector('[data-view="form"]').hidden = true;
    document.querySelector('[data-view="done"]').hidden = false;
  }

  $("inviteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("");
    const people = [...document.querySelectorAll(".invite-row")]
      .map((row) => ({
        email: row.querySelector(".invite-email").value.trim().toLowerCase(),
        role: row.querySelector(".invite-role").value,
        modules: [...row.querySelectorAll(".invite-pages-grid input:checked")].map((box) => box.value),
      }))
      .filter((person) => person.email);
    if (!people.length) {
      showError(t("invite.type-at-least-one-email-or"));
      return;
    }
    const wrong = people.find((person) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email));
    if (wrong) {
      showError(t("invite.is-not-an-email-address", { email: wrong.email }));
      return;
    }
    const noPages = people.find((person) => person.role !== "admin" && !person.modules.length);
    if (noPages) {
      showError(t("invite.choose-at-least-one-page-for", { email: noPages.email }));
      return;
    }

    $("sendBtn").disabled = true;
    const sent = [];
    let failure = "";
    try {
      for (const person of people) {
        const body = { email: person.email, role: person.role, ...(person.role !== "admin" && { modules: person.modules }) };
        const result = await crmApi("/invites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        sent.push({ email: person.email, role: person.role, link: result.link, emailed: result.emailed });
      }
    } catch (error) {
      const who = people[sent.length]?.email;
      failure = `${who ? `${who}: ` : ""}${apiErrorMessage(error, t("invite.the-invite-could-not-be-sent"))}`;
    } finally {
      $("sendBtn").disabled = false;
    }
    if (!sent.length) {
      showError(failure);
      return;
    }
    await finishStep(false);
    showLinks(sent, failure);
  });

  $("addRowBtn").addEventListener("click", addRow);
  $("skipBtn").addEventListener("click", async () => {
    await finishStep(true);
    next();
  });
  $("continueBtn").addEventListener("click", next);
  crmI18n.ready.then(addRow); // its labels are texts
})();
