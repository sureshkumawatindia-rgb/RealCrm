const queue = require('./queue');

// Background jobs of the CRM. Each kind of job is defined next to the code it belongs to and
// registered here, so the server starts every handler before the worker begins taking jobs.
// (Lead source polling and auto-replies are added with Phase 4B and 4D.)
const definitions = [];

function start(config) {
  definitions.forEach((register) => register(queue));
  queue.start(config);
}

module.exports = { start, stop: queue.stop, queue };
