const mongoose = require('mongoose');

// A private number (D61): a personal chat (family, friends) that came in with the company's
// WhatsApp Business app number. Only owners see its contact, leads and chats; new messages from
// it stay private and run no automation, bot, auto-reply, lead creation or notification; reports
// leave it out. An owner adds one from a chat or in Settings → WhatsApp, and can remove it again.
const privateNumberSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    phoneE164: { type: String, required: true },
    note: { type: String, trim: true, default: '' },
    addedById: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

privateNumberSchema.index({ organizationId: 1, phoneE164: 1 }, { unique: true });

module.exports = mongoose.model('PrivateNumber', privateNumberSchema);
