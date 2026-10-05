const mongoose = require('mongoose');

// A saved audience (Phase 7), e.g. "Tier A – Rajasthan": the customers whose details match all
// the filled-in filters, worked out when it is used (so new customers join on their own).
// Broadcasts send to a segment; customers who opted out are never included (D35).
const { ObjectId } = mongoose.Schema.Types;

const segmentSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    filters: {
      tagsAll: { type: [String], default: [] }, // has every one of these tags
      tagsAny: { type: [String], default: [] }, // has at least one
      tagsNone: { type: [String], default: [] }, // has none of these
      states: { type: [String], default: [] },
      cities: { type: [String], default: [] },
      sources: { type: [String], default: [] },
      lifecycles: { type: [String], default: [] }, // lead | customer
      ownerIds: { type: [ObjectId], default: [] },
      productIds: { type: [ObjectId], default: [] }, // interested in, or has a lead for
      productCategories: { type: [String], default: [] },
      leadStages: { type: [String], default: [] }, // has a lead in one of these stages
      consent: { type: String, enum: ['not_opted_out', 'opted_in'], default: 'not_opted_out' },
    },
    createdById: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

segmentSchema.index({ organizationId: 1, name: 1 });

module.exports = mongoose.model('Segment', segmentSchema);
