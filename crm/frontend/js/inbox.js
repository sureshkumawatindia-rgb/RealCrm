/**
 * inbox.js — WhatsApp team inbox (Inbox.html)
 * Chats, messages, notes, quick replies and templates come from the CRM backend
 * (/conversations, /quick-replies, /templates); live updates arrive over Socket.IO. Everything
 * customers write is shown as text only (escapeHtml), never as HTML. Files are fetched through
 * the signed-in API and shown from object URLs (photos, audio, video) or downloaded.
 * Which chats appear (decision D24): owners, admins and inbox:view_all see every chat; other
 * members see their own chats and the queue of chats nobody has taken yet.
 * Reuses app.js: crmApi, crmRequest, crmLoad, cached, jsonRequest, newIdempotencyKey,
 * refreshAccessToken, endSession, getCurrentMember, getAgents, escapeHtml, showToast,
 * apiErrorMessage, requireAuth, renderSidebarUser, initSidebarToggle.
 */
// Starts once the page's texts are in (i18n/*.json, CP5).
crmI18n.ready.then(function inbox() {
  requireAuth();
  renderSidebarUser();
  initSidebarToggle();

  const $ = (id) => document.getElementById(id);
  const me = getCurrentMember() || {};
  const seesAll = ["owner", "admin"].includes(me.role) || (me.permissions || []).includes("inbox:view_all");
  const PAGE_SIZE = 30;
  const TICKS = {
    queued: `<i class="fa-regular fa-clock tick" title="${escapeHtml(t("inbox.tick.queued"))}"></i>`,
    sent: `<i class="fa-solid fa-check tick" title="${escapeHtml(t("inbox.tick.sent"))}"></i>`,
    delivered: `<i class="fa-solid fa-check-double tick" title="${escapeHtml(t("inbox.tick.delivered"))}"></i>`,
    read: `<i class="fa-solid fa-check-double tick read" title="${escapeHtml(t("inbox.tick.read"))}"></i>`,
    played: `<i class="fa-solid fa-microphone tick read" title="${escapeHtml(t("inbox.tick.played"))}"></i>`,
    failed: `<i class="fa-solid fa-circle-exclamation tick failed" title="${escapeHtml(t("inbox.tick.failed"))}"></i>`,
  };
  const MEDIA = {
    image: ["fa-image", t("inbox.media.image")],
    video: ["fa-video", t("inbox.media.video")],
    audio: ["fa-microphone", t("inbox.media.audio")],
    document: ["fa-file-lines", t("inbox.media.document")],
    sticker: ["fa-note-sticky", t("inbox.media.sticker")],
  };
  // The emoji picker (CP3; the emojis people in India send most) and the quick reactions.
  const EMOJIS = ["🙏", "👍", "😊", "😀", "😂", "🤣", "😍", "😘", "🤗", "🙂", "😉", "😎", "🤔", "😅", "😇", "😢", "😮", "😡", "👌", "✌️", "🤝", "👏", "🙌", "💪", "👋", "❤️", "💯", "🔥", "🎉", "✅", "❌", "⭐", "📦", "🚚", "🛒", "💰", "📞", "📍", "⏰", "📄", "🪔", "🌸", "🎁", "🍬", "☀️", "🌙"];
  const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
  const REACTION_DAYS = 30; // WhatsApp takes reactions on messages of the last 30 days
  // Files the page shows itself (anything else is only offered as a download).
  const PREVIEW_TYPES = ["image/jpeg", "image/png", "image/webp", "audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "video/mp4", "video/3gpp"];
  const baseMime = (mime) => String(mime || "").split(";")[0].trim().toLowerCase();
  const fileSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

  const state = {
    view: "all",
    status: "",
    q: "",
    page: 1,
    hasMore: false,
    conversations: [],
    current: null,
    messages: [],
    nextBefore: null,
    notes: [],
    quickReplies: [],
    replyTo: null,
    quickIndex: 0,
    unread: 0,
    file: null, // a file waiting to be sent (D103: or a quick reply's file, { quickReplyId, name, size })
    scheduled: [], // D103: this chat's texts waiting to go
    later: null, // D103: the scheduled text being edited
    templates: null, // approved templates (loaded when the picker opens)
    template: null, // the one picked
    botEnabled: false, // the organization's WhatsApp FAQ bot is on (GET /bot/status)
    voice: false, // the file waiting is a recorded voice note (CP3)
    reactingTo: null, // the message whose reaction bar is open
    channel: "", // G8 (D112): one channel's chats (whatsapp, instagram, messenger), or all
    hasSocial: false, // an Instagram or Messenger chat was seen: the channel filter shows
  };
  // G8 (D112): Instagram and Messenger chats (text only from the CRM; 7 days for a person to answer).
  const SOCIAL = {
    instagram: { icon: "fa-brands fa-instagram", name: "Instagram" },
    messenger: { icon: "fa-brands fa-facebook-messenger", name: "Messenger" },
  };
  const isSocial = (c) => Boolean(c && SOCIAL[c.channel]);

  // --- small helpers -------------------------------------------------------
  const initialsOf = (name) =>
    String(name || "?")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join("") || "?";
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  function shortTime(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    const now = new Date();
    if (sameDay(date, now)) return date.toLocaleTimeString(crmI18n.locale(), { hour: "numeric", minute: "2-digit" });
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, yesterday)) return t("inbox.yesterday");
    return date.toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short" });
  }
  function dayLabel(date) {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, now)) return t("inbox.today");
    if (sameDay(date, yesterday)) return t("inbox.yesterday");
    return date.toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short", year: "numeric" });
  }
  // Links in customers' text become clickable (the text itself is escaped first).
  const linkify = (html) => html.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  const memberNameOf = (id) => (id ? memberName(id) || t("inbox.teammate") : "");
  const visibleToMe = (c) => seesAll || !c.assigneeId || String(c.assigneeId) === String(me.id);
  function windowLeft(win) {
    if (!win || !win.open || !win.expiresAt) return null;
    const minutes = Math.max(0, Math.round((new Date(win.expiresAt) - Date.now()) / 60000));
    if (minutes >= 48 * 60) return t("inbox.leftD", { d: Math.floor(minutes / 1440) }); // G8: Instagram and Messenger's 7 days
    return minutes >= 60 ? t("inbox.leftHm", { h: Math.floor(minutes / 60), m: minutes % 60 }) : t("inbox.leftM", { m: minutes });
  }
  // "+" on the smallest phones (R3): attach, template and products open above the message box,
  // and close again after a pick, a tap elsewhere or Escape.
  function setComposerMore(open) {
    $("composerForm").classList.toggle("more-open", open);
    $("composerMore").setAttribute("aria-expanded", String(open));
  }
  $("composerMore").addEventListener("click", () => setComposerMore(!$("composerForm").classList.contains("more-open")));
  $("composerExtras").addEventListener("click", (event) => {
    if (event.target.closest("button")) setComposerMore(false);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#composerMore, #composerExtras")) setComposerMore(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("composerForm").classList.contains("more-open")) {
      setComposerMore(false);
      $("composerMore").focus();
    }
  });

  // "3h" or "45m": the phone's short reply-window chip (R2).
  function windowLeftShort(win) {
    if (!win || !win.open || !win.expiresAt) return null;
    const minutes = Math.max(0, Math.round((new Date(win.expiresAt) - Date.now()) / 60000));
    if (minutes >= 48 * 60) return t("inbox.leftD", { d: Math.floor(minutes / 1440) });
    return minutes >= 60 ? t("inbox.leftH", { h: Math.floor(minutes / 60) }) : t("inbox.leftM", { m: minutes });
  }
  const isWindowOpen = (c) => Boolean(c?.window?.open && new Date(c.window.expiresAt) > new Date());

  // --- conversation list ------------------------------------------------
  function matchesFilters(c) {
    if (!visibleToMe(c)) return false;
    if ((state.view === "blocked") !== Boolean(c.blocked)) return false; // D103: blocked customers only under Blocked
    if (state.view !== "blocked" && (state.view === "archived") !== Boolean(c.archived)) return false; // archived chats only under Archived
    if (state.view === "mine" && String(c.assigneeId) !== String(me.id)) return false;
    if (state.view === "unassigned" && c.assigneeId) return false;
    if (state.view !== "blocked" && state.status !== "any" && (state.status ? c.status !== state.status : c.status === "closed")) return false;
    if (state.channel && (c.channel || "whatsapp") !== state.channel) return false; // G8
    if (state.q) {
      const q = state.q.toLowerCase();
      const hay = `${c.contact.name} ${c.contact.company} ${c.contact.phone} ${c.social?.customerUsername || ""} ${(c.tags || []).join(" ")}`.toLowerCase();
      if (!hay.includes(q) && !(q.replace(/\D/g, "") && c.contact.phone.includes(q.replace(/\D/g, "")))) return false;
    }
    return true;
  }

  function conversationHtml(c) {
    const active = state.current && String(state.current.id) === String(c.id);
    const preview = `${c.lastMessageDirection === "out" ? t("inbox.you") : ""}${c.lastMessagePreview || ""}`;
    const assignee = c.assigneeId ? memberNameOf(c.assigneeId) : t("inbox.queue");
    // G8 (D112): an Instagram or Messenger chat carries its app's mark.
    const channel = SOCIAL[c.channel] ? `<i class="${SOCIAL[c.channel].icon} conv-channel ${escapeHtml(c.channel)}" title="${escapeHtml(SOCIAL[c.channel].name)}" aria-label="${escapeHtml(SOCIAL[c.channel].name)}"></i>` : "";
    return `
      <button class="conv-item ${active ? "active" : ""} ${c.unreadCount ? "unread" : ""}" data-id="${escapeHtml(c.id)}" type="button">
        <span class="conv-avatar">${escapeHtml(initialsOf(c.contact.name))}${channel}</span>
        <span style="min-width:0">
          <span class="name">${c.private ? `<i class="fa-solid fa-lock private-lock" title="${escapeHtml(t("inbox.privateTitle"))}"></i> ` : ""}${escapeHtml(c.contact.name || c.contact.phone)}</span>
          <span class="preview">${escapeHtml(preview)}</span>
          ${(c.tags || []).length ? `<span class="conv-labels">${c.tags.slice(0, 2).map((tag) => `<span class="conv-label">${escapeHtml(tag)}</span>`).join("")}${c.tags.length > 2 ? `<span class="conv-label">+${c.tags.length - 2}</span>` : ""}</span>` : ""}
        </span>
        <span class="conv-meta">
          <span>${c.pinned ? `<i class="fa-solid fa-thumbtack conv-pin" title="${escapeHtml(t("inbox.pinned"))}"></i> ` : ""}${escapeHtml(shortTime(c.lastMessageAt))}</span>
          ${c.unreadCount ? `<span class="unread-badge">${c.unreadCount}</span>` : `<span class="assignee-chip">${escapeHtml(assignee)}</span>`}
        </span>
      </button>`;
  }

  // G8 (D112): the channel filter appears once the company has an Instagram or Messenger chat.
  function noteChannels(conversations) {
    if (!state.hasSocial && (conversations || []).some(isSocial)) state.hasSocial = true;
    $("inboxChannel").hidden = !state.hasSocial && !state.channel;
  }

  function renderList() {
    const list = $("conversationList");
    if (!state.conversations.length) {
      // No WhatsApp number yet: the next step, not an empty list (owners and admins connect it).
      if (state.whatsappConnected === false && !state.q) {
        list.innerHTML = isOrgManager()
          ? `<div class="inbox-list-empty inbox-connect"><i class="fa-brands fa-whatsapp"></i><strong>${escapeHtml(t("inbox.connect.title"))}</strong><span>${escapeHtml(t("inbox.connect.text"))}</span><a class="btn btn-primary" href="connect-whatsapp.html?add=1">${escapeHtml(t("inbox.connect.button"))}</a></div>`
          : `<div class="inbox-list-empty">${escapeHtml(t("inbox.connect.askAdmin"))}</div>`;
        $("conversationMore").hidden = true;
        return;
      }
      const empty = state.q
        ? t("inbox.empty.search")
        : state.view === "archived"
          ? t("inbox.empty.archived")
          : state.view === "mine"
          ? t("inbox.empty.mine")
          : state.status === "" ? t("inbox.empty.open") : t("inbox.empty.none");
      list.innerHTML = `<div class="inbox-list-empty">${escapeHtml(empty)}</div>`;
    } else {
      list.innerHTML = state.conversations.map(conversationHtml).join("");
    }
    $("conversationMore").hidden = !state.hasMore;
  }

  async function loadConversations({ append = false } = {}) {
    if (!append) state.page = 1;
    const params = new URLSearchParams({ view: state.view, page: state.page, limit: PAGE_SIZE });
    if (state.status) params.set("status", state.status);
    else if (state.view === "blocked") params.set("status", "any"); // D103: every blocked chat
    if (state.q) params.set("q", state.q);
    if (state.channel) params.set("channel", state.channel);
    try {
      const body = await crmRequest(`/conversations?${params}`);
      state.conversations = append ? [...state.conversations, ...body.data] : body.data;
      state.hasMore = Boolean(body.pagination?.hasNextPage);
      noteChannels(body.data);
      renderList();
    } catch (error) {
      $("conversationList").innerHTML = `<div class="inbox-list-empty">${escapeHtml(apiErrorMessage(error, t("inbox.err.loadChats")))}</div>`;
    }
  }

  // Pinned chats first (each member's own), then the newest.
  const byPinThenTime = (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0);
  function upsertConversation(c) {
    const index = state.conversations.findIndex((item) => String(item.id) === String(c.id));
    // Live updates do not say who pinned a chat: keep what this member knows.
    if (c.pinned === undefined) c.pinned = index !== -1 ? Boolean(state.conversations[index].pinned) : Boolean(state.current && String(state.current.id) === String(c.id) && state.current.pinned);
    if (index !== -1) state.conversations.splice(index, 1);
    if (matchesFilters(c)) {
      state.conversations.unshift(c);
      state.conversations.sort(byPinThenTime);
    }
    noteChannels([c]);
    renderList();
  }

  let summaryTimer = null;
  function scheduleSummary() {
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(loadSummary, 400);
  }
  async function loadSummary() {
    try {
      const summary = await crmApi("/conversations/summary");
      $("countMine").textContent = summary.mine;
      $("countUnassigned").textContent = summary.unassigned;
      $("countAll").textContent = summary.all;
      state.unread = summary.unread;
      document.title = `${summary.unread ? `(${summary.unread}) ` : ""}${t("nav.inbox")} | YELLOW CRM`;
      if (typeof setInboxNavBadge === "function") setInboxNavBadge(summary.unread);
    } catch {
      /* the counts are a convenience */
    }
  }

  // --- thread --------------------------------------------------------------
  // Photos load as previews; audio and video load when played; documents download. The file
  // always comes through the API (signed in), never from a public address.
  function mediaHtml(m) {
    const [icon, label] = MEDIA[m.type];
    const id = escapeHtml(m.id);
    const name = m.type === "audio" && m.media?.voice ? t("inbox.voiceMessage") : m.media?.fileName || label;
    if (!m.media) return `<div class="attachment"><i class="fa-solid ${icon}"></i><span>${escapeHtml(name)}</span></div>`;
    const viewable = PREVIEW_TYPES.includes(baseMime(m.media.mimeType));
    if ((m.type === "image" || m.type === "sticker") && viewable) {
      const url = mediaUrls.get(m.id);
      const inner = typeof url === "string" ? `<img src="${url}" alt="${escapeHtml(m.text || t("inbox.media.image"))}" />` : '<span class="media-wait"><i class="fa-solid fa-image"></i></span>';
      return `<button class="media-photo" type="button" data-photo="${id}" title="${escapeHtml(t("inbox.openPhoto"))}">${inner}</button>`;
    }
    if ((m.type === "audio" || m.type === "video") && viewable) {
      return `<div class="media-player" data-player="${id}"><button class="btn btn-outline media-play" type="button" data-play="${id}"><i class="fa-solid fa-play"></i> ${escapeHtml(name)}</button></div>`;
    }
    const size = m.media.sizeBytes ? fileSize(m.media.sizeBytes) : "";
    return `<div class="attachment doc"><i class="fa-solid ${m.type === "document" ? "fa-file-lines" : icon}"></i><span class="doc-name">${escapeHtml(name)}</span>${size ? `<span class="doc-size">${size}</span>` : ""}<button class="icon-btn" type="button" data-download="${id}" title="${escapeHtml(t("inbox.download"))}"><i class="fa-solid fa-download"></i></button></div>`;
  }

  function messageBody(m) {
    const text = m.text ? linkify(escapeHtml(m.text)) : "";
    if (MEDIA[m.type]) return `${mediaHtml(m)}${text ? `<div class="caption">${text}</div>` : ""}`;
    if (m.type === "template" && m.media) return `${mediaHtml({ ...m, type: "document" })}${text ? `<div class="caption">${text}</div>` : ""}`;
    if (m.type === "location" && m.location) {
      const { latitude, longitude, name, address } = m.location;
      const url = `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}`;
      return `<div class="attachment"><i class="fa-solid fa-location-dot"></i><a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(name || address || t("inbox.location"))}</a></div>`;
    }
    if (m.type === "reaction") return escapeHtml(t("inbox.reacted", { emoji: m.reaction?.emoji || "" }));
    // G7 (D111): a WhatsApp call's line, our request to call, and the customer's answer to it.
    if (m.type === "call" && m.call) return callLineHtml(m);
    if (m.type === "interactive" && m.interactive?.kind === "call_permission") {
      return `${text}<div class="bot-options"><span class="bot-option"><i class="fa-solid fa-phone"></i> ${escapeHtml(t("inbox.call.askChip"))}</span></div>`;
    }
    if (m.type === "interactive" && m.callPermission) {
      const p = m.callPermission;
      const until = p.expiresAt ? new Date(p.expiresAt).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short" }) : "";
      const label = p.response !== "accept" ? t("inbox.call.refused") : p.permanent || !until ? t("inbox.call.allowedAlways") : t("inbox.call.allowedUntil", { when: until });
      return `<div class="attachment"><i class="fa-solid ${p.response === "accept" ? "fa-phone" : "fa-phone-slash"}"></i><span>${escapeHtml(label)}</span></div>`;
    }
    // Products from the WhatsApp catalog (sent), and a cart the customer sent back (Phase 8C).
    if (m.type === "interactive" && m.interactive?.products?.length) {
      const names = m.interactive.products.map((p) => `<span class="bot-option"><i class="fa-solid fa-store"></i> ${escapeHtml(p.name || p.retailerId)}</span>`).join("");
      return `${m.interactive.kind === "product_list" ? text : ""}<div class="bot-options">${names}</div>`;
    }
    if (m.type === "order" && m.order) {
      const items = m.order.items.map((i) => `<li>${escapeHtml(String(i.quantity))} × ${escapeHtml(productNameOf(i.retailerId))}${i.itemPricePaise ? ` · ₹${(i.itemPricePaise / 100).toLocaleString(crmI18n.locale())}` : ""}</li>`).join("");
      return `<div class="attachment"><i class="fa-solid fa-cart-shopping"></i><strong>${escapeHtml(t("inbox.catalogOrder"))}</strong></div><ul class="cart-items">${items}</ul>${m.order.text ? `<div class="caption">${linkify(escapeHtml(m.order.text))}</div>` : ""}${m.order.orderId ? `<a class="btn btn-outline" href="Orders.html?id=${encodeURIComponent(m.order.orderId)}"><i class="fa-solid fa-truck-fast"></i> ${escapeHtml(t("inbox.openOrder"))}</a>` : `<div class="text-muted">${escapeHtml(t("inbox.makingOrder"))}</div>`}`;
    }
    // G6 (D110): a WhatsApp form sent, and the customer's answers (with the lead or order they made).
    if (m.type === "interactive" && m.interactive?.kind === "flow") {
      return `${text}<div class="bot-options"><span class="bot-option"><i class="fa-solid fa-clipboard-list"></i> ${escapeHtml(m.form?.name || t("inbox.form.form"))}</span></div>`;
    }
    if (m.type === "interactive" && m.direction === "in" && m.form) {
      const answers = (m.form.answers || []).map((a) => `<li><strong>${escapeHtml(a.label)}:</strong> ${escapeHtml(a.value)}</li>`).join("");
      const link = m.form.orderId
        ? `<a class="btn btn-outline" href="Orders.html?id=${encodeURIComponent(m.form.orderId)}"><i class="fa-solid fa-truck-fast"></i> ${escapeHtml(t("inbox.openOrder"))}</a>`
        : m.form.leadId
          ? `<a class="btn btn-outline" href="leads.html?open=${encodeURIComponent(m.form.leadId)}"><i class="fa-solid fa-filter-circle-dollar"></i> ${escapeHtml(t("inbox.form.openLead"))}</a>`
          : m.form.done ? "" : `<div class="text-muted">${escapeHtml(t("inbox.form.reading"))}</div>`;
      const title = m.form.name ? t("inbox.form.answersOf", { name: m.form.name }) : t("inbox.form.answers");
      return `<div class="attachment"><i class="fa-solid fa-clipboard-check"></i><strong>${escapeHtml(title)}</strong></div>${answers ? `<ul class="cart-items">${answers}</ul>` : ""}${link}`;
    }
    // The bot's buttons or list (sent), or the customer's choice (received).
    if (m.type === "interactive" && m.direction === "out" && m.interactive) {
      const options = m.interactive.options.map((o) => `<span class="bot-option">${escapeHtml(o.title)}</span>`).join("");
      const list = m.interactive.kind === "list" ? `<div class="bot-list-btn"><i class="fa-solid fa-list-ul"></i> ${escapeHtml(m.interactive.listButton || t("inbox.choose"))}</div>` : "";
      return `${text}<div class="bot-options">${options}</div>${list}`;
    }
    if (m.type === "interactive" || m.type === "button") return `<i class="fa-solid fa-reply"></i> ${text}`;
    if (m.type === "contacts") return `<div class="attachment"><i class="fa-solid fa-address-card"></i><span>${escapeHtml(m.text || t("inbox.contactCard"))}</span></div>`;
    if (m.type === "unsupported") return `<span class="text-muted">${escapeHtml(t("inbox.unsupported"))}</span>`;
    return text;
  }

  // G7 (D111): how a WhatsApp call went, with its length.
  const CALL_LINE = {
    in: { ringing: "inbox.call.lineRinging", in_progress: "inbox.call.lineLive", completed: "inbox.call.lineDone", no_answer: "inbox.call.lineMissed", busy: "inbox.call.lineDeclined", failed: "inbox.call.lineFailed", cancelled: "inbox.call.lineCancelled" },
    out: { queued: "inbox.call.lineCalling", ringing: "inbox.call.lineCalling", in_progress: "inbox.call.lineLive", completed: "inbox.call.lineDone", no_answer: "inbox.call.lineNoAnswer", busy: "inbox.call.lineDeclined", failed: "inbox.call.lineFailed", cancelled: "inbox.call.lineCancelled" },
  };
  function callLineHtml(m) {
    const { status, durationSec } = m.call;
    const missed = m.direction === "in" && status === "no_answer";
    const off = missed || ["busy", "failed", "cancelled"].includes(status) || (m.direction === "out" && status === "no_answer");
    const key = CALL_LINE[m.direction === "in" ? "in" : "out"][status] || "inbox.call.lineDone";
    return `<div class="call-line ${missed ? "missed" : ""}"><i class="fa-solid ${off ? "fa-phone-slash" : "fa-phone"}" aria-hidden="true"></i><span>${escapeHtml(t(key, { duration: crmWhatsAppCalls.clockText(durationSec) }))}</span></div>`;
  }

  function messageHtml(m) {
    const quoted = m.replyToProviderMessageId ? state.messages.find((other) => other.providerMessageId === m.replyToProviderMessageId) : null;
    // Sent by a teammate, or by the CRM itself (an auto-reply rule).
    const robot = m.automation ? `${escapeHtml(crmI18n.has(`inbox.auto.${m.automation.kind}`) ? t(`inbox.auto.${m.automation.kind}`) : t("inbox.auto.other"))} · ` : "";
    // Sent from the WhatsApp Business app on the phone (a connected app number, D60).
    const fromPhone = m.origin === "phone" ? `<span class="from-phone"><i class="fa-solid fa-mobile-screen"></i> ${escapeHtml(t("inbox.fromPhone"))}</span> · ` : "";
    const who = m.direction !== "out" ? "" : fromPhone || robot || (m.sentByMemberId ? `${escapeHtml(memberNameOf(m.sentByMemberId))} · ` : "");
    const time = new Date(m.at).toLocaleTimeString(crmI18n.locale(), { hour: "numeric", minute: "2-digit" });
    const replyButton = m.providerMessageId && m.direction === "in"
      ? `<button class="reply-btn" type="button" data-reply="${escapeHtml(m.id)}" title="${escapeHtml(t("inbox.replyTo"))}"><i class="fa-solid fa-reply"></i></button>`
      : "";
    // A reaction (CP3): on a customer's message of the last 30 days, while the window is open.
    const canReact = m.direction === "in" && m.providerMessageId && isWindowOpen(state.current) && Date.now() - new Date(m.at) < REACTION_DAYS * 24 * 60 * 60 * 1000;
    const reactButton = canReact
      ? `<button class="reply-btn react-btn" type="button" data-react="${escapeHtml(m.id)}" title="${escapeHtml(t("inbox.react"))}" aria-label="${escapeHtml(t("inbox.reactTo"))}" aria-expanded="${state.reactingTo === m.id}"><i class="fa-regular fa-face-smile"></i></button>`
      : "";
    const reactionBar = state.reactingTo === m.id
      ? `<div class="reaction-bar" role="menu" aria-label="${escapeHtml(t("inbox.reactions"))}">${QUICK_REACTIONS.map((emoji) => `<button type="button" role="menuitem" data-reaction="${emoji}" aria-label="${escapeHtml(t("inbox.reactWith", { emoji }))}">${emoji}</button>`).join("")}</div>`
      : "";
    const reactions = [m.reactions?.customer, m.reactions?.business].filter(Boolean);
    return `
      <div class="msg ${m.direction} ${m.status === "failed" ? "failed" : ""}" data-id="${escapeHtml(m.id)}">
        <div class="bubble">
          ${quoted ? `<div class="quote">${escapeHtml(quoted.text || quoted.type)}</div>` : ""}
          ${m.referral ? `<div class="msg-ad"><i class="fa-solid fa-bullhorn" aria-hidden="true"></i> ${escapeHtml(t("inbox.came.fromAd"))}: <strong>${escapeHtml(m.referral.headline || t("inbox.came.adNoName"))}</strong></div>` : ""}
          <div class="bubble-body">${messageBody(m)}</div>
          <div class="bubble-meta">${m.type === "template" ? `<span class="tpl-tag">${escapeHtml(t("inbox.template"))}</span>` : ""}${who}${escapeHtml(time)} ${m.direction === "out" && m.type !== "call" ? TICKS[m.status] || "" : ""}</div>
          ${m.status === "failed" && m.error ? `<div class="msg-error">${escapeHtml(m.error.message || m.error.title || t("inbox.notAccepted"))}</div>` : ""}
          ${reactions.length ? `<div class="msg-reactions" title="${escapeHtml(t("inbox.reactions"))}">${reactions.map(escapeHtml).join(" ")}</div>` : ""}
        </div>
        ${replyButton}${reactButton}${reactionBar}
      </div>`;
  }

  function renderMessages({ stickToBottom = true } = {}) {
    const box = $("threadMessages");
    const previousHeight = box.scrollHeight;
    const previousTop = box.scrollTop;
    let lastDay = "";
    // Audio and video players survive the re-render (and keep playing).
    const players = [...document.querySelectorAll("#messageList [data-player]")]
      .map((slot) => [slot.dataset.player, slot.querySelector("audio, video")])
      .filter(([, player]) => player)
      .map(([id, player]) => ({ id, player, playing: !player.paused }));
    $("messageList").innerHTML = state.messages
      .filter((m) => m.type !== "reaction") // shown on the message it is for (CP3)
      .map((m) => {
        const day = dayLabel(new Date(m.at));
        const separator = day !== lastDay ? `<div class="day-sep"><span>${escapeHtml(day)}</span></div>` : "";
        lastDay = day;
        return separator + messageHtml(m);
      })
      .join("");
    if (!state.messages.length) {
      $("messageList").innerHTML = `<div class="inbox-list-empty">${escapeHtml(t("inbox.empty.messages"))}</div>`;
    }
    players.forEach(({ id, player, playing }) => {
      const slot = document.querySelector(`#messageList [data-player="${CSS.escape(id)}"]`);
      if (!slot) return;
      slot.replaceChildren(player);
      if (playing) player.play().catch(() => {});
    });
    $("olderMessages").hidden = !state.nextBefore;
    // Loading older messages keeps the view where it was; new ones scroll to the bottom.
    box.scrollTop = stickToBottom ? box.scrollHeight : box.scrollHeight - previousHeight + previousTop;
    box.querySelectorAll("#messageList img").forEach(keepBottomOnLoad);
    showPhotos();
  }
  // A photo gets its height only once it has loaded: stay at the bottom if the view was there.
  function keepBottomOnLoad(img) {
    if (img.complete) return;
    const box = $("threadMessages");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (atBottom) img.addEventListener("load", () => (box.scrollTop = box.scrollHeight), { once: true });
  }

  // --- files in messages ---------------------------------------------------------
  // Object URLs of downloaded files, per message (freed when another chat opens).
  const mediaUrls = new Map();
  const mediaPath = (m) => `/conversations/${m.conversationId}/messages/${m.id}/media`;
  function forgetMedia() {
    mediaUrls.forEach((url) => {
      if (typeof url === "string") URL.revokeObjectURL(url);
    });
    mediaUrls.clear();
  }
  async function mediaUrl(m) {
    if (mediaUrls.has(m.id)) return mediaUrls.get(m.id);
    const loading = crmRequest(mediaPath(m), {}, { blob: true }).then((blob) => {
      // The download is typed as a plain file; the page gives it its real (allowed) type.
      const url = URL.createObjectURL(new Blob([blob], { type: baseMime(m.media.mimeType) }));
      mediaUrls.set(m.id, url);
      return url;
    });
    mediaUrls.set(m.id, loading);
    loading.catch(() => mediaUrls.delete(m.id));
    return loading;
  }
  const messageById = (id) => state.messages.find((m) => String(m.id) === String(id));
  function showPhotos() {
    document.querySelectorAll("#messageList [data-photo]").forEach(async (button) => {
      const m = messageById(button.dataset.photo);
      if (!m || button.querySelector("img")) return;
      try {
        const url = await mediaUrl(m);
        if (!button.isConnected) return;
        button.innerHTML = `<img src="${url}" alt="${escapeHtml(m.text || t("inbox.media.image"))}" />`;
        keepBottomOnLoad(button.querySelector("img"));
      } catch (error) {
        if (button.isConnected) button.outerHTML = `<div class="attachment"><i class="fa-solid fa-image"></i><span>${escapeHtml(apiErrorMessage(error, t("inbox.err.photo")))}</span></div>`;
      }
    });
  }
  async function playMedia(button) {
    const m = messageById(button.dataset.play);
    if (!m) return;
    button.disabled = true;
    try {
      const url = await mediaUrl(m);
      const player = document.createElement(m.type === "video" ? "video" : "audio");
      player.controls = true;
      player.src = url;
      button.replaceWith(player);
      player.play().catch(() => {});
    } catch (error) {
      button.disabled = false;
      showToast(apiErrorMessage(error, t("inbox.err.loadFile")), "error");
    }
  }
  async function downloadMedia(id) {
    const m = messageById(id);
    if (!m) return;
    try {
      await crmDownload(mediaPath(m), m.media?.fileName || `whatsapp-${m.type}`);
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.err.download")), "error");
    }
  }

  function renderThreadHead() {
    const c = state.current;
    const social = SOCIAL[c.channel] || null; // G8 (D112): an Instagram or Messenger chat
    $("threadAvatar").textContent = initialsOf(c.contact.name);
    $("threadName").textContent = c.contact.name || c.contact.phone;
    const assignee = c.assigneeId ? t("inbox.assignedTo", { name: memberNameOf(c.assigneeId) }) : t("inbox.inQueue");
    $("threadSub").textContent = social
      ? `${c.social?.customerUsername ? `@${c.social.customerUsername} · ` : ""}${t("inbox.viaSocial", { channel: social.name, name: c.social?.username ? `@${c.social.username}` : c.social?.name || "" })} · ${assignee}`
      : `${c.contact.phone}${c.account?.displayPhone ? t("inbox.via", { phone: c.account.displayPhone }) : ""} · ${assignee}`;
    const left = windowLeft(c.window);
    const chip = $("threadWindow");
    const open = isWindowOpen(c);
    // The long text on computers, the short one on phones (inbox.css).
    chip.innerHTML = open
      ? `<i class="fa-regular fa-clock"></i> <span class="window-long">${escapeHtml(t("inbox.window.open", { left }))}</span><span class="window-short">${escapeHtml(t("inbox.window.short", { left: windowLeftShort(c.window) }))}</span>`
      : `<i class="fa-regular fa-clock"></i> <span class="window-long">${escapeHtml(t("inbox.window.closed"))}</span><span class="window-short">${escapeHtml(t(social ? "inbox.window.closed" : "inbox.window.templatesOnly"))}</span>`;
    chip.title = social
      ? t(open ? (c.window.humanAgent ? "inbox.window.socialAgentTitle" : "inbox.window.socialOpenTitle") : "inbox.window.socialClosedTitle", { left })
      : open ? t("inbox.window.openTitle", { left }) : t("inbox.window.closedTitle");
    chip.className = `window-chip ${open ? "" : "closed"}`;
    renderBotChip(c);
    // Private numbers (D61): owners only — make the chat's number private, or show it again.
    const privateChip = $("threadPrivate");
    privateChip.hidden = !isOrgOwner() || Boolean(social); // private numbers are WhatsApp numbers (D61)
    privateChip.className = `private-chip ${c.private ? "on" : ""}`;
    privateChip.innerHTML = c.private ? `<i class="fa-solid fa-lock"></i> ${escapeHtml(t("inbox.private.on"))}` : `<i class="fa-solid fa-lock-open"></i> ${escapeHtml(t("inbox.private.make"))}`;
    privateChip.title = c.private ? t("inbox.private.onTitle") : t("inbox.private.makeTitle");
    // G7 (D111): a WhatsApp call — on a number with calls on; without the customer's permission
    // the button asks them first.
    const callButton = $("threadCall");
    callButton.hidden = !c.account?.calling;
    callButton.disabled = Boolean(c.blocked);
    callButton.title = t(c.callPermission?.status === "granted" ? "inbox.call.button" : "inbox.call.buttonAsk");
    callButton.setAttribute("aria-label", callButton.title);
    // D103: a blocked customer cannot be written to at all.
    const writable = canWrite(c);
    $("composerBlocked").hidden = !c.blocked;
    $("composerClosed").hidden = open || Boolean(c.blocked);
    // G8: Instagram and Messenger take text only (no templates, files, products or forms).
    $("composerClosedText").textContent = t(social ? "inbox.closedSocial" : "inbox.closedText");
    $("closedTemplateBtn").hidden = Boolean(social);
    ["attachBtn", "templateBtn", "productsBtn", "formBtn"].forEach((id) => { $(id).hidden = Boolean(social); });
    $("composerText").disabled = !writable;
    $("composerSend").disabled = !writable;
    $("quickRepliesBtn").disabled = !writable;
    $("attachBtn").disabled = !writable;
    $("productsBtn").disabled = !writable; // product messages need the 24-hour window
    $("formBtn").disabled = !writable; // so do WhatsApp forms (D110)
    $("emojiBtn").disabled = !writable;
    $("laterBtn").disabled = !writable;
    $("templateBtn").disabled = Boolean(c.blocked);
    syncSendButton();
    $("aiSuggestBtn").style.display = state.aiAvailable ? "" : "none";
    $("aiSuggestBtn").disabled = !writable;
    if (!writable) clearFile();
  }

  // --- the AI assistant's reply drafts (Phase 10D): the agent picks one, edits and sends it ---
  function hideAiSuggest() {
    state.aiAsk = (state.aiAsk || 0) + 1; // an answer still on its way is dropped
    $("aiSuggest").hidden = true;
    $("aiSuggest").innerHTML = "";
  }
  async function suggestReplies() {
    const c = state.current;
    if (!c) return;
    const ask = (state.aiAsk || 0) + 1;
    state.aiAsk = ask;
    const panel = $("aiSuggest");
    panel.hidden = false;
    panel.innerHTML = `<div class="ai-suggest-head"><span><i class="fa-solid fa-wand-magic-sparkles"></i> ${escapeHtml(t("inbox.ai.writing"))}</span></div>`;
    try {
      const { suggestions, note } = await crmApi(`/conversations/${c.id}/ai/suggest`, { method: "POST" });
      if (state.aiAsk !== ask || !state.current || String(state.current.id) !== String(c.id)) return;
      panel.innerHTML = `
        <div class="ai-suggest-head"><span><i class="fa-solid fa-wand-magic-sparkles"></i> ${escapeHtml(t("inbox.ai.suggested"))}</span><button class="icon-btn" type="button" data-ai-close aria-label="${escapeHtml(t("common.close"))}"><i class="fa-solid fa-xmark"></i></button></div>
        ${suggestions.map((text, i) => `<button class="ai-suggestion" type="button" data-ai-pick="${i}">${escapeHtml(text)}</button>`).join("")}
        ${note ? `<div class="ai-suggest-note">${escapeHtml(note)}</div>` : ""}`;
      panel.querySelectorAll("[data-ai-pick]").forEach((button) => button.addEventListener("click", () => {
        composer.value = suggestions[Number(button.dataset.aiPick)];
        autoSize();
        composer.focus();
        hideAiSuggest();
      }));
      panel.querySelector("[data-ai-close]").addEventListener("click", hideAiSuggest);
    } catch (error) {
      if (state.aiAsk !== ask) return;
      panel.innerHTML = `<div class="ai-suggest-head"><span>${escapeHtml(apiErrorMessage(error, t("inbox.ai.none")))}</span><button class="icon-btn" type="button" data-ai-close aria-label="${escapeHtml(t("common.close"))}"><i class="fa-solid fa-xmark"></i></button></div>`;
      panel.querySelector("[data-ai-close]").addEventListener("click", hideAiSuggest);
    }
  }

  // D33: the bot answers while nobody has the chat and the customer has not asked for a person.
  function renderBotChip(c) {
    const chip = $("threadBot");
    const waiting = Boolean(c.bot?.handedOffAt);
    // Someone has the chat: the bot is quiet there anyway, nothing to switch.
    chip.hidden = !state.botEnabled || Boolean(c.assigneeId);
    chip.className = `bot-chip ${waiting ? "off" : ""}`;
    chip.innerHTML = waiting ? `<i class="fa-solid fa-robot"></i> ${escapeHtml(t("inbox.bot.off"))}` : `<i class="fa-solid fa-robot"></i> ${escapeHtml(t("inbox.bot.on"))}`;
    chip.title = waiting
      ? t("inbox.bot.offTitle", { reason: c.bot.handoffReason || t("inbox.bot.waiting") })
      : t("inbox.bot.onTitle");
  }
  async function toggleBot() {
    const c = state.current;
    if (!c) return;
    try {
      const updated = await crmApi(`/conversations/${c.id}/bot`, jsonRequest("POST", { active: Boolean(c.bot?.handedOffAt) }));
      onConversationUpdated(updated);
      showToast(t(updated.bot?.handedOffAt ? "inbox.bot.turnedOff" : "inbox.bot.turnedOn"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.bot.failed")), "error");
    }
  }

  async function openConversation(id, { fromList = true } = {}) {
    if (recording) finishVoiceNote(false);
    state.reactingTo = null;
    typingSentAt = 0;
    let c = state.conversations.find((item) => String(item.id) === String(id));
    try {
      if (!c || !fromList) c = await crmApi(`/conversations/${id}`);
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.err.open")), "error");
      return;
    }
    if (!state.current || String(state.current.id) !== String(c.id)) {
      forgetMedia();
      clearFile();
      hideAiSuggest();
      state.scheduled = [];
      renderScheduled();
      state.context = null;
      renderContext();
    }
    state.current = c;
    state.replyTo = null;
    $("replyBar").hidden = true;
    $("threadEmpty").hidden = true;
    $("threadView").hidden = false;
    $("detailsView").hidden = false;
    $("inbox").dataset.pane = "thread";
    renderThreadHead();
    renderDetails();
    renderList();
    $("messageList").innerHTML = `<div class="inbox-list-empty">${escapeHtml(t("inbox.loadingMessages"))}</div>`;
    const history = new URL(window.location.href);
    history.searchParams.set("c", c.id);
    window.history.replaceState(null, "", history);
    try {
      const [page, notes] = await Promise.all([
        crmRequest(`/conversations/${c.id}/messages?limit=50`),
        crmApi(`/conversations/${c.id}/notes`),
      ]);
      if (!state.current || String(state.current.id) !== String(c.id)) return; // another chat was opened meanwhile
      state.messages = page.data;
      state.nextBefore = page.nextBefore;
      state.notes = notes;
      renderMessages();
      renderNotes();
      loadContext();
      loadScheduled(); // D103
      loadBlockInfo(); // D103
      if (c.unreadCount) markRead();
      if (!$("composerText").disabled) $("composerText").focus();
    } catch (error) {
      $("messageList").innerHTML = `<div class="inbox-list-empty">${escapeHtml(apiErrorMessage(error, t("inbox.err.loadMessages")))}</div>`;
    }
  }

  function closeThread(message) {
    state.current = null;
    state.messages = [];
    forgetMedia();
    clearFile();
    $("threadView").hidden = true;
    $("detailsView").hidden = true;
    $("threadEmpty").hidden = false;
    $("inbox").dataset.pane = "list";
    delete $("inbox").dataset.details;
    detailsInHistory = false;
    syncDetailsSheet();
    const history = new URL(window.location.href);
    history.searchParams.delete("c");
    window.history.replaceState(null, "", history);
    if (message) showToast(message, "info");
    renderList();
  }

  async function loadOlder() {
    if (!state.current || !state.nextBefore) return;
    try {
      const page = await crmRequest(`/conversations/${state.current.id}/messages?limit=50&before=${state.nextBefore}`);
      state.messages = [...page.data, ...state.messages];
      state.nextBefore = page.nextBefore;
      renderMessages({ stickToBottom: false });
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.err.loadOlder")), "error");
    }
  }

  let readTimer = null;
  function markRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(async () => {
      if (!state.current || document.hidden) return;
      try {
        const updated = await crmApi(`/conversations/${state.current.id}/read`, { method: "POST" });
        upsertConversation(updated);
        if (state.current && String(state.current.id) === String(updated.id)) state.current = updated;
        scheduleSummary();
      } catch {
        /* the next message tries again */
      }
    }, 300);
  }

  function addOrReplaceMessage(message) {
    const index = state.messages.findIndex((m) => String(m.id) === String(message.id));
    if (index === -1) state.messages.push(message);
    else state.messages[index] = message;
    state.messages.sort((a, b) => new Date(a.at) - new Date(b.at));
  }

  // --- composer ----------------------------------------------------------
  const composer = $("composerText");
  function autoSize() {
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, 140)}px`;
    // A scrollbar only once the text is taller than the box can grow.
    composer.style.overflowY = composer.scrollHeight > 140 ? "auto" : "hidden";
  }

  // --- a file to send (the text box becomes its caption) ---
  // The long hint only where it fits on one line: phones, and a box narrowed by the details
  // panel, get the short one. Checked again whenever the box changes width.
  const defaultPlaceholder = () => (window.matchMedia("(max-width: 520px)").matches || (composer.clientWidth > 0 && composer.clientWidth < 260) ? t("inbox.composer.short") : t("inbox.composer.long"));
  composer.placeholder = defaultPlaceholder();
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      if (!state.file) composer.placeholder = defaultPlaceholder();
    }).observe(composer);
  }
  function clearFile() {
    state.file = null;
    state.voice = false;
    $("fileInput").value = "";
    $("fileBar").hidden = true;
    composer.placeholder = defaultPlaceholder();
  }
  $("attachBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) {
      showToast(t("inbox.composer.tooBig"), "error");
      clearFile();
      return;
    }
    state.file = file;
    $("fileName").textContent = file.name;
    $("fileSize").textContent = fileSize(file.size);
    $("fileBar").hidden = false;
    composer.placeholder = t("inbox.composer.caption");
    composer.focus();
  });
  $("fileCancel").addEventListener("click", clearFile);

  function sendRequest(conversation, text) {
    const headers = { "Idempotency-Key": newIdempotencyKey() };
    // D103: a quick reply's file (from Documents), its text as the caption.
    if (state.file?.quickReplyId) {
      return crmApi(`/conversations/${conversation.id}/messages/quick-reply-file`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ quickReplyId: state.file.quickReplyId, caption: text, ...(state.replyTo && { replyToMessageId: state.replyTo.id }) }),
      });
    }
    if (state.file) {
      const form = new FormData();
      form.append("file", state.file, state.file.name);
      if (text) form.append("caption", text);
      if (state.voice) form.append("voice", "true");
      if (state.replyTo) form.append("replyToMessageId", state.replyTo.id);
      return crmApi(`/conversations/${conversation.id}/messages/media`, { method: "POST", headers, body: form });
    }
    return crmApi(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...(state.replyTo && { replyToMessageId: state.replyTo.id }) }),
    });
  }

  async function sendMessage() {
    const text = composer.value.trim();
    if ((!text && !state.file) || !state.current) return;
    const conversation = state.current;
    const sendButton = $("composerSend");
    sendButton.disabled = true;
    try {
      const message = await sendRequest(conversation, text);
      composer.value = "";
      clearFile();
      autoSize();
      state.replyTo = null;
      $("replyBar").hidden = true;
      if (state.current && String(state.current.id) === String(conversation.id)) {
        addOrReplaceMessage(message);
        renderMessages();
      }
      if (message.status === "failed") showToast(t("inbox.notSent", { reason: message.error?.message || t("inbox.unknownReason") }), "error");
    } catch (error) {
      if (error.code === "WINDOW_CLOSED" && state.current) {
        state.current.window = { open: false, expiresAt: state.current.window?.expiresAt || null };
        renderThreadHead();
      }
      showToast(apiErrorMessage(error, t("inbox.err.send")), "error");
    } finally {
      sendButton.disabled = !canWrite(state.current);
      syncSendButton();
    }
  }

  // --- the microphone, emoji and "typing…" (CP3) ------------------------------------------
  // Nothing typed and no file: the microphone stands where the send button is.
  const canRecord = () => Boolean(window.crmVoiceNote?.supported()) && !isSocial(state.current); // G8: voice notes are WhatsApp's
  function syncSendButton() {
    const empty = !composer.value.trim() && !state.file;
    $("micBtn").hidden = !(empty && canRecord());
    $("composerSend").hidden = empty && canRecord();
    $("micBtn").disabled = !canWrite(state.current);
  }
  let recording = null;
  const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  async function startVoiceNote() {
    if (!state.current || !isWindowOpen(state.current) || recording) return;
    try {
      recording = await crmVoiceNote.startRecording({
        onTick: (seconds) => { $("recordTime").textContent = clock(seconds); },
        onLimit: () => finishVoiceNote(true),
      });
    } catch (error) {
      recording = null;
      showToast(t(error?.name === "NotAllowedError" ? "inbox.voice.allowMic" : "inbox.voice.micFailed"), "error");
      return;
    }
    $("recordTime").textContent = "0:00";
    $("composerForm").hidden = true;
    $("recordingBar").hidden = false;
    $("recordSend").focus();
  }
  async function finishVoiceNote(send) {
    if (!recording) return;
    const current = recording;
    recording = null;
    $("recordingBar").hidden = true;
    $("composerForm").hidden = false;
    if (!send) {
      current.cancel();
      return;
    }
    try {
      const { file, voice } = await current.stop();
      state.file = file;
      state.voice = voice;
      await sendMessage();
    } catch (error) {
      clearFile();
      showToast(apiErrorMessage(error, t("inbox.voice.failed")), "error");
    }
  }
  $("micBtn").addEventListener("click", startVoiceNote);
  $("recordSend").addEventListener("click", () => finishVoiceNote(true));
  $("recordCancel").addEventListener("click", () => finishVoiceNote(false));

  // The emoji picker: a tap puts the emoji where the cursor is.
  $("emojiPicker").innerHTML = EMOJIS.map((emoji) => `<button type="button" data-emoji="${emoji}" aria-label="${emoji}">${emoji}</button>`).join("");
  function setEmojiPicker(open) {
    $("emojiPicker").hidden = !open;
    $("emojiBtn").setAttribute("aria-expanded", String(open));
  }
  $("emojiBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    setEmojiPicker($("emojiPicker").hidden);
  });
  $("emojiPicker").addEventListener("click", (e) => {
    const button = e.target.closest("[data-emoji]");
    if (!button) return;
    const start = composer.selectionStart ?? composer.value.length;
    const end = composer.selectionEnd ?? start;
    composer.value = composer.value.slice(0, start) + button.dataset.emoji + composer.value.slice(end);
    composer.selectionStart = composer.selectionEnd = start + button.dataset.emoji.length;
    setEmojiPicker(false);
    composer.focus();
    autoSize();
    syncSendButton();
  });
  document.addEventListener("click", (e) => {
    if (!$("emojiPicker").hidden && !e.target.closest("#emojiPicker, #emojiBtn")) setEmojiPicker(false);
  });

  // "Typing…" for the customer while a teammate writes (WhatsApp shows it for up to 25 seconds).
  let typingSentAt = 0;
  function pingTyping() {
    const c = state.current;
    if (!c || !isWindowOpen(c) || !composer.value.trim() || composer.value.startsWith("/")) return;
    if (Date.now() - typingSentAt < 20 * 1000) return;
    typingSentAt = Date.now();
    crmApi(`/conversations/${c.id}/typing`, { method: "POST" }).catch(() => {});
  }

  // "/" at the start of the box opens the quick replies.
  function quickMatches() {
    const match = /^\/(\S*)$/.exec(composer.value);
    if (!match) return null;
    const term = match[1].toLowerCase();
    return state.quickReplies.filter((r) => r.shortcut.startsWith(term) || r.title.toLowerCase().includes(term)).slice(0, 8);
  }
  function renderQuickMenu() {
    const matches = quickMatches();
    const menu = $("quickMenu");
    if (!matches) {
      menu.hidden = true;
      return;
    }
    state.quickIndex = Math.min(state.quickIndex, Math.max(matches.length - 1, 0));
    menu.innerHTML = matches.length
      ? matches
          .map(
            (r, i) => `
          <button class="quick-item ${i === state.quickIndex ? "active" : ""}" type="button" data-quick="${escapeHtml(r.id)}">
            <div class="shortcut">/${escapeHtml(r.shortcut)} ${r.title ? `<span class="text-muted">· ${escapeHtml(r.title)}</span>` : ""}</div>
            <div class="body">${escapeHtml(r.body)}</div>
            ${r.attachment ? `<div class="quick-file"><i class="fa-solid fa-paperclip" aria-hidden="true"></i> ${escapeHtml(r.attachment.fileName)}</div>` : ""}
          </button>`,
          )
          .join("") + `<button class="quick-item" type="button" data-quick-manage="1"><div class="shortcut">${escapeHtml(t("inbox.quick.manage"))}</div></button>`
      : `<div class="quick-empty">${escapeHtml(t("inbox.quick.none"))} <a href="#" data-quick-manage="1">${escapeHtml(t("inbox.quick.add"))}</a></div>`;
    menu.hidden = false;
  }
  // A detail of a quick reply ("{{contact.cf.zone}}") in words: "Customer: Zone".
  const objectWord = (object) => t(object === "contact" ? "wfb.cf.contact" : "wfb.cf.lead");
  function detailName(placeholder) {
    const spec = placeholder.replace(/[{}\s]/g, "");
    const [object, cf, key] = spec.split(".");
    if (cf === "cf") {
      const field = cfFields(object).find((f) => f.key === key);
      return field ? `${objectWord(object)}: ${field.label}` : spec;
    }
    return crmI18n.has(`wfb.ph.${spec}`) ? t(`wfb.ph.${spec}`) : crmI18n.has(`wfb.var.${spec}`) ? t(`wfb.var.${spec}`) : spec;
  }
  // {{contact.name}}, {{lead.title}}, {{contact.cf.<key>}} … are filled for this chat's customer by
  // the server (D99), as this member may see them; what stayed empty is named so they can look.
  async function useQuickReply(id) {
    const reply = state.quickReplies.find((r) => String(r.id) === String(id));
    if (!reply) return;
    $("quickMenu").hidden = true;
    let text = reply.body;
    if (reply.body.includes("{{") && state.current) {
      try {
        const filled = await crmApi(`/quick-replies/${encodeURIComponent(reply.id)}/fill`, jsonRequest("POST", { conversationId: state.current.id }));
        text = filled.text;
        if (filled.missing.length) showToast(t("inbox.quick.missing", { names: filled.missing.map(detailName).join(", ") }), "info");
      } catch (error) {
        showToast(apiErrorMessage(error, t("inbox.quick.fillFailed")), "error");
      }
    }
    composer.value = text;
    // D103: its file waits beside the text, which becomes the caption.
    if (reply.attachment) {
      state.file = { quickReplyId: reply.id, name: reply.attachment.fileName, size: reply.attachment.sizeBytes };
      state.voice = false;
      $("fileName").textContent = reply.attachment.fileName;
      $("fileSize").textContent = fileSize(reply.attachment.sizeBytes || 0);
      $("fileBar").hidden = false;
      composer.placeholder = t("inbox.composer.caption");
    }
    autoSize();
    syncSendButton();
    composer.focus();
  }

  composer.addEventListener("input", () => {
    autoSize();
    state.quickIndex = 0;
    renderQuickMenu();
    syncSendButton();
    pingTyping();
  });
  composer.addEventListener("keydown", (e) => {
    const menuOpen = !$("quickMenu").hidden;
    const matches = menuOpen ? quickMatches() || [] : [];
    if (menuOpen && matches.length && ["ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      state.quickIndex = (state.quickIndex + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
      renderQuickMenu();
      return;
    }
    if (menuOpen && matches.length && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      useQuickReply(matches[state.quickIndex].id);
      return;
    }
    if (e.key === "Escape") {
      $("quickMenu").hidden = true;
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  $("quickMenu").addEventListener("click", (e) => {
    const item = e.target.closest("[data-quick]");
    if (item) useQuickReply(item.dataset.quick);
    if (e.target.closest("[data-quick-manage]")) {
      e.preventDefault();
      $("quickMenu").hidden = true;
      openQuickManager();
    }
  });
  $("quickRepliesBtn").addEventListener("click", () => {
    composer.value = "/";
    composer.focus();
    renderQuickMenu();
  });
  $("composerForm").addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage();
  });
  $("messageList").addEventListener("click", async (e) => {
    const photo = e.target.closest("[data-photo]");
    if (photo) {
      const url = mediaUrls.get(photo.dataset.photo);
      if (typeof url === "string") window.open(url, "_blank", "noopener");
      return;
    }
    const play = e.target.closest("[data-play]");
    if (play) return playMedia(play);
    const download = e.target.closest("[data-download]");
    if (download) return downloadMedia(download.dataset.download);
    const react = e.target.closest("[data-react]");
    if (react) {
      state.reactingTo = state.reactingTo === react.dataset.react ? null : react.dataset.react;
      renderMessages({ stickToBottom: false });
      return undefined;
    }
    const reaction = e.target.closest("[data-reaction]");
    if (reaction && state.reactingTo && state.current) return sendReaction(state.reactingTo, reaction.dataset.reaction);
    const button = e.target.closest("[data-reply]");
    if (!button) return;
    state.replyTo = state.messages.find((m) => String(m.id) === button.dataset.reply) || null;
    if (!state.replyTo) return;
    $("replyText").textContent = state.replyTo.text || state.replyTo.type;
    $("replyBar").hidden = false;
    composer.focus();
  });
  async function sendReaction(messageId, emoji) {
    const conversation = state.current;
    state.reactingTo = null;
    renderMessages({ stickToBottom: false });
    try {
      const updated = await crmApi(`/conversations/${conversation.id}/messages/${messageId}/reaction`, jsonRequest("POST", { emoji }));
      if (state.current && String(state.current.id) === String(conversation.id)) {
        addOrReplaceMessage(updated);
        renderMessages({ stickToBottom: false });
      }
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.err.reaction")), "error");
    }
  }
  // A tap elsewhere or Escape closes the reaction bar.
  document.addEventListener("click", (e) => {
    if (state.reactingTo && !e.target.closest("[data-react], .reaction-bar")) {
      state.reactingTo = null;
      renderMessages({ stickToBottom: false });
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.reactingTo) {
      state.reactingTo = null;
      renderMessages({ stickToBottom: false });
    }
  });

  $("replyCancel").addEventListener("click", () => {
    state.replyTo = null;
    $("replyBar").hidden = true;
  });
  $("olderMessages").addEventListener("click", loadOlder);

  // --- template picker -------------------------------------------------------
  // Approved templates can be sent any time; they are the only way to write first or after
  // the 24-hour window. Variables become form fields with a live preview.
  async function loadTemplates(force = false) {
    if (state.templates && !force) return state.templates;
    state.templates = await crmApi("/templates?status=APPROVED");
    return state.templates;
  }
  const templatesForChat = () =>
    (state.templates || []).filter((t) => t.sendable && (!state.current?.account?.id || String(t.accountId) === String(state.current.account.id)));
  // "{{1}}" / "{{name}}" in escaped text, replaced by the typed value or highlighted.
  function fillPreview(text, values) {
    return escapeHtml(text).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) =>
      values[name] ? `<mark>${escapeHtml(values[name])}</mark>` : `<mark class="empty">{{${escapeHtml(name)}}}</mark>`,
    );
  }
  function renderTemplateList() {
    const q = $("templateSearch").value.trim().toLowerCase();
    const list = templatesForChat().filter((t) => !q || `${t.name} ${t.body.text}`.toLowerCase().includes(q));
    const manage = isOrgManager() ? t("inbox.tpl.manageAdmin") : escapeHtml(t("inbox.tpl.manageAsk")); // our own text with a link
    $("templateList").innerHTML = list.length
      ? list
          .map(
            (t) => `
          <button class="template-item" type="button" data-template="${escapeHtml(t.id)}">
            <div class="template-item-head"><strong>${escapeHtml(t.name)}</strong> <span class="badge badge-neutral">${escapeHtml(t.language)}</span> <span class="badge badge-info">${escapeHtml(t.category.toLowerCase())}</span></div>
            <div class="template-item-body">${escapeHtml(t.body.text)}</div>
          </button>`,
          )
          .join("")
      : `<p class="text-muted template-empty">${templatesForChat().length ? escapeHtml(t("inbox.tpl.noMatch")) : `${escapeHtml(t("inbox.tpl.none"))}${manage}`}</p>`;
  }
  function templateValues() {
    const values = { header: {}, body: {}, buttons: {} };
    document.querySelectorAll("#templateFields [data-part]").forEach((input) => {
      values[input.dataset.part][input.dataset.name] = input.value.trim();
    });
    return values;
  }
  function renderTemplatePreview() {
    const t = state.template;
    if (!t) return;
    const values = templateValues();
    $("templatePreview").innerHTML = [
      t.header?.text ? `<div class="tp-header">${fillPreview(t.header.text, values.header)}</div>` : "",
      `<div class="tp-body">${fillPreview(t.body.text, values.body)}</div>`,
      t.footer ? `<div class="tp-footer">${escapeHtml(t.footer)}</div>` : "",
      t.buttons.length ? `<div class="tp-buttons">${t.buttons.map((b) => `<span>${escapeHtml(b.text)}</span>`).join("")}</div>` : "",
    ].join("");
  }
  function pickTemplate(id) {
    const t = templatesForChat().find((item) => String(item.id) === String(id));
    if (!t) return;
    state.template = t;
    $("templatePickedName").textContent = t.name;
    $("templatePickedMeta").textContent = ` · ${t.language} · ${t.category.toLowerCase()}`;
    const contactName = state.current?.contact?.name || "";
    const field = (part, name, label, value = "") => `
      <div class="field">
        <label for="tv-${part}-${escapeHtml(name)}">${escapeHtml(label)}</label>
        <input type="text" id="tv-${part}-${escapeHtml(name)}" data-part="${part}" data-name="${escapeHtml(name)}" maxlength="${part === "header" ? 60 : 1024}" value="${escapeHtml(value)}" required />
      </div>`;
    // Named variables that ask for a name start with the customer's name.
    const guess = (name) => (/name/i.test(name) && !/^\d+$/.test(name) ? contactName : "");
    $("templateFields").innerHTML =
      (t.header?.variables || []).map((name) => field("header", name, crmI18n.t("inbox.tpl.header", { name }), guess(name))).join("") +
      t.body.variables.map((name) => field("body", name, `{{${name}}}`, guess(name))).join("") +
      t.buttons.filter((b) => b.variables.length).map((b) => field("buttons", String(b.index), crmI18n.t("inbox.tpl.buttonLink", { text: b.text, url: b.url }))).join("") ||
      `<p class="text-muted template-empty">${escapeHtml(crmI18n.t("inbox.tpl.noVariables"))}</p>`;
    $("templateChooser").hidden = true;
    $("templateForm").hidden = false;
    renderTemplatePreview();
    $("templateFields").querySelector("input")?.focus();
  }
  async function openTemplatePicker() {
    if (!state.current) return;
    state.template = null;
    $("templateChooser").hidden = false;
    $("templateForm").hidden = true;
    $("templateSearch").value = "";
    $("templateList").innerHTML = `<p class="text-muted template-empty">${escapeHtml(t("inbox.tpl.loading"))}</p>`;
    $("templateModal").classList.add("open");
    try {
      await loadTemplates(true);
      renderTemplateList();
      $("templateSearch").focus();
    } catch (error) {
      $("templateList").innerHTML = `<p class="text-muted template-empty">${escapeHtml(apiErrorMessage(error, t("inbox.tpl.loadFailed")))}</p>`;
    }
  }
  const closeTemplatePicker = () => $("templateModal").classList.remove("open");
  $("templateBtn").addEventListener("click", openTemplatePicker);
  $("closedTemplateBtn").addEventListener("click", openTemplatePicker);
  $("templateModalClose").addEventListener("click", closeTemplatePicker);
  $("templateModal").addEventListener("click", (e) => {
    if (e.target.id === "templateModal") closeTemplatePicker();
  });
  $("templateSearch").addEventListener("input", renderTemplateList);
  $("templateList").addEventListener("click", (e) => {
    const item = e.target.closest("[data-template]");
    if (item) pickTemplate(item.dataset.template);
  });
  $("templateChange").addEventListener("click", () => {
    state.template = null;
    $("templateForm").hidden = true;
    $("templateChooser").hidden = false;
  });
  $("templateFields").addEventListener("input", renderTemplatePreview);
  $("templateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const conversation = state.current;
    if (!state.template || !conversation) return;
    const button = $("templateSend");
    button.disabled = true;
    try {
      const message = await crmApi(`/conversations/${conversation.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() },
        body: JSON.stringify({ type: "template", templateId: state.template.id, variables: templateValues() }),
      });
      closeTemplatePicker();
      if (state.current && String(state.current.id) === String(conversation.id)) {
        addOrReplaceMessage(message);
        renderMessages();
      }
      if (message.status === "failed") showToast(t("inbox.notSent", { reason: message.error?.message || t("inbox.unknownReason") }), "error");
      else showToast(t("inbox.tpl.sent"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.tpl.sendFailed")), "error");
    } finally {
      button.disabled = false;
    }
  });

  // --- products from the WhatsApp catalog (Phase 8C) ------------------------------------------
  // Synced products of the chat's number; one goes as a product message, several as a list.
  const pickedProducts = new Set();
  function productNameOf(retailerId) {
    return (state.catalogProducts || []).find((p) => p.retailerId === retailerId)?.name || retailerId;
  }
  function renderProductPicker() {
    const q = $("productsSearch").value.trim().toLowerCase();
    const list = (state.catalogProducts || []).filter((p) => !q || `${p.name} ${p.category}`.toLowerCase().includes(q));
    $("productsList").innerHTML = list.length
      ? list
          .map(
            (p) => `
          <label class="template-item product-pick">
            <input type="checkbox" data-product="${escapeHtml(p.id)}" ${pickedProducts.has(String(p.id)) ? "checked" : ""} />
            <span><strong>${escapeHtml(p.name)}</strong>${p.category ? ` <span class="badge badge-neutral">${escapeHtml(p.category)}</span>` : ""}
              <span class="template-item-body">${escapeHtml(t("inbox.prod.price", { price: `₹${(p.priceWithGstPaise / 100).toLocaleString(crmI18n.locale(), { minimumFractionDigits: 2 })}` }))}${p.unit ? escapeHtml(t("inbox.prod.perUnit", { unit: p.unit })) : ""}</span></span>
          </label>`,
          )
          .join("")
      : `<p class="text-muted template-empty">${escapeHtml(t("inbox.prod.noMatch"))}</p>`;
    renderProductPickerFoot();
  }
  // The heading (for a list) and the Send button follow the ticks (the list is not redrawn).
  function renderProductPickerFoot() {
    const count = pickedProducts.size;
    $("productsHeaderField").hidden = count < 2;
    $("productsSend").disabled = !count || count > 30;
    $("productsSend").innerHTML = `<i class="fa-solid fa-paper-plane"></i> ${escapeHtml(count > 30 ? t("inbox.prod.atMost") : count ? t(count === 1 ? "inbox.prod.sendOne" : "inbox.prod.sendMany", { n: count }) : t("inbox.send"))}`;
  }
  async function openProductPicker() {
    if (!state.current) return;
    pickedProducts.clear();
    $("productsSearch").value = "";
    $("productsText").value = "";
    $("productsHeader").value = "Our products";
    $("productsHeaderField").hidden = true;
    $("productsSend").disabled = true;
    $("productsList").innerHTML = `<p class="text-muted template-empty">${escapeHtml(t("inbox.prod.loading"))}</p>`;
    $("productsModal").classList.add("open");
    try {
      const data = await crmApi(`/conversations/${state.current.id}/catalog`);
      state.catalogProducts = data.products;
      if (data.blocked || !data.products.length) {
        const empty = isOrgManager()
          ? t("inbox.prod.emptyAdmin") // our own text with a link
          : escapeHtml(t("inbox.prod.emptyAsk"));
        $("productsList").innerHTML = `<p class="text-muted template-empty">${data.blocked ? escapeHtml(data.blocked) : empty}</p>`;
        return;
      }
      renderProductPicker();
      $("productsSearch").focus();
    } catch (error) {
      $("productsList").innerHTML = `<p class="text-muted template-empty">${escapeHtml(apiErrorMessage(error, t("inbox.prod.loadFailed")))}</p>`;
    }
  }
  const closeProductPicker = () => $("productsModal").classList.remove("open");
  $("productsBtn").addEventListener("click", openProductPicker);
  $("productsModalClose").addEventListener("click", closeProductPicker);
  $("productsModal").addEventListener("click", (e) => {
    if (e.target.id === "productsModal") closeProductPicker();
  });
  $("productsSearch").addEventListener("input", renderProductPicker);
  $("productsList").addEventListener("change", (e) => {
    const box = e.target.closest("[data-product]");
    if (!box) return;
    if (box.checked) pickedProducts.add(box.dataset.product);
    else pickedProducts.delete(box.dataset.product);
    renderProductPickerFoot();
  });
  $("productsSend").addEventListener("click", async () => {
    const conversation = state.current;
    if (!conversation || !pickedProducts.size) return;
    const button = $("productsSend");
    button.disabled = true;
    try {
      const message = await crmApi(`/conversations/${conversation.id}/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() },
        body: JSON.stringify({ productIds: [...pickedProducts], header: $("productsHeader").value.trim(), body: $("productsText").value.trim() }),
      });
      closeProductPicker();
      if (state.current && String(state.current.id) === String(conversation.id)) {
        addOrReplaceMessage(message);
        renderMessages();
      }
      showToast(message.status === "failed" ? t("inbox.notSent", { reason: message.error?.message || t("inbox.unknownReason") }) : t("inbox.prod.sent"), message.status === "failed" ? "error" : "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.prod.sendFailed")), "error");
    } finally {
      button.disabled = false;
    }
  });

  // --- WhatsApp forms (D110): a published form into the chat, inside the 24-hour window -----
  let pickedForm = null;
  async function openFormPicker() {
    if (!state.current) return;
    pickedForm = null;
    $("formsSend").disabled = true;
    $("formsList").innerHTML = `<p class="text-muted template-empty">${escapeHtml(t("inbox.form.loading"))}</p>`;
    $("formsModal").classList.add("open");
    try {
      const { items } = await crmApi("/whatsapp-forms");
      const sendable = items.filter((f) => f.sendable);
      $("formsList").innerHTML = sendable.length
        ? sendable.map((f) => `
          <label class="template-item product-pick">
            <input type="radio" name="formPick" data-form="${escapeHtml(f.id)}" />
            <span><strong>${escapeHtml(f.name)}</strong> <span class="badge badge-neutral">${escapeHtml(t(`wf.kind.${f.kind}`))}</span>
              <span class="template-item-body">${escapeHtml(f.intro || "")}</span></span>
          </label>`).join("")
        : `<p class="text-muted template-empty">${escapeHtml(t(isOrgManager() ? "inbox.form.noneManager" : "inbox.form.none"))}</p>`;
    } catch (error) {
      $("formsList").innerHTML = `<p class="text-muted template-empty">${escapeHtml(apiErrorMessage(error, t("inbox.form.loadFailed")))}</p>`;
    }
  }
  const closeFormPicker = () => $("formsModal").classList.remove("open");
  $("formBtn").addEventListener("click", openFormPicker);
  $("formsModalClose").addEventListener("click", closeFormPicker);
  $("formsModal").addEventListener("click", (e) => {
    if (e.target.id === "formsModal") closeFormPicker();
  });
  $("formsList").addEventListener("change", (e) => {
    const radio = e.target.closest("[data-form]");
    if (!radio) return;
    pickedForm = radio.dataset.form;
    $("formsSend").disabled = false;
  });
  $("formsSend").addEventListener("click", async () => {
    const conversation = state.current;
    if (!conversation || !pickedForm) return;
    const button = $("formsSend");
    button.disabled = true;
    try {
      const message = await crmApi(`/conversations/${conversation.id}/form`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() },
        body: JSON.stringify({ formId: pickedForm }),
      });
      closeFormPicker();
      if (state.current && String(state.current.id) === String(conversation.id)) {
        addOrReplaceMessage(message);
        renderMessages();
      }
      showToast(message.status === "failed" ? t("inbox.notSent", { reason: message.error?.message || t("inbox.unknownReason") }) : t("inbox.form.sent"), message.status === "failed" ? "error" : "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.form.sendFailed")), "error");
    } finally {
      button.disabled = false;
    }
  });

  // --- details panel ------------------------------------------------------
  function inboxMembers() {
    return cached("members").filter((m) => m.status === "active" && (["owner", "admin"].includes(m.role) || (m.modules || []).includes("inbox")));
  }
  function renderDetails() {
    const c = state.current;
    if (!c) return;
    $("detailsAvatar").textContent = initialsOf(c.contact.name);
    $("detailsName").textContent = c.contact.name || c.contact.phone;
    $("detailsPhone").textContent = c.contact.phone;
    $("detailsCompany").textContent = c.contact.company || "";
    // Where the latest enquiry came from (D102): a Click-to-WhatsApp ad, or the website's button.
    const came = c.cameFrom;
    $("detailsCame").hidden = !came;
    if (came) {
      const ad = came.kind === "ad";
      const link = ad ? came.sourceUrl : came.page;
      const label = ad ? t("inbox.came.ad", { headline: came.headline || t("inbox.came.adNoName") }) : t("inbox.came.site");
      $("detailsCame").innerHTML = `<i class="fa-solid ${ad ? "fa-bullhorn" : "fa-globe"}" aria-hidden="true"></i><span>${escapeHtml(label)}${/^https?:\/\//i.test(link || "") ? ` · <a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(ad ? "inbox.came.openAd" : "inbox.came.openPage"))}</a>` : ""}</span>`;
    }
    $("details360").href = `customer-360.html?id=${encodeURIComponent(c.contact.id)}`;
    const select = $("detailsAssignee");
    select.innerHTML =
      `<option value="">${escapeHtml(t("inbox.details.nobody"))}</option>` +
      inboxMembers()
        .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.email)}${String(m.id) === String(me.id) ? escapeHtml(t("inbox.details.me")) : ""}</option>`)
        .join("");
    select.value = c.assigneeId ? String(c.assigneeId) : "";
    document.querySelectorAll("#detailsStatus button").forEach((button) => button.classList.toggle("active", button.dataset.status === c.status));
    if (document.activeElement !== $("detailsTags")) $("detailsTags").value = (c.tags || []).join(", ");
    // Pin (this member only) and archive (everyone), CP3.
    $("detailsPin").querySelector("span").textContent = t(c.pinned ? "inbox.details.unpin" : "inbox.details.pin");
    $("detailsPin").setAttribute("aria-pressed", String(Boolean(c.pinned)));
    $("detailsArchive").querySelector("span").textContent = t(c.archived ? "inbox.details.unarchive" : "inbox.details.archive");
    // D103: block or unblock the customer (who did it, and whether WhatsApp took it, below).
    const blockButton = $("detailsBlock");
    blockButton.hidden = !memberCan("inbox", "edit");
    blockButton.className = `btn ${c.blocked ? "btn-outline" : "btn-danger-outline"}`;
    blockButton.querySelector("span").textContent = t(c.blocked ? "inbox.block.unblock" : "inbox.block.button");
    if (!c.blocked) $("detailsBlockInfo").hidden = true;
  }
  // D103: the 24-hour window is open and the customer is not blocked.
  function canWrite(c) {
    return isWindowOpen(c) && !c?.blocked;
  }
  async function loadBlockInfo() {
    const c = state.current;
    if (!c?.blocked) return;
    try {
      const { blocked } = await crmApi(`/conversations/${c.id}/block`);
      if (!blocked || String(state.current?.id) !== String(c.id)) return;
      const lines = [
        t("inbox.block.by", { name: blocked.byName || t("inbox.block.someone"), date: new Date(blocked.at).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short", year: "numeric" }) }),
        blocked.reason,
        blocked.onWhatsApp ? t("inbox.block.onWhatsApp") : t("inbox.block.notOnWhatsApp", { reason: blocked.whatsappNote || "—" }),
      ].filter(Boolean);
      $("detailsBlockInfo").textContent = lines.join(" · ");
      $("detailsBlockInfo").hidden = false;
    } catch {
      /* the button still works */
    }
  }
  $("detailsBlock").addEventListener("click", async () => {
    const c = state.current;
    if (!c) return;
    try {
      let result;
      if (c.blocked) {
        if (!window.confirm(t("inbox.block.confirmUnblock", { name: c.contact.name || c.contact.phone }))) return;
        result = await crmApi(`/conversations/${c.id}/block`, { method: "DELETE" });
        showToast(t("inbox.block.undone"), "success");
      } else {
        const reason = window.prompt(t("inbox.block.confirm", { name: c.contact.name || c.contact.phone }), "");
        if (reason === null) return;
        result = await crmApi(`/conversations/${c.id}/block`, jsonRequest("POST", { reason: reason.trim() }));
        showToast(result.blocked?.onWhatsApp ? t("inbox.block.done") : t("inbox.block.doneHere", { reason: result.blocked?.whatsappNote || "—" }), "success");
      }
      state.current = { ...result.conversation, pinned: c.pinned };
      upsertConversation(state.current);
      renderThreadHead();
      renderDetails();
      loadBlockInfo();
      scheduleSummary();
      loadScheduled();
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.block.failed")), "error");
    }
  });
  $("detailsPin").addEventListener("click", () => {
    if (state.current) patchConversation({ pinned: !state.current.pinned }, t(state.current.pinned ? "inbox.details.unpinned" : "inbox.details.pinned"));
  });
  $("detailsArchive").addEventListener("click", () => {
    if (state.current) patchConversation({ archived: !state.current.archived }, t(state.current.archived ? "inbox.details.unarchived" : "inbox.details.archived"));
  });
  function renderNotes() {
    $("notesList").innerHTML = state.notes.length
      ? state.notes
          .map((n) => `<div class="note">${escapeHtml(n.text)}<div class="meta">${escapeHtml(n.authorName || "")} · ${escapeHtml(shortTime(n.createdAt))}</div></div>`)
          .join("")
      : `<p class="text-muted" style="font-size:12.5px;margin:0">${escapeHtml(t("inbox.details.noNotes"))}</p>`;
  }

  // --- sales context: the customer's leads, quotations and open follow-ups ------------
  // Each part shows only when the member may open that page (the API answers 403 otherwise)
  // and lists only the records they may see.
  const LEAD_STAGES = ["New", "Contacted", "Quote Sent", "Negotiation", "Won", "Lost"];
  const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString(crmI18n.locale(), { maximumFractionDigits: 2 })}`;
  function memberCan(module, action) {
    if (["owner", "admin"].includes(me.role)) return true;
    if (!(me.modules || []).includes(module)) return false;
    if (action === "view") return true;
    if (me.role === "viewer") return false;
    if (action === "delete") return (me.permissions || []).includes(`${module}:delete`);
    return true;
  }
  async function loadContext() {
    const c = state.current;
    if (!c) return;
    // Taking a chat can make you the owner of the customer's lead (D25): reload when that changes.
    state.contextAssignee = String(c.assigneeId || "");
    const id = encodeURIComponent(c.contact.id);
    const [leads, quotes, orders, tasks, customer] = await Promise.all([
      crmApi(`/leads?contactId=${id}&limit=5`).catch(() => null),
      crmApi(`/quotations?contactId=${id}&limit=3`).catch(() => null),
      crmApi(`/orders?contactId=${id}&limit=3`).catch(() => null),
      crmApi(`/tasks?relatedType=Customer&relatedId=${id}&limit=50`).catch(() => null),
      // The customer's own fields (D99) need the Customers page.
      memberCan("customers", "view") ? crmApi(`/contacts/${id}`).catch(() => null) : null,
    ]);
    if (!state.current || String(state.current.id) !== String(c.id)) return;
    state.context = { leads, quotes, orders, tasks, customer };
    renderContext();
  }

  // The company's own fields (D73, D99) as this member may see them (the server leaves out the
  // hidden ones): the customer's under "Customer details", each lead's under the lead.
  function fieldRow({ label, text, heading }, i, rows) {
    const title = heading && heading !== rows[i - 1]?.heading ? `<div class="details-fields-heading">${escapeHtml(heading)}</div>` : "";
    return `${title}<div class="details-field"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(text)}</span></div>`;
  }
  async function renderFields() {
    const id = String(state.current?.id || "");
    const { leads, customer } = state.context || {};
    const stillHere = () => String(state.current?.id || "") === id;
    const filled = customer ? await cfFilledValues("contact", customer.customFields, customer.customFieldLinks) : [];
    if (!stillHere()) return;
    $("detailsFieldsSection").hidden = !filled.length;
    $("detailsFields").innerHTML = filled.map(fieldRow).join("");
    for (const lead of Array.isArray(leads) ? leads : []) {
      const rows = await cfFilledValues("lead", lead.customFields, lead.customFieldLinks);
      const box = stillHere() && $("detailsLeads").querySelector(`[data-lead-fields="${CSS.escape(String(lead.id))}"]`);
      if (!box) continue;
      box.hidden = !rows.length;
      box.innerHTML = rows.map(({ label, text }) => `<span><span class="k">${escapeHtml(label)}:</span> ${escapeHtml(text)}</span>`).join("");
    }
  }
  function renderContext() {
    const { leads, quotes, orders, tasks } = state.context || {};
    $("detailsSales").hidden = !Array.isArray(leads) && !Array.isArray(quotes);
    const canMove = memberCan("leads", "edit") || memberCan("deals", "edit");
    $("detailsLeads").innerHTML = Array.isArray(leads)
      ? leads.length
        ? leads
            .map((l) => {
              const title = l.title || t(["WhatsApp", "WhatsApp Ad", "Website widget"].includes(l.source) ? "inbox.ctx.waEnquiry" : "inbox.ctx.enquiry");
              const stage = canMove
                ? `<select data-lead-stage="${escapeHtml(l.id)}" aria-label="${escapeHtml(t("inbox.ctx.stageOf", { title }))}">${LEAD_STAGES.map((s) => `<option value="${s}"${s === l.stage ? " selected" : ""}>${escapeHtml(crmLabel("stage", s))}</option>`).join("")}</select>`
                : `<span class="badge badge-info">${escapeHtml(crmLabel("stage", l.stage))}</span>`;
              return `
            <div class="ctx-item">
              <div class="ctx-main">
                <div class="ctx-title">${escapeHtml(title)}${l.expectedValuePaise ? ` · ${rupees(l.expectedValuePaise)}` : ""}</div>
                <div class="ctx-meta">${escapeHtml(l.ownerId ? t("inbox.ctx.owner", { name: memberNameOf(l.ownerId) }) : t("inbox.ctx.noOwner"))}${l.score ? ` ${crmLeadScore.badge(l.score)}` : ""}</div>
                <div class="ctx-fields" data-lead-fields="${escapeHtml(l.id)}" hidden></div>
              </div>
              ${stage}
            </div>`;
            })
            .join("")
        : `<p class="ctx-empty">${escapeHtml(t(seesAll ? "inbox.ctx.noLead" : "inbox.ctx.noLeadVisible"))}</p>`
      : "";
    $("detailsOrders").innerHTML = Array.isArray(orders)
      ? orders
          .map(
            (o) => `
          <a class="ctx-item ctx-link" href="Orders.html?id=${encodeURIComponent(o.id)}">
            <div class="ctx-main"><div class="ctx-title">${escapeHtml(t("inbox.ctx.order", { number: o.number }))}</div><div class="ctx-meta">${escapeHtml([o.dispatch?.transporter, o.dispatch?.lrNumber].filter(Boolean).join(" · ") || shortTime(o.orderDate || o.createdAt))}</div></div>
            <span class="ctx-amount">${rupees(o.totals?.grandTotalPaise)}</span> ${o.stage !== "Cancelled" && o.duePaise > 0 && o.amountPaidPaise > 0 ? `<span class="badge badge-warning">${escapeHtml(t("inbox.ctx.due", { amount: rupees(o.duePaise) }))}</span>` : o.paymentStatus === "paid" && o.stage !== "Payment Collected" ? `<span class="badge badge-success">${escapeHtml(t("inbox.ctx.paid"))}</span>` : `<span class="badge badge-neutral">${escapeHtml(crmLabel("orderStage", o.stage))}</span>`}
          </a>`,
          )
          .join("")
      : "";
    // Phase 8: a payment link for the newest order with money due, else the newest sent
    // quotation without an order, else an amount for this customer.
    const canPay = memberCan("leads", "edit") || memberCan("deals", "edit");
    if (canPay && typeof crmPaymentLinks !== "undefined" && state.current?.contact?.id) {
      const dueOrder = (orders || []).find((o) => o.stage !== "Cancelled" && o.duePaise > 0);
      const openQuote = !dueOrder && (quotes || []).find((q) => !q.orderId && ["Sent", "Viewed", "Accepted"].includes(q.status));
      const subject = dueOrder ? `data-pay-order="${escapeHtml(dueOrder.id)}"` : openQuote ? `data-pay-quote="${escapeHtml(openQuote.id)}"` : `data-pay-contact="${escapeHtml(state.current.contact.id)}"`;
      const label = escapeHtml(dueOrder ? t("inbox.ctx.payOrder", { number: dueOrder.number }) : openQuote ? t("inbox.ctx.payQuote", { number: openQuote.number }) : t("inbox.ctx.payAmount"));
      $("detailsOrders").innerHTML += `<button class="btn btn-outline ctx-new-quote" type="button" ${subject}><i class="fa-solid fa-indian-rupee-sign"></i> ${label}</button>`;
    }
    const canQuote = memberCan("leads", "create") || memberCan("deals", "create");
    $("detailsQuotes").innerHTML = Array.isArray(quotes)
      ? quotes
          .map(
            (q) => `
          <a class="ctx-item ctx-link" href="Quotations.html?id=${encodeURIComponent(q.id)}">
            <div class="ctx-main"><div class="ctx-title">${escapeHtml(crmLabel("quoteType", q.type || "Quotation"))} ${escapeHtml(q.number || q.legacyNumber || "")}</div><div class="ctx-meta">${escapeHtml(shortTime(q.quotationDate || q.createdAt))}</div></div>
            <span class="ctx-amount">${rupees(q.totals?.grandTotalPaise)}</span> <span class="badge badge-neutral">${escapeHtml(crmLabel("quoteStatus", q.status))}</span>
          </a>`,
          )
          .join("") +
        (canQuote ? `<a class="btn btn-outline ctx-new-quote" href="Quotations.html?new=1&conversationId=${encodeURIComponent(state.current?.id || "")}"><i class="fa-solid fa-file-invoice"></i> ${escapeHtml(t("inbox.ctx.newQuote"))}</a>` : "")
      : "";

    $("detailsTasksSection").hidden = !Array.isArray(tasks);
    $("followUpForm").hidden = !memberCan("tasks", "create");
    const open = (tasks || []).filter((t) => t.status !== "Done").slice(0, 5);
    const canFinish = memberCan("tasks", "edit");
    $("detailsTasks").innerHTML = open.length
      ? open
          .map(
            (t) => `
          <div class="ctx-item">
            ${canFinish ? `<button class="icon-btn" type="button" data-task-done="${escapeHtml(t.id)}" title="${escapeHtml(crmI18n.t("inbox.ctx.markDone"))}"><i class="fa-regular fa-square"></i></button>` : ""}
            <div class="ctx-main"><div class="ctx-title">${escapeHtml(t.title)}</div><div class="ctx-meta">${escapeHtml(t.dueDate ? crmI18n.t("inbox.ctx.dueOn", { date: new Date(`${t.dueDate}T00:00:00`).toLocaleDateString(crmI18n.locale(), { day: "numeric", month: "short" }) }) : crmI18n.t("inbox.ctx.noDueDate"))}${t.assigneeId ? ` · ${escapeHtml(memberNameOf(t.assigneeId))}` : ""}</div></div>
          </div>`,
          )
          .join("")
      : `<p class="ctx-empty">${escapeHtml(t("inbox.ctx.noFollowUp"))}</p>`;
    renderFields();
  }
  $("detailsOrders").addEventListener("click", (e) => {
    const button = e.target.closest("[data-pay-order], [data-pay-quote], [data-pay-contact]");
    if (!button) return;
    crmPaymentLinks.open({
      orderId: button.dataset.payOrder, quotationId: button.dataset.payQuote, contactId: button.dataset.payContact,
      onChange: () => loadContext(),
    });
  });
  $("detailsLeads").addEventListener("change", async (e) => {
    const select = e.target.closest("[data-lead-stage]");
    if (!select) return;
    const lead = state.context.leads.find((l) => String(l.id) === select.dataset.leadStage);
    let lostReason = "";
    if (select.value === "Lost") {
      lostReason = (window.prompt(t("inbox.ctx.lostWhy")) || "").trim();
      if (!lostReason) {
        select.value = lead.stage;
        return;
      }
    }
    try {
      const updated = await crmApi(`/leads/${lead.id}/stage`, jsonRequest("POST", { stage: select.value, version: lead.version, ...(lostReason && { lostReason }) }));
      Object.assign(lead, updated);
      showToast(t("inbox.ctx.stageChanged", { stage: crmLabel("stage", updated.stage) }), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.ctx.stageFailed")), "error");
    }
    renderContext();
  });
  $("detailsTasks").addEventListener("click", async (e) => {
    const done = e.target.closest("[data-task-done]");
    if (!done) return;
    done.disabled = true;
    try {
      await crmApi(`/tasks/${done.dataset.taskDone}`, jsonRequest("PATCH", { status: "Done" }));
      state.context.tasks = state.context.tasks.map((t) => (String(t.id) === done.dataset.taskDone ? { ...t, status: "Done" } : t));
      renderContext();
      showToast(t("inbox.ctx.followUpDone"), "success");
    } catch (error) {
      done.disabled = false;
      showToast(apiErrorMessage(error, t("inbox.ctx.taskFailed")), "error");
    }
  });
  $("followUpForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = state.current;
    const title = $("followUpTitle").value.trim();
    if (!c || !title) return;
    const dueDate = $("followUpDate").value;
    try {
      const task = await crmApi("/tasks", jsonRequest("POST", {
        title, relatedType: "Customer", relatedId: c.contact.id, relatedName: c.contact.name || c.contact.phone, assigneeId: me.id, ...(dueDate && { dueDate }),
      }));
      state.context.tasks = [task, ...(state.context.tasks || [])];
      e.target.reset();
      renderContext();
      showToast(t("inbox.ctx.followUpAdded"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.ctx.followUpFailed")), "error");
    }
  });

  async function patchConversation(body, success) {
    if (!state.current) return;
    try {
      const updated = await crmApi(`/conversations/${state.current.id}`, jsonRequest("PATCH", body));
      if (!visibleToMe(updated)) {
        closeThread(t("inbox.assignedToDot", { name: memberNameOf(updated.assigneeId) }));
        upsertConversation(updated);
      } else {
        state.current = updated;
        upsertConversation(updated);
        renderThreadHead();
        renderDetails();
        if (state.contextAssignee !== String(updated.assigneeId || "")) loadContext();
        if (success) showToast(success, "success");
      }
      scheduleSummary();
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.err.update")), "error");
      renderDetails();
    }
  }
  $("detailsAssignee").addEventListener("change", (e) => {
    const assigneeId = e.target.value || null;
    patchConversation({ assigneeId }, assigneeId ? t("inbox.assignedToDot", { name: memberNameOf(assigneeId) }) : t("inbox.movedToQueue"));
  });
  $("detailsStatus").addEventListener("click", (e) => {
    const button = e.target.closest("[data-status]");
    if (button && state.current && button.dataset.status !== state.current.status) patchConversation({ status: button.dataset.status });
  });
  function saveTags() {
    if (!state.current) return;
    const tags = $("detailsTags").value.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (tags.join(",") !== (state.current.tags || []).join(",")) patchConversation({ tags });
  }
  $("detailsTags").addEventListener("change", saveTags);
  $("detailsTags").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.blur();
    }
  });
  $("noteForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("noteText").value.trim();
    if (!text || !state.current) return;
    try {
      const note = await crmApi(`/conversations/${state.current.id}/notes`, jsonRequest("POST", { text }));
      if (!state.notes.some((n) => String(n.id) === String(note.id))) state.notes.unshift(note);
      $("noteText").value = "";
      renderNotes();
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.err.note")), "error");
    }
  });
  // Closing (not just hiding) the chat, so new messages in it stay unread while the list is showing.
  $("threadBack").addEventListener("click", () => closeThread());

  // Private numbers (D61): the popup explains it first; owners only (the server checks too).
  $("threadPrivate").addEventListener("click", async () => {
    const c = state.current;
    if (!c || !isOrgOwner()) return;
    const choice = await crmPrivacyDialog.open({ mode: c.private ? "show" : "hide", name: c.contact.name, phone: c.contact.phone });
    if (!choice) return;
    try {
      if (c.private) {
        const entry = (await crmApi("/privacy/numbers")).find((item) => item.phone === c.contact.phone);
        if (entry) await crmApi(`/privacy/numbers/${entry.id}`, { method: "DELETE" });
        showToast(t("inbox.private.shown"), "success");
      } else {
        await crmApi(`/conversations/${c.id}/private`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: choice.note }) });
        showToast(t("inbox.private.hidden"), "success");
      }
      state.current = await crmApi(`/conversations/${c.id}`);
      renderThreadHead();
      loadConversations();
    } catch (error) {
      showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
    }
  });
  // The contact details: a column on wide screens, a sheet over the chat up to 1200px. The closed
  // sheet is inert (no focus, no screen reader); Escape and the phone's back button close it.
  const detailsAsSheet = window.matchMedia("(max-width: 1200px)");
  let detailsInHistory = false;
  function syncDetailsSheet() {
    const panel = document.querySelector(".inbox-details");
    if (panel) panel.inert = detailsAsSheet.matches && $("inbox").dataset.details !== "open";
  }
  function openDetails() {
    $("inbox").dataset.details = "open";
    if (detailsAsSheet.matches && !detailsInHistory) {
      history.pushState({ inboxDetails: true }, "");
      detailsInHistory = true;
    }
    syncDetailsSheet();
    if (detailsAsSheet.matches) $("detailsClose").focus();
  }
  function closeDetails() {
    if (detailsInHistory) {
      history.back(); // popstate closes it, so Back and the × do the same
      return;
    }
    delete $("inbox").dataset.details;
    syncDetailsSheet();
  }
  window.addEventListener("popstate", () => {
    if (!detailsInHistory) return;
    detailsInHistory = false;
    delete $("inbox").dataset.details;
    syncDetailsSheet();
    $("threadInfo").focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || $("inbox").dataset.details !== "open" || !detailsAsSheet.matches) return;
    if (document.querySelector(".modal-overlay.open")) return; // the popup on top closes first
    closeDetails();
  });
  detailsAsSheet.addEventListener("change", syncDetailsSheet);
  syncDetailsSheet();
  $("threadInfo").addEventListener("click", openDetails);
  $("detailsClose").addEventListener("click", closeDetails);

  // --- list controls --------------------------------------------------------
  $("conversationList").addEventListener("click", (e) => {
    const item = e.target.closest(".conv-item");
    if (item) openConversation(item.dataset.id);
  });
  document.querySelectorAll(".inbox-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".inbox-tab").forEach((t) => t.classList.toggle("active", t === tab));
      state.view = tab.dataset.view;
      loadConversations();
    }),
  );
  $("inboxStatus").addEventListener("change", (e) => {
    state.status = e.target.value;
    loadConversations();
  });
  $("inboxChannel").addEventListener("change", (e) => {
    state.channel = e.target.value; // G8 (D112)
    loadConversations();
  });
  let searchTimer = null;
  $("inboxSearch").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      loadConversations();
    }, 300);
  });
  $("conversationMore").addEventListener("click", () => {
    state.page += 1;
    loadConversations({ append: true });
  });

  // --- send later (D103): the text goes at the chosen time, if the 24-hour window is open then ---
  const whenText = (iso) => new Date(iso).toLocaleString(crmI18n.locale(), { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const localInput = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  function laterPicks() {
    const now = new Date();
    const inHour = new Date(now.getTime() + 60 * 60000);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    const monday = new Date(now);
    monday.setDate(now.getDate() + (((8 - now.getDay()) % 7) || 7));
    monday.setHours(10, 0, 0, 0);
    return [["inbox.later.in1h", inHour], ["inbox.later.tomorrow", tomorrow], ["inbox.later.monday", monday]];
  }
  async function loadScheduled() {
    const c = state.current;
    if (!c) return;
    try {
      const items = await crmApi(`/conversations/${c.id}/scheduled`);
      if (String(state.current?.id) !== String(c.id)) return;
      state.scheduled = items;
    } catch {
      state.scheduled = [];
    }
    renderScheduled();
  }
  function renderScheduled() {
    const bar = $("scheduledBar");
    bar.hidden = !state.scheduled.length;
    bar.innerHTML = state.scheduled.map((s) => `
      <div class="scheduled-item">
        <i class="fa-regular fa-clock" aria-hidden="true"></i>
        <span class="when">${escapeHtml(whenText(s.sendAt))}</span>
        <span class="text">${escapeHtml(s.text)}</span>
        <button class="icon-btn" type="button" data-later-edit="${escapeHtml(s.id)}" title="${escapeHtml(t("common.edit"))}" aria-label="${escapeHtml(t("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
        <button class="icon-btn danger" type="button" data-later-cancel="${escapeHtml(s.id)}" title="${escapeHtml(t("inbox.later.cancelOne"))}" aria-label="${escapeHtml(t("inbox.later.cancelOne"))}"><i class="fa-solid fa-xmark"></i></button>
      </div>`).join("");
  }
  function laterWarn() {
    const at = new Date($("laterWhen").value);
    const expires = state.current?.window?.expiresAt ? new Date(state.current.window.expiresAt) : null;
    const closing = !Number.isNaN(at.getTime()) && (!expires || at > expires);
    $("laterWarn").hidden = !closing;
    if (closing) $("laterWarn").textContent = t("inbox.later.windowWarn", { time: expires ? whenText(expires) : "—" });
  }
  function openLater(item = null) {
    const text = item ? item.text : composer.value.trim();
    if (!text) return showToast(t("inbox.later.writeFirst"), "error");
    if (!item && state.file) return showToast(t("inbox.later.noFiles"), "error");
    state.later = item ? item.id : null;
    $("laterTitle").textContent = t(item ? "inbox.later.editTitle" : "inbox.later.title");
    $("laterText").value = text;
    $("laterWhen").min = localInput(new Date(Date.now() + 60000));
    $("laterWhen").value = localInput(item ? new Date(item.sendAt) : laterPicks()[1][1]);
    $("laterPicks").innerHTML = laterPicks().map(([key], i) => `<button class="btn btn-outline" type="button" data-later-pick="${i}">${escapeHtml(t(key))}</button>`).join("");
    $("laterSave").textContent = t(item ? "common.save" : "inbox.later.schedule");
    laterWarn();
    $("laterModal").classList.add("open");
    $("laterWhen").focus();
    return undefined;
  }
  const closeLater = () => $("laterModal").classList.remove("open");
  $("laterBtn").addEventListener("click", () => openLater());
  $("laterClose").addEventListener("click", closeLater);
  $("laterCancel").addEventListener("click", closeLater);
  $("laterWhen").addEventListener("input", laterWarn);
  $("laterPicks").addEventListener("click", (e) => {
    const pick = e.target.closest("[data-later-pick]");
    if (!pick) return;
    $("laterWhen").value = localInput(laterPicks()[Number(pick.dataset.laterPick)][1]);
    laterWarn();
  });
  $("laterSave").addEventListener("click", async () => {
    const c = state.current;
    const text = $("laterText").value.trim();
    const at = new Date($("laterWhen").value);
    if (!c || !text) return showToast(t("inbox.later.writeFirst"), "error");
    if (Number.isNaN(at.getTime())) return showToast(t("inbox.later.pickTime"), "error");
    $("laterSave").disabled = true;
    try {
      const body = { text, sendAt: at.toISOString() };
      const request = jsonRequest(state.later ? "PATCH" : "POST", body);
      if (!state.later) request.headers["Idempotency-Key"] = newIdempotencyKey();
      const saved = await crmApi(state.later ? `/scheduled-messages/${state.later}` : `/conversations/${c.id}/scheduled`, request);
      if (!state.later) {
        composer.value = "";
        autoSize();
        syncSendButton();
      }
      closeLater();
      showToast(t(state.later ? "inbox.later.changed" : "inbox.later.scheduled", { when: whenText(saved.sendAt) }), "success");
      loadScheduled();
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.later.failed")), "error");
    } finally {
      $("laterSave").disabled = false;
    }
    return undefined;
  });
  $("scheduledBar").addEventListener("click", async (e) => {
    const editing = e.target.closest("[data-later-edit]");
    const cancelling = e.target.closest("[data-later-cancel]");
    if (editing) openLater(state.scheduled.find((s) => String(s.id) === editing.dataset.laterEdit));
    if (cancelling) {
      if (!window.confirm(t("inbox.later.confirmCancel"))) return;
      try {
        await crmApi(`/scheduled-messages/${cancelling.dataset.laterCancel}`, { method: "DELETE" });
        showToast(t("inbox.later.cancelled"), "success");
        loadScheduled();
      } catch (error) {
        showToast(apiErrorMessage(error, t("inbox.later.failed")), "error");
      }
    }
  });

  // --- quick replies manager ---------------------------------------------
  async function loadQuickReplies() {
    try {
      state.quickReplies = await crmApi("/quick-replies");
    } catch {
      state.quickReplies = [];
    }
  }
  function renderQuickManager() {
    $("quickManageList").innerHTML = state.quickReplies.length
      ? state.quickReplies
          .map(
            (r) => `
          <div class="quick-row">
            <div class="info"><strong>/${escapeHtml(r.shortcut)}</strong> ${r.title ? `<span class="text-muted">· ${escapeHtml(r.title)}</span>` : ""}<div class="body">${escapeHtml(r.body)}</div>${r.attachment ? `<div class="quick-file"><i class="fa-solid fa-paperclip" aria-hidden="true"></i> ${escapeHtml(r.attachment.fileName)}</div>` : ""}</div>
            <button class="icon-btn" type="button" data-quick-edit="${escapeHtml(r.id)}" title="${escapeHtml(t("common.edit"))}"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn danger" type="button" data-quick-delete="${escapeHtml(r.id)}" title="${escapeHtml(t("common.delete"))}"><i class="fa-solid fa-trash"></i></button>
          </div>`,
          )
          .join("")
      : `<p class="text-muted" style="font-size:12.5px">${escapeHtml(t("inbox.quick.empty"))}</p>`;
  }
  function resetQuickForm() {
    $("quickForm").reset();
    $("quickEditId").value = "";
    $("quickFile").value = "";
    $("quickSave").textContent = t("common.save");
  }
  function openQuickManager() {
    resetQuickForm();
    renderQuickManager();
    fillQuickInsert();
    fillQuickFiles();
    $("quickModal").classList.add("open");
  }
  // D103: the files WhatsApp takes (photos, videos, documents) among the Documents this member may
  // open; a teammate without the Documents page sees why there is no list.
  const QUICK_FILE_TYPES = ["jpg", "jpeg", "png", "mp4", "3gp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt"];
  async function fillQuickFiles(selected = $("quickFile").value) {
    const select = $("quickFile");
    let docs = [];
    let note = t("inbox.quick.fileHint");
    try {
      docs = (await crmApi("/documents?limit=100")).filter((d) => d.hasFile && QUICK_FILE_TYPES.includes(String(d.fileName || "").split(".").pop().toLowerCase()));
      if (!docs.length) note = t("inbox.quick.noFiles");
    } catch {
      note = t("inbox.quick.noDocs");
    }
    const keep = state.quickReplies.find((r) => r.attachment && String(r.attachment.documentId) === String(selected))?.attachment;
    if (keep && !docs.some((d) => String(d.id) === String(keep.documentId))) docs.unshift({ id: keep.documentId, name: keep.name, fileName: keep.fileName });
    select.innerHTML = `<option value="">${escapeHtml(t("inbox.quick.noFile"))}</option>${docs.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name && d.name !== d.fileName ? `${d.name} (${d.fileName})` : d.fileName)}</option>`).join("")}`;
    select.value = selected || "";
    $("quickFileHint").textContent = note;
  }
  // "Insert a detail…" under the message: the customer's and the lead's details, their own fields
  // too (D99, those this member may see), put in at the cursor as {{…}}.
  const QUICK_DETAILS = ["contact.name", "contact.company", "contact.city", "contact.phone", "lead.title", "lead.stage", "owner.name", "org.name"];
  async function fillQuickInsert() {
    const [contactFields, leadFields] = await Promise.all([cfLoad("contact"), cfLoad("lead")]);
    const option = (spec, label) => `<option value="${escapeHtml(spec)}">${escapeHtml(label)}</option>`;
    const group = (label, items) => (items.length ? `<optgroup label="${escapeHtml(label)}">${items.join("")}</optgroup>` : "");
    const builtIn = (...prefixes) => QUICK_DETAILS.filter((s) => prefixes.some((p) => s.startsWith(p))).map((s) => option(s, detailName(s)));
    const own = (object, fields) => (fields || []).map((f) => option(`${object}.cf.${f.key}`, `${objectWord(object)}: ${f.label}`));
    $("quickInsert").innerHTML = option("", t("wfb.insert"))
      + group(objectWord("contact"), [...builtIn("contact."), ...own("contact", contactFields)])
      + group(objectWord("lead"), [...builtIn("lead."), ...own("lead", leadFields)])
      + group(t("wfb.insert.other"), builtIn("owner.", "org."));
  }
  $("quickInsert").addEventListener("change", () => {
    const body = $("quickBody");
    const detail = $("quickInsert").value;
    $("quickInsert").value = "";
    if (!detail) return;
    const text = `{{${detail}}}`;
    const start = body.selectionStart ?? body.value.length;
    body.value = body.value.slice(0, start) + text + body.value.slice(body.selectionEnd ?? start);
    body.focus();
    body.setSelectionRange(start + text.length, start + text.length);
  });
  $("quickModalClose").addEventListener("click", () => $("quickModal").classList.remove("open"));
  $("quickModal").addEventListener("click", (e) => {
    if (e.target.id === "quickModal") $("quickModal").classList.remove("open");
  });
  $("quickReset").addEventListener("click", resetQuickForm);
  $("quickManageList").addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-quick-edit]");
    const remove = e.target.closest("[data-quick-delete]");
    if (edit) {
      const reply = state.quickReplies.find((r) => String(r.id) === edit.dataset.quickEdit);
      $("quickEditId").value = reply.id;
      $("quickShortcut").value = reply.shortcut;
      $("quickTitle").value = reply.title;
      $("quickBody").value = reply.body;
      fillQuickFiles(reply.attachment ? String(reply.attachment.documentId) : "");
      $("quickSave").textContent = t("common.update");
    }
    if (remove) {
      if (!confirm(t("inbox.quick.confirmDelete"))) return;
      try {
        await crmApi(`/quick-replies/${remove.dataset.quickDelete}`, { method: "DELETE" });
        await loadQuickReplies();
        renderQuickManager();
      } catch (error) {
        showToast(apiErrorMessage(error, t("common.deleteFailed")), "error");
      }
    }
  });
  $("quickForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("quickEditId").value;
    const body = { shortcut: $("quickShortcut").value.trim().replace(/^\//, ""), title: $("quickTitle").value.trim(), body: $("quickBody").value.trim() };
    const file = $("quickFile").value;
    if (file || id) body.documentId = file || null; // D103
    try {
      await crmApi(id ? `/quick-replies/${id}` : "/quick-replies", jsonRequest(id ? "PATCH" : "POST", body));
      await loadQuickReplies();
      resetQuickForm();
      renderQuickManager();
      showToast(t("inbox.quick.saved"), "success");
    } catch (error) {
      showToast(apiErrorMessage(error, t("inbox.quick.saveFailed")), "error");
    }
  });

  // --- notifications ---------------------------------------------------------
  const canNotify = () => "Notification" in window && Notification.permission === "granted";
  function updateNotifyButton() {
    $("inboxNotifyBtn").hidden = !("Notification" in window) || Notification.permission !== "default";
  }
  $("inboxNotifyBtn").addEventListener("click", async () => {
    try {
      await Notification.requestPermission();
    } catch {
      /* older browsers */
    }
    updateNotifyButton();
  });
  // A short two-tone chime for new customer messages (made in the browser, no sound file).
  // Browsers only allow sound after the first click on the page.
  let soundOn = getPreference("inboxSound", true);
  let audio = null;
  function renderSoundButton() {
    const button = $("inboxSoundBtn");
    button.setAttribute("aria-pressed", String(soundOn));
    button.title = t(soundOn ? "inbox.soundOn" : "inbox.soundOff");
    button.innerHTML = `<i class="fa-solid ${soundOn ? "fa-volume-high" : "fa-volume-xmark"}"></i>`;
  }
  $("inboxSoundBtn").addEventListener("click", () => {
    soundOn = !soundOn;
    setPreference("inboxSound", soundOn);
    renderSoundButton();
    if (soundOn) chime();
  });
  document.addEventListener(
    "pointerdown",
    () => {
      try {
        audio = audio || new AudioContext();
        audio.resume();
      } catch {
        /* no Web Audio */
      }
    },
    { once: true },
  );
  function chime() {
    if (!soundOn || !audio || audio.state !== "running") return;
    const start = audio.currentTime;
    [880, 1320].forEach((frequency, i) => {
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      const at = start + i * 0.12;
      tone.type = "sine";
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, at);
      volume.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      tone.connect(volume).connect(audio.destination);
      tone.start(at);
      tone.stop(at + 0.32);
    });
  }
  renderSoundButton();

  function notify(conversation, message) {
    chime();
    if (!canNotify()) return;
    const notification = new Notification(conversation.contact.name || conversation.contact.phone, {
      body: message.text || conversation.lastMessagePreview || t("inbox.newMessage"),
      tag: `conversation-${conversation.id}`,
      icon: "./img/logo/logo.png",
    });
    notification.onclick = () => {
      window.focus();
      openConversation(conversation.id, { fromList: false });
      notification.close();
    };
  }

  // --- live updates ------------------------------------------------------------
  function setLive(mode, text) {
    $("inboxLive").className = `inbox-live ${mode}`;
    $("inboxLiveText").textContent = text || t(mode === "online" ? "inbox.live.on" : "inbox.live.reconnecting");
  }

  function onMessageNew({ conversation, message }) {
    upsertConversation(conversation);
    const isOpen = state.current && String(state.current.id) === String(conversation.id);
    if (isOpen) {
      state.current = conversation;
      addOrReplaceMessage(message);
      renderMessages();
      renderThreadHead();
      if (message.direction === "in") markRead();
    }
    // A customer's WhatsApp call has its own ring (whatsapp-calls.js).
    if (message.direction === "in" && message.type !== "call" && (document.hidden || !isOpen)) notify(conversation, message);
    scheduleSummary();
  }
  function onConversationUpdated(conversation) {
    upsertConversation(conversation);
    if (state.current && String(state.current.id) === String(conversation.id)) {
      if (!visibleToMe(conversation)) {
        closeThread(t("inbox.reassigned", { name: memberNameOf(conversation.assigneeId) }));
      } else {
        const blockedNow = Boolean(conversation.blocked) !== Boolean(state.current.blocked);
        state.current = conversation;
        renderThreadHead();
        renderDetails();
        if (blockedNow) loadBlockInfo(); // D103: blocked or unblocked by a teammate
        if (state.contextAssignee !== String(conversation.assigneeId || "")) loadContext();
      }
    }
    scheduleSummary();
  }
  function onMessageStatus(message) {
    if (!state.current || String(state.current.id) !== String(message.conversationId)) return;
    addOrReplaceMessage(message);
    renderMessages();
  }
  function onNoteNew({ conversationId, note }) {
    if (!state.current || String(state.current.id) !== String(conversationId)) return;
    if (!state.notes.some((n) => String(n.id) === String(note.id))) {
      state.notes.unshift(note);
      renderNotes();
    }
  }

  // After a reconnect the page reloads what it may have missed.
  async function resync() {
    await Promise.all([loadConversations(), loadSummary()]);
    if (state.current) openConversation(state.current.id, { fromList: false });
  }

  function loadSocketClient(origin) {
    if (window.io) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${origin}/socket.io/socket.io.min.js`;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Socket.IO client not available"));
      document.head.appendChild(script);
    });
  }

  async function connectLive() {
    const origin = CRM_API_BASE.replace(/\/api\/v1$/, "");
    try {
      await loadSocketClient(origin);
    } catch {
      setLive("offline", t("inbox.live.unavailable"));
      return;
    }
    let authFailures = 0;
    let hadConnection = false;
    const socket = window.io(origin, {
      auth: (cb) => cb({ token: localStorage.getItem(KEYS.SESSION) || "" }),
      transports: ["websocket", "polling"],
    });
    socket.on("connect", () => {
      authFailures = 0;
      setLive("online");
      if (hadConnection) resync();
      hadConnection = true;
    });
    socket.on("disconnect", (reason) => {
      setLive("offline");
      // The server drops connections when a member's access changes: reconnect with it.
      if (reason === "io server disconnect") setTimeout(() => socket.connect(), 1000);
    });
    socket.on("connect_error", async (error) => {
      setLive("offline");
      if (error.message === "FORBIDDEN") {
        setLive("offline", t("inbox.live.noAccess"));
        return;
      }
      if (error.message === "UNAUTHORIZED") {
        authFailures += 1;
        if (authFailures > 3) return;
        const token = await refreshAccessToken(localStorage.getItem(KEYS.SESSION));
        if (token) socket.connect();
        else endSession();
      }
    });
    crmWhatsAppCalls.attach(socket); // G7 (D111): calls ring here
    socket.on("message:new", onMessageNew);
    socket.on("conversation:updated", onConversationUpdated);
    socket.on("notification:new", (notification) => crmBell.push(notification));
    socket.on("message:status", onMessageStatus);
    socket.on("note:new", onNoteNew);
    // An owner made a number private (or visible again, D61): reload; a chat no longer visible closes.
    socket.on("inbox:refresh", async () => {
      loadConversations();
      loadSummary();
      if (!state.current || isOrgOwner()) return;
      try {
        await crmApi(`/conversations/${state.current.id}`);
      } catch {
        closeThread();
      }
    });
    // Chats being imported from a WhatsApp Business app number (D60): refresh the list now and then.
    let syncReload = null;
    socket.on("whatsapp:sync", () => {
      state.whatsappConnected = true;
      if (syncReload) return;
      syncReload = setTimeout(() => {
        syncReload = null;
        loadConversations();
      }, 2000);
    });
  }

  // Keep the reply-window chip current and mark the open chat read when the tab comes back.
  setInterval(() => {
    if (state.current) renderThreadHead();
  }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.current?.unreadCount) markRead();
  });

  // --- start -----------------------------------------------------------------
  // G7 (D111): WhatsApp calls — answering one opens its chat.
  crmWhatsAppCalls.init({ onOpenChat: (id) => openConversation(id, { fromList: false }) });
  $("threadCall").addEventListener("click", () => crmWhatsAppCalls.start(state.current));
  $("threadBot").addEventListener("click", toggleBot);
  $("aiSuggestBtn").addEventListener("click", suggestReplies);
  crmReady(["members"], async () => {
    updateNotifyButton();
    crmApi("/bot/status").then((status) => {
      state.botEnabled = Boolean(status?.enabled);
      if (state.current) renderThreadHead();
    }).catch(() => {});
    crmApi("/ai/status").then((status) => {
      state.aiAvailable = Boolean(status?.available);
      if (state.current) renderThreadHead();
    }).catch(() => {});
    // Owners and admins: is a WhatsApp number connected at all (D60)? Otherwise the empty list
    // says how to connect one.
    if (isOrgManager()) {
      crmApi("/whatsapp/connect").then((status) => {
        state.whatsappConnected = status.accounts.length > 0;
        renderList();
      }).catch(() => {});
    }
    await Promise.all([loadConversations(), loadSummary(), loadQuickReplies()]);
    const deepLink = new URLSearchParams(window.location.search).get("c");
    if (deepLink) {
      const opening = openConversation(deepLink, { fromList: false });
      // D103: from the bell note of a scheduled text that could not go — the templates at once.
      if (new URLSearchParams(window.location.search).get("template") === "1") opening.then(() => { if (state.current && !state.current.blocked) openTemplatePicker(); });
    }
    connectLive();
  });
});
