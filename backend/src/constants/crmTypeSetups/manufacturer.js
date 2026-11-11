// How the CRM is set up for a manufacturer (docs/CRM_TYPES_PLAN.md), in English and Hindi. Its sales
// stages, quick replies and quotation terms are the manufacturer kit that "Ready settings" already
// offers (KITS.manufacturer in constants/businessKits.js). What a manufacturer makes is their own,
// so no products are added. Projects stays in the menu: a won order becomes a production project
// in one click from the template below (the Projects feature, D92).
const { creditFields, neededBy, transporters } = require('./shared');

const fields = [
  {
    object: 'contact',
    label: { en: 'Customer type', hi: 'ग्राहक का प्रकार' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Distributor', hi: 'डिस्ट्रीब्यूटर' },
      { en: 'Dealer', hi: 'डीलर' },
      { en: 'Wholesaler', hi: 'होलसेलर' },
      { en: 'Retailer', hi: 'रिटेलर' },
      { en: 'OEM or brand', hi: 'OEM या ब्रांड' },
      { en: 'Exporter', hi: 'एक्सपोर्टर' },
      { en: 'Government or institution', hi: 'सरकारी या संस्था' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  ...creditFields,
  { object: 'lead', label: { en: 'Size or specification', hi: 'साइज़ या स्पेसिफ़िकेशन' }, type: 'text' },
  {
    object: 'lead',
    label: { en: 'Sample status', hi: 'सैंपल की स्थिति' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Not needed', hi: 'नहीं चाहिए' },
      { en: 'Asked for', hi: 'माँगा' },
      { en: 'Sent', hi: 'भेजा' },
      { en: 'Approved', hi: 'मंज़ूर' },
      { en: 'Rejected', hi: 'नामंज़ूर' },
    ],
  },
  neededBy,
];

// A won order's production, step by step: Projects → "Start the project" on the won enquiry.
const projectTemplates = [
  {
    name: { en: 'Production order', hi: 'प्रोडक्शन ऑर्डर' },
    days: 21,
    milestones: [
      { name: { en: 'Order confirmed', hi: 'ऑर्डर पक्का' }, dueAfterDays: 0 },
      { name: { en: 'Raw material ready', hi: 'कच्चा माल तैयार' }, dueAfterDays: 5 },
      { name: { en: 'Production done', hi: 'माल बनकर तैयार' }, dueAfterDays: 15 },
      { name: { en: 'Quality checked and packed', hi: 'क्वालिटी चेक और पैकिंग पूरी' }, dueAfterDays: 18 },
      { name: { en: 'Dispatched', hi: 'माल रवाना' }, dueAfterDays: 21 },
    ],
    tasks: [
      {
        title: { en: 'Confirm the PO, quantity, sizes and delivery date with the customer', hi: 'ग्राहक से PO, मात्रा, साइज़ और डिलीवरी की तारीख पक्की करें' },
        milestone: 0,
        dueAfterDays: 0,
        priority: 'High',
      },
      { title: { en: 'Order the raw material', hi: 'कच्चा माल मँगवाएँ' }, milestone: 1, dueAfterDays: 2, priority: 'Medium' },
      { title: { en: 'Start production', hi: 'माल बनाना शुरू करें' }, milestone: 2, dueAfterDays: 5, priority: 'Medium' },
      { title: { en: 'Check the goods against the approved sample', hi: 'माल को मंज़ूर सैंपल से मिलाकर जाँचें' }, milestone: 3, dueAfterDays: 17, priority: 'High' },
      {
        title: { en: 'Send the invoice, e-way bill and transport details to the customer', hi: 'ग्राहक को इनवॉइस, ई-वे बिल और ट्रांसपोर्ट की जानकारी भेजें' },
        milestone: 4,
        dueAfterDays: 21,
        priority: 'Medium',
      },
    ],
  },
];

module.exports = { products: [], fields, records: [transporters], projectTemplates, hiddenModules: [] };
