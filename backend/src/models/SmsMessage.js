const mongoose = require('mongoose');
const { SMS_STATUSES, SMS_SOURCES, SMS_PROVIDERS } = require('../constants/sms');

// One SMS to or from a customer (Phase 8A, D88). idempotencyKey makes a send happen once: a
// retried sequence step or a double click finds the message already there. A delivery report is
// matched by (company, provider, providerMessageId) and only moves the status forward.
const { ObjectId } = mongoose.Schema.Types;

const smsMessageSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    contactId: { type: ObjectId, ref: 'Contact' },
    leadId: { type: ObjectId, ref: 'Lead' },
    memberId: { type: ObjectId, ref: 'OrganizationMember' },
    direction: { type: String, enum: ['out', 'in'], default: 'out' },
    source: { type: String, enum: SMS_SOURCES, default: 'manual' },
    templateKey: { type: String, default: '' },
    templateName: { type: String, default: '' },
    text: { type: String, default: '', maxlength: 2000 },
    to: { type: String, default: '' },
    from: { type: String, default: '' },
    status: { type: String, enum: SMS_STATUSES, default: 'queued' },
    provider: { type: String, enum: SMS_PROVIDERS },
    providerMessageId: { type: String },
    idempotencyKey: { type: String },
    retryable: { type: Boolean, default: false },
    enrollmentId: { type: ObjectId, ref: 'SequenceEnrollment' },
    runId: { type: ObjectId, ref: 'AutomationRun' },
    error: { type: String, default: '' },
    sentAt: { type: Date },
    deliveredAt: { type: Date },
  },
  { timestamps: true },
);

smsMessageSchema.index({ organizationId: 1, contactId: 1, createdAt: -1 });
smsMessageSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
smsMessageSchema.index({ organizationId: 1, provider: 1, providerMessageId: 1 }, { unique: true, partialFilterExpression: { providerMessageId: { $type: 'string' } } });

module.exports = mongoose.model('SmsMessage', smsMessageSchema);
