// How the CRM is set up for home and office cleaning — deep cleaning, kitchens, bathrooms, sofas,
// carpets, water tanks (docs/CRM_TYPES_PLAN.md), in English and Hindi. The services are the
// Products list (named Services for this type), with the usual ones at price 0 for the business to
// fill in. A regular contract's monthly visits come in one click from the project template below
// (the Projects feature, D92).

// Cleaning services: 18% GST (heading 9985; general cleaning 998533), unchanged on 22 September 2025.
// Both can be changed on each service.
const SAC = '9985';
const GST_RATE_PCT = 18;
const SQ_FT = { en: 'sq ft', hi: 'वर्ग फ़ुट' };
const service = (en, hi, unit) => ({ name: { en, hi }, unit, hsnSac: SAC, gstRatePct: GST_RATE_PCT });
const products = [
  service('Full home deep cleaning', 'पूरे घर की डीप क्लीनिंग', { en: 'home', hi: 'घर' }),
  service('Kitchen cleaning', 'किचन की सफ़ाई', { en: 'kitchen', hi: 'किचन' }),
  service('Bathroom cleaning', 'बाथरूम की सफ़ाई', { en: 'bathroom', hi: 'बाथरूम' }),
  service('Sofa cleaning', 'सोफ़ा की सफ़ाई', { en: 'seat', hi: 'सीट' }),
  service('Carpet cleaning', 'कार्पेट की सफ़ाई', SQ_FT),
  service('Mattress cleaning', 'गद्दे की सफ़ाई', { en: 'mattress', hi: 'गद्दा' }),
  service('Water tank cleaning', 'पानी की टंकी की सफ़ाई', { en: 'tank', hi: 'टंकी' }),
  service('Office cleaning', 'ऑफ़िस की सफ़ाई', SQ_FT),
  service('After-construction cleaning', 'निर्माण के बाद की सफ़ाई', SQ_FT),
  service('Sanitisation', 'सैनिटाइज़ेशन', SQ_FT),
];

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Home cleaning', hi: 'होम क्लीनिंग' },
  about: {
    en: 'Enquiries, quotes, slot bookings and repeat cleanings.',
    hi: 'पूछताछ, रेट, स्लॉट बुकिंग और दोबारा सफ़ाई।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Requirement understood', hi: 'ज़रूरत समझ ली' }, probability: 25, quietDays: 1 },
    { kind: 'Quote Sent', name: { en: 'Rate shared', hi: 'रेट बताया' }, probability: 45, quietDays: 2 },
    { kind: 'Negotiation', name: { en: 'Slot booked', hi: 'स्लॉट बुक' }, probability: 80, quietDays: 1 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the cleaning', hi: 'सफ़ाई के बारे में पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Which cleaning do you need (full home, kitchen, bathroom, sofa …), for how many rooms or sq ft, and on which day?',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। आपको कौन-सी सफ़ाई चाहिए (पूरा घर, किचन, बाथरूम, सोफ़ा …), कितने कमरे या कितने वर्ग फ़ुट, और किस दिन?',
      },
    },
    {
      shortcut: 'rate',
      title: { en: 'Rate', hi: 'रेट' },
      body: {
        en: 'For ___, the charge is ₹___. It includes ___. Shall we book a slot?',
        hi: '___ के लिए चार्ज ₹___ है। इसमें ___ शामिल है। क्या स्लॉट बुक कर दें?',
      },
    },
    {
      shortcut: 'booking',
      title: { en: 'Booking confirmed', hi: 'बुकिंग पक्की' },
      body: {
        en: 'Your cleaning is booked for ___ at ___. Our team of ___ will come with all the equipment and materials.',
        hi: 'आपकी सफ़ाई ___ को ___ बजे बुक है। हमारी ___ लोगों की टीम सारे उपकरण और सामान के साथ आएगी।',
      },
    },
    {
      shortcut: 'prepare',
      title: { en: 'Before we come', hi: 'हमारे आने से पहले' },
      body: {
        en: 'Before we come, please keep cash, jewellery and fragile items away, and keep the water and electricity on.',
        hi: 'हमारे आने से पहले नकद, गहने और नाज़ुक सामान अलग रख दीजिए, और पानी व बिजली चालू रखिए।',
      },
    },
    {
      shortcut: 'reminder',
      title: { en: 'Booking reminder', hi: 'बुकिंग की याद' },
      body: {
        en: 'A reminder: our cleaning team reaches you on ___ at ___.',
        hi: 'याद दिला दें: हमारी सफ़ाई टीम ___ को ___ बजे आपके यहाँ पहुँचेगी।',
      },
    },
    {
      shortcut: 'done',
      title: { en: 'Cleaning done', hi: 'सफ़ाई पूरी' },
      body: {
        en: 'Your cleaning is done! Please check, and tell us if anything was missed; we will put it right at once.',
        hi: 'आपकी सफ़ाई पूरी हो गई! कृपया देख लीजिए, और कुछ छूट गया हो तो बताइए — हम तुरंत ठीक कर देंगे।',
      },
    },
    {
      shortcut: 'repeat',
      title: { en: 'Time for the next cleaning', hi: 'अगली सफ़ाई का समय' },
      body: {
        en: 'Namaste {{contact.name}} ji, it has been ___ months since your last deep cleaning. Shall we book the next one? Regular customers get ___% off.',
        hi: 'नमस्ते {{contact.name}} जी, आपकी पिछली डीप क्लीनिंग को ___ महीने हो गए। क्या अगली बुक कर दें? नियमित ग्राहकों को ___% की छूट मिलती है।',
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
      '1. Charges are as quoted for the rooms, area or items listed; GST is extra at the applicable rate.',
      '2. Our team brings the equipment and cleaning materials; the water and electricity are the customer\'s.',
      '3. Please keep cash, jewellery and fragile items away before the cleaning.',
      '4. Old, permanent or hard-water stains may not come off fully; we do our best.',
      '5. To change or cancel a booking, please tell us at least 12 hours ahead.',
      '6. Payment is due when the cleaning is done.',
      '7. This quotation is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. चार्ज बताए गए कमरों, एरिया या सामान के लिए कोटेशन के अनुसार; GST लागू दर से अलग।',
      '2. उपकरण और सफ़ाई का सामान हमारी टीम लाएगी; पानी और बिजली ग्राहक की।',
      '3. सफ़ाई से पहले नकद, गहने और नाज़ुक सामान अलग रख दें।',
      '4. पुराने, पक्के या खारे पानी के दाग पूरी तरह न निकलें, ऐसा हो सकता है; हम पूरी कोशिश करते हैं।',
      '5. बुकिंग बदलनी या कैंसिल करनी हो तो कम से कम 12 घंटे पहले बताएँ।',
      '6. भुगतान सफ़ाई पूरी होने पर।',
      '7. यह कोटेशन दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 7,
};

// Extra fields on an enquiry. The service is the enquiry's built-in "interested service".
const fields = [
  {
    object: 'lead',
    label: { en: 'Property type', hi: 'प्रॉपर्टी का प्रकार' },
    type: 'dropdown',
    options: [
      { en: 'Flat', hi: 'फ़्लैट' },
      { en: 'Independent house or villa', hi: 'मकान या विला' },
      { en: 'Office', hi: 'ऑफ़िस' },
      { en: 'Shop', hi: 'दुकान' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  { object: 'lead', label: { en: 'BHK or area', hi: 'BHK या एरिया' }, type: 'text', listColumn: true },
  { object: 'lead', label: { en: 'Cleaning date', hi: 'सफ़ाई की तारीख' }, type: 'date', listColumn: true },
  {
    object: 'lead',
    label: { en: 'Preferred time', hi: 'पसंदीदा समय' },
    type: 'dropdown',
    listColumn: true,
    options: [{ en: 'Morning', hi: 'सुबह' }, { en: 'Afternoon', hi: 'दोपहर' }, { en: 'Evening', hi: 'शाम' }],
  },
  { object: 'lead', label: { en: 'Pets at home', hi: 'घर में पालतू जानवर' }, type: 'checkbox' },
];

// A regular contract (an office, a society, a home every month): Projects → "Start the project" on
// the won booking gives a task for each monthly visit, a reminder the day before visits 2 to 6 (the
// /reminder quick reply) and, after the last, an offer to renew (/repeat).
const VISITS = 6;
const EVERY_DAYS = 30;
const visits = Array.from({ length: VISITS }, (unused, index) => index + 1);
const projectTemplates = [
  {
    name: { en: 'Monthly cleaning: 6 visits', hi: 'हर महीने सफ़ाई: 6 विज़िट' },
    days: (VISITS - 1) * EVERY_DAYS + 1,
    milestones: [
      ...visits.map((n) => ({ name: { en: `Visit ${n}`, hi: `विज़िट ${n}` }, dueAfterDays: (n - 1) * EVERY_DAYS })),
      { name: { en: 'Contract renewal', hi: 'कॉन्ट्रैक्ट रिन्यूअल' }, dueAfterDays: (VISITS - 1) * EVERY_DAYS + 1 },
    ],
    tasks: [
      ...visits.flatMap((n) => [
        ...(n > 1 ? [{
          title: { en: `Send the reminder for visit ${n} (/reminder)`, hi: `विज़िट ${n} की याद भेजें (/reminder)` },
          milestone: n - 1,
          dueAfterDays: (n - 1) * EVERY_DAYS - 1,
          priority: 'Medium',
        }] : []),
        { title: { en: `Visit ${n}: cleaning`, hi: `विज़िट ${n}: सफ़ाई` }, milestone: n - 1, dueAfterDays: (n - 1) * EVERY_DAYS, priority: 'High' },
      ]),
      { title: { en: 'Offer to renew the contract (/repeat)', hi: 'कॉन्ट्रैक्ट रिन्यू करने का ऑफ़र दें (/repeat)' }, milestone: VISITS, dueAfterDays: (VISITS - 1) * EVERY_DAYS + 1, priority: 'Medium' },
    ],
  },
];

module.exports = { kit, products, fields, records: [], projectTemplates, hiddenModules: [] };
