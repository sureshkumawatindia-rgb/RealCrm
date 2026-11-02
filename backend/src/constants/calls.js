// Calls (Phase 6, D85).
const CALL_DIRECTIONS = Object.freeze(['in', 'out']);
// queued → ringing → in_progress → one of the end states.
const CALL_STATUSES = Object.freeze(['queued', 'ringing', 'in_progress', 'completed', 'failed', 'busy', 'no_answer', 'cancelled']);
const END_STATUSES = Object.freeze(['completed', 'failed', 'busy', 'no_answer', 'cancelled']);
// What came of it, in a salesperson's words (the board and Phase 8's dialer use the same list).
const CALL_OUTCOMES = Object.freeze(['connected', 'interested', 'callback', 'not_interested', 'no_answer', 'busy', 'wrong_number', 'switched_off']);
// whatsapp: a WhatsApp call, answered or made in the browser (G7, D111).
const CALL_PROVIDERS = Object.freeze(['manual', 'exotel', 'mock', 'whatsapp']);
// Calls still going on (not ended).
const LIVE_STATUSES = Object.freeze(['queued', 'ringing', 'in_progress']);
const TELEPHONY_PROVIDERS = Object.freeze(['exotel', 'mock']);

module.exports = { CALL_DIRECTIONS, CALL_STATUSES, END_STATUSES, LIVE_STATUSES, CALL_OUTCOMES, CALL_PROVIDERS, TELEPHONY_PROVIDERS };
