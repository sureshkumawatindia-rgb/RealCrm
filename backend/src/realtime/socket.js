const { Server } = require('socket.io');
const User = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Conversation = require('../models/Conversation');
const env = require('../config/env');
const logger = require('../config/logger');
const bus = require('./bus');
const { createRelay } = require('./relay');
const { verifyAccessToken } = require('../utils/tokens');
const { isManager } = require('../constants/permissions');
const { serializeConversation, serializeMessage, seesAll } = require('../services/conversationService');
const phoneVisibility = require('../services/phoneVisibility');
const { maskPhonesIn } = require('../utils/phoneMask');

// Live inbox updates over Socket.IO (same port as the API, path /socket.io).
// The browser connects with its access token (auth: { token }). Each socket joins rooms by what
// the member may see (the same rule as the conversations API, D24):
//   member:<id>          — the member: their assigned chats; dropped when their access changes
//   org:<id>:inbox-all   — owners, admins and inbox:view_all: every chat
//   org:<id>:inbox       — other inbox members: chats nobody has taken yet
//   org:<id>:owners      — owners: the only ones who receive private numbers' chats (D61)
// Server → browser events: conversation:updated, message:new, message:status, note:new,
// notification:new, whatsapp:sync, inbox:refresh.
// Agents and viewers whose company hides customers' numbers (D65) get every event masked.
// With more than one server (F6), every update goes through the relay (realtime/relay.js): each
// server applies it to its own browsers.
const rooms = {
  member: (id) => `member:${id}`,
  all: (organizationId) => `org:${organizationId}:inbox-all`,
  queue: (organizationId) => `org:${organizationId}:inbox`,
  owners: (organizationId) => `org:${organizationId}:owners`, // private chats (D61)
};

const POPULATE = [
  { path: 'contactId', select: 'name phone phoneE164 company' },
  { path: 'whatsappAccountId', select: 'name displayPhone verifiedName phoneNumberId' },
];

async function authenticateSocket(socket, next) {
  try {
    const payload = verifyAccessToken(String(socket.handshake.auth?.token || ''));
    const [user, member] = await Promise.all([
      User.findById(payload.sub),
      OrganizationMember.findOne({ organizationId: payload.org, userId: payload.sub, status: 'active' }),
    ]);
    if (!user || user.disabledAt || !member) return next(new Error('UNAUTHORIZED'));
    if (!isManager(member) && !member.modules.includes('inbox')) return next(new Error('FORBIDDEN'));
    socket.data.member = member;
    socket.data.maskPhones = await phoneVisibility.hidesPhonesFor(member);
    return next();
  } catch {
    return next(new Error('UNAUTHORIZED'));
  }
}

// Who hears about a chat: everyone who sees all chats, plus its assignee (or, while nobody has
// taken it, the inbox queue). previousAssigneeId: undefined = unchanged, null = was in the queue.
function targetsFor(conversation, previousAssigneeId) {
  const organizationId = conversation.organizationId;
  // A private number's chat (D61): owners only.
  if (conversation.private) return [rooms.owners(organizationId)];
  const targets = new Set([rooms.all(organizationId)]);
  targets.add(conversation.assigneeId ? rooms.member(conversation.assigneeId) : rooms.queue(organizationId));
  if (previousAssigneeId === null) targets.add(rooms.queue(organizationId));
  if (previousAssigneeId) targets.add(rooms.member(previousAssigneeId));
  return [...targets];
}

// relay: share updates with the other servers (F6); listen: false = a server that only replays
// the others' updates (tests stand in a second server in the same process with it).
function attachRealtime(httpServer, { relay: relayOn = env.realtimeRelay, listen = true } = {}) {
  const io = new Server(httpServer, { cors: { origin: env.corsOrigins, credentials: true } });
  io.use(authenticateSocket);
  io.on('connection', (socket) => {
    const { member } = socket.data;
    socket.join(rooms.member(member._id));
    socket.join(seesAll(member) ? rooms.all(member.organizationId) : rooms.queue(member.organizationId));
    if (member.role === 'owner') socket.join(rooms.owners(member.organizationId));
  });

  // Each browser gets the event as its member may see it: masked numbers for agents and viewers
  // of a company that hides them (D65), the real ones for everyone else.
  async function emitTo(targets, event, payload) {
    const sockets = await io.in(targets).fetchSockets();
    if (!sockets.some((socket) => socket.data.maskPhones)) {
      io.to(targets).emit(event, payload);
      return;
    }
    let masked;
    for (const socket of sockets) {
      if (socket.data.maskPhones) masked = masked || maskPhonesIn(payload);
      socket.emit(event, socket.data.maskPhones ? masked : payload);
    }
  }

  // What a server does with an update (its own, or another server's through the relay).
  async function apply(op) {
    if (op.type === 'emit') return emitTo(op.targets, op.event, op.payload);
    if (op.type === 'broadcast') {
      io.to(op.targets).emit(op.event, op.payload);
      return undefined;
    }
    if (op.type === 'phones') {
      const targets = [rooms.all(op.organizationId), rooms.queue(op.organizationId)];
      for (const socket of await io.in(targets).fetchSockets()) {
        socket.data.maskPhones = Boolean(op.hidePhonesFromAgents) && !isManager(socket.data.member);
      }
      io.to(targets).emit('inbox:refresh');
      return undefined;
    }
    if (op.type === 'disconnect') io.in(rooms.member(op.memberId)).disconnectSockets(true);
    return undefined;
  }
  const relay = createRelay({ apply, enabled: relayOn });
  const send = (targets, event, payload) => relay.send({ type: 'emit', targets, event, payload });

  const load = (id) => Conversation.findById(id).populate(POPULATE);
  const handlers = {
    'conversation:updated': async ({ conversation, previousAssigneeId }) => {
      const full = await load(conversation._id);
      if (full) await send(targetsFor(full, previousAssigneeId), 'conversation:updated', serializeConversation(full));
    },
    'message:new': async ({ conversation, message }) => {
      const full = await load(conversation._id);
      if (full) await send(targetsFor(full), 'message:new', { conversation: serializeConversation(full), message: serializeMessage(message) });
    },
    'message:status': async ({ message }) => {
      const conversation = await Conversation.findById(message.conversationId);
      if (conversation) await send(targetsFor(conversation), 'message:status', serializeMessage(message));
    },
    'note:new': async ({ conversation, note }) => {
      await send(targetsFor(conversation), 'note:new', { conversationId: conversation._id, note });
    },
    // Importing a connected WhatsApp Business app number's contacts and chats (D60): to the
    // owners and admins, who connect numbers.
    'whatsapp:sync': async ({ organizationId, accountId, sync }) => {
      await relay.send({ type: 'broadcast', targets: [rooms.all(organizationId)], event: 'whatsapp:sync', payload: { accountId, sync } });
    },
    // A number was made private or visible again (D61): open Inbox pages reload their list.
    'privacy:changed': async ({ organizationId }) => {
      await relay.send({ type: 'broadcast', targets: [rooms.all(organizationId), rooms.queue(organizationId)], event: 'inbox:refresh' });
    },
    // "Hide customer phone numbers from agents" was switched (D65): open browsers follow at once.
    'privacy:phones-changed': async ({ organizationId, hidePhonesFromAgents }) => {
      await relay.send({ type: 'phones', organizationId, hidePhonesFromAgents: Boolean(hidePhonesFromAgents) });
    },
    // The bell (Phase 6): only to the member it is for.
    'notification:new': async ({ memberId, notification }) => {
      await send([rooms.member(memberId)], 'notification:new', notification);
    },
    // Role, pages or status changed, or the member was removed: drop their sockets. The browser
    // reconnects and gets the rooms that match the new access (or is refused).
    'member:access-changed': async ({ memberId }) => {
      await relay.send({ type: 'disconnect', memberId: String(memberId) });
    },
  };
  const listeners = !listen ? [] : Object.entries(handlers).map(([event, handler]) => {
    const listener = (payload) => handler(payload).catch((error) => logger.error(`Realtime ${event} failed: ${error.message}`));
    bus.on(event, listener);
    return [event, listener];
  });

  // Stops forwarding (tests start and stop servers several times).
  io.detach = () => {
    listeners.forEach(([event, listener]) => bus.off(event, listener));
    return relay.close();
  };
  io.relayReady = () => relay.ready();
  return io;
}

module.exports = { attachRealtime, targetsFor, rooms };
