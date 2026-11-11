// Parts of a CRM type's set-up that more than one type uses (docs/CRM_TYPES_PLAN.md).

// Credit given to a customer: how much, and for how many days.
const creditFields = [
  { object: 'contact', label: { en: 'Credit limit (₹)', hi: 'उधार की सीमा (₹)' }, type: 'number' },
  { object: 'contact', label: { en: 'Credit days', hi: 'उधार के दिन' }, type: 'number' },
];

// When the customer wants the goods (an enquiry's own closing date is when the sale is expected).
const neededBy = { object: 'lead', label: { en: 'Needed by', hi: 'कब तक चाहिए' }, type: 'date' };

// The transport companies goods go with. An order keeps its own transporter and LR number; this is
// the list to pick them from. A record has its own customer link, so none of these asks for one.
const transporters = {
  singular: { en: 'Transporter', hi: 'ट्रांसपोर्टर' },
  plural: { en: 'Transporters', hi: 'ट्रांसपोर्टर' },
  icon: 'truck',
  fields: [
    { label: { en: 'Phone', hi: 'फ़ोन' }, type: 'text', listColumn: true },
    { label: { en: 'Cities served', hi: 'किन शहरों में जाते हैं' }, type: 'text', listColumn: true },
    { label: { en: 'Freight rate', hi: 'भाड़े का रेट' }, type: 'text' },
  ],
};

module.exports = { creditFields, neededBy, transporters };
