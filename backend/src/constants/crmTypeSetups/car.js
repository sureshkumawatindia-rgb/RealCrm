// How the CRM is set up for a car or two-wheeler dealer and service centre — new and used vehicles
// and the workshop (docs/CRM_TYPES_PLAN.md), in English and Hindi. Vehicles for sale are not added
// as products: their price is the dealer's own and their GST depends on the vehicle (since 22
// September 2025 small and large cars are taxed differently). The usual workshop services are
// added. The customers' vehicles are the company's own records, for service and insurance reminders,
// and a new vehicle's first year comes in one click from the project template below (Projects, D92).

// Maintenance and repair of motor vehicles: 18% GST (heading 9987), unchanged on 22 September 2025.
const SAC = '9987';
const GST_RATE_PCT = 18;
const VEHICLE = { en: 'vehicle', hi: 'गाड़ी' };
const service = (en, hi, unit = VEHICLE) => ({ name: { en, hi }, unit, hsnSac: SAC, gstRatePct: GST_RATE_PCT });
const products = [
  service('General service', 'जनरल सर्विस'),
  service('Oil and filter change', 'ऑयल और फ़िल्टर बदलना'),
  service('Wheel alignment and balancing', 'व्हील अलाइनमेंट और बैलेंसिंग'),
  service('Car wash and polish', 'कार वॉश और पॉलिश'),
  service('Car AC service', 'कार AC सर्विस'),
  service('Denting and painting', 'डेंटिंग और पेंटिंग', { en: 'panel', hi: 'पैनल' }),
];

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Car dealer and service centre', hi: 'कार डीलर और सर्विस सेंटर' },
  about: {
    en: 'Enquiries, test drives, finance and exchange, bookings, delivery and service.',
    hi: 'पूछताछ, टेस्ट ड्राइव, फ़ाइनेंस और एक्सचेंज, बुकिंग, डिलीवरी और सर्विस।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Test drive done', hi: 'टेस्ट ड्राइव हो गई' }, probability: 35, quietDays: 2 },
    { kind: 'Quote Sent', name: { en: 'Quotation sent', hi: 'कोटेशन भेजा' }, probability: 50, quietDays: 3 },
    { kind: 'Negotiation', name: { en: 'Finance and exchange', hi: 'फ़ाइनेंस और एक्सचेंज' }, probability: 65, quietDays: 3 },
    { kind: 'Negotiation', name: { en: 'Ready to book', hi: 'बुक करने को तैयार' }, probability: 85, quietDays: 2 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the model', hi: 'मॉडल पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Which model are you looking at, and will you exchange an old vehicle? Shall we book a test drive?',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। आप कौन-सा मॉडल देख रहे हैं, और क्या पुरानी गाड़ी एक्सचेंज करेंगे? क्या टेस्ट ड्राइव बुक कर दें?',
      },
    },
    {
      shortcut: 'testdrive',
      title: { en: 'Test drive', hi: 'टेस्ट ड्राइव' },
      body: {
        en: 'Your test drive of the ___ is booked for ___ at ___. Please bring your driving licence.',
        hi: '___ की आपकी टेस्ट ड्राइव ___ को ___ बजे बुक है। कृपया ड्राइविंग लाइसेंस साथ लाएँ।',
      },
    },
    {
      shortcut: 'quote',
      title: { en: 'On-road price', hi: 'ऑन-रोड कीमत' },
      body: {
        en: 'On-road price of the ___ (___ variant): ₹___ — ex-showroom ₹___, insurance ₹___, registration ₹___. Current offer: ___.',
        hi: '___ (___ वेरिएंट) की ऑन-रोड कीमत: ₹___ — एक्स-शोरूम ₹___, इंश्योरेंस ₹___, रजिस्ट्रेशन ₹___। अभी का ऑफ़र: ___।',
      },
    },
    {
      shortcut: 'finance',
      title: { en: 'Finance and EMI', hi: 'फ़ाइनेंस और EMI' },
      body: {
        en: "We can arrange a loan: down payment ₹___, EMI about ₹___ for ___ months. For the approval we need PAN, Aadhaar, 3 months' salary slips or ITR and 6 months' bank statement.",
        hi: 'हम लोन करवा सकते हैं: डाउन पेमेंट ₹___, लगभग ₹___ EMI ___ महीनों के लिए। मंज़ूरी के लिए PAN, आधार, 3 महीने की सैलरी स्लिप या ITR और 6 महीने का बैंक स्टेटमेंट चाहिए।',
      },
    },
    {
      shortcut: 'booking',
      title: { en: 'Booking confirmed', hi: 'बुकिंग पक्की' },
      body: {
        en: 'Thank you for booking your ___! Booking amount received: ₹___. Expected delivery: ___.',
        hi: 'आपकी ___ की बुकिंग के लिए धन्यवाद! बुकिंग की रकम मिली: ₹___। डिलीवरी की उम्मीद: ___।',
      },
    },
    {
      shortcut: 'delivery',
      title: { en: 'Delivery', hi: 'डिलीवरी' },
      body: {
        en: 'Your ___ is ready for delivery on ___ at ___. Please bring ___. Congratulations!',
        hi: 'आपकी ___ ___ को ___ बजे डिलीवरी के लिए तैयार है। कृपया ___ साथ लाएँ। बहुत-बहुत बधाई!',
      },
    },
    {
      shortcut: 'service',
      title: { en: 'Service due', hi: 'सर्विस का समय' },
      body: {
        en: 'Namaste {{contact.name}} ji, your ___ is due for its service. Shall we book a slot? Pick-up and drop are available.',
        hi: 'नमस्ते {{contact.name}} जी, आपकी ___ की सर्विस का समय हो गया है। क्या स्लॉट बुक कर दें? पिक-अप और ड्रॉप की सुविधा है।',
      },
    },
    {
      shortcut: 'insurance',
      title: { en: 'Insurance renewal', hi: 'इंश्योरेंस रिन्यूअल' },
      body: {
        en: 'Your vehicle insurance ends on ___. Renew it with us so the cover does not stop: ___.',
        hi: 'आपकी गाड़ी का इंश्योरेंस ___ को ख़त्म हो रहा है। कवर न रुके, इसलिए हमसे रिन्यू करवाइए: ___।',
      },
    },
  ],
  terms: {
    en: [
      '1. Prices are ex-showroom unless stated; insurance, registration and accessories are charged as shown.',
      '2. Prices and offers are as on the date of this quotation; the price on the date of the invoice applies.',
      '3. The booking amount is adjusted in the final invoice; a refund on cancellation follows our booking policy.',
      "4. Delivery dates depend on the maker's supply.",
      "5. A loan depends on the bank's approval.",
      "6. The vehicle carries the maker's warranty.",
      '7. This quotation is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. कीमतें एक्स-शोरूम हैं जब तक अलग न लिखा हो; इंश्योरेंस, रजिस्ट्रेशन और एक्सेसरीज़ बताए अनुसार।',
      '2. कीमत और ऑफ़र इस कोटेशन की तारीख के हैं; इनवॉइस की तारीख की कीमत लागू होगी।',
      '3. बुकिंग की रकम अंतिम इनवॉइस में एडजस्ट होगी; कैंसिल करने पर रिफ़ंड हमारी बुकिंग नीति के अनुसार।',
      '4. डिलीवरी की तारीख कंपनी से गाड़ी आने पर निर्भर है।',
      '5. लोन बैंक की मंज़ूरी पर निर्भर है।',
      '6. गाड़ी पर कंपनी की वारंटी लागू है।',
      '7. यह कोटेशन दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 7,
};

// The company's own kinds of record, shown under "Your records". The record's own customer link is
// the owner.
const records = [
  {
    singular: { en: 'Vehicle', hi: 'गाड़ी' },
    plural: { en: 'Vehicles', hi: 'गाड़ियाँ' },
    icon: 'truck',
    fields: [
      { label: { en: 'Registration number', hi: 'गाड़ी का नंबर' }, type: 'text', listColumn: true },
      { label: { en: 'Model', hi: 'मॉडल' }, type: 'text', listColumn: true },
      { label: { en: 'Purchase date', hi: 'खरीद की तारीख' }, type: 'date' },
      { label: { en: 'Last service date', hi: 'पिछली सर्विस की तारीख' }, type: 'date' },
      { label: { en: 'Next service due', hi: 'अगली सर्विस कब' }, type: 'date', listColumn: true },
      { label: { en: 'Insurance ends', hi: 'इंश्योरेंस कब ख़त्म' }, type: 'date' },
      { label: { en: 'Kilometres', hi: 'किलोमीटर' }, type: 'number' },
    ],
  },
];

// Extra fields on an enquiry.
const fields = [
  {
    object: 'lead',
    label: { en: 'Enquiry for', hi: 'किसके लिए' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'New vehicle', hi: 'नई गाड़ी' },
      { en: 'Used vehicle', hi: 'पुरानी गाड़ी' },
      { en: 'Service', hi: 'सर्विस' },
      { en: 'Insurance', hi: 'इंश्योरेंस' },
      { en: 'Accessories', hi: 'एक्सेसरीज़' },
    ],
  },
  { object: 'lead', label: { en: 'Model', hi: 'मॉडल' }, type: 'text', listColumn: true },
  { object: 'lead', label: { en: 'Variant or colour', hi: 'वेरिएंट या रंग' }, type: 'text' },
  {
    object: 'lead',
    label: { en: 'Fuel', hi: 'फ़्यूल' },
    type: 'dropdown',
    options: [
      { en: 'Petrol', hi: 'पेट्रोल' },
      { en: 'Diesel', hi: 'डीज़ल' },
      { en: 'CNG', hi: 'CNG' },
      { en: 'Electric', hi: 'इलेक्ट्रिक' },
      { en: 'Hybrid', hi: 'हाइब्रिड' },
    ],
  },
  { object: 'lead', label: { en: 'Test drive date', hi: 'टेस्ट ड्राइव की तारीख' }, type: 'date', listColumn: true },
  { object: 'lead', label: { en: 'Exchange vehicle', hi: 'एक्सचेंज में गाड़ी' }, type: 'text' },
  { object: 'lead', label: { en: 'Finance needed', hi: 'फ़ाइनेंस चाहिए' }, type: 'checkbox' },
  { object: 'lead', label: { en: 'Registration number', hi: 'गाड़ी का नंबर' }, type: 'text' },
];

// A new vehicle's first year: Projects → "Start the project" on the won booking with this template
// gives the delivery, a first-week call, the free services with their reminders (/service) and
// the insurance renewal (/insurance).
const projectTemplates = [
  {
    name: { en: 'New vehicle: first year', hi: 'नई गाड़ी: पहला साल' },
    days: 365,
    milestones: [
      { name: { en: 'Delivery', hi: 'डिलीवरी' }, dueAfterDays: 0 },
      { name: { en: 'First service', hi: 'पहली सर्विस' }, dueAfterDays: 30 },
      { name: { en: 'Second service', hi: 'दूसरी सर्विस' }, dueAfterDays: 180 },
      { name: { en: 'Insurance renewal and third service', hi: 'इंश्योरेंस रिन्यूअल और तीसरी सर्विस' }, dueAfterDays: 365 },
    ],
    tasks: [
      { title: { en: 'Delivery, papers and the welcome', hi: 'डिलीवरी, कागज़ और स्वागत' }, milestone: 0, dueAfterDays: 0, priority: 'High' },
      { title: { en: 'Call to ask how the first week went', hi: 'फ़ोन करके पहले हफ़्ते के बारे में पूछें' }, milestone: 0, dueAfterDays: 7, priority: 'Medium' },
      { title: { en: 'First service reminder (/service)', hi: 'पहली सर्विस की याद (/service)' }, milestone: 1, dueAfterDays: 25, priority: 'Medium' },
      { title: { en: 'First service', hi: 'पहली सर्विस' }, milestone: 1, dueAfterDays: 30, priority: 'High' },
      { title: { en: 'Second service reminder (/service)', hi: 'दूसरी सर्विस की याद (/service)' }, milestone: 2, dueAfterDays: 175, priority: 'Medium' },
      { title: { en: 'Second service', hi: 'दूसरी सर्विस' }, milestone: 2, dueAfterDays: 180, priority: 'High' },
      { title: { en: 'Insurance renewal reminder (/insurance)', hi: 'इंश्योरेंस रिन्यूअल की याद (/insurance)' }, milestone: 3, dueAfterDays: 335, priority: 'High' },
      { title: { en: 'Third service reminder (/service)', hi: 'तीसरी सर्विस की याद (/service)' }, milestone: 3, dueAfterDays: 355, priority: 'Medium' },
      { title: { en: 'Renew the insurance and do the third service', hi: 'इंश्योरेंस रिन्यू करें और तीसरी सर्विस करें' }, milestone: 3, dueAfterDays: 365, priority: 'High' },
    ],
  },
];

module.exports = { kit, products, fields, records, projectTemplates, hiddenModules: [] };
