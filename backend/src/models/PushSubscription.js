const mongoose = require('mongoose');

// One browser or installed app that gets the bell's notes as web push (Phase 10E), for one
// member of one organization. The endpoint is the push service's address for that browser.
const pushSubscriptionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    endpoint: { type: String, required: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, default: '' },
    lastSuccessAt: Date,
    failures: { type: Number, default: 0 },
  },
  { timestamps: true },
);

pushSubscriptionSchema.index({ endpoint: 1 }, { unique: true });
pushSubscriptionSchema.index({ organizationId: 1, memberId: 1 });

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
