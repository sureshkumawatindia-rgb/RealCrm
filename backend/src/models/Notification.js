const mongoose = require('mongoose');

// A message for one team member in the CRM's bell (Phase 6, D31): from an automation's
// "notify" step today. link opens the record (a lead, chat, order …).
const notificationSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember', required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, default: '' },
    link: { type: String, default: '' },
    source: { type: String, default: '' }, // e.g. "workflow:<id>"
    readAt: { type: Date },
  },
  { timestamps: true },
);

notificationSchema.index({ organizationId: 1, memberId: 1, createdAt: -1 });
notificationSchema.index({ organizationId: 1, memberId: 1, readAt: 1 });
// Kept for 90 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('Notification', notificationSchema);
