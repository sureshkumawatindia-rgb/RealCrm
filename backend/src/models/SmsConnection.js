const mongoose = require('mongoose');
const { SMS_PROVIDERS } = require('../constants/sms');

// The company's SMS account (Phase 8A, D88), Settings → SMS (owners and admins): MSG91 with the
// company's own auth key (encrypted, never sent back) and sender ID, and the DLT-approved
// templates it may send (each with MSG91's template id and the approved text with ##blanks##).
// Delivery reports and replies come to an address that carries webhookKey.
const templateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true }, // stable, made by the server
    name: { type: String, required: true, trim: true, maxlength: 80 },
    flowId: { type: String, trim: true, maxlength: 64, default: '' }, // MSG91's template (flow) id
    dltTemplateId: { type: String, trim: true, maxlength: 40, default: '' },
    text: { type: String, required: true, maxlength: 1000 },
    variables: { type: [String], default: [] },
  },
  { _id: false },
);

const smsConnectionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true },
    provider: { type: String, enum: SMS_PROVIDERS, required: true },
    authKeyEnc: { type: String },
    senderId: { type: String, trim: true, maxlength: 6, default: '' },
    templates: { type: [templateSchema], default: [] },
    webhookKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ['active', 'error'], default: 'active' },
    lastError: { type: String, default: '' },
    lastSentAt: { type: Date },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('SmsConnection', smsConnectionSchema);
