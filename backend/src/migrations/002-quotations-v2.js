const Contact = require('../models/Contact');
const Organization = require('../models/Organization');
const Quotation = require('../models/Quotation');
const { supplyFor } = require('../utils/gst');
const { stateCodeFor, stateName } = require('../constants/gst');
const { stateCodeFromGstin } = require('../utils/gstin');
const { sellerStateCode } = require('../services/organizationService');

// Phase 2 quotations (one tax % per line) get the Phase 5 shape: the tax split into CGST +
// SGST or IGST (by the organization's and the customer's states), taxable values, the rate
// summary, the customer and seller details, type "Quotation", revision 0. Their amounts do
// not change: no round-off, and each line keeps its tax total. Idempotent: only quotations
// without schemaVersion 2 are touched.
async function up() {
  const cursor = Quotation.collection.find({ schemaVersion: { $ne: 2 } });
  const orgs = new Map();
  let updated = 0;
  for await (const doc of cursor) {
    const key = String(doc.organizationId);
    if (!orgs.has(key)) orgs.set(key, await Organization.findById(doc.organizationId));
    const org = orgs.get(key);
    const contact = doc.contactId ? await Contact.collection.findOne({ _id: doc.contactId }) : null;
    const buyerCode = stateCodeFromGstin(contact?.gstin) || contact?.stateCode || stateCodeFor(contact?.state);
    const supply = supplyFor({ sellerStateCode: sellerStateCode(org), buyerStateCode: buyerCode });

    const items = (doc.items || []).map((item) => {
      const subtotalPaise = item.subtotalPaise || 0;
      const discountPaise = item.discountPaise || 0;
      const taxPaise = item.taxPaise || 0;
      const cgstPaise = supply.interState ? 0 : Math.floor(taxPaise / 2);
      return {
        productId: item.productId, name: item.name || 'Item', description: '', hsnSac: '', unit: '',
        quantity: item.quantity, unitPricePaise: item.unitPricePaise, discountType: 'amount', discountValue: discountPaise,
        subtotalPaise, discountPaise, taxablePaise: subtotalPaise - discountPaise, gstRatePct: item.taxRatePct ?? item.gstRatePct ?? 0,
        cgstPaise, sgstPaise: supply.interState ? 0 : taxPaise - cgstPaise, igstPaise: supply.interState ? taxPaise : 0,
        taxPaise, totalPaise: item.totalPaise ?? subtotalPaise - discountPaise + taxPaise,
      };
    });
    const sum = (field, list = items) => list.reduce((total, line) => total + (line[field] || 0), 0);
    const byRate = [...new Set(items.map((line) => line.gstRatePct))].sort((a, b) => a - b).map((ratePct) => {
      const group = items.filter((line) => line.gstRatePct === ratePct);
      return { ratePct, taxablePaise: sum('taxablePaise', group), cgstPaise: sum('cgstPaise', group), sgstPaise: sum('sgstPaise', group), igstPaise: sum('igstPaise', group), taxPaise: sum('taxPaise', group) };
    });
    const { warnings, placeOfSupply, ...storedSupply } = supply;
    await Quotation.collection.updateOne({ _id: doc._id }, {
      $set: {
        type: doc.type || 'Quotation',
        revision: doc.revision || 0,
        revisions: doc.revisions || [],
        roundOff: false,
        items,
        totals: {
          subtotalPaise: sum('subtotalPaise'), discountPaise: sum('discountPaise'), taxablePaise: sum('taxablePaise'),
          cgstPaise: sum('cgstPaise'), sgstPaise: sum('sgstPaise'), igstPaise: sum('igstPaise'), taxPaise: sum('taxPaise'),
          roundOffPaise: 0, grandTotalPaise: sum('totalPaise'), byRate,
        },
        supply: storedSupply,
        placeOfSupplyCode: '',
        billTo: {
          name: contact?.name || '', company: contact?.company || '', phone: contact?.phone || '', email: contact?.email || '',
          gstin: contact?.gstin || '', address: contact?.address || '', city: contact?.city || '', state: contact?.state || stateName(buyerCode),
          stateCode: buyerCode, postalCode: '',
        },
        seller: {
          name: org?.name || '', gstin: org?.gstin || '', address: org?.address || '', city: org?.city || '',
          state: stateName(supply.sellerStateCode) || org?.state || '', stateCode: supply.sellerStateCode, postalCode: org?.postalCode || '', phone: org?.phone || '', email: org?.email || '',
        },
        terms: doc.terms || '',
        notes: doc.notes || '',
        viewCount: doc.viewCount || 0,
        schemaVersion: 2,
      },
    });
    updated += 1;
  }
  return { updated };
}

module.exports = { name: '002-quotations-v2', up };
