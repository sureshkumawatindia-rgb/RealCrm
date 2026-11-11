// How the CRM is set up for a salon or a spa — beauty and unisex salons, spas, makeup artists,
// nail studios (docs/CRM_TYPES_PLAN.md), in English and Hindi. The service menu is the Products list
// (named Services for this type), with the usual services at price 0 for the salon to fill in. A
// package of sittings becomes its schedule in one click from the project template below (the
// Projects feature, D92).

// Beauty and well-being services: 5% GST without input tax credit since 22 September 2025 (56th GST
// Council; 18% before). SAC heading 9997. Both can be changed on each service.
const SAC = '9997';
const GST_RATE_PCT = 5;
const SERVICE = { en: 'service', hi: 'सर्विस' };
const service = (en, hi) => ({ name: { en, hi }, unit: SERVICE, hsnSac: SAC, gstRatePct: GST_RATE_PCT });
const products = [
  service('Haircut', 'हेयरकट'),
  service('Hair colour', 'हेयर कलर'),
  service('Hair spa', 'हेयर स्पा'),
  service('Facial', 'फ़ेशियल'),
  service('Clean-up', 'क्लीन-अप'),
  service('Waxing', 'वैक्सिंग'),
  service('Threading', 'थ्रेडिंग'),
  service('Manicure', 'मैनीक्योर'),
  service('Pedicure', 'पेडीक्योर'),
  service('Body massage', 'बॉडी मसाज'),
  service('Bridal makeup', 'ब्राइडल मेकअप'),
];

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Salon and spa', hi: 'सैलून और स्पा' },
  about: {
    en: 'Booking enquiries, appointments, packages and repeat visits.',
    hi: 'बुकिंग की पूछताछ, अपॉइंटमेंट, पैकेज और दोबारा आना।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Services and rates shared', hi: 'सर्विस और रेट बताए' }, probability: 30, quietDays: 1 },
    { kind: 'Quote Sent', name: { en: 'Package quoted', hi: 'पैकेज का कोटेशन भेजा' }, probability: 45, quietDays: 2 },
    { kind: 'Negotiation', name: { en: 'Booking fixed', hi: 'बुकिंग पक्की' }, probability: 75, quietDays: 1 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the booking', hi: 'बुकिंग के बारे में पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Which service would you like, and what day and time suit you? We will book your slot.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। आपको कौन-सी सर्विस चाहिए, और कौन-सा दिन और समय ठीक रहेगा? हम आपका स्लॉट बुक कर देंगे।',
      },
    },
    {
      shortcut: 'menu',
      title: { en: 'Service menu', hi: 'सर्विस और रेट' },
      body: {
        en: "Here is our service menu with the prices: ___. Ask us about this week's offers!",
        hi: 'यह हमारी सर्विस और रेट की लिस्ट है: ___। इस हफ़्ते के ऑफ़र के बारे में ज़रूर पूछिए!',
      },
    },
    {
      shortcut: 'booking',
      title: { en: 'Booking confirmed', hi: 'बुकिंग पक्की' },
      body: {
        en: 'Your booking at {{org.name}} is confirmed for ___ at ___ (___ with ___). See you soon!',
        hi: '{{org.name}} में आपकी बुकिंग ___ को ___ बजे पक्की है (___, ___ के साथ)। जल्द मिलते हैं!',
      },
    },
    {
      shortcut: 'reminder',
      title: { en: 'Appointment reminder', hi: 'अपॉइंटमेंट की याद' },
      body: {
        en: 'A reminder: your appointment at {{org.name}} is on ___ at ___. Reply here to change the time.',
        hi: 'याद दिला दें: {{org.name}} में आपका अपॉइंटमेंट ___ को ___ बजे है। समय बदलना हो तो यहीं जवाब दीजिए।',
      },
    },
    {
      shortcut: 'bridal',
      title: { en: 'Bridal package', hi: 'ब्राइडल पैकेज' },
      body: {
        en: 'Our bridal package includes ___, for ₹___. A trial session is ₹___, adjusted in the package. Shall we block your date?',
        hi: 'हमारे ब्राइडल पैकेज में ___ शामिल है, ₹___ में। ट्रायल सेशन ₹___ का है, जो पैकेज में एडजस्ट हो जाएगा। क्या आपकी तारीख बुक कर दें?',
      },
    },
    {
      shortcut: 'rebook',
      title: { en: 'Time for the next visit', hi: 'अगली विज़िट का समय' },
      body: {
        en: "Namaste {{contact.name}} ji, it has been a while since your last visit. Shall we book your next ___? This week's free slots: ___.",
        hi: 'नमस्ते {{contact.name}} जी, आपकी पिछली विज़िट को काफ़ी समय हो गया। क्या आपकी अगली ___ बुक कर दें? इस हफ़्ते के खाली स्लॉट: ___।',
      },
    },
    {
      shortcut: 'birthday',
      title: { en: 'Birthday offer', hi: 'जन्मदिन का ऑफ़र' },
      body: {
        en: 'Happy birthday, {{contact.name}} ji! Enjoy ___% off on any service at {{org.name}} this month.',
        hi: 'जन्मदिन मुबारक, {{contact.name}} जी! इस महीने {{org.name}} में किसी भी सर्विस पर ___% की छूट पाइए।',
      },
    },
    {
      shortcut: 'review',
      title: { en: 'Ask for a review', hi: 'रिव्यू माँगें' },
      body: {
        en: 'Thank you for visiting {{org.name}}! If you loved it, please leave us a Google review: ___',
        hi: '{{org.name}} आने के लिए धन्यवाद! अगर आपको अच्छा लगा, तो कृपया Google पर रिव्यू दीजिए: ___',
      },
    },
  ],
  terms: {
    en: [
      '1. Prices are per service as listed; GST is extra at the applicable rate.',
      '2. Please arrive on time; a late arrival may shorten the service or move the booking.',
      '3. To cancel or move a booking, please tell us at least 3 hours ahead.',
      '4. Package sittings are used within the validity shown; sittings left after it lapse.',
      '5. Bridal and event bookings are confirmed with an advance; travel for a home or venue visit is extra.',
      '6. Please tell us about any allergy or skin sensitivity before the service.',
      '7. This quotation is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. दाम हर सर्विस के लिए लिस्ट के अनुसार हैं; GST लागू दर से अलग।',
      '2. कृपया समय पर आइए; देर से आने पर सर्विस छोटी हो सकती है या बुकिंग आगे खिसक सकती है।',
      '3. बुकिंग कैंसिल करनी या बदलनी हो तो कम से कम 3 घंटे पहले बताइए।',
      '4. पैकेज के सेशन दी गई अवधि में इस्तेमाल करने होंगे; उसके बाद बचे सेशन खत्म हो जाएँगे।',
      '5. ब्राइडल और इवेंट की बुकिंग एडवांस मिलने पर पक्की होगी; घर या वेन्यू पर आने का खर्च अलग।',
      '6. सर्विस से पहले किसी भी एलर्जी या त्वचा की परेशानी के बारे में ज़रूर बताइए।',
      '7. यह कोटेशन दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 7,
};

// Extra fields on a client and on an enquiry.
const fields = [
  { object: 'contact', label: { en: 'Birthday', hi: 'जन्मदिन' }, type: 'date', listColumn: true },
  { object: 'contact', label: { en: 'Preferred stylist', hi: 'पसंदीदा स्टाइलिस्ट' }, type: 'text' },
  { object: 'contact', label: { en: 'Allergies or skin notes', hi: 'एलर्जी या त्वचा के नोट' }, type: 'textarea' },
  { object: 'lead', label: { en: 'Appointment date', hi: 'अपॉइंटमेंट की तारीख' }, type: 'date', listColumn: true },
  { object: 'lead', label: { en: 'Stylist', hi: 'स्टाइलिस्ट' }, type: 'text', listColumn: true },
  {
    object: 'lead',
    label: { en: 'Occasion', hi: 'मौका' },
    type: 'dropdown',
    options: [
      { en: 'Regular', hi: 'रोज़ाना' },
      { en: 'Wedding', hi: 'शादी' },
      { en: 'Party', hi: 'पार्टी' },
      { en: 'Festival', hi: 'त्योहार' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
];

// A package of sittings (hair spa, facials, massages …): Projects → "Start the project" on the won
// booking gives a task for each monthly sitting, a WhatsApp reminder the day before sittings 2 to 6
// (the /reminder quick reply) and, after the last, an offer to renew the package.
const SITTINGS = 6;
const EVERY_DAYS = 30;
const sittings = Array.from({ length: SITTINGS }, (unused, index) => index + 1);
const projectTemplates = [
  {
    name: { en: 'Package: 6 monthly sittings', hi: 'पैकेज: हर महीने 6 सेशन' },
    days: (SITTINGS - 1) * EVERY_DAYS + 1,
    milestones: [
      ...sittings.map((n) => ({ name: { en: `Sitting ${n}`, hi: `सेशन ${n}` }, dueAfterDays: (n - 1) * EVERY_DAYS })),
      { name: { en: 'Package renewal', hi: 'पैकेज रिन्यूअल' }, dueAfterDays: (SITTINGS - 1) * EVERY_DAYS + 1 },
    ],
    tasks: [
      ...sittings.flatMap((n) => [
        ...(n > 1 ? [{
          title: { en: `Send the reminder for sitting ${n} (/reminder)`, hi: `सेशन ${n} की याद भेजें (/reminder)` },
          milestone: n - 1,
          dueAfterDays: (n - 1) * EVERY_DAYS - 1,
          priority: 'Medium',
        }] : []),
        { title: { en: `Sitting ${n}`, hi: `सेशन ${n}` }, milestone: n - 1, dueAfterDays: (n - 1) * EVERY_DAYS, priority: 'High' },
      ]),
      { title: { en: 'Offer to renew the package, and ask for a review (/review)', hi: 'पैकेज रिन्यू करने का ऑफ़र दें और रिव्यू माँगें (/review)' }, milestone: SITTINGS, dueAfterDays: (SITTINGS - 1) * EVERY_DAYS + 1, priority: 'Medium' },
    ],
  },
];

module.exports = { kit, products, fields, records: [], projectTemplates, hiddenModules: [] };
