/**
 * settings-forms.js — Settings → WhatsApp → Forms in WhatsApp (G6, D110, owners and admins)
 * Enquiry and order forms that open inside WhatsApp (Meta's Flows, /whatsapp-forms): make one with
 * your own questions, publish it (a Flow on each WhatsApp Business Account of the company), see how
 * many were sent and answered, publish again after a change, delete. Teammates send them from a
 * chat in the Inbox; the answers fill the lead or make an order. One IIFE: no globals.
 */
(function settingsForms() {
  const box = document.getElementById("waForms");
  if (!box || !isOrgManager()) return;
  let data = null; // { items, fields, defaults, limits }
  let products = null; // the company's products, for an order form
  let editing = null; // the form in the window
  let modal = null;

  function statusOf(form) {
    if (form.status === "error" && !form.sendable) return ["badge-danger", "wf.status.error"];
    if (form.dirty) return ["badge-warning", "wf.status.dirty"];
    if (form.sendable) return ["badge-success", "wf.status.published"];
    return ["badge-neutral", "wf.status.draft"];
  }

  function cardHtml(form) {
    const [cls, key] = statusOf(form);
    const publishKey = form.sendable && !form.dirty ? "" : form.version ? "wf.publishAgain" : "wf.publish";
    return `<div class="wf-card" data-id="${escapeHtml(form.id)}">
      <div class="wf-main">
        <div class="wf-name"><strong>${escapeHtml(form.name)}</strong><span class="badge badge-neutral">${escapeHtml(t(`wf.kind.${form.kind}`))}</span><span class="badge ${cls}">${escapeHtml(t(key))}</span></div>
        <p class="settings-hint">${escapeHtml(t("wf.counts", { sent: form.sentCount, answered: form.answerCount }))}</p>
        ${form.error ? `<p class="wf-error"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(form.error)}</p>` : ""}
      </div>
      <div class="wf-actions">
        <button class="btn btn-outline" type="button" data-wf="edit">${escapeHtml(t("wf.edit"))}</button>
        ${publishKey ? `<button class="btn btn-primary" type="button" data-wf="publish"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> ${escapeHtml(t(publishKey))}</button>` : ""}
        <button class="btn btn-danger-outline" type="button" data-wf="delete">${escapeHtml(t("wf.delete"))}</button>
      </div>
    </div>`;
  }

  function render() {
    box.innerHTML = `
      <p class="settings-hint">${escapeHtml(t("wf.hint"))}</p>
      <div class="wf-list">${data.items.length ? data.items.map(cardHtml).join("") : `<p class="settings-hint">${escapeHtml(t("wf.none"))}</p>`}</div>
      <div class="wf-new">
        <button class="btn btn-outline" type="button" data-wf-new="enquiry"><i class="fa-solid fa-clipboard-question" aria-hidden="true"></i> ${escapeHtml(t("wf.newEnquiry"))}</button>
        <button class="btn btn-outline" type="button" data-wf-new="order"><i class="fa-solid fa-cart-plus" aria-hidden="true"></i> ${escapeHtml(t("wf.newOrder"))}</button>
      </div>`;
  }

  async function load() {
    try {
      data = await crmApi("/whatsapp-forms");
      render();
    } catch (error) {
      box.innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("wf.err.load")))}</p>`;
    }
  }

  // --- the window to make or change a form -------------------------------------------------------
  function ensureModal() {
    if (modal) return;
    modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.id = "wfModal";
    modal.innerHTML = `<div class="modal modal--wide" role="dialog" aria-modal="true" aria-labelledby="wfTitle">
      <div class="modal-head"><h3 id="wfTitle"></h3><button class="icon-btn" type="button" data-wf-close aria-label="${escapeHtml(t("common.close"))}"><i class="fa-solid fa-xmark"></i></button></div>
      <form class="modal-body" id="wfForm" autocomplete="off" novalidate></form>
      <div class="modal-foot"><button class="btn btn-outline" type="button" data-wf-close>${escapeHtml(t("common.cancel"))}</button><button class="btn btn-primary" type="submit" form="wfForm">${escapeHtml(t("wf.save"))}</button></div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.closest("[data-wf-close]")) modal.classList.remove("open");
    });
    modal.querySelector("#wfForm").addEventListener("submit", save);
  }

  function editorHtml(form) {
    const limits = data.limits;
    const questions = data.fields[form.kind].map((definition) => {
      const saved = form.fields.find((f) => f.key === definition.key) || definition;
      const max = definition.type === "date" ? limits.dateLabel : limits.label;
      const name = t(`wf.field.${definition.key}`);
      return `<div class="wf-field">
        <label class="wf-check wf-field-name"><input type="checkbox" data-on="${definition.key}" ${saved.on ? "checked" : ""} ${definition.fixed ? "disabled" : ""} /> ${escapeHtml(name)}</label>
        <input type="text" data-label="${definition.key}" maxlength="${max}" value="${escapeHtml(saved.label)}" aria-label="${escapeHtml(t("wf.labelFor", { field: name }))}" />
        <label class="wf-check"><input type="checkbox" data-required="${definition.key}" ${saved.required ? "checked" : ""} ${definition.fixed ? "disabled" : ""} /> ${escapeHtml(t("wf.required"))}</label>
      </div>`;
    }).join("");
    const productList = form.kind !== "order" ? "" : `<div class="wf-block">
      <div class="wf-block-label">${escapeHtml(t("wf.products"))}</div>
      <div class="wf-products">${(products || []).length
        ? products.map((p) => `<label class="wf-check"><input type="checkbox" data-product="${escapeHtml(p.id)}" ${form.productIds.map(String).includes(String(p.id)) ? "checked" : ""} /> ${escapeHtml(p.name)}</label>`).join("")
        : `<p class="settings-hint">${escapeHtml(t("wf.noProducts"))}</p>`}</div>
    </div>`;
    return `
      <div class="field"><label for="wfName">${escapeHtml(t("wf.name"))}</label><input type="text" id="wfName" maxlength="${limits.name}" value="${escapeHtml(form.name)}" /></div>
      <div class="field"><label for="wfIntro">${escapeHtml(t("wf.intro"))}</label><textarea id="wfIntro" rows="2" maxlength="${limits.intro}">${escapeHtml(form.intro)}</textarea></div>
      <div class="field-row">
        <div class="field"><label for="wfCta">${escapeHtml(t("wf.cta"))}</label><input type="text" id="wfCta" maxlength="${limits.cta}" value="${escapeHtml(form.cta)}" /></div>
        <div class="field"><label for="wfSubmit">${escapeHtml(t("wf.submit"))}</label><input type="text" id="wfSubmit" maxlength="${limits.submitLabel}" value="${escapeHtml(form.submitLabel)}" /></div>
      </div>
      <div class="field"><label for="wfHeading">${escapeHtml(t("wf.heading"))}</label><input type="text" id="wfHeading" maxlength="${limits.heading}" value="${escapeHtml(form.heading)}" /></div>
      <div class="wf-block">
        <div class="wf-block-label">${escapeHtml(t("wf.fields"))}</div>
        <p class="settings-hint">${escapeHtml(t("wf.fieldsHint"))}</p>
        ${questions}
      </div>
      ${productList}
      <div class="field"><label for="wfThanks">${escapeHtml(t("wf.thanks"))}</label><textarea id="wfThanks" rows="2" maxlength="${limits.thanks}" placeholder="${escapeHtml(t("wf.thanksPh"))}">${escapeHtml(form.thanks)}</textarea></div>`;
  }

  async function openEditor(form) {
    ensureModal();
    if (form.kind === "order" && !products) {
      try {
        products = (await crmFetchAll("/products")).filter((p) => p.active !== false);
      } catch {
        products = [];
      }
    }
    editing = form;
    modal.querySelector("#wfTitle").textContent = form.id ? t("wf.titleEdit") : t("wf.titleNew", { kind: t(`wf.kind.${form.kind}`) });
    modal.querySelector("#wfForm").innerHTML = editorHtml(form);
    modal.classList.add("open");
    modal.querySelector("#wfName").focus();
  }

  function newForm(kind) {
    const defaults = data.defaults[kind];
    return { kind, name: "", intro: defaults.intro, cta: defaults.cta, heading: defaults.heading, submitLabel: defaults.submitLabel, thanks: "", fields: data.fields[kind], productIds: [] };
  }

  async function save(event) {
    event.preventDefault();
    const form = modal.querySelector("#wfForm");
    const value = (id) => form.querySelector(`#${id}`).value.trim();
    const body = {
      name: value("wfName"), intro: value("wfIntro"), cta: value("wfCta"), heading: value("wfHeading"), submitLabel: value("wfSubmit"), thanks: value("wfThanks"),
      fields: data.fields[editing.kind].map((definition) => ({
        key: definition.key,
        label: form.querySelector(`[data-label="${definition.key}"]`).value.trim() || definition.label,
        on: form.querySelector(`[data-on="${definition.key}"]`).checked,
        required: form.querySelector(`[data-required="${definition.key}"]`).checked,
      })),
      ...(editing.kind === "order" && { productIds: [...form.querySelectorAll("[data-product]:checked")].map((input) => input.dataset.product) }),
    };
    if (!body.name || !body.cta || !body.heading || !body.submitLabel) {
      showToast(t("deals.required"), "error");
      return;
    }
    if (editing.kind === "order" && !body.productIds.length) {
      showToast(t("wf.err.products"), "error");
      return;
    }
    const button = modal.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const saved = editing.id
        ? await crmApi(`/whatsapp-forms/${editing.id}`, jsonRequest("PATCH", body))
        : await crmApi("/whatsapp-forms", jsonRequest("POST", { kind: editing.kind, ...body }));
      modal.classList.remove("open");
      showToast(t(saved.dirty ? "wf.savedLive" : "wf.saved"), "success");
      await load();
    } catch (error) {
      showToast(apiErrorMessage(error, t("wf.err.save")), "error");
    } finally {
      button.disabled = false;
    }
  }

  box.addEventListener("click", async (event) => {
    const fresh = event.target.closest("[data-wf-new]");
    if (fresh) {
      openEditor(newForm(fresh.dataset.wfNew));
      return;
    }
    const button = event.target.closest("[data-wf]");
    if (!button) return;
    const form = data.items.find((f) => String(f.id) === button.closest("[data-id]").dataset.id);
    if (!form) return;
    const action = button.dataset.wf;
    if (action === "edit") {
      openEditor(form);
      return;
    }
    if (action === "delete" && !confirm(t("wf.deleteConfirm"))) return;
    button.disabled = true;
    try {
      if (action === "publish") {
        const result = await crmApi(`/whatsapp-forms/${form.id}/publish`, { method: "POST" });
        if (result.sendable && !result.dirty && (!result.error || result.status === "published")) showToast(t("wf.published"), "success");
        else showToast(t("wf.notPublished", { reason: result.error || "" }), "error");
      } else if (action === "delete") {
        await crmApi(`/whatsapp-forms/${form.id}`, { method: "DELETE" });
        showToast(t("wf.deleted"), "success");
      }
    } catch (error) {
      showToast(apiErrorMessage(error, t("wf.failed")), "error");
    }
    await load();
  });

  // Loaded the first time the tab opens (or now, when the page opens on it).
  let loaded = false;
  const loadOnce = () => {
    if (loaded) return;
    loaded = true;
    load();
  };
  document.querySelector('.settings-tab[data-panel="whatsapp"]')?.addEventListener("click", loadOnce);
  if (document.querySelector('[data-settings-panel="whatsapp"]')?.classList.contains("active")) crmI18n.ready.then(loadOnce);
})();
