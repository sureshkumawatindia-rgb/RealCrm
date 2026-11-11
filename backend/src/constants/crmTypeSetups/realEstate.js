// How the CRM is set up for real estate — brokers and builders (docs/CRM_TYPES_PLAN.md), in English
// and Hindi. The properties are the company's own records ("Your records" → Properties): the record's
// customer is the owner or landlord, and an enquiry links the property it is about. A quotation
// needs no product (a line can be a name and a price), so no products are added; a builder can
// still list units there. Projects is hidden: in real estate a "project" is the builder's housing
// project, not the CRM's after-sale projects.

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Real estate', hi: 'रियल एस्टेट' },
  about: {
    en: 'Enquiries, site visits, properties and bookings.',
    hi: 'पूछताछ, साइट विज़िट, प्रॉपर्टी और बुकिंग।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Requirement understood', hi: 'ज़रूरत समझ ली' }, probability: 20, quietDays: 2 },
    { kind: 'Contacted', name: { en: 'Site visit fixed', hi: 'साइट विज़िट तय' }, probability: 35, quietDays: 3 },
    { kind: 'Contacted', name: { en: 'Site visit done', hi: 'साइट विज़िट हो गई' }, probability: 50, quietDays: 3 },
    { kind: 'Quote Sent', name: { en: 'Price shared', hi: 'दाम बताया' }, probability: 60, quietDays: 3 },
    { kind: 'Negotiation', name: { en: 'Negotiation', hi: 'मोलभाव' }, probability: 80, quietDays: 5 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask for the requirement', hi: 'ज़रूरत पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for your enquiry with {{org.name}}. Please tell us: buy or rent, which area, how many BHK and your budget, and we will share the best options.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से पूछताछ के लिए धन्यवाद। कृपया बताइए: खरीदना है या किराए पर लेना है, कौन-सा इलाका, कितने BHK और आपका बजट — हम आपको सबसे अच्छे विकल्प भेजेंगे।',
      },
    },
    {
      shortcut: 'property',
      title: { en: 'Property details', hi: 'प्रॉपर्टी की जानकारी' },
      body: {
        en: 'Here is a property for you: ___ BHK, ___ sq ft at ___, for ₹___. The photos are attached. Shall we fix a site visit?',
        hi: 'आपके लिए एक प्रॉपर्टी: ___ BHK, ___ वर्ग फ़ुट, ___ में, ₹___ में। फ़ोटो साथ में हैं। क्या साइट विज़िट तय करें?',
      },
    },
    {
      shortcut: 'visit',
      title: { en: 'Site visit', hi: 'साइट विज़िट' },
      body: {
        en: 'Your site visit is fixed for ___ at ___. Location: ___. ___ from our team will meet you there.',
        hi: 'आपकी साइट विज़िट ___ को ___ बजे तय है। लोकेशन: ___। हमारी टीम से ___ आपसे वहीं मिलेंगे।',
      },
    },
    {
      shortcut: 'followup',
      title: { en: 'After the visit', hi: 'विज़िट के बाद' },
      body: {
        en: 'Namaste {{contact.name}} ji, how did you like the property? Shall we talk about the price, or show you a few more options?',
        hi: 'नमस्ते {{contact.name}} जी, आपको प्रॉपर्टी कैसी लगी? क्या दाम पर बात करें, या कुछ और विकल्प दिखाएँ?',
      },
    },
    {
      shortcut: 'documents',
      title: { en: 'Booking documents', hi: 'बुकिंग के कागज़' },
      body: {
        en: 'For the booking, please keep ready: PAN card, Aadhaar card, 2 passport-size photos and the booking amount.',
        hi: 'बुकिंग के लिए ये तैयार रखिए: PAN कार्ड, आधार कार्ड, 2 पासपोर्ट साइज़ फ़ोटो और बुकिंग की रकम।',
      },
    },
    {
      shortcut: 'payment',
      title: { en: 'Payment plan', hi: 'भुगतान का प्लान' },
      body: {
        en: 'Payment plan: ___% at booking, ___% at the agreement and the rest ___. Stamp duty and registration are extra.',
        hi: 'भुगतान का प्लान: बुकिंग पर ___%, एग्रीमेंट पर ___% और बाकी ___। स्टांप ड्यूटी और रजिस्ट्री का खर्च अलग।',
      },
    },
    {
      shortcut: 'thanks',
      title: { en: 'Congratulations', hi: 'बधाई' },
      body: {
        en: 'Congratulations on your new property, {{contact.name}} ji! Thank you for trusting {{org.name}}.',
        hi: 'नई प्रॉपर्टी की बहुत-बहुत बधाई, {{contact.name}} जी! {{org.name}} पर भरोसा करने के लिए धन्यवाद।',
      },
    },
  ],
  terms: {
    en: [
      '1. Prices are as per this quotation and may change until the booking is confirmed.',
      '2. GST, stamp duty, registration and legal charges are extra, as applicable.',
      '3. The booking is confirmed only when the booking amount is received.',
      '4. Payments follow the agreed payment plan; the agreement decides the rest.',
      '5. Areas, plans and specifications are as per the approved plans.',
      '6. Brokerage, where it applies, is due when the deal is final.',
      '7. This quotation is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. दाम इस कोटेशन के अनुसार हैं और बुकिंग पक्की होने तक बदल सकते हैं।',
      '2. GST, स्टांप ड्यूटी, रजिस्ट्री और कानूनी खर्च लागू होने पर अलग से।',
      '3. बुकिंग की रकम मिलने पर ही बुकिंग पक्की होगी।',
      '4. भुगतान तय प्लान के अनुसार होगा; बाकी बातें एग्रीमेंट के अनुसार।',
      '5. एरिया, नक्शा और सुविधाएँ मंज़ूर नक्शे के अनुसार।',
      '6. ब्रोकरेज, जहाँ लागू हो, डील पक्की होने पर देय।',
      '7. यह कोटेशन दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 7,
};

const PROPERTY_TYPES = [
  { en: 'Flat', hi: 'फ़्लैट' },
  { en: 'Independent house or villa', hi: 'मकान या विला' },
  { en: 'Plot', hi: 'प्लॉट' },
  { en: 'Shop or showroom', hi: 'दुकान या शोरूम' },
  { en: 'Office', hi: 'ऑफ़िस' },
  { en: 'Warehouse', hi: 'गोदाम' },
  { en: 'Agricultural land', hi: 'खेती की ज़मीन' },
  { en: 'Other', hi: 'अन्य' },
];
const BHK = [
  { en: '1 RK', hi: '1 RK' },
  { en: '1 BHK', hi: '1 BHK' },
  { en: '2 BHK', hi: '2 BHK' },
  { en: '3 BHK', hi: '3 BHK' },
  { en: '4 BHK', hi: '4 BHK' },
  { en: '5 BHK or more', hi: '5 BHK या ज़्यादा' },
  { en: 'Not applicable', hi: 'लागू नहीं' },
];
const propertyType = { label: { en: 'Property type', hi: 'प्रॉपर्टी का प्रकार' }, type: 'dropdown', options: PROPERTY_TYPES };
const bhk = { label: { en: 'BHK', hi: 'BHK' }, type: 'dropdown', options: BHK };

// The company's own kinds of record, shown under "Your records". The record's own customer link is
// the owner or landlord.
const records = [
  {
    singular: { en: 'Property', hi: 'प्रॉपर्टी' },
    plural: { en: 'Properties', hi: 'प्रॉपर्टी' },
    icon: 'building',
    fields: [
      {
        label: { en: 'Sale or rent', hi: 'बिक्री या किराया' },
        type: 'dropdown',
        options: [{ en: 'Sale', hi: 'बिक्री' }, { en: 'Rent', hi: 'किराया' }, { en: 'Lease', hi: 'लीज़' }],
      },
      propertyType,
      bhk,
      { label: { en: 'Area (sq ft)', hi: 'एरिया (वर्ग फ़ुट)' }, type: 'number' },
      { label: { en: 'Price (₹)', hi: 'दाम (₹)' }, type: 'number', listColumn: true },
      { label: { en: 'Location', hi: 'लोकेशन' }, type: 'text', listColumn: true },
      {
        label: { en: 'Status', hi: 'स्थिति' },
        type: 'dropdown',
        listColumn: true,
        options: [
          { en: 'Available', hi: 'उपलब्ध' },
          { en: 'On hold', hi: 'होल्ड पर' },
          { en: 'Booked', hi: 'बुक' },
          { en: 'Sold or rented', hi: 'बिक गई या किराए पर' },
        ],
      },
    ],
  },
];

const fields = [
  {
    object: 'contact',
    label: { en: 'Customer type', hi: 'ग्राहक का प्रकार' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Buyer', hi: 'खरीदार' },
      { en: 'Tenant', hi: 'किरायेदार' },
      { en: 'Owner or landlord', hi: 'मालिक या मकान-मालिक' },
      { en: 'Investor', hi: 'निवेशक' },
      { en: 'Builder', hi: 'बिल्डर' },
      { en: 'Channel partner', hi: 'चैनल पार्टनर' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  {
    object: 'lead',
    label: { en: 'Requirement', hi: 'ज़रूरत' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Buy', hi: 'खरीदना' },
      { en: 'Rent', hi: 'किराए पर लेना' },
      { en: 'Sell', hi: 'बेचना' },
      { en: 'Give on rent', hi: 'किराए पर देना' },
    ],
  },
  { object: 'lead', ...propertyType },
  { object: 'lead', ...bhk, listColumn: true },
  { object: 'lead', label: { en: 'Budget (₹)', hi: 'बजट (₹)' }, type: 'number', listColumn: true },
  { object: 'lead', label: { en: 'Preferred location', hi: 'पसंदीदा इलाका' }, type: 'text' },
  { object: 'lead', label: { en: 'Site visit date', hi: 'साइट विज़िट की तारीख' }, type: 'date' },
  // A link to one of the records above (records[0], Properties); its key is known once it exists.
  { object: 'lead', label: { en: 'Property', hi: 'प्रॉपर्टी' }, type: 'lookup', lookupRecord: 0 },
];

// Pages this kind of business does not use. They can be switched back on in Settings → Team & Access.
const hiddenModules = ['projects'];

module.exports = { kit, products: [], fields, records, hiddenModules };
