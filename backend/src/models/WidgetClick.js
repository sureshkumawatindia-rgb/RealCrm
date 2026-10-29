const mongoose = require('mongoose');

// A click on the website's WhatsApp button (D102): the short code the button put in the
// customer's ready message, and the page they were on (with its campaign tags). When the message
// arrives with the code, the new lead's source is "Website widget" and its touch is this page.
// No cookie and nothing about the visitor beyond the page; kept 30 days.
const { ObjectId } = mongoose.Schema.Types;
const short = { type: String, trim: true, maxlength: 200 };

const widgetClickSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    connectionId: { type: ObjectId, ref: 'LeadSourceConnection', required: true },
    code: { type: String, required: true }, // 6 letters and digits, e.g. 7K2Q9X
    page: { type: String, trim: true, maxlength: 500, default: '' },
    referrer: { type: String, trim: true, maxlength: 500, default: '' },
    utm: { source: short, medium: short, campaign: short, term: short, content: short },
    clickIds: { gclid: short, fbclid: short },
    usedAt: { type: Date },
    contactId: { type: ObjectId, ref: 'Contact' },
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

widgetClickSchema.index({ organizationId: 1, code: 1 }, { unique: true });
widgetClickSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('WidgetClick', widgetClickSchema);
