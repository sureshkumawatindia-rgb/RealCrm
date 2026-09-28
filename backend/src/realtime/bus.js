const { EventEmitter } = require('events');

// In-process events for things the inbox shows live ("message:new", "message:status",
// "conversation:updated"). Socket.IO (Phase 3 checkpoint B) forwards them to browsers.
const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
