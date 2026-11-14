// What the status page reports, and which outside answers mean trouble (Phase 9, D151).

// Outside services whose answers are counted.
const OUTSIDE_SERVICES = Object.freeze(['whatsapp', 'razorpay', 'cashfree']);
// In the order the status page shows them. crm: the CRM itself; jobs: its background work.
const SERVICES = Object.freeze(['crm', 'jobs', ...OUTSIDE_SERVICES]);
// notice: the platform's admin saying something about no service in particular.
const INCIDENT_SERVICES = Object.freeze([...SERVICES, 'notice']);
const INCIDENT_LEVELS = Object.freeze(['info', 'degraded', 'down']);
const LEVEL_RANK = Object.freeze({ ok: 0, info: 0, degraded: 1, down: 2 });

// The WhatsApp Cloud API's error codes that say a send may work later (its "Error codes" page).
// Meta's own trouble: counted towards "Meta is down" …
const META_TROUBLE_CODES = Object.freeze([2, 131016, 133004]);
// … and worth trying again, but no sign of an outage: "something went wrong" with one message,
// too many at once, the account in maintenance.
const META_TRY_AGAIN_CODES = Object.freeze([1, 4, 80007, 130429, 131000, 131056, 131057]);

module.exports = { OUTSIDE_SERVICES, SERVICES, INCIDENT_SERVICES, INCIDENT_LEVELS, LEVEL_RANK, META_TROUBLE_CODES, META_TRY_AGAIN_CODES };
