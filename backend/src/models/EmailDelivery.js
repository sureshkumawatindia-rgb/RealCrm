const mongoose = require('mongoose');

// One email from the platform (D104) to one person, through Resend: a team invite, a trial or
// payment note, a plan invoice, a deletion warning or a new-login alert. Written when it is
// queued, rendered and sent by the job queue (retries on Resend's rate limit and outages).
// skipped = not sent because RESEND_API_KEY or EMAIL_FROM is not set (or the person switched that
// email off). Secrets in data (an invite link) are encrypted and removed once sent. Kept 180 days.
const emailDeliverySchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    kind: { type: String, required: true },
    to: { type: String, required: true, lowercase: true, trim: true },
    language: { type: String, enum: ['en', 'hi'], default: 'en' },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    subject: { type: String, default: '' },
    status: { type: String, enum: ['queued', 'sent', 'failed', 'skipped'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    providerId: { type: String, default: '' },
    error: { type: String, default: '' },
    sentAt: Date,
    // The same email is never sent twice (e.g. one trial reminder per level per person).
    dedupeKey: { type: String },
  },
  { timestamps: true, minimize: false },
);

emailDeliverySchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
emailDeliverySchema.index({ status: 1, createdAt: -1 });
emailDeliverySchema.index({ organizationId: 1, createdAt: -1 });
emailDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('EmailDelivery', emailDeliverySchema);
