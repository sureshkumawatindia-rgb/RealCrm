// How the CRM is set up for a trader or wholesaler (docs/CRM_TYPES_PLAN.md), in English and Hindi.
// Its sales stages, quick replies and quotation terms are the trader kit that "Ready settings"
// already offers (KITS.trader in constants/businessKits.js). What a trader sells is their own, so
// no products are added. A customer already has GSTIN, city and address, and an enquiry already
// has a quantity and a closing date, so those are not added again.
const { creditFields, neededBy, transporters } = require('./shared');

const fields = [
  {
    object: 'contact',
    label: { en: 'Customer type', hi: 'ग्राहक का प्रकार' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Retailer', hi: 'रिटेलर' },
      { en: 'Wholesaler', hi: 'होलसेलर' },
      { en: 'Distributor', hi: 'डिस्ट्रीब्यूटर' },
      { en: 'Contractor', hi: 'कॉन्ट्रैक्टर' },
      { en: 'Factory', hi: 'फ़ैक्ट्री' },
      { en: 'Institution', hi: 'संस्था' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  ...creditFields,
  { object: 'contact', label: { en: 'Area or route', hi: 'इलाका या रूट' }, type: 'text' },
  { object: 'lead', label: { en: 'Delivery city', hi: 'डिलीवरी का शहर' }, type: 'text' },
  neededBy,
];

// Pages this kind of business does not use. They can be switched back on in Settings → Team & Access.
const hiddenModules = ['projects'];

module.exports = { products: [], fields, records: [transporters], hiddenModules };
