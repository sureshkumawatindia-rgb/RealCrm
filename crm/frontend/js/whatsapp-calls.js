/**
 * whatsapp-calls.js — WhatsApp calls in the Inbox (G7, D111)
 * A customer's call rings here for everyone who sees that chat: a card with Answer and Decline,
 * and a ring. The first teammate to answer takes the call. A teammate calls a customer from the
 * chat's phone button once the customer allowed it; until then the button asks them, in the chat.
 * The sound goes between this browser and WhatsApp (WebRTC: the microphone out, the customer's
 * voice into an <audio>); the CRM only passes each side's audio set-up (SDP) to and from Meta.
 * Inbox (inbox.js) calls init(), attach(socket) and start(conversation).
 */
window.crmWhatsAppCalls = (function whatsappCalls() {
  const RING_MS = 75 * 1000; // WhatsApp stops ringing an unanswered call after about a minute
  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
  const LIVE = ["queued", "ringing", "in_progress"];
  const rings = new Map(); // call id → { call, conversation, timer }
  let active = null; // the call on this browser: { id, direction, conversation, status, pc, stream, since, muted, poll }
  let openChat = () => {};
  let root = null;
  let audio = null;
  let tone = null;
  let clock = null;

  const nameOf = (c) => c?.contact?.name || c?.contact?.phone || t("inbox.call.customer");
  // 75 → "1:15"; an hour or more → "1:02:03".
  function clockText(sec) {
    const s = Math.max(Math.round(sec || 0), 0);
    const two = (n) => String(n).padStart(2, "0");
    return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
  }

  function ensureRoot() {
    if (root) return;
    root = document.createElement("div");
    root.className = "wa-call-stack";
    root.hidden = true;
    root.setAttribute("aria-live", "assertive");
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.hidden = true;
    document.body.append(root, audio);
    root.addEventListener("click", onClick);
  }

  // --- the ring: two short tones every 3 seconds (no sound file) ---
  function startTone() {
    if (tone) return;
    try {
      const context = new (window.AudioContext || window.webkitAudioContext)();
      const play = () => {
        if (context.state === "suspended") context.resume().catch(() => {});
        [0, 0.35].forEach((offset) => {
          const at = context.currentTime + offset;
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.frequency.value = 480;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
          oscillator.connect(gain).connect(context.destination);
          oscillator.start(at);
          oscillator.stop(at + 0.3);
        });
      };
      play();
      tone = { context, timer: setInterval(play, 3000) };
    } catch {
      tone = null; // no sound in this browser: the card still shows
    }
  }
  function stopTone() {
    if (!tone) return;
    clearInterval(tone.timer);
    tone.context.close().catch(() => {});
    tone = null;
  }

  // --- the cards ---
  function ringHtml({ call, conversation }) {
    const id = escapeHtml(call.id);
    const sub = [conversation?.contact?.phone, conversation?.account?.verifiedName || conversation?.account?.name || conversation?.account?.displayPhone].filter(Boolean).join(" · ");
    return `<div class="wa-call-card" role="alertdialog" aria-label="${escapeHtml(t("inbox.call.incomingFrom", { name: nameOf(conversation) }))}">
      <div class="wa-call-icon ringing" aria-hidden="true"><i class="fa-brands fa-whatsapp"></i></div>
      <div class="wa-call-info">
        <div class="wa-call-title">${escapeHtml(t("inbox.call.incoming"))}</div>
        <div class="wa-call-name">${escapeHtml(nameOf(conversation))}</div>
        ${sub ? `<div class="wa-call-sub">${escapeHtml(sub)}</div>` : ""}
      </div>
      <div class="wa-call-actions">
        <button class="btn wa-call-btn end" type="button" data-call-decline="${id}"><i class="fa-solid fa-phone-slash"></i> <span>${escapeHtml(t("inbox.call.decline"))}</span></button>
        <button class="btn wa-call-btn answer" type="button" data-call-answer="${id}"><i class="fa-solid fa-phone"></i> <span>${escapeHtml(t("inbox.call.answer"))}</span></button>
      </div>
    </div>`;
  }
  function statusText() {
    if (active.status === "in_progress") return clockText((Date.now() - active.since) / 1000);
    if (active.direction === "out" && active.status === "ringing") return t("inbox.call.ringingOut");
    return t("inbox.call.connecting");
  }
  function activeHtml() {
    return `<div class="wa-call-card live" role="region" aria-label="${escapeHtml(t("inbox.call.onCallWith", { name: nameOf(active.conversation) }))}">
      <div class="wa-call-icon" aria-hidden="true"><i class="fa-solid fa-phone-volume"></i></div>
      <div class="wa-call-info">
        <div class="wa-call-title">${escapeHtml(t(active.direction === "in" ? "inbox.call.fromCustomer" : "inbox.call.toCustomer"))}</div>
        <div class="wa-call-name">${escapeHtml(nameOf(active.conversation))}</div>
        <div class="wa-call-sub" data-call-clock>${escapeHtml(statusText())}</div>
      </div>
      <div class="wa-call-actions">
        <button class="icon-btn wa-call-tool" type="button" data-call-mute aria-pressed="${active.muted ? "true" : "false"}" title="${escapeHtml(t(active.muted ? "inbox.call.unmute" : "inbox.call.mute"))}" aria-label="${escapeHtml(t(active.muted ? "inbox.call.unmute" : "inbox.call.mute"))}"><i class="fa-solid ${active.muted ? "fa-microphone-slash" : "fa-microphone"}"></i></button>
        <button class="icon-btn wa-call-tool" type="button" data-call-open title="${escapeHtml(t("inbox.call.openChat"))}" aria-label="${escapeHtml(t("inbox.call.openChat"))}"><i class="fa-regular fa-comment"></i></button>
        <button class="btn wa-call-btn end" type="button" data-call-end><i class="fa-solid fa-phone-slash"></i> <span>${escapeHtml(t("inbox.call.hangUp"))}</span></button>
      </div>
    </div>`;
  }
  function render() {
    ensureRoot();
    const waiting = [...rings.values()].filter((ring) => !active || String(ring.call.id) !== active.id);
    root.innerHTML = `${active ? activeHtml() : ""}${waiting.map(ringHtml).join("")}`;
    root.hidden = !active && !waiting.length;
    // No ring over a call already going on: the card is enough.
    if (waiting.length && !active) startTone();
    else stopTone();
  }
  function tick() {
    const el = root?.querySelector("[data-call-clock]");
    if (el && active) el.textContent = statusText();
  }

  // --- a customer's call ringing ---
  function addRing(call, conversation) {
    const id = String(call?.id || "");
    if (!id || call.direction !== "in" || call.status !== "ringing" || rings.has(id) || active?.id === id) return;
    const started = new Date(call.startedAt).getTime();
    const left = Math.min(Math.max(RING_MS - (Date.now() - (Number.isNaN(started) ? Date.now() : started)), 5000), RING_MS);
    rings.set(id, { call, conversation, timer: setTimeout(() => dropRing(id), left) });
    render();
    // A note on the computer when this tab is in the background (if notifications are allowed).
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      const note = new Notification(t("inbox.call.incoming"), { body: nameOf(conversation), tag: `wa-call-${id}`, icon: "./img/icons/icon-192.png" });
      note.onclick = () => {
        window.focus();
        note.close();
      };
    }
  }
  function dropRing(id) {
    const ring = rings.get(id);
    if (!ring) return;
    clearTimeout(ring.timer);
    rings.delete(id);
    render();
  }
  async function loadRinging() {
    try {
      const items = await crmApi("/whatsapp-calls/ringing");
      (items || []).forEach(({ call, conversation }) => addRing(call, conversation));
    } catch {
      // the next call still rings through the live connection
    }
  }

  // --- the sound ---
  async function microphone() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error(t("inbox.call.unsupported"));
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      throw new Error(t("inbox.call.noMic"));
    }
  }
  // WhatsApp takes the whole set-up at once: wait (up to 3 s) until the browser found its addresses.
  function gathered(pc, ms = 3000) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        pc.removeEventListener("icegatheringstatechange", check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(done, ms);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }
  // The microphone first: without it a ringing call keeps ringing (allow it, then answer again).
  async function withMicrophone() {
    try {
      return await microphone();
    } catch (error) {
      showToast(error.message, "error");
      return null;
    }
  }
  // describe(pc): makes this side's offer or answer.
  async function connect(call, describe) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    call.pc = pc;
    call.stream.getTracks().forEach((track) => pc.addTrack(track, call.stream));
    pc.addEventListener("track", (event) => {
      ensureRoot();
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      audio.play().catch(() => {});
    });
    await describe(pc);
    await gathered(pc);
  }

  // The live update may not reach this browser: ask the server every 4 seconds during the call.
  function follow(call) {
    clearInterval(call.poll);
    call.poll = setInterval(async () => {
      if (active !== call || !call.id) return;
      try {
        const latest = await crmApi(`/whatsapp-calls/${call.id}`);
        if (latest.sdp) applyAnswer(call.id, latest.sdp);
        onUpdated(latest);
      } catch {
        // try again on the next round
      }
    }, 4000);
    clearInterval(clock);
    clock = setInterval(tick, 1000);
  }
  async function applyAnswer(id, sdp) {
    if (!active || active.id !== String(id) || active.answered || !sdp || !active.pc) return;
    active.answered = true;
    try {
      await active.pc.setRemoteDescription({ type: "answer", sdp });
    } catch (error) {
      console.warn("WhatsApp's answer could not be used", error);
    }
  }

  function cleanup() {
    if (!active) return;
    clearInterval(active.poll);
    clearInterval(clock);
    try {
      active.pc?.close();
    } catch {
      // already closed
    }
    active.stream?.getTracks().forEach((track) => track.stop());
    if (audio) audio.srcObject = null;
    active = null;
    render();
  }
  const ENDED = { completed: "inbox.call.ended", cancelled: "inbox.call.ended", no_answer: "inbox.call.endedNoAnswer", busy: "inbox.call.endedDeclined", failed: "inbox.call.endedFailed" };
  function finish(status) {
    if (!active) return;
    cleanup();
    showToast(t(ENDED[status] || "inbox.call.ended"), status === "failed" ? "error" : "info");
  }

  // --- live updates ---
  function onUpdated(call) {
    const id = String(call?.id || "");
    if (!id) return;
    if (rings.has(id) && call.status !== "ringing") dropRing(id);
    if (!active || active.id !== id) return;
    if (!LIVE.includes(call.status)) {
      finish(call.status);
      return;
    }
    if (call.status === active.status) return;
    if (call.status === "in_progress") active.since = call.answeredAt && active.direction === "out" ? new Date(call.answeredAt).getTime() : active.since || Date.now();
    active.status = call.status;
    render();
  }

  // --- what the teammate does ---
  async function answer(id) {
    const ring = rings.get(id);
    if (!ring || active) return;
    const stream = await withMicrophone();
    if (!stream || active || !rings.has(id)) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }
    dropRing(id);
    const call = { id, direction: "in", conversation: ring.conversation, status: "connecting", stream };
    active = call;
    render();
    try {
      await connect(call, async (pc) => {
        await pc.setRemoteDescription({ type: "offer", sdp: ring.call.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
      });
      const taken = await crmApi(`/whatsapp-calls/${id}/answer`, jsonRequest("POST", { sdp: call.pc.localDescription.sdp }));
      if (active !== call) return;
      call.status = taken.status;
      call.since = Date.now();
      render();
      follow(call);
      if (ring.conversation?.id) openChat(ring.conversation.id);
    } catch (error) {
      if (active === call) cleanup();
      showToast(apiErrorMessage(error, t("inbox.call.answerFailed")), "error");
    }
  }
  async function decline(id) {
    if (!rings.has(id)) return;
    dropRing(id);
    try {
      await crmApi(`/whatsapp-calls/${id}/decline`, jsonRequest("POST", {}));
    } catch (error) {
      showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
    }
  }
  async function hangUp() {
    const call = active;
    if (!call) return;
    cleanup();
    showToast(t("inbox.call.ended"), "info");
    if (!call.id) return; // still being set up: the server never heard of it
    try {
      await crmApi(`/whatsapp-calls/${call.id}/end`, jsonRequest("POST", {}));
    } catch (error) {
      showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
    }
  }
  function toggleMute() {
    if (!active?.stream) return;
    active.muted = !active.muted;
    active.stream.getAudioTracks().forEach((track) => {
      track.enabled = !active.muted;
    });
    render();
  }

  // The chat's phone button: call the customer, or — without their permission — ask for it.
  async function start(conversation) {
    if (!conversation?.account?.calling) return;
    if (active) {
      showToast(t("inbox.call.onAnother"), "info");
      return;
    }
    if (conversation.callPermission?.status !== "granted") {
      askPermission(conversation);
      return;
    }
    const stream = await withMicrophone();
    if (!stream || active) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }
    const call = { id: "", direction: "out", conversation, status: "connecting", stream };
    active = call;
    render();
    try {
      await connect(call, async (pc) => {
        await pc.setLocalDescription(await pc.createOffer());
      });
      const placed = await crmApi("/whatsapp-calls", jsonRequest("POST", { conversationId: conversation.id, sdp: call.pc.localDescription.sdp }));
      if (active !== call) {
        // hung up while it was being placed
        crmApi(`/whatsapp-calls/${placed.id}/end`, jsonRequest("POST", {})).catch(() => {});
        return;
      }
      call.id = String(placed.id);
      call.status = placed.status;
      render();
      follow(call);
    } catch (error) {
      if (active === call) cleanup();
      showToast(apiErrorMessage(error, t("inbox.call.failed")), "error");
    }
  }

  // --- asking the customer for permission to call (inside the 24-hour window) ---
  let askModal = null;
  function askPermission(conversation) {
    if (!askModal) {
      askModal = document.createElement("div");
      askModal.className = "modal-overlay";
      askModal.innerHTML = `<div class="modal wa-call-ask" role="dialog" aria-modal="true" aria-labelledby="waCallAskTitle">
        <div class="modal-head">
          <h3 id="waCallAskTitle">${escapeHtml(t("inbox.call.askTitle"))}</h3>
          <button class="icon-btn" type="button" data-ask-close aria-label="${escapeHtml(t("common.close"))}"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="modal-body">
          <p class="text-muted" data-ask-note></p>
          <div class="field">
            <label for="waCallAskText">${escapeHtml(t("inbox.call.askMessage"))}</label>
            <textarea id="waCallAskText" rows="3" maxlength="1024"></textarea>
          </div>
          <p class="wa-call-ask-warn" data-ask-warn hidden></p>
          <div class="template-actions">
            <button class="btn btn-outline" type="button" data-ask-close>${escapeHtml(t("common.cancel"))}</button>
            <button class="btn btn-primary" type="button" data-ask-send><i class="fa-solid fa-paper-plane"></i> <span>${escapeHtml(t("inbox.call.askSend"))}</span></button>
          </div>
        </div>
      </div>`;
      document.body.append(askModal);
      const close = () => askModal.classList.remove("open");
      askModal.addEventListener("click", async (event) => {
        if (event.target === askModal || event.target.closest("[data-ask-close]")) close();
        const send = event.target.closest("[data-ask-send]");
        if (!send) return;
        const text = askModal.querySelector("textarea").value.trim();
        if (!text) return;
        send.disabled = true;
        try {
          await crmApi("/whatsapp-calls/permission", jsonRequest("POST", { conversationId: askModal.dataset.conversation, text }));
          showToast(t("inbox.call.asked"), "success");
          close();
        } catch (error) {
          showToast(apiErrorMessage(error, t("common.tryAgain")), "error");
        } finally {
          send.disabled = false;
        }
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && askModal.classList.contains("open")) close();
      });
    }
    const p = conversation.callPermission || {};
    const when = p.requestedAt ? new Date(p.requestedAt).toLocaleString(crmI18n.locale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
    const note = p.status === "requested" ? t("inbox.call.askedAt", { when }) : p.status === "rejected" ? t("inbox.call.refusedNote") : t("inbox.call.askWhy");
    const recent = p.requestedAt && Date.now() - new Date(p.requestedAt).getTime() < 24 * 60 * 60 * 1000;
    const open = Boolean(conversation.window?.open) && !conversation.blocked;
    const warn = !open ? t("inbox.call.askWindow") : recent ? t("inbox.call.askToday") : "";
    askModal.dataset.conversation = conversation.id;
    askModal.querySelector("[data-ask-note]").textContent = note;
    askModal.querySelector("textarea").value = t("inbox.call.askDefault");
    askModal.querySelector("textarea").disabled = Boolean(warn);
    askModal.querySelector("[data-ask-warn]").textContent = warn;
    askModal.querySelector("[data-ask-warn]").hidden = !warn;
    askModal.querySelector("[data-ask-send]").disabled = Boolean(warn);
    askModal.classList.add("open");
    if (!warn) setTimeout(() => askModal.querySelector("textarea").focus(), 50);
  }

  function onClick(event) {
    const answerBtn = event.target.closest("[data-call-answer]");
    if (answerBtn) return answer(answerBtn.dataset.callAnswer);
    const declineBtn = event.target.closest("[data-call-decline]");
    if (declineBtn) return decline(declineBtn.dataset.callDecline);
    if (event.target.closest("[data-call-end]")) return hangUp();
    if (event.target.closest("[data-call-mute]")) return toggleMute();
    if (event.target.closest("[data-call-open]") && active?.conversation?.id) return openChat(active.conversation.id);
    return undefined;
  }

  // Leaving the page would cut the sound: the browser asks first.
  window.addEventListener("beforeunload", (event) => {
    if (!active) return;
    event.preventDefault();
    event.returnValue = "";
  });

  return {
    init({ onOpenChat } = {}) {
      if (onOpenChat) openChat = onOpenChat;
    },
    attach(socket) {
      socket.on("call:incoming", ({ call, conversation }) => addRing(call, conversation));
      socket.on("call:updated", onUpdated);
      socket.on("call:answer", ({ id, sdp }) => applyAnswer(id, sdp));
      socket.on("connect", loadRinging); // also after a reconnect
    },
    start,
    clockText,
  };
}());
