const mongoose = require('mongoose');

// A WhatsApp text a teammate wrote to go later (D103, "send later"). A job sends it at sendAt as
// that teammate, if the customer's 24-hour window is still open then; if not, it stays unsent
// (window_closed) and the teammate gets a bell note to send a template instead. It can be edited
// or cancelled until it goes. version: an edit makes the waiting job for the old time do nothing.
const { ObjectId } = mongoose.Schema.Types;

const scheduledMessageSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    conversationId: { type: ObjectId, ref: 'Conversation', required: true },
    contactId: { type: ObjectId, ref: 'Contact', required: true },
    memberId: { type: ObjectId, ref: 'OrganizationMember', required: true }, // who wrote it; it goes as theirs
    memberName: { type: String, default: '' },
    text: { type: String, required: true },
    sendAt: { type: Date, required: true },
    status: { type: String, enum: ['scheduled', 'sending', 'sent', 'cancelled', 'window_closed', 'failed'], default: 'scheduled' },
    version: { type: Number, default: 1 },
    messageId: { type: ObjectId, ref: 'Message' }, // once sent
    error: { type: String, default: '' },
    doneAt: { type: Date },
  },
  { timestamps: true },
);

scheduledMessageSchema.index({ organizationId: 1, conversationId: 1, status: 1, sendAt: 1 });
scheduledMessageSchema.index({ organizationId: 1, memberId: 1, status: 1 });

module.exports = mongoose.model('ScheduledMessage', scheduledMessageSchema);
