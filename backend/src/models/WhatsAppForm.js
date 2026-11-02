const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

const { ObjectId } = mongoose.Schema.Types;

// A form inside WhatsApp (G6, D110: Meta's WhatsApp Flows, services/whatsappFormService.js): an
// enquiry form (its answers fill the customer and their lead) or an order form (a product and a
// quantity become an order). Owners and admins make it in Settings → WhatsApp and publish it; the
// CRM then makes a Flow on each WhatsApp Business Account of the company (flows; a published Flow
// cannot change, so publishing again makes new ones and retires the old). dirty: changed since it
// was published (the live version still goes out until it is published again). Teammates send it
// in a chat; the answers come back as a message.
const fieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true, trim: true },
    on: { type: Boolean, default: true },
    required: { type: Boolean, default: false },
  },
  { _id: false },
);

const flowSchema = new mongoose.Schema(
  {
    wabaId: { type: String, default: '' }, // the WhatsApp Business Account (a test number: its phone number id)
    accountId: { type: ObjectId, ref: 'WhatsAppAccount' },
    flowId: { type: String, default: '' },
    status: { type: String, default: '' }, // PUBLISHED, DEPRECATED or ERROR
    error: { type: String, default: '' },
    publishedAt: { type: Date },
  },
  { _id: false },
);

const whatsappFormSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    kind: { type: String, enum: ['enquiry', 'order'], required: true },
    name: { type: String, required: true, trim: true },
    intro: { type: String, default: '' }, // the message text above the button
    cta: { type: String, default: '' }, // the button
    heading: { type: String, default: '' }, // the form's heading
    submitLabel: { type: String, default: '' },
    thanks: { type: String, default: '' }, // sent after the answers (empty: nothing)
    fields: { type: [fieldSchema], default: [] },
    productIds: { type: [ObjectId], default: [] }, // an order form's products
    status: { type: String, enum: ['draft', 'published', 'error'], default: 'draft' },
    dirty: { type: Boolean, default: false },
    flows: { type: [flowSchema], default: [] },
    version: { type: Number, default: 0 },
    error: { type: String, default: '' },
    publishedAt: { type: Date },
    sentCount: { type: Number, default: 0 },
    answerCount: { type: Number, default: 0 },
    lastAnswerAt: { type: Date },
    createdById: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

whatsappFormSchema.plugin(softDelete);
whatsappFormSchema.index({ organizationId: 1, deletedAt: 1, createdAt: -1 });

module.exports = mongoose.model('WhatsAppForm', whatsappFormSchema);
