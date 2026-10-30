const mongoose = require('mongoose');

// "How was our service?" after a chat was resolved (D103, CSAT): asked with three WhatsApp buttons
// (Good / Okay / Bad) when the company switched it on, inside the customer's 24-hour window, at
// most once a day per customer, never on a private number. The answer counts for memberId (the
// chat's teammate when it was resolved) in Team live, My performance and Reports.
const { ObjectId } = mongoose.Schema.Types;

const csatSurveySchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    conversationId: { type: ObjectId, ref: 'Conversation', required: true },
    contactId: { type: ObjectId, ref: 'Contact', required: true },
    memberId: { type: ObjectId, ref: 'OrganizationMember' },
    askedAt: { type: Date, required: true },
    messageId: { type: ObjectId, ref: 'Message' }, // the question we sent
    rating: { type: String, enum: ['good', 'okay', 'bad'] },
    answeredAt: { type: Date },
  },
  { timestamps: true },
);

csatSurveySchema.index({ organizationId: 1, contactId: 1, askedAt: -1 });
csatSurveySchema.index({ organizationId: 1, answeredAt: -1, memberId: 1 });

module.exports = mongoose.model('CsatSurvey', csatSurveySchema);
