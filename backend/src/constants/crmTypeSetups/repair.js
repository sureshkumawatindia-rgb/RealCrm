// How the CRM is set up for AC and appliance repair — AC service and installation, washing
// machines, refrigerators, RO water purifiers, geysers (docs/CRM_TYPES_PLAN.md), in English and
// Hindi. The services are the Products list (named Services for this type), with the usual ones at
// price 0 for the business to fill in. AMC contracts are the company's own records, and a new AMC's
// year of services comes in one click from the project template below (the Projects feature, D92).

// Maintenance, repair and installation services: 18% GST (heading 9987; household appliances
// 998715), unchanged on 22 September 2025. Both can be changed on each service.
const SAC = '9987';
const GST_RATE_PCT = 18;
const UNIT = { en: 'unit', hi: 'यूनिट' };
const VISIT = { en: 'visit', hi: 'विज़िट' };
const service = (en, hi, unit) => ({ name: { en, hi }, unit, hsnSac: SAC, gstRatePct: GST_RATE_PCT });
const products = [
  service('Visit charge', 'विज़िट चार्ज', VISIT),
  service('AC service', 'AC सर्विस', UNIT),
  service('AC gas refilling', 'AC गैस भरवाना', UNIT),
  service('AC installation', 'AC इंस्टॉलेशन', UNIT),
  service('AC uninstallation', 'AC अनइंस्टॉलेशन', UNIT),
  service('Washing machine repair', 'वॉशिंग मशीन रिपेयर', VISIT),
  service('Refrigerator repair', 'फ़्रिज रिपेयर', VISIT),
  service('RO water purifier service', 'RO वॉटर प्यूरीफ़ायर सर्विस', VISIT),
  service('Geyser repair', 'गीज़र रिपेयर', VISIT),
  service('AC AMC (yearly)', 'AC AMC (सालाना)', UNIT),
];

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'AC and appliance repair', hi: 'AC और अप्लायंस रिपेयर' },
  about: {
    en: 'Service requests, technician visits, estimates, repairs and AMC.',
    hi: 'सर्विस की पूछताछ, टेक्नीशियन विज़िट, खर्च का अनुमान, रिपेयर और AMC।',
  },
  stages: [
    { kind: 'New', name: { en: 'New request', hi: 'नई रिक्वेस्ट' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Technician assigned', hi: 'टेक्नीशियन तय' }, probability: 30, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Visit done', hi: 'विज़िट हो गई' }, probability: 45, quietDays: 1 },
    { kind: 'Quote Sent', name: { en: 'Estimate shared', hi: 'खर्च बताया' }, probability: 60, quietDays: 2 },
    { kind: 'Negotiation', name: { en: 'Approved, parts awaited', hi: 'मंज़ूर, पार्ट्स का इंतज़ार' }, probability: 80, quietDays: 3 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the problem', hi: 'समस्या पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Please tell us the appliance and its brand, the problem, and your address with a time that suits you, and we will send a technician.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। कृपया उपकरण और उसका ब्रांड, समस्या, और अपना पता व सही समय बताइए — हम टेक्नीशियन भेज देंगे।',
      },
    },
    {
      shortcut: 'visit',
      title: { en: 'Technician visit', hi: 'टेक्नीशियन विज़िट' },
      body: {
        en: 'Our technician ___ (phone ___) will visit you on ___ between ___. Visit charge: ₹___, adjusted in the repair bill.',
        hi: 'हमारे टेक्नीशियन ___ (फ़ोन ___) ___ को ___ के बीच आएँगे। विज़िट चार्ज: ₹___, जो रिपेयर के बिल में एडजस्ट होगा।',
      },
    },
    {
      shortcut: 'estimate',
      title: { en: 'Repair estimate', hi: 'रिपेयर का खर्च' },
      body: {
        en: 'After checking, the repair needs ___. Estimate: ₹___ (parts ₹___ + service ₹___). Shall we go ahead?',
        hi: 'जाँच के बाद रिपेयर में ___ लगेगा। अनुमानित खर्च: ₹___ (पार्ट्स ₹___ + सर्विस ₹___)। क्या हम काम शुरू करें?',
      },
    },
    {
      shortcut: 'parts',
      title: { en: 'Part ordered', hi: 'पार्ट मँगवाया' },
      body: {
        en: 'The part for your ___ has been ordered and should reach us by ___. We will come back to fit it then.',
        hi: 'आपके ___ का पार्ट मँगवा लिया है, जो ___ तक आ जाना चाहिए। तब हम आकर लगा देंगे।',
      },
    },
    {
      shortcut: 'done',
      title: { en: 'Repair done', hi: 'रिपेयर हो गया' },
      body: {
        en: 'Your ___ has been repaired. Warranty on this repair: ___ days. Please message us here if you face any problem.',
        hi: 'आपका ___ ठीक हो गया है। इस रिपेयर पर वारंटी: ___ दिन। कोई भी समस्या हो तो हमें यहीं मैसेज कीजिए।',
      },
    },
    {
      shortcut: 'amc',
      title: { en: 'AMC offer', hi: 'AMC की जानकारी' },
      body: {
        en: 'Our yearly AMC for your AC covers ___ services and priority visits for ₹___. Shall we start it?',
        hi: 'आपके AC के लिए हमारे सालाना AMC में ___ सर्विस और जल्दी विज़िट ₹___ में मिलती हैं। क्या इसे शुरू करें?',
      },
    },
    {
      shortcut: 'service',
      title: { en: 'Service due', hi: 'सर्विस का समय' },
      body: {
        en: 'Namaste {{contact.name}} ji, your ___ is due for its service. Shall we book a visit this week?',
        hi: 'नमस्ते {{contact.name}} जी, आपके ___ की सर्विस का समय हो गया है। क्या इस हफ़्ते विज़िट बुक कर दें?',
      },
    },
    {
      shortcut: 'review',
      title: { en: 'Ask for a review', hi: 'रिव्यू माँगें' },
      body: {
        en: 'Thank you for choosing {{org.name}}! Please leave us a Google review: ___',
        hi: '{{org.name}} को चुनने के लिए धन्यवाद! कृपया Google पर रिव्यू दीजिए: ___',
      },
    },
  ],
  terms: {
    en: [
      '1. The visit charge applies even if no repair is done; it is adjusted in the repair bill when you go ahead.',
      '2. The estimate is made after inspection; parts and labour are charged as per the final bill.',
      "3. Spare parts carry the maker's warranty; our repair warranty is as stated on the bill.",
      '4. Replaced parts are returned to the customer on request.',
      '5. Gas refilling and installation material (pipe, stand, wiring) are charged as used.',
      '6. GST is extra at the applicable rate.',
      '7. This estimate is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. रिपेयर न होने पर भी विज़िट चार्ज लगेगा; काम करवाने पर यह रिपेयर के बिल में एडजस्ट होगा।',
      '2. अनुमान जाँच के बाद दिया जाता है; पार्ट्स और मज़दूरी अंतिम बिल के अनुसार।',
      '3. स्पेयर पार्ट्स पर बनाने वाली कंपनी की वारंटी; हमारे रिपेयर की वारंटी बिल पर लिखे अनुसार।',
      '4. बदले गए पुराने पार्ट्स माँगने पर ग्राहक को लौटाए जाएँगे।',
      '5. गैस भरवाने और इंस्टॉलेशन का सामान (पाइप, स्टैंड, वायरिंग) जितना लगे उतना चार्ज होगा।',
      '6. GST लागू दर से अलग।',
      '7. यह अनुमान दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 7,
};

const APPLIANCES = [
  { en: 'AC', hi: 'AC' },
  { en: 'Washing machine', hi: 'वॉशिंग मशीन' },
  { en: 'Refrigerator', hi: 'फ़्रिज' },
  { en: 'Water purifier (RO)', hi: 'वॉटर प्यूरीफ़ायर (RO)' },
  { en: 'Geyser', hi: 'गीज़र' },
  { en: 'Microwave', hi: 'माइक्रोवेव' },
  { en: 'TV', hi: 'TV' },
  { en: 'Kitchen chimney', hi: 'किचन चिमनी' },
  { en: 'Other', hi: 'अन्य' },
];

// The company's own kinds of record, shown under "Your records". The record's own customer link is
// the customer whose appliances it covers.
const records = [
  {
    singular: { en: 'AMC contract', hi: 'AMC कॉन्ट्रैक्ट' },
    plural: { en: 'AMC contracts', hi: 'AMC कॉन्ट्रैक्ट' },
    icon: 'file-contract',
    fields: [
      { label: { en: 'Appliance', hi: 'उपकरण' }, type: 'dropdown', options: APPLIANCES },
      { label: { en: 'Units', hi: 'कितने यूनिट' }, type: 'number' },
      { label: { en: 'Start date', hi: 'शुरू होने की तारीख' }, type: 'date' },
      { label: { en: 'End date', hi: 'ख़त्म होने की तारीख' }, type: 'date', listColumn: true },
      { label: { en: 'Services in a year', hi: 'साल में सर्विस' }, type: 'number' },
      { label: { en: 'Next service date', hi: 'अगली सर्विस की तारीख' }, type: 'date', listColumn: true },
      { label: { en: 'Contract amount (₹)', hi: 'कॉन्ट्रैक्ट की रकम (₹)' }, type: 'number' },
      {
        label: { en: 'Status', hi: 'स्थिति' },
        type: 'dropdown',
        listColumn: true,
        options: [
          { en: 'Active', hi: 'चालू' },
          { en: 'Renewal due', hi: 'रिन्यूअल बाकी' },
          { en: 'Expired', hi: 'ख़त्म' },
          { en: 'Cancelled', hi: 'रद्द' },
        ],
      },
    ],
  },
];

// Extra fields on an enquiry (a service request).
const fields = [
  { object: 'lead', label: { en: 'Appliance', hi: 'उपकरण' }, type: 'dropdown', listColumn: true, options: APPLIANCES },
  { object: 'lead', label: { en: 'Brand', hi: 'ब्रांड' }, type: 'text' },
  { object: 'lead', label: { en: 'Problem', hi: 'समस्या' }, type: 'text' },
  {
    object: 'lead',
    label: { en: 'Service type', hi: 'काम का प्रकार' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Repair', hi: 'रिपेयर' },
      { en: 'Service', hi: 'सर्विस' },
      { en: 'Installation', hi: 'इंस्टॉलेशन' },
      { en: 'Uninstallation', hi: 'अनइंस्टॉलेशन' },
      { en: 'Gas refilling', hi: 'गैस भरवाना' },
    ],
  },
  { object: 'lead', label: { en: 'Visit date', hi: 'विज़िट की तारीख' }, type: 'date', listColumn: true },
  { object: 'lead', label: { en: 'Technician', hi: 'टेक्नीशियन' }, type: 'text' },
  { object: 'lead', label: { en: 'Under warranty', hi: 'वारंटी में है' }, type: 'checkbox' },
];

// A new AMC's year: Projects → "Start the project" on the won job with this template gives a task
// for each of the three services, a WhatsApp reminder two days before services 2 and 3 (the
// /service quick reply), and the renewal (/amc).
const projectTemplates = [
  {
    name: { en: 'AMC: 3 services a year', hi: 'AMC: साल में 3 सर्विस' },
    days: 365,
    milestones: [
      { name: { en: 'Service 1', hi: 'सर्विस 1' }, dueAfterDays: 0 },
      { name: { en: 'Service 2', hi: 'सर्विस 2' }, dueAfterDays: 120 },
      { name: { en: 'Service 3', hi: 'सर्विस 3' }, dueAfterDays: 240 },
      { name: { en: 'AMC renewal', hi: 'AMC रिन्यूअल' }, dueAfterDays: 365 },
    ],
    tasks: [
      { title: { en: 'Service 1', hi: 'सर्विस 1' }, milestone: 0, dueAfterDays: 0, priority: 'High' },
      { title: { en: 'Send the reminder for service 2 (/service)', hi: 'सर्विस 2 की याद भेजें (/service)' }, milestone: 1, dueAfterDays: 118, priority: 'Medium' },
      { title: { en: 'Service 2', hi: 'सर्विस 2' }, milestone: 1, dueAfterDays: 120, priority: 'High' },
      { title: { en: 'Send the reminder for service 3 (/service)', hi: 'सर्विस 3 की याद भेजें (/service)' }, milestone: 2, dueAfterDays: 238, priority: 'Medium' },
      { title: { en: 'Service 3', hi: 'सर्विस 3' }, milestone: 2, dueAfterDays: 240, priority: 'High' },
      { title: { en: 'Offer the AMC renewal (/amc)', hi: 'AMC रिन्यू करने का ऑफ़र दें (/amc)' }, milestone: 3, dueAfterDays: 335, priority: 'High' },
      { title: { en: 'Renew the AMC', hi: 'AMC रिन्यू करें' }, milestone: 3, dueAfterDays: 365, priority: 'High' },
    ],
  },
];

module.exports = { kit, products, fields, records, projectTemplates, hiddenModules: [] };
