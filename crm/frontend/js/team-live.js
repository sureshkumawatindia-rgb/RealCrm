/**
 * team-live.js — Team live (D61), owners and admins: who in the team is online, each member's
 * open chats and the ones waiting for an answer (the customer wrote last, and since when), today's
 * replies, resolved chats and first-reply time, and the chats nobody has taken yet
 * (GET /reports/team-live). Refreshes every 15 seconds, and at once when a chat changes
 * (Socket.IO message:new / conversation:updated).
 */
(function teamLive() {
  if (!isOrgManager()) {
    window.location.replace("my-performance.html"); // agents see their own work
    return;
  }
  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 15000;
  const WAITING_LONG_MS = 30 * 60 * 1000;
  let timer = null;
  let soon = null;

  const initials = (name) => String(name || "?").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
  const duration = (seconds) => crmDuration(seconds);
  const since = (iso) => (iso ? duration((Date.now() - new Date(iso).getTime()) / 1000) : "");
  const kpi = (label, value, sub, cls = "") => `<div class="stat-card ${cls}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="report-note">${escapeHtml(sub)}</div></div>`;
  const cell = (value, sub = "", cls = "") => `<td class="num ${cls}">${escapeHtml(String(value))}${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ""}</td>`;

  function waitingCell(count, oldest) {
    if (!count) return cell(0);
    const long = oldest && Date.now() - new Date(oldest).getTime() > WAITING_LONG_MS;
    return cell(count, crmI18n.t("teamlive.oldest", { v: since(oldest) }), long ? "waiting-long" : "");
  }

  function render(data) {
    const t = data.today;
    $("teamKpis").innerHTML = [
      kpi(crmI18n.t("teamlive.online-now"), `${t.online} / ${data.items.length}`, crmI18n.t("teamlive.team-members")),
      kpi(crmI18n.t("teamlive.waiting-for-a-reply"), t.waiting, data.queue.waitingChats ? crmI18n.t("teamlive.not-taken-by-anyone", { waitingChats: data.queue.waitingChats }) : crmI18n.t("teamlive.customers-who-wrote-last"), t.waiting ? "warning" : ""),
      kpi(crmI18n.t("teamlive.replies-today"), t.replies, crmI18n.t("teamlive.first-reply-median", { v: duration(t.firstResponseMedianSeconds) })),
      kpi(crmI18n.t("teamlive.resolved-today"), t.resolved, crmI18n.t("teamlive.chats-closed"), "success"),
      kpi(crmI18n.t("teamlive.feedback-today"), t.csat?.answers ? crmI18n.t("teamlive.good", { v: Number(t.csat.scorePct).toLocaleString("en-IN", { maximumFractionDigits: 1 }) }) : "—", t.csat?.answers ? crmI18n.t(t.csat.answers === 1 ? "teamlive.answer-bad-one" : "teamlive.answer-bad-many", { n: t.csat.answers, bad: t.csat.bad }) : crmI18n.t("teamlive.no-answers-yet")),
    ].join("");
    const queueRow = `<tr class="queue-row">
      <td><div class="leaderboard-agent"><span class="avatar"><i class="fa-solid fa-inbox"></i></span><div>${escapeHtml(crmI18n.t("teamlive.not-taken-yet"))}<span class="sub">${escapeHtml(crmI18n.t("teamlive.the-inbox-queue"))}</span></div></div></td>
      <td></td>${cell(data.queue.openChats)}${waitingCell(data.queue.waitingChats, data.queue.oldestWaitingSince)}<td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>
    </tr>`;
    const rows = data.items.map((m) => `<tr>
      <td><div class="leaderboard-agent"><span class="avatar">${escapeHtml(initials(m.name))}</span><div>${escapeHtml(m.name)}<span class="sub">${escapeHtml(crmLabel("role", String(m.role || "").replace(/^./, (c) => c.toUpperCase())))}</span></div></div></td>
      <td><span class="presence ${m.online ? "on" : ""}"><span class="dot"></span>${m.online ? crmI18n.t("teamlive.online") : m.lastSeenAt ? crmI18n.t("teamlive.seen-ago", { v: escapeHtml(since(m.lastSeenAt)) }) : crmI18n.t("teamlive.not-seen-yet")}</span></td>
      ${cell(m.openChats)}${waitingCell(m.waitingChats, m.oldestWaitingSince)}${cell(m.repliesToday)}${cell(m.resolvedToday)}${cell(duration(m.firstResponseMedianSeconds))}${cell(m.csatAnswersToday ? `${Number(m.csatScorePctToday).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%` : "—", m.csatAnswersToday ? crmI18n.t(m.csatAnswersToday === 1 ? "teamlive.answer-one" : "teamlive.answer-many", { n: m.csatAnswersToday }) : "")}
    </tr>`);
    $("teamTable").innerHTML = `<table>
      <thead><tr><th>${escapeHtml(crmI18n.t("teamlive.member"))}</th><th>${escapeHtml(crmI18n.t("board.field.task.status"))}</th><th class="num">${escapeHtml(crmI18n.t("teamlive.open-chats"))}</th><th class="num">${escapeHtml(crmI18n.t("orders.col.waiting"))}</th><th class="num">${escapeHtml(crmI18n.t("teamlive.replies-today"))}</th><th class="num">${escapeHtml(crmI18n.t("teamlive.resolved-today"))}</th><th class="num">${escapeHtml(crmI18n.t("teamlive.first-reply-today"))}</th><th class="num">${escapeHtml(crmI18n.t("teamlive.feedback-today"))}</th></tr></thead>
      <tbody>${queueRow}${rows.join("")}</tbody>
    </table>`;
    $("updatedAt").textContent = crmI18n.t("teamlive.updated", { v: new Date(data.at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit" }) });
  }

  async function load() {
    try {
      render(await crmApi("/reports/team-live"));
      $("livePill").classList.remove("off");
    } catch (error) {
      $("livePill").classList.add("off");
      $("teamTable").innerHTML = `<div class="report-empty"><i class="fa-solid fa-triangle-exclamation"></i>${escapeHtml(apiErrorMessage(error, t("teamlive.couldn-t-load-the-team")))}</div>`;
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
  }

  // A chat changed: refresh within a couple of seconds (several changes → one refresh).
  function soonLoad() {
    if (soon) return;
    soon = setTimeout(() => {
      soon = null;
      load();
    }, 2000);
  }
  function connectLive() {
    const origin = CRM_API_BASE.replace(/\/api\/v1$/, "");
    const start = () => {
      if (!window.io) return;
      const socket = window.io(origin, { auth: (cb) => cb({ token: localStorage.getItem(KEYS.SESSION) || "" }), transports: ["websocket", "polling"] });
      ["message:new", "conversation:updated", "inbox:refresh"].forEach((event) => socket.on(event, soonLoad));
    };
    if (window.io) return start();
    const script = document.createElement("script");
    script.src = `${origin}/socket.io/socket.io.min.js`;
    script.onload = start;
    document.head.appendChild(script);
    return undefined;
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) load();
  });
  load();
  schedule();
  connectLive();
})();
