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
  function duration(seconds) {
    if (seconds == null) return "—";
    if (seconds < 60) return `${Math.round(seconds)} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return hours < 48 ? `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${Math.round(hours / 24)} days`;
  }
  const since = (iso) => (iso ? duration((Date.now() - new Date(iso).getTime()) / 1000) : "");
  const kpi = (label, value, sub, cls = "") => `<div class="stat-card ${cls}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="report-note">${escapeHtml(sub)}</div></div>`;
  const cell = (value, sub = "", cls = "") => `<td class="num ${cls}">${escapeHtml(String(value))}${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ""}</td>`;

  function waitingCell(count, oldest) {
    if (!count) return cell(0);
    const long = oldest && Date.now() - new Date(oldest).getTime() > WAITING_LONG_MS;
    return cell(count, `oldest ${since(oldest)}`, long ? "waiting-long" : "");
  }

  function render(data) {
    const t = data.today;
    $("teamKpis").innerHTML = [
      kpi("Online now", `${t.online} / ${data.items.length}`, "team members"),
      kpi("Waiting for a reply", t.waiting, data.queue.waitingChats ? `${data.queue.waitingChats} not taken by anyone` : "customers who wrote last", t.waiting ? "warning" : ""),
      kpi("Replies today", t.replies, `first reply ${duration(t.firstResponseMedianSeconds)} (median)`),
      kpi("Resolved today", t.resolved, "chats closed", "success"),
    ].join("");
    const queueRow = `<tr class="queue-row">
      <td><div class="leaderboard-agent"><span class="avatar"><i class="fa-solid fa-inbox"></i></span><div>Not taken yet<span class="sub">the Inbox queue</span></div></div></td>
      <td></td>${cell(data.queue.openChats)}${waitingCell(data.queue.waitingChats, data.queue.oldestWaitingSince)}<td class="num">—</td><td class="num">—</td><td class="num">—</td>
    </tr>`;
    const rows = data.items.map((m) => `<tr>
      <td><div class="leaderboard-agent"><span class="avatar">${escapeHtml(initials(m.name))}</span><div>${escapeHtml(m.name)}<span class="sub">${escapeHtml(m.role)}</span></div></div></td>
      <td><span class="presence ${m.online ? "on" : ""}"><span class="dot"></span>${m.online ? "Online" : m.lastSeenAt ? `Seen ${escapeHtml(since(m.lastSeenAt))} ago` : "Not seen yet"}</span></td>
      ${cell(m.openChats)}${waitingCell(m.waitingChats, m.oldestWaitingSince)}${cell(m.repliesToday)}${cell(m.resolvedToday)}${cell(duration(m.firstResponseMedianSeconds))}
    </tr>`);
    $("teamTable").innerHTML = `<table>
      <thead><tr><th>Member</th><th>Status</th><th class="num">Open chats</th><th class="num">Waiting</th><th class="num">Replies today</th><th class="num">Resolved today</th><th class="num">First reply today</th></tr></thead>
      <tbody>${queueRow}${rows.join("")}</tbody>
    </table>`;
    $("updatedAt").textContent = `Updated ${new Date(data.at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
  }

  async function load() {
    try {
      render(await crmApi("/reports/team-live"));
      $("livePill").classList.remove("off");
    } catch (error) {
      $("livePill").classList.add("off");
      $("teamTable").innerHTML = `<div class="report-empty"><i class="fa-solid fa-triangle-exclamation"></i>${escapeHtml(apiErrorMessage(error, "Couldn't load the team."))}</div>`;
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
