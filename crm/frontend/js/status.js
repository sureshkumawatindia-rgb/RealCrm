/**
 * status.js — the public status page (Phase 9, D151; docs/RELIABILITY.md): how the CRM and what it
 * depends on are doing now, the last 30 days of each, the platform's notices and recent problems.
 * No sign-in. When the CRM cannot answer, the page says so plainly.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const EVERY_MS = 60 * 1000;
  const ICONS = { ok: "fa-circle-check", degraded: "fa-triangle-exclamation", down: "fa-circle-xmark", info: "fa-circle-info" };
  let last = null;
  let noAnswer = false;

  const words = (both) => both?.[crmI18n.language()] || both?.en || "";
  const when = (iso) => new Date(iso).toLocaleString(crmI18n.locale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const dayName = (date) => new Date(`${date}T12:00:00+05:30`).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short" });
  const serviceName = (key) => t(`status.svc.${key}`);
  const plural = (n, key) => t(`${key}.${n === 1 ? "one" : "many"}`, { n });
  function howLong(minutes) {
    if (minutes < 60) return plural(minutes, "status.took.minutes");
    if (minutes < 48 * 60) return plural(Math.round(minutes / 60), "status.took.hours");
    return plural(Math.round(minutes / (24 * 60)), "status.took.days");
  }

  function hero(level, title, text) {
    $("statusHero").className = `status-hero ${level}`;
    $("statusHero").innerHTML = `<i class="fa-solid ${ICONS[level]}" aria-hidden="true"></i><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></div>`;
  }

  function serviceHtml(service, days) {
    const trouble = service.days.filter(Boolean).length;
    const summary = trouble ? plural(trouble, "status.days") : t("status.days.none");
    const bars = service.days.map((level, index) => `<span class="status-day level-${level}" title="${escapeHtml(`${dayName(days[index])}: ${t(`status.day.${level}`)}`)}"></span>`).join("");
    return `<li class="status-service">
      <div class="status-service-head">
        <strong>${escapeHtml(serviceName(service.key))}</strong>
        <span class="status-chip ${service.status}">${escapeHtml(t(`status.level.${service.status}`))}</span>
      </div>
      <div class="status-days" role="img" aria-label="${escapeHtml(summary)}">${bars}</div>
      <div class="status-service-foot">
        <span>${escapeHtml(dayName(days[0]))}</span>
        <span>${escapeHtml(t("status.uptime", { n: service.uptime.toLocaleString(crmI18n.locale(), { maximumFractionDigits: 2 }) }))}</span>
        <span>${escapeHtml(t("status.today"))}</span>
      </div>
    </li>`;
  }

  function incidentHtml(incident) {
    const title = words(incident.title) || t(`status.problem.${incident.level}`, { service: serviceName(incident.service === "notice" ? "crm" : incident.service) });
    const span = incident.endedAt ? t("status.fromTo", { from: when(incident.startedAt), took: howLong(incident.minutes) }) : t("status.since", { from: when(incident.startedAt) });
    return `<li class="status-incident">
      <span class="status-chip ${incident.endedAt ? "ended" : incident.level}">${escapeHtml(t(incident.endedAt ? "status.ended" : `status.level.${incident.level}`))}</span>
      <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(span)}</span></div>
    </li>`;
  }

  function render() {
    document.querySelectorAll("[data-status-language]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.statusLanguage === crmI18n.language())));
    if (noAnswer) hero("down", t("status.noAnswer"), t("status.noAnswerText"));
    if (!last) return;
    if (!noAnswer) hero(last.status, t(`status.overall.${last.status}`), t("status.checkedAt", { time: when(last.at) }));
    $("statusNotices").innerHTML = last.notices.map((notice) => `<article class="status-notice ${notice.level}">
      <i class="fa-solid ${ICONS[notice.level]}" aria-hidden="true"></i>
      <div><strong>${escapeHtml(words(notice.title))}</strong>${words(notice.body) ? `<p>${escapeHtml(words(notice.body))}</p>` : ""}<span>${escapeHtml(t("status.since", { from: when(notice.startedAt) }))}</span></div>
    </article>`).join("");
    $("statusServices").innerHTML = last.services.map((service) => serviceHtml(service, last.days)).join("");
    $("statusIncidents").innerHTML = last.incidents.length
      ? `<ul class="status-incidents">${last.incidents.map(incidentHtml).join("")}</ul>`
      : `<p class="status-none">${escapeHtml(t("status.noProblems"))}</p>`;
  }

  async function load() {
    try {
      const response = await fetch(`${CRM_API_BASE}/status`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      last = (await response.json()).data;
      noAnswer = false;
    } catch {
      noAnswer = true;
    }
    await crmI18n.ready;
    render();
  }

  document.querySelector(".status-lang").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-status-language]");
    if (!button) return;
    await crmI18n.setLanguage(button.dataset.statusLanguage);
    render();
  });
  load();
  setInterval(load, EVERY_MS);
})();
