/**
 * projects.js — Projects after the sale (Phase 10, D92)
 * The list (status, progress, due date, customer, manager) with filters; a project's page:
 * status, dates, team, milestones as a checklist with their tasks (tick, add), links to the deal
 * and the customer. Owners and admins also manage templates and the "start a project when a deal
 * is won" switch. Projects started from a deal come from the deal box ("Start the project").
 */
(function projectsPage() {
  const STATUSES = ["not_started", "in_progress", "on_hold", "completed", "cancelled"];
  const $ = (id) => document.getElementById(id);
  const state = { items: [], current: null, tasks: [], templates: [], members: [], filters: { q: "", status: "", mine: false }, timer: null };

  const memberName = (id) => state.members.find((m) => String(m.id) === String(id))?.name || "";
  const day = (value) => (value ? new Date(`${value}T00:00:00`).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short", year: "numeric" }) : "");
  const statusBadge = (s) => `<span class="badge pj-status pj-${s}">${escapeHtml(t(`proj.status.${s}`))}</span>`;
  const bar = (n) => `<span class="pj-meter" role="progressbar" aria-valuenow="${n}" aria-valuemin="0" aria-valuemax="100"><span style="width:${n}%"></span></span>`;

  // ---------------------------------------------------------------- the list
  async function loadList() {
    const f = state.filters;
    const params = new URLSearchParams({ limit: "100", ...(f.q && { q: f.q }), ...(f.status && { status: f.status }), ...(f.mine && { mine: "true" }) });
    try {
      state.items = await crmApi(`/projects?${params}`);
      renderList();
    } catch (error) {
      $("pjList").innerHTML = `<p class="settings-hint">${escapeHtml(apiErrorMessage(error, t("proj.loadFailed")))}</p>`;
    }
  }

  function renderList() {
    $("pjList").innerHTML = state.items.length
      ? state.items.map((p) => `<button type="button" class="pj-card${state.current && String(state.current.id) === String(p.id) ? " active" : ""}" data-project="${escapeHtml(p.id)}">
          <span class="pj-card-top"><strong>${escapeHtml(p.name)}</strong>${statusBadge(p.status)}</span>
          ${bar(p.progress)}
          <span class="pj-card-meta">${escapeHtml([p.number, `${p.progress}%`, p.dueDate ? t(p.overdue ? "proj.overdue" : "proj.due", { date: day(p.dueDate) }) : "", memberName(p.managerId)].filter(Boolean).join(" · "))}</span>
        </button>`).join("")
      : `<p class="settings-hint">${escapeHtml(t("proj.empty"))}</p>`;
  }

  // ---------------------------------------------------------------- one project
  async function openProject(id) {
    try {
      const [project, tasks] = await Promise.all([crmApi(`/projects/${encodeURIComponent(id)}`), crmApi(`/projects/${encodeURIComponent(id)}/tasks`)]);
      state.current = project;
      state.tasks = tasks;
      history.replaceState(null, "", `?id=${encodeURIComponent(id)}`);
      renderList();
      renderProject();
      $("pjDetail").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      showToast(apiErrorMessage(error, t("proj.loadFailed")), "error");
    }
  }

  function taskRow(task) {
    const done = task.status === "Done";
    return `<label class="pj-task${done ? " done" : ""}"><input type="checkbox" data-task="${escapeHtml(task.id)}" ${done ? "checked" : ""} />
      <span>${escapeHtml(task.title)}<small>${escapeHtml([task.dueDate ? day(task.dueDate) : "", memberName(task.assigneeId)].filter(Boolean).join(" · "))}</small></span></label>`;
  }

  function renderProject() {
    const p = state.current;
    if (!p) {
      $("pjDetail").innerHTML = `<p class="settings-hint">${escapeHtml(t("proj.pick"))}</p>`;
      return;
    }
    const byMilestone = (id) => state.tasks.filter((x) => String(x.milestoneId || "") === String(id || ""));
    const loose = byMilestone(null);
    $("pjDetail").innerHTML = `
      <div class="pj-head">
        <div><span class="pj-number">${escapeHtml(p.number)}</span><h3>${escapeHtml(p.name)}</h3></div>
        <select id="pjStatus" aria-label="${escapeHtml(t("proj.statusLabel"))}">${STATUSES.map((s) => `<option value="${s}" ${s === p.status ? "selected" : ""}>${escapeHtml(t(`proj.status.${s}`))}</option>`).join("")}</select>
      </div>
      <div class="pj-progress">${bar(p.progress)}<strong>${p.progress}%</strong><span>${escapeHtml(t("proj.tasksDone", { done: p.tasks.done, total: p.tasks.total }))}</span></div>
      <dl class="pj-facts">
        <div><dt>${escapeHtml(t("proj.manager"))}</dt><dd>${escapeHtml(memberName(p.managerId) || "—")}</dd></div>
        <div><dt>${escapeHtml(t("proj.team"))}</dt><dd>${escapeHtml(p.memberIds.map(memberName).filter(Boolean).join(", ") || "—")}</dd></div>
        <div><dt>${escapeHtml(t("proj.dates"))}</dt><dd>${escapeHtml([day(p.startDate), day(p.dueDate)].filter(Boolean).join(" → ") || "—")}${p.overdue ? ` <span class="badge badge-danger">${escapeHtml(t("proj.late"))}</span>` : ""}</dd></div>
        <div><dt>${escapeHtml(t("proj.links"))}</dt><dd>${p.leadId ? `<a href="Deals.html?open=${encodeURIComponent(p.leadId)}">${escapeHtml(t("proj.deal"))}</a>` : ""} ${p.contactId ? `<a href="customer-360.html?id=${encodeURIComponent(p.contactId)}">${escapeHtml(t("proj.customer"))}</a>` : ""}</dd></div>
      </dl>
      <h4>${escapeHtml(t("proj.milestones"))}</h4>
      <div class="pj-milestones">
        ${p.milestones.map((m) => `<div class="pj-milestone${m.done ? " done" : ""}">
            <label class="pj-ms-head"><input type="checkbox" data-milestone="${escapeHtml(m.id)}" ${m.done ? "checked" : ""} /> <strong>${escapeHtml(m.name)}</strong>${m.dueDate ? `<small>${escapeHtml(day(m.dueDate))}</small>` : ""}</label>
            <div class="pj-tasks">${byMilestone(m.id).map(taskRow).join("")}</div>
          </div>`).join("")}
        ${loose.length ? `<div class="pj-milestone"><div class="pj-ms-head"><strong>${escapeHtml(t("proj.otherTasks"))}</strong></div><div class="pj-tasks">${loose.map(taskRow).join("")}</div></div>` : ""}
      </div>
      <form class="pj-add" id="pjAddTask">
        <input type="text" name="title" maxlength="300" required placeholder="${escapeHtml(t("proj.newTask"))}" aria-label="${escapeHtml(t("proj.newTask"))}" />
        <select name="milestoneId" aria-label="${escapeHtml(t("proj.milestone"))}"><option value="">${escapeHtml(t("proj.noMilestone"))}</option>${p.milestones.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join("")}</select>
        <button class="btn btn-outline" type="submit">${escapeHtml(t("proj.addTask"))}</button>
      </form>
      <form class="pj-add" id="pjAddMilestone">
        <input type="text" name="name" maxlength="120" required placeholder="${escapeHtml(t("proj.newMilestone"))}" aria-label="${escapeHtml(t("proj.newMilestone"))}" />
        <input type="date" name="dueDate" aria-label="${escapeHtml(t("proj.dueLabel"))}" />
        <button class="btn btn-outline" type="submit">${escapeHtml(t("proj.addMilestone"))}</button>
      </form>`;
  }

  async function refreshCurrent() {
    if (!state.current) return;
    const id = state.current.id;
    const [project, tasks] = await Promise.all([crmApi(`/projects/${encodeURIComponent(id)}`), crmApi(`/projects/${encodeURIComponent(id)}/tasks`)]);
    state.current = project;
    state.tasks = tasks;
    const index = state.items.findIndex((x) => String(x.id) === String(id));
    if (index >= 0) state.items[index] = project;
    renderList();
    renderProject();
  }

  async function act(fn, failKey = "proj.saveFailed") {
    try {
      await fn();
      await refreshCurrent();
    } catch (error) {
      showToast(apiErrorMessage(error, t(failKey)), "error");
      await refreshCurrent().catch(() => {});
    }
  }

  function onDetailChange(event) {
    const p = state.current;
    const task = event.target.closest("[data-task]");
    if (task) return act(() => crmApi(`/projects/${encodeURIComponent(p.id)}/tasks/${encodeURIComponent(task.dataset.task)}`, jsonRequest("PATCH", { status: task.checked ? "Done" : "To Do" })));
    const milestone = event.target.closest("[data-milestone]");
    if (milestone) return act(() => crmApi(`/projects/${encodeURIComponent(p.id)}/milestones/${encodeURIComponent(milestone.dataset.milestone)}`, jsonRequest("PATCH", { done: milestone.checked })));
    if (event.target.id === "pjStatus") return act(() => crmApi(`/projects/${encodeURIComponent(p.id)}`, jsonRequest("PATCH", { status: event.target.value })));
    return undefined;
  }

  function onDetailSubmit(event) {
    event.preventDefault();
    const p = state.current;
    const data = Object.fromEntries(new FormData(event.target));
    if (event.target.id === "pjAddTask") {
      act(() => crmApi(`/projects/${encodeURIComponent(p.id)}/tasks`, jsonRequest("POST", { title: data.title.trim(), ...(data.milestoneId && { milestoneId: data.milestoneId }) })));
    } else if (event.target.id === "pjAddMilestone") {
      act(() => crmApi(`/projects/${encodeURIComponent(p.id)}/milestones`, jsonRequest("POST", { name: data.name.trim(), dueDate: data.dueDate || "" })));
    }
  }

  // ---------------------------------------------------------------- new project, templates, settings
  async function newProject() {
    const name = prompt(t("proj.newName"));
    if (!name || !name.trim()) return;
    const templateId = state.templates.length ? await crmMoveMenu.open({ title: t("proj.pickTemplate"), current: "", options: [{ value: "none", label: t("proj.noTemplate") }, ...state.templates.map((x) => ({ value: x.id, label: x.name }))] }) : "none";
    if (!templateId) return;
    try {
      const project = await crmApi("/projects", jsonRequest("POST", { name: name.trim(), ...(templateId !== "none" && { templateId }) }));
      showToast(t("proj.created"), "success");
      await loadList();
      await openProject(project.id);
    } catch (error) {
      showToast(apiErrorMessage(error, t("proj.saveFailed")), "error");
    }
  }

  function templateEditor(tpl = { name: "", days: 30, milestones: [{ name: "", dueAfterDays: 7 }], tasks: [] }) {
    const milestoneOptions = (sel) => `<option value="">—</option>${tpl.milestones.map((m, i) => `<option value="${i}" ${sel === i ? "selected" : ""}>${escapeHtml(m.name || `#${i + 1}`)}</option>`).join("")}`;
    return `<form id="pjTplForm" class="pj-tpl" data-id="${escapeHtml(tpl.id || "")}">
      <div class="pj-row"><label>${escapeHtml(t("proj.tplName"))}<input type="text" name="name" maxlength="80" required value="${escapeHtml(tpl.name)}" /></label>
        <label>${escapeHtml(t("proj.tplDays"))}<input type="number" name="days" min="0" max="730" value="${tpl.days || 0}" /></label></div>
      <h4>${escapeHtml(t("proj.milestones"))}</h4>
      ${tpl.milestones.map((m, i) => `<div class="pj-row" data-ms-row="${i}"><input type="text" data-ms-name maxlength="120" value="${escapeHtml(m.name)}" placeholder="${escapeHtml(t("proj.newMilestone"))}" aria-label="${escapeHtml(t("proj.newMilestone"))}" />
        <input type="number" data-ms-days min="0" max="730" value="${m.dueAfterDays || 0}" aria-label="${escapeHtml(t("proj.afterDays"))}" title="${escapeHtml(t("proj.afterDays"))}" /></div>`).join("")}
      <button type="button" class="link-btn" data-tpl="add-ms">+ ${escapeHtml(t("proj.addMilestone"))}</button>
      <h4>${escapeHtml(t("proj.tasks"))}</h4>
      ${tpl.tasks.map((x, i) => `<div class="pj-row" data-task-row="${i}" data-priority="${escapeHtml(x.priority || "Medium")}" data-for-manager="${x.forManager === false ? "false" : "true"}"><input type="text" data-task-title maxlength="300" value="${escapeHtml(x.title)}" placeholder="${escapeHtml(t("proj.newTask"))}" aria-label="${escapeHtml(t("proj.newTask"))}" />
        <select data-task-ms aria-label="${escapeHtml(t("proj.milestone"))}">${milestoneOptions(x.milestone)}</select>
        <input type="number" data-task-days min="0" max="730" value="${x.dueAfterDays || 0}" aria-label="${escapeHtml(t("proj.afterDays"))}" title="${escapeHtml(t("proj.afterDays"))}" /></div>`).join("")}
      <button type="button" class="link-btn" data-tpl="add-task">+ ${escapeHtml(t("proj.addTask"))}</button>
      <div class="pj-buttons"><button class="btn btn-primary" type="submit">${escapeHtml(t("proj.saveTemplate"))}</button>${tpl.id ? `<button class="btn btn-danger-outline" type="button" data-tpl="delete">${escapeHtml(t("common.delete"))}</button>` : ""}</div>
    </form>`;
  }
  function readTemplate() {
    const form = $("pjTplForm");
    const milestones = [...form.querySelectorAll("[data-ms-row]")].map((row) => ({ name: row.querySelector("[data-ms-name]").value.trim(), dueAfterDays: Number(row.querySelector("[data-ms-days]").value) || 0 }));
    const tasks = [...form.querySelectorAll("[data-task-row]")].map((row) => {
      const ms = row.querySelector("[data-task-ms]").value;
      return { title: row.querySelector("[data-task-title]").value.trim(), milestone: ms === "" ? null : Number(ms), dueAfterDays: Number(row.querySelector("[data-task-days]").value) || 0, priority: row.dataset.priority, forManager: row.dataset.forManager !== "false" };
    });
    return { id: form.dataset.id || undefined, name: form.elements.name.value.trim(), days: Number(form.elements.days.value) || 0, milestones, tasks };
  }
  async function openTemplates() {
    state.templates = await crmApi("/project-templates").catch(() => []);
    const settings = await crmApi("/projects/settings").catch(() => ({ onWon: { enabled: false } }));
    $("pjTplBody").innerHTML = `
      <label class="pj-switch"><input type="checkbox" id="pjOnWon" ${settings.onWon.enabled ? "checked" : ""} /> ${escapeHtml(t("proj.onWon"))}</label>
      <select id="pjOnWonTpl" aria-label="${escapeHtml(t("proj.pickTemplate"))}"><option value="">${escapeHtml(t("proj.noTemplate"))}</option>${state.templates.map((x) => `<option value="${escapeHtml(x.id)}" ${String(settings.onWon.templateId) === String(x.id) ? "selected" : ""}>${escapeHtml(x.name)}</option>`).join("")}</select>
      <h4>${escapeHtml(t("proj.templates"))}</h4>
      <div class="pj-tpl-list">${state.templates.map((x) => `<button type="button" class="btn btn-outline" data-tpl-open="${escapeHtml(x.id)}">${escapeHtml(x.name)}</button>`).join("")}<button type="button" class="btn btn-outline" data-tpl-open="">+ ${escapeHtml(t("proj.newTemplate"))}</button></div>
      <div id="pjTplEditor"></div>`;
    $("pjTplDialog").showModal();
  }
  async function saveSettings() {
    try {
      await crmApi("/projects/settings", jsonRequest("PUT", { onWon: { enabled: $("pjOnWon").checked, templateId: $("pjOnWonTpl").value || null } }));
      showToast(t("proj.settingsSaved"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("proj.saveFailed")), "error");
    }
  }
  async function onTemplatesClick(event) {
    const open = event.target.closest("[data-tpl-open]");
    if (open) {
      const tpl = state.templates.find((x) => String(x.id) === open.dataset.tplOpen);
      $("pjTplEditor").innerHTML = templateEditor(tpl ? JSON.parse(JSON.stringify(tpl)) : undefined);
      return;
    }
    const button = event.target.closest("[data-tpl]");
    if (!button) return;
    const tpl = readTemplate();
    if (button.dataset.tpl === "add-ms") tpl.milestones.push({ name: "", dueAfterDays: 0 });
    if (button.dataset.tpl === "add-task") tpl.tasks.push({ title: "", milestone: null, dueAfterDays: 0, priority: "Medium", forManager: true });
    if (button.dataset.tpl === "delete") {
      if (!confirm(t("proj.deleteTemplate"))) return;
      await crmApi(`/project-templates/${encodeURIComponent(tpl.id)}`, { method: "DELETE" }).catch((error) => showToast(apiErrorMessage(error, t("proj.saveFailed")), "error"));
      await openTemplates();
      return;
    }
    $("pjTplEditor").innerHTML = templateEditor(tpl);
  }
  async function onTemplateSubmit(event) {
    if (event.target.id !== "pjTplForm") return;
    event.preventDefault();
    const tpl = readTemplate();
    // Unnamed milestones are left out; the tasks point to the ones kept.
    const kept = tpl.milestones.map((m, i) => (m.name ? i : -1)).filter((i) => i >= 0);
    const body = {
      name: tpl.name,
      days: tpl.days,
      milestones: kept.map((i) => tpl.milestones[i]),
      tasks: tpl.tasks.filter((x) => x.title).map((x) => ({ ...x, milestone: kept.includes(x.milestone) ? kept.indexOf(x.milestone) : null })),
    };
    try {
      await crmApi(tpl.id ? `/project-templates/${encodeURIComponent(tpl.id)}` : "/project-templates", jsonRequest(tpl.id ? "PATCH" : "POST", body));
      showToast(t("proj.templateSaved"), "success");
      await openTemplates();
    } catch (error) {
      showToast(apiErrorMessage(error, t("proj.saveFailed")), "error");
    }
  }

  // ---------------------------------------------------------------- start
  async function start() {
    await crmI18n.ready;
    [state.members, state.templates] = await Promise.all([crmApi("/members?limit=100").catch(() => []), crmApi("/project-templates").catch(() => [])]);
    $("pjManage").hidden = !isOrgManager();
    await loadList();
    const id = new URLSearchParams(location.search).get("id");
    if (id) await openProject(id);
    else renderProject();

    $("pjList").addEventListener("click", (event) => {
      const card = event.target.closest("[data-project]");
      if (card) openProject(card.dataset.project);
    });
    $("pjDetail").addEventListener("change", onDetailChange);
    $("pjDetail").addEventListener("submit", onDetailSubmit);
    $("pjSearch").addEventListener("input", (event) => {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => { state.filters.q = event.target.value.trim(); loadList(); }, 300);
    });
    $("pjStatusFilter").innerHTML = `<option value="">${escapeHtml(t("proj.allStatuses"))}</option>${STATUSES.map((s) => `<option value="${s}">${escapeHtml(t(`proj.status.${s}`))}</option>`).join("")}`;
    $("pjStatusFilter").addEventListener("change", (event) => { state.filters.status = event.target.value; loadList(); });
    $("pjMine").addEventListener("change", (event) => { state.filters.mine = event.target.checked; loadList(); });
    $("pjNew").addEventListener("click", newProject);
    $("pjManage").addEventListener("click", openTemplates);
    $("pjTplBody").addEventListener("click", onTemplatesClick);
    $("pjTplBody").addEventListener("submit", onTemplateSubmit);
    $("pjTplBody").addEventListener("change", (event) => { if (["pjOnWon", "pjOnWonTpl"].includes(event.target.id)) saveSettings(); });
    $("pjTplClose").addEventListener("click", () => { $("pjTplDialog").close(); crmApi("/project-templates").then((x) => { state.templates = x; }).catch(() => {}); });
  }

  start();
})();
