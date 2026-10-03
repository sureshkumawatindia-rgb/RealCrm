const mongoose = require('mongoose');

// The parts quotations and orders share (Phase 5): priced lines, the customer and seller as
// they were on the document, the place of supply and the totals. Amounts are integer paise
// computed by utils/gst.
const { ObjectId } = mongoose.Schema.Types;

const itemSchema = new mongoose.Schema(
  {
    productId: { type: ObjectId, ref: 'Product' },
    name: { type: String, default: '' },
    description: { type: String, default: '' },
    hsnSac: { type: String, default: '' },
    unit: { type: String, default: '' },
    quantity: { type: Number, min: 0, required: true },
    unitPricePaise: { type: Number, min: 0, required: true },
    discountType: { type: String, enum: ['amount', 'percent'], default: 'amount' },
    discountValue: { type: Number, min: 0, default: 0 }, // paise, or a percentage
    subtotalPaise: { type: Number, required: true }, // quantity × price
    discountPaise: { type: Number, default: 0 },
    taxablePaise: { type: Number, default: 0 },
    gstRatePct: { type: Number, min: 0, max: 100, default: 0 },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 }, // SGST or UTGST (supply.taxLabel)
    igstPaise: { type: Number, default: 0 },
    taxPaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
  },
  { _id: false },
);

const partySchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    company: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    gstin: { type: String, default: '' },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    stateCode: { type: String, default: '' },
    postalCode: { type: String, default: '' },
  },
  { _id: false },
);

const supplySchema = new mongoose.Schema(
  {
    sellerStateCode: { type: String, default: '' },
    placeOfSupplyCode: { type: String, default: '' },
    interState: { type: Boolean, default: false },
    zeroRated: { type: Boolean, default: false }, // export / SEZ under LUT: no GST
    taxLabel: { type: String, enum: ['SGST', 'UTGST'], default: 'SGST' },
    stateAssumed: { type: Boolean, default: false }, // D30
  },
  { _id: false },
);

const rateSchema = new mongoose.Schema(
  { ratePct: Number, taxablePaise: Number, cgstPaise: Number, sgstPaise: Number, igstPaise: Number, taxPaise: Number },
  { _id: false },
);

const totalsSchema = new mongoose.Schema(
  {
    subtotalPaise: { type: Number, default: 0 },
    discountPaise: { type: Number, default: 0 },
    taxablePaise: { type: Number, default: 0 },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    taxPaise: { type: Number, default: 0 },
    roundOffPaise: { type: Number, default: 0 },
    grandTotalPaise: { type: Number, default: 0 },
    byRate: { type: [rateSchema], default: [] },
  },
  { _id: false },
);

const sellerSchema = new mongoose.Schema(
  {
    name: String, gstin: String, address: String, city: String, state: String, stateCode: String,
    postalCode: String, phone: String, email: String,
  },
  { _id: false },
);

module.exports = { itemSchema, partySchema, supplySchema, rateSchema, totalsSchema, sellerSchema };
