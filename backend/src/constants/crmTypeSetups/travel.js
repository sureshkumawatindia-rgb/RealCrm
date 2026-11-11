// How the CRM is set up for a travel agency (docs/CRM_TYPES_PLAN.md), in English and Hindi. The
// packages are the Products list (named Packages for this type); what an agency sells is its own,
// so none is added. Its suppliers (hotels, transport, guides …) are the company's own records.
// No project template: a project's tasks can only fall after its start, and a trip's work falls
// before the departure, so Projects is hidden.

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Travel agency', hi: 'ट्रैवल एजेंसी' },
  about: {
    en: 'Trip enquiries, itineraries, advances and departures.',
    hi: 'यात्रा की पूछताछ, यात्रा प्लान, एडवांस और रवानगी।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Requirement understood', hi: 'ज़रूरत समझ ली' }, probability: 20, quietDays: 1 },
    { kind: 'Quote Sent', name: { en: 'Itinerary sent', hi: 'यात्रा प्लान भेजा' }, probability: 40, quietDays: 2 },
    { kind: 'Negotiation', name: { en: 'Negotiation', hi: 'मोलभाव' }, probability: 60, quietDays: 2 },
    { kind: 'Negotiation', name: { en: 'Advance awaited', hi: 'एडवांस का इंतज़ार' }, probability: 80, quietDays: 2 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the trip', hi: 'यात्रा के बारे में पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for your enquiry with {{org.name}}. Please tell us: where to, the travel dates, how many adults and children, your budget and the hotel category you like. We will send you the best plan.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से पूछताछ के लिए धन्यवाद। कृपया बताइए: कहाँ जाना है, यात्रा की तारीखें, कितने बड़े और कितने बच्चे, आपका बजट और कैसा होटल चाहिए। हम आपको सबसे अच्छा प्लान भेजेंगे।',
      },
    },
    {
      shortcut: 'itinerary',
      title: { en: 'Trip plan', hi: 'यात्रा प्लान' },
      body: {
        en: 'Here is your trip plan for ___: ___ nights / ___ days, hotels ___, with ___. ₹___ per person. Shall we hold it for you?',
        hi: '___ के लिए आपका यात्रा प्लान: ___ रात / ___ दिन, होटल ___, साथ में ___। ₹___ प्रति व्यक्ति। क्या हम इसे आपके लिए रोक लें?',
      },
    },
    {
      shortcut: 'documents',
      title: { en: 'Traveller details', hi: 'यात्रियों की जानकारी' },
      body: {
        en: "For the booking, please send each traveller's name as on the ID or passport, the date of birth, and a photo of the ID or passport.",
        hi: 'बुकिंग के लिए हर यात्री का नाम (जैसा पहचान पत्र या पासपोर्ट पर है), जन्म तारीख, और पहचान पत्र या पासपोर्ट की फ़ोटो भेजिए।',
      },
    },
    {
      shortcut: 'advance',
      title: { en: 'Advance to book', hi: 'बुकिंग के लिए एडवांस' },
      body: {
        en: 'To confirm your booking, please pay an advance of ₹___. Our UPI and bank details are on the quotation. The balance is due by ___.',
        hi: 'बुकिंग पक्की करने के लिए ₹___ का एडवांस भेजिए। हमारे UPI और बैंक की जानकारी कोटेशन पर है। बाकी रकम ___ तक देनी है।',
      },
    },
    {
      shortcut: 'balance',
      title: { en: 'Balance reminder', hi: 'बाकी रकम की याद' },
      body: {
        en: 'A reminder: the balance of ₹___ for your ___ trip is due by ___.',
        hi: 'याद दिला दें: आपकी ___ यात्रा की बाकी रकम ₹___ ___ तक देनी है।',
      },
    },
    {
      shortcut: 'visa',
      title: { en: 'Visa documents', hi: 'वीज़ा के कागज़' },
      body: {
        en: 'For the ___ visa we need: the passport (valid for at least 6 more months), 2 photos, 6 months of bank statements and ___. It takes about ___ days.',
        hi: '___ वीज़ा के लिए चाहिए: पासपोर्ट (कम से कम 6 महीने और मान्य), 2 फ़ोटो, 6 महीने का बैंक स्टेटमेंट और ___। इसमें लगभग ___ दिन लगते हैं।',
      },
    },
    {
      shortcut: 'departure',
      title: { en: 'Departure details', hi: 'रवानगी की जानकारी' },
      body: {
        en: 'Your trip starts on ___. Pickup: ___ at ___. Your driver or guide: ___ (phone ___). The hotel vouchers and tickets are attached. Have a great trip!',
        hi: 'आपकी यात्रा ___ को शुरू होगी। पिकअप: ___ बजे ___ से। आपके ड्राइवर या गाइड: ___ (फ़ोन ___)। होटल वाउचर और टिकट साथ में हैं। आपकी यात्रा शुभ हो!',
      },
    },
    {
      shortcut: 'feedback',
      title: { en: 'Welcome back', hi: 'वापसी पर' },
      body: {
        en: 'Welcome back, {{contact.name}} ji! How was your trip? We would love your feedback or a Google review: ___',
        hi: 'वापसी पर स्वागत है, {{contact.name}} जी! आपकी यात्रा कैसी रही? अपनी राय या Google रिव्यू ज़रूर दीजिए: ___',
      },
    },
  ],
  terms: {
    en: [
      '1. Prices are per person on the sharing basis shown, and depend on availability when you book.',
      '2. The booking is confirmed when the advance is received; the balance is due before the trip starts.',
      '3. Flight, train and hotel rates can change until they are booked; a rise is charged at actual cost.',
      '4. Cancellation charges follow the airline, hotel and our own policy, and depend on how close to the trip you cancel.',
      '5. Not included: anything not listed, personal expenses, entry tickets and tips.',
      "6. A valid ID (and a passport and visa for a trip abroad) is the traveller's responsibility.",
      '7. This quotation is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. दाम प्रति व्यक्ति हैं (बताए गए शेयरिंग के हिसाब से), और बुकिंग के समय उपलब्धता पर निर्भर हैं।',
      '2. एडवांस मिलने पर बुकिंग पक्की होगी; बाकी रकम यात्रा शुरू होने से पहले देनी होगी।',
      '3. फ़्लाइट, ट्रेन और होटल के दाम बुक होने तक बदल सकते हैं; बढ़ोतरी असल खर्च के हिसाब से लगेगी।',
      '4. कैंसिल करने के चार्ज एयरलाइन, होटल और हमारी नीति के अनुसार होंगे, और इस पर निर्भर करेंगे कि यात्रा से कितना पहले कैंसिल किया।',
      '5. शामिल नहीं: जो लिखा नहीं है, निजी खर्च, एंट्री टिकट और टिप।',
      '6. मान्य पहचान पत्र (और विदेश यात्रा के लिए पासपोर्ट और वीज़ा) यात्री की ज़िम्मेदारी है।',
      '7. यह कोटेशन दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 3, // travel prices change fast
};

// The company's own kinds of record, shown under "Your records".
const records = [
  {
    singular: { en: 'Supplier', hi: 'सप्लायर' },
    plural: { en: 'Suppliers', hi: 'सप्लायर' },
    icon: 'building',
    fields: [
      {
        label: { en: 'Supplier type', hi: 'सप्लायर का प्रकार' },
        type: 'dropdown',
        listColumn: true,
        options: [
          { en: 'Hotel', hi: 'होटल' },
          { en: 'Transport', hi: 'ट्रांसपोर्ट' },
          { en: 'Guide', hi: 'गाइड' },
          { en: 'Tickets', hi: 'टिकट' },
          { en: 'Local agent', hi: 'लोकल एजेंट' },
          { en: 'Other', hi: 'अन्य' },
        ],
      },
      { label: { en: 'City', hi: 'शहर' }, type: 'text', listColumn: true },
      { label: { en: 'Phone', hi: 'फ़ोन' }, type: 'text', listColumn: true },
      { label: { en: 'Rates and notes', hi: 'रेट और नोट' }, type: 'textarea' },
    ],
  },
];

// Extra fields on an enquiry.
const fields = [
  { object: 'lead', label: { en: 'Destination', hi: 'कहाँ जाना है' }, type: 'text', listColumn: true },
  { object: 'lead', label: { en: 'Travel date', hi: 'यात्रा की तारीख' }, type: 'date', listColumn: true },
  { object: 'lead', label: { en: 'Nights', hi: 'कितनी रातें' }, type: 'number' },
  { object: 'lead', label: { en: 'Adults', hi: 'बड़े' }, type: 'number' },
  { object: 'lead', label: { en: 'Children', hi: 'बच्चे' }, type: 'number' },
  { object: 'lead', label: { en: 'Budget (₹)', hi: 'बजट (₹)' }, type: 'number', listColumn: true },
  {
    object: 'lead',
    label: { en: 'Hotel category', hi: 'होटल की श्रेणी' },
    type: 'dropdown',
    options: [
      { en: 'Budget', hi: 'बजट' },
      { en: '3 star', hi: '3 स्टार' },
      { en: '4 star', hi: '4 स्टार' },
      { en: '5 star', hi: '5 स्टार' },
      { en: 'Homestay or resort', hi: 'होमस्टे या रिज़ॉर्ट' },
    ],
  },
  {
    object: 'lead',
    label: { en: 'Trip type', hi: 'यात्रा का प्रकार' },
    type: 'dropdown',
    options: [
      { en: 'Family holiday', hi: 'परिवार के साथ घूमना' },
      { en: 'Honeymoon', hi: 'हनीमून' },
      { en: 'Group tour', hi: 'ग्रुप टूर' },
      { en: 'Pilgrimage', hi: 'तीर्थ यात्रा' },
      { en: 'Business travel', hi: 'कारोबारी यात्रा' },
      { en: 'Adventure', hi: 'एडवेंचर' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  { object: 'lead', label: { en: 'Departure city', hi: 'कहाँ से' }, type: 'text' },
];

// Pages this kind of business does not use. They can be switched back on in Settings → Team & Access.
const hiddenModules = ['projects'];

module.exports = { kit, products: [], fields, records, hiddenModules };
