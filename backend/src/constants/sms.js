// SMS to customers (Phase 8A, D88): through the company's own MSG91 account with DLT-approved
// templates, or a test provider in tests and development.
const SMS_PROVIDERS = Object.freeze(['msg91', 'mock']);
const SMS_STATUSES = Object.freeze(['queued', 'sent', 'delivered', 'failed', 'blocked', 'received']);
const SMS_SOURCES = Object.freeze(['manual', 'sequence', 'workflow', 'bulk', 'customer']);
const MAX_SMS_TEMPLATES = 50;
// A delivery report moves a message forward only (a late "sent" never undoes "delivered").
const SMS_RANK = Object.freeze({ queued: 0, sent: 1, delivered: 2, failed: 2 });
// An incoming SMS that is only one of these words opts the customer out.
const STOP_WORDS = Object.freeze(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'ruko', 'band', 'बंद', 'रुको']);
// "##name##" blanks in a DLT template's approved text.
const SMS_BLANK = /##([A-Za-z0-9_]{1,30})##/g;

module.exports = { SMS_PROVIDERS, SMS_STATUSES, SMS_SOURCES, MAX_SMS_TEMPLATES, SMS_RANK, STOP_WORDS, SMS_BLANK };
