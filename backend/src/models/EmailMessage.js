const mongoose = require('mongoose');

// An email between a member and the company's customers, from that member's Gmail (Phase 9A,
// D90). Only messages with a customer's address are kept, and only their headers and Gmail's
// snippet (never the body or attachments). One per (connection, Gmail message): a message seen
// again by a later sync is not stored twice. shared: the team sees it on the customer's history
// (the member's choice); otherwise only that member does.
const { ObjectId } = mongoose.Schema.Types;

const emailMessageSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    connectionId: { type: ObjectId, ref: 'GmailConnection', required: true },
    userId: { type: ObjectId, ref: 'User', required: true },
    memberId: { type: ObjectId, ref: 'OrganizationMember' },
    gmailMessageId: { type: String, required: true },
    threadId: { type: String, default: '' },
    direction: { type: String, enum: ['in', 'out'], required: true },
    from: { type: String, default: '' },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    subject: { type: String, default: '', maxlength: 500 },
    snippet: { type: String, default: '', maxlength: 1000 },
    sentAt: { type: Date, required: true },
    contactIds: { type: [ObjectId], ref: 'Contact', default: [] },
    leadIds: { type: [ObjectId], ref: 'Lead', default: [] },
    shared: { type: Boolean, default: true },
  },
  { timestamps: true },
);

emailMessageSchema.index({ connectionId: 1, gmailMessageId: 1 }, { unique: true });
emailMessageSchema.index({ organizationId: 1, contactIds: 1, sentAt: -1 });
emailMessageSchema.index({ organizationId: 1, threadId: 1, sentAt: 1 });

module.exports = mongoose.model('EmailMessage', emailMessageSchema);
