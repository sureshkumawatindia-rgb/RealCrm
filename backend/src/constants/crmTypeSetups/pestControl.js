// How the CRM is set up for a pest control company (docs/CRM_TYPES_PLAN.md), in English and Hindi.
// services/crmTypeService.js applies it when a company chooses this CRM type, and only ever fills
// what the company does not have yet. A "___" in a quick reply is for the person to fill in before
// sending; {{contact.name}} and {{org.name}} fill themselves.

// What a company charges is its own, so prices start at 0. 998531: disinfecting and exterminating
// services; 18% GST. Both can be changed on the treatment.
const SAC_CODE = '998531';
const GST_RATE_PCT = 18;

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Pest control', hi: 'पेस्ट कंट्रोल' },
  about: {
    en: 'Enquiries, site inspections, treatments and AMC contracts.',
    hi: 'पूछताछ, साइट निरीक्षण, ट्रीटमेंट और AMC कॉन्ट्रैक्ट।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Site inspection', hi: 'साइट निरीक्षण' }, probability: 30, quietDays: 2 },
    { kind: 'Quote Sent', name: { en: 'Quotation sent', hi: 'कोटेशन भेजा' }, probability: 50, quietDays: 3 },
    { kind: 'Negotiation', name: { en: 'Treatment booked', hi: 'ट्रीटमेंट बुक' }, probability: 85, quietDays: 3 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask for details', hi: 'जानकारी पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Please tell us which pest you are facing, the type of property and its area in sq ft, and we will share the charges.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। कृपया बताइए कौन-सा कीट परेशान कर रहा है, प्रॉपर्टी किस तरह की है और उसका एरिया कितने वर्ग फ़ुट है, हम आपको चार्ज बता देंगे।',
      },
    },
    {
      shortcut: 'inspection',
      title: { en: 'Site inspection', hi: 'साइट निरीक्षण' },
      body: {
        en: 'Our team can inspect your property on ___ at ___. Please confirm if this time suits you.',
        hi: 'हमारी टीम ___ को ___ बजे आपकी प्रॉपर्टी का निरीक्षण कर सकती है। कृपया बताइए यह समय ठीक है या नहीं।',
      },
    },
    {
      shortcut: 'precautions',
      title: { en: 'Precautions', hi: 'सावधानियाँ' },
      body: {
        en: 'Before the treatment, please put away food and utensils and keep children and pets out of the area. After it, keep the rooms closed for ___ hours and do not wash the treated spots for ___ days.',
        hi: 'ट्रीटमेंट से पहले खाने का सामान और बर्तन हटा दीजिए और बच्चों व पालतू जानवरों को उस जगह से दूर रखिए। ट्रीटमेंट के बाद कमरे ___ घंटे बंद रखिए और जिन जगहों पर दवा लगी है उन्हें ___ दिन तक न धोइए।',
      },
    },
    {
      shortcut: 'visit',
      title: { en: 'Visit reminder', hi: 'विज़िट की याद' },
      body: {
        en: 'Reminder: your pest control service is on ___ at ___. Our technician ___ will reach your place.',
        hi: 'याद दिला दें: आपकी पेस्ट कंट्रोल सर्विस ___ को ___ बजे है। हमारे टेक्नीशियन ___ आपके यहाँ पहुँचेंगे।',
      },
    },
    {
      shortcut: 'done',
      title: { en: 'Treatment done', hi: 'ट्रीटमेंट पूरा' },
      body: {
        en: 'Your treatment is complete. If the problem comes back within ___ days, message us here and we will check it again.',
        hi: 'आपका ट्रीटमेंट पूरा हो गया है। अगर ___ दिन के अंदर समस्या दोबारा हो, तो हमें यहीं मैसेज कीजिए, हम फिर से जाँच करेंगे।',
      },
    },
    {
      shortcut: 'amc',
      title: { en: 'AMC offer', hi: 'AMC की जानकारी' },
      body: {
        en: 'Our Annual Maintenance Contract covers ___ visits in a year for ₹___ + GST, so the pests stay away all year.',
        hi: 'हमारे सालाना मेंटेनेंस कॉन्ट्रैक्ट (AMC) में साल में ___ विज़िट ₹___ + GST में मिलती हैं, ताकि पूरे साल कीड़े दूर रहें।',
      },
    },
    {
      shortcut: 'renewal',
      title: { en: 'AMC renewal', hi: 'AMC रिन्यूअल' },
      body: {
        en: 'Namaste {{contact.name}} ji, your AMC ends on ___. Shall we renew it for one more year?',
        hi: 'नमस्ते {{contact.name}} जी, आपका AMC ___ को ख़त्म हो रहा है। क्या इसे एक साल के लिए और बढ़ा दें?',
      },
    },
    {
      shortcut: 'payment',
      title: { en: 'Payment details', hi: 'भुगतान की जानकारी' },
      body: {
        en: 'Our bank and UPI details are on the quotation. Please send a photo of the payment slip once you have paid.',
        hi: 'हमारे बैंक और UPI की जानकारी कोटेशन पर है। भुगतान के बाद उसकी पर्ची की फ़ोटो भेज दीजिए।',
      },
    },
    {
      shortcut: 'thanks',
      title: { en: 'Thank you', hi: 'धन्यवाद' },
      body: {
        en: 'Thank you for choosing us, {{contact.name}} ji! — {{org.name}}',
        hi: 'हमें चुनने के लिए धन्यवाद, {{contact.name}} जी! — {{org.name}}',
      },
    },
  ],
  terms: {
    en: [
      '1. Charges cover the treatment and the area named in this quotation. GST is extra at the applicable rate.',
      '2. Payment: 50% advance at booking and the balance when the service is done, unless agreed otherwise in writing.',
      '3. Please follow the precautions we share before and after the treatment.',
      '4. Warranty: if the same pest returns in the treated area within the warranty period shown, we treat it again free of charge.',
      '5. The warranty does not cover new infestation after renovation or structural changes, or when the precautions were not followed.',
      '6. AMC visits follow the agreed schedule. Please tell us at least 24 hours ahead to change a visit.',
      '7. This quotation is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. चार्ज इस कोटेशन में लिखे ट्रीटमेंट और एरिया के लिए हैं। GST लागू दर से अलग लगेगा।',
      '2. भुगतान: बुकिंग पर 50% एडवांस और सर्विस पूरी होने पर बाकी, जब तक लिखित में अलग से तय न हो।',
      '3. ट्रीटमेंट से पहले और बाद में हमारी बताई सावधानियों का पालन करें।',
      '4. वारंटी: दी गई वारंटी अवधि में उसी जगह वही कीट दोबारा आने पर हम बिना चार्ज दोबारा ट्रीटमेंट करेंगे।',
      '5. मरम्मत या निर्माण बदलने के बाद आए नए कीट, या सावधानियों का पालन न होने पर, वारंटी लागू नहीं होगी।',
      '6. AMC की विज़िट तय समय पर होंगी। विज़िट बदलनी हो तो कम से कम 24 घंटे पहले बताएँ।',
      '7. यह कोटेशन दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 15,
};

const VISIT = { en: 'visit', hi: 'विज़िट' };
const AREA = { en: 'sq ft', hi: 'वर्ग फ़ुट' };
const YEAR = { en: 'year', hi: 'साल' };

// The Products page's list (named Treatments for this CRM type).
const treatments = [
  { name: { en: 'General pest control', hi: 'सामान्य पेस्ट कंट्रोल' }, unit: VISIT },
  { name: { en: 'Cockroach treatment', hi: 'कॉकरोच ट्रीटमेंट' }, unit: VISIT },
  { name: { en: 'Termite treatment', hi: 'दीमक ट्रीटमेंट' }, unit: AREA },
  { name: { en: 'Bed bug treatment', hi: 'खटमल ट्रीटमेंट' }, unit: VISIT },
  { name: { en: 'Rodent control', hi: 'चूहा नियंत्रण' }, unit: VISIT },
  { name: { en: 'Mosquito control', hi: 'मच्छर नियंत्रण' }, unit: VISIT },
  { name: { en: 'Ant treatment', hi: 'चींटी ट्रीटमेंट' }, unit: VISIT },
  { name: { en: 'Wood borer treatment', hi: 'लकड़ी के घुन का ट्रीटमेंट' }, unit: AREA },
  { name: { en: 'Annual contract (AMC)', hi: 'सालाना कॉन्ट्रैक्ट (AMC)' }, unit: YEAR },
].map((treatment) => ({ ...treatment, hsnSac: SAC_CODE, gstRatePct: GST_RATE_PCT }));

// Extra fields on an enquiry (a lead).
const fields = [
  {
    object: 'lead',
    label: { en: 'Pest type', hi: 'कीट का प्रकार' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Cockroach', hi: 'कॉकरोच' },
      { en: 'Termite', hi: 'दीमक' },
      { en: 'Bed bugs', hi: 'खटमल' },
      { en: 'Rats', hi: 'चूहे' },
      { en: 'Mosquitoes', hi: 'मच्छर' },
      { en: 'Ants', hi: 'चींटियाँ' },
      { en: 'Lizards', hi: 'छिपकली' },
      { en: 'Wood borer', hi: 'लकड़ी का घुन' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  {
    object: 'lead',
    label: { en: 'Property type', hi: 'प्रॉपर्टी का प्रकार' },
    type: 'dropdown',
    options: [
      { en: 'Home', hi: 'घर' },
      { en: 'Flat', hi: 'फ़्लैट' },
      { en: 'Office', hi: 'ऑफ़िस' },
      { en: 'Shop', hi: 'दुकान' },
      { en: 'Hotel or restaurant', hi: 'होटल या रेस्टोरेंट' },
      { en: 'Factory or godown', hi: 'फ़ैक्ट्री या गोदाम' },
      { en: 'Hospital or school', hi: 'अस्पताल या स्कूल' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  { object: 'lead', label: { en: 'Area (sq ft)', hi: 'एरिया (वर्ग फ़ुट)' }, type: 'number' },
  { object: 'lead', label: { en: 'Inspection date', hi: 'निरीक्षण की तारीख' }, type: 'date' },
];

// The company's own kinds of record, shown under "Your records". A record has its own customer
// link, so the contract does not ask for the customer again.
const records = [
  {
    singular: { en: 'AMC contract', hi: 'AMC कॉन्ट्रैक्ट' },
    plural: { en: 'AMC contracts', hi: 'AMC कॉन्ट्रैक्ट' },
    icon: 'file-contract',
    fields: [
      { label: { en: 'Start date', hi: 'शुरू होने की तारीख' }, type: 'date' },
      { label: { en: 'End date', hi: 'ख़त्म होने की तारीख' }, type: 'date', listColumn: true },
      { label: { en: 'Visits in a year', hi: 'साल में विज़िट' }, type: 'number' },
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

// A year of AMC visits in one click (the owner's choice, 2026-11-11): on a won AMC job, Projects →
// "Start the project" with this template gives a task for every visit, a WhatsApp reminder two days
// before each (the /visit quick reply) and the renewal a month before the year ends. Starting it
// stays a click: "Start a project by itself when a deal is won" would start one for one-off jobs too.
const ordinals = [
  { en: 'First', hi: 'पहली' },
  { en: 'Second', hi: 'दूसरी' },
  { en: 'Third', hi: 'तीसरी' },
  { en: 'Fourth', hi: 'चौथी' },
];
const VISIT_EVERY_DAYS = 90;
const REMIND_DAYS_BEFORE = 2;
const projectTemplates = [
  {
    name: { en: 'AMC: 4 visits a year', hi: 'AMC: साल में 4 विज़िट' },
    days: 365,
    milestones: [
      ...ordinals.map((ordinal, index) => ({ name: { en: `${ordinal.en} visit`, hi: `${ordinal.hi} विज़िट` }, dueAfterDays: index * VISIT_EVERY_DAYS })),
      { name: { en: 'AMC renewal', hi: 'AMC रिन्यूअल' }, dueAfterDays: 335 },
    ],
    tasks: [
      ...ordinals.flatMap((ordinal, index) => [
        ...(index ? [{
          title: { en: `Send the reminder for the ${ordinal.en.toLowerCase()} visit (/visit)`, hi: `${ordinal.hi} विज़िट की याद भेजें (/visit)` },
          milestone: index,
          dueAfterDays: index * VISIT_EVERY_DAYS - REMIND_DAYS_BEFORE,
          priority: 'Medium',
        }] : []),
        {
          title: index
            ? { en: `${ordinal.en} visit: treatment`, hi: `${ordinal.hi} विज़िट: ट्रीटमेंट करें` }
            : { en: 'First visit: treatment, and share the precautions', hi: 'पहली विज़िट: ट्रीटमेंट करें और सावधानियाँ बताएँ' },
          milestone: index,
          dueAfterDays: index * VISIT_EVERY_DAYS,
          priority: 'High',
        },
      ]),
      { title: { en: 'Ask the customer to renew the AMC (/renewal)', hi: 'ग्राहक से AMC रिन्यू करने को कहें (/renewal)' }, milestone: 4, dueAfterDays: 335, priority: 'High' },
    ],
  },
];

// Pages this kind of business does not use: none. Projects carries the AMC visits.
const hiddenModules = [];

module.exports = { kit, products: treatments, fields, records, projectTemplates, hiddenModules };
