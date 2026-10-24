const crypto = require('crypto');
const os = require('os');
const mongoose = require('mongoose');
const logger = require('../config/logger');

// The live inbox across servers (F6). Each server sends live updates to the browsers connected to
// it; with two servers, what happens on one must reach the browsers on the other. Every update
// (who gets it, the event, what it carries) is written to a short-lived collection, and each
// server follows that collection with a MongoDB change stream and replays the others' updates to
// its own browsers. Updates are kept an hour (TTL); a broken stream reopens by itself. The same
// job as Socket.IO's MongoDB adapter, without another package.

const RealtimeRelay = mongoose.models.RealtimeRelay || mongoose.model('RealtimeRelay', new mongoose.Schema({
  origin: { type: String, required: true },
  // The update as JSON text: what the browsers get is JSON anyway, and any key is safe in it.
  op: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 },
}, { versionKey: false }));

const REOPEN_MS = 2000;

// apply(op): what this server does with an update (its own, and the others').
function createRelay({ apply, enabled }) {
  const origin = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
  let stream = null;
  let closed = false;
  let ready = Promise.resolve();

  function open() {
    if (closed) return;
    stream = RealtimeRelay.collection.watch([{ $match: { operationType: 'insert', 'fullDocument.origin': { $ne: origin } } }]);
    // The stream is live once MongoDB has answered; tests wait for it.
    ready = new Promise((resolve) => {
      stream.once('resumeTokenChanged', resolve);
      setTimeout(resolve, 1500).unref();
    });
    stream.on('change', (change) => {
      Promise.resolve().then(() => apply(JSON.parse(change.fullDocument.op))).catch((error) => logger.error(`Realtime relay: ${error.message}`));
    });
    stream.on('error', (error) => {
      if (closed) return;
      logger.warn(`Realtime relay stream stopped (${error.message}); reopening`);
      stream.close().catch(() => {});
      setTimeout(open, REOPEN_MS).unref();
    });
  }
  if (enabled) open();

  return {
    origin,
    // Applies here at once, and tells the other servers.
    async send(op) {
      await apply(op);
      if (enabled) await RealtimeRelay.create({ origin, op: JSON.stringify(op) }).catch((error) => logger.warn(`Realtime relay write failed: ${error.message}`));
    },
    ready: () => ready,
    async close() {
      closed = true;
      if (stream) await stream.close().catch(() => {});
    },
  };
}

module.exports = { createRelay, RealtimeRelay };
