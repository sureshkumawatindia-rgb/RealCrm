const mongoose = require('mongoose');

// A power-dialer session (Phase 8B, D89): one member's list of customers to call one after
// another. Each item is a lead and its customer; it is done when its outcome is saved (on the
// call placed for it, or a call logged by hand), or skipped. Nothing is ever dialed by itself:
// each call is a press of "Call".
const { ObjectId } = mongoose.Schema.Types;

const itemSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: 'Lead', required: true },
    contactId: { type: ObjectId, ref: 'Contact', required: true },
    label: { type: String, default: '' }, // the customer's name
    title: { type: String, default: '' }, // the deal
    status: { type: String, enum: ['pending', 'done', 'skipped'], default: 'pending' },
    callId: { type: ObjectId, ref: 'Call' },
    outcome: { type: String, default: '' },
    reason: { type: String, default: '' }, // why it was skipped
    at: { type: Date },
  },
  { _id: false },
);

const dialerSessionSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    memberId: { type: ObjectId, ref: 'OrganizationMember', required: true },
    name: { type: String, trim: true, maxlength: 80, default: '' },
    items: { type: [itemSchema], default: [] },
    status: { type: String, enum: ['active', 'finished'], default: 'active' },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

dialerSessionSchema.index({ organizationId: 1, memberId: 1, createdAt: -1 });

module.exports = mongoose.model('DialerSession', dialerSessionSchema);
