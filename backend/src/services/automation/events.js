const crypto = require('crypto');
const bus = require('../../realtime/bus');

// Business events for the automation engine (Phase 6). Services call emit() after the change
// is saved; the engine turns each event into a job, so a slow or failing automation never holds
// up the request. req.automation (set when an automation itself made the change) carries the
// chain of workflows behind it, so automations cannot trigger each other in a loop.
// key: what makes this event unique (a retried job must not start a workflow twice).
// req.skipWorkflows (a bulk change without "Run automations too", D100): the event still ends
// sequences and reaches webhooks, but starts no workflow.
function emit(type, payload, req) {
  const event = {
    type,
    key: payload.key || `${type}:${crypto.randomBytes(9).toString('hex')}`,
    chain: (req?.automation?.chain || []).map(String),
    at: new Date(),
    ...payload,
    organizationId: String(payload.organizationId),
    ...(req?.skipWorkflows && { skipWorkflows: true }),
  };
  bus.emit('automation:event', event);
  return event;
}

module.exports = { emit };
