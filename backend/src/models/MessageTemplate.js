const mongoose = require('mongoose');

// A WhatsApp message template, as Meta has it (synced, or created here and submitted for
// approval). Only APPROVED templates can be sent; they are the only messages allowed outside
// the 24-hour window. components is Meta's own list (HEADER / BODY / FOOTER / BUTTONS).
const messageTemplateSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    whatsappAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppAccount', required: true },
    providerTemplateId: { type: String, default: '' },
    name: { type: String, required: true },
    language: { type: String, required: true },
    category: { type: String, default: '' },
    // APPROVED, PENDING, REJECTED, PAUSED, DISABLED, ... (Meta's value, upper case).
    status: { type: String, default: 'PENDING' },
    parameterFormat: { type: String, enum: ['POSITIONAL', 'NAMED'], default: 'POSITIONAL' },
    components: { type: [mongoose.Schema.Types.Mixed], default: [] },
    rejectedReason: { type: String, default: '' },
    qualityScore: { type: String, default: '' },
    lastSyncedAt: { type: Date },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

messageTemplateSchema.index({ organizationId: 1, whatsappAccountId: 1, name: 1, language: 1 }, { unique: true });
messageTemplateSchema.index({ organizationId: 1, providerTemplateId: 1 });

module.exports = mongoose.model('MessageTemplate', messageTemplateSchema);
