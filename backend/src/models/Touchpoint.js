const mongoose = require('mongoose');
const { LEAD_SOURCES, CHANNELS } = require('../constants/crm');

// One way a customer reached the company (Phase 2, D79): every enquiry that comes in through a
// lead source, the website form or the API leaves one, with its campaign tags, click ids,
// referrer and landing page. Leads keep their first and last touch; customers their first.
const { ObjectId } = mongoose.Schema.Types;
const short = { type: String, trim: true, maxlength: 200 };
const url = { type: String, trim: true, maxlength: 500 };

const touchpointSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    contactId: { type: ObjectId, ref: 'Contact', required: true },
    leadId: { type: ObjectId, ref: 'Lead' },
    intakeId: { type: ObjectId, ref: 'LeadIntake' },
    source: { type: String, enum: LEAD_SOURCES, required: true },
    channel: { type: String, enum: CHANNELS, required: true },
    utm: { source: short, medium: short, campaign: short, term: short, content: short },
    clickIds: { gclid: short, fbclid: short },
    referrer: url,
    landingPage: url,
    // From an ad platform: Facebook's ad and form, Google Ads' campaign.
    ad: { id: short, name: short, formName: short, campaignId: short },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

touchpointSchema.index({ organizationId: 1, contactId: 1, at: -1 });
touchpointSchema.index({ organizationId: 1, at: -1 });

module.exports = mongoose.model('Touchpoint', touchpointSchema);
