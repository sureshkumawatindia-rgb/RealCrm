// How the CRM is set up for transport and logistics — fleet owners, transport agencies and
// brokers, packers and movers (docs/CRM_TYPES_PLAN.md), in English and Hindi. No services are added:
// a goods transport agency's GST depends on its option and on who pays (reverse charge or forward
// charge), which one rate on a product cannot hold. The company's own vehicles and the transporters
// it hires are its own records. Projects is hidden: a load is booked, moved and delivered in days.
const { transporters } = require('./shared');

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Transport and logistics', hi: 'ट्रांसपोर्ट और लॉजिस्टिक्स' },
  about: {
    en: 'Load enquiries, rates, vehicles, LR, delivery and freight payments.',
    hi: 'माल की पूछताछ, रेट, गाड़ी, LR, डिलीवरी और भाड़े का भुगतान।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Load details taken', hi: 'माल की जानकारी ली' }, probability: 25, quietDays: 1 },
    { kind: 'Quote Sent', name: { en: 'Rate shared', hi: 'रेट बताया' }, probability: 45, quietDays: 1 },
    { kind: 'Negotiation', name: { en: 'Negotiation', hi: 'मोलभाव' }, probability: 65, quietDays: 1 },
    { kind: 'Negotiation', name: { en: 'Vehicle arranged', hi: 'गाड़ी तय' }, probability: 85, quietDays: 1 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the load', hi: 'माल के बारे में पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Please tell us: from where to where, the goods and their weight, the vehicle you need, and the loading date.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। कृपया बताइए: कहाँ से कहाँ तक, कौन-सा माल और कितना वज़न, कैसी गाड़ी चाहिए, और लोडिंग की तारीख।',
      },
    },
    {
      shortcut: 'rate',
      title: { en: 'Rate', hi: 'रेट' },
      body: {
        en: 'Rate from ___ to ___ (___ vehicle): ₹___, including ___. Loading on ___. Shall we book it?',
        hi: '___ से ___ तक (___ गाड़ी) का रेट: ₹___, ___ के साथ। लोडिंग ___ को। क्या बुक कर दें?',
      },
    },
    {
      shortcut: 'vehicle',
      title: { en: 'Vehicle details', hi: 'गाड़ी की जानकारी' },
      body: {
        en: 'Your vehicle ___ (driver ___, phone ___) will reach the loading point on ___ at ___.',
        hi: 'आपकी गाड़ी ___ (ड्राइवर ___, फ़ोन ___) ___ को ___ बजे लोडिंग की जगह पहुँचेगी।',
      },
    },
    {
      shortcut: 'loaded',
      title: { en: 'Loaded', hi: 'माल लोड हुआ' },
      body: {
        en: 'Your goods are loaded. LR/bilty no.: ___. Expected delivery: ___.',
        hi: 'आपका माल लोड हो गया है। LR/बिल्टी नंबर: ___। डिलीवरी की उम्मीद: ___।',
      },
    },
    {
      shortcut: 'tracking',
      title: { en: 'Where is it', hi: 'माल कहाँ है' },
      body: {
        en: 'Your consignment is at ___ and on time. Expected delivery: ___.',
        hi: 'आपका माल अभी ___ पर है और समय पर चल रहा है। डिलीवरी की उम्मीद: ___।',
      },
    },
    {
      shortcut: 'delivered',
      title: { en: 'Delivered', hi: 'डिलीवर हो गया' },
      body: {
        en: 'Your consignment was delivered on ___. The proof of delivery (POD) is attached.',
        hi: 'आपका माल ___ को डिलीवर हो गया। डिलीवरी का सबूत (POD) साथ में है।',
      },
    },
    {
      shortcut: 'payment',
      title: { en: 'Freight payment', hi: 'भाड़े का भुगतान' },
      body: {
        en: 'A reminder: the freight of ₹___ for LR no. ___ is due by ___. Our bank and UPI details are on the invoice.',
        hi: 'याद दिला दें: LR नंबर ___ का ₹___ भाड़ा ___ तक देना है। हमारे बैंक और UPI की जानकारी इनवॉइस पर है।',
      },
    },
    {
      shortcut: 'thanks',
      title: { en: 'Thank you', hi: 'धन्यवाद' },
      body: {
        en: 'Thank you for your business, {{contact.name}} ji! For your next load, just message us here. — {{org.name}}',
        hi: 'काम देने के लिए धन्यवाद, {{contact.name}} जी! अगले माल के लिए बस यहीं मैसेज कीजिए। — {{org.name}}',
      },
    },
  ],
  terms: {
    en: [
      '1. The rate is for the route, vehicle and weight shown; detention, loading and unloading, and tolls are extra as applicable.',
      '2. The customer declares the goods and their value; prohibited and hazardous goods are not carried.',
      '3. Goods travel at the owner\'s risk unless insured; transit insurance can be arranged on request.',
      '4. Payment as agreed: an advance at loading and the balance on delivery.',
      '5. Delivery times are estimates; road, weather and checkpoint delays may apply.',
      '6. GST is charged as it applies to goods transport.',
      '7. This quotation is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. रेट बताए गए रूट, गाड़ी और वज़न के लिए है; रुकने का चार्ज (डिटेंशन), लोडिंग-अनलोडिंग और टोल लागू होने पर अलग।',
      '2. माल और उसकी कीमत ग्राहक बताएगा; प्रतिबंधित और खतरनाक माल नहीं ले जाया जाता।',
      '3. बीमा न हो तो माल मालिक के जोखिम पर जाता है; माँगने पर ट्रांज़िट बीमा करवाया जा सकता है।',
      '4. भुगतान तय अनुसार: लोडिंग पर एडवांस और डिलीवरी पर बाकी।',
      '5. डिलीवरी का समय अनुमान है; सड़क, मौसम और चेकपोस्ट पर देरी हो सकती है।',
      '6. GST माल ढुलाई पर जैसा लागू हो वैसा लगेगा।',
      '7. यह कोटेशन दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 3, // freight rates change fast
};

// The company's own kinds of record, shown under "Your records": its own vehicles, and the
// transporters it hires (shared with the trader and manufacturer types).
const vehicles = {
  singular: { en: 'Vehicle', hi: 'गाड़ी' },
  plural: { en: 'Vehicles', hi: 'गाड़ियाँ' },
  icon: 'truck',
  fields: [
    { label: { en: 'Registration number', hi: 'गाड़ी का नंबर' }, type: 'text', listColumn: true },
    { label: { en: 'Vehicle type', hi: 'गाड़ी का प्रकार' }, type: 'text' },
    { label: { en: 'Capacity (tonnes)', hi: 'क्षमता (टन)' }, type: 'number' },
    { label: { en: 'Driver', hi: 'ड्राइवर' }, type: 'text', listColumn: true },
    { label: { en: 'Driver phone', hi: 'ड्राइवर का फ़ोन' }, type: 'text' },
    { label: { en: 'Insurance ends', hi: 'इंश्योरेंस कब ख़त्म' }, type: 'date' },
    { label: { en: 'Permit and fitness end', hi: 'परमिट और फ़िटनेस कब ख़त्म' }, type: 'date' },
    {
      label: { en: 'Status', hi: 'स्थिति' },
      type: 'dropdown',
      listColumn: true,
      options: [
        { en: 'Available', hi: 'खाली' },
        { en: 'On a trip', hi: 'ट्रिप पर' },
        { en: 'In repair', hi: 'रिपेयर में' },
      ],
    },
  ],
};

// Extra fields on an enquiry.
const fields = [
  { object: 'lead', label: { en: 'From', hi: 'कहाँ से' }, type: 'text', listColumn: true },
  { object: 'lead', label: { en: 'To', hi: 'कहाँ तक' }, type: 'text', listColumn: true },
  { object: 'lead', label: { en: 'Goods', hi: 'माल' }, type: 'text' },
  { object: 'lead', label: { en: 'Weight (tonnes)', hi: 'वज़न (टन)' }, type: 'number' },
  {
    object: 'lead',
    label: { en: 'Load type', hi: 'लोड का प्रकार' },
    type: 'dropdown',
    options: [{ en: 'Full load', hi: 'पूरा लोड' }, { en: 'Part load', hi: 'पार्ट लोड' }, { en: 'House or office shifting', hi: 'घर या ऑफ़िस शिफ़्टिंग' }],
  },
  {
    object: 'lead',
    label: { en: 'Vehicle needed', hi: 'कैसी गाड़ी चाहिए' },
    type: 'dropdown',
    options: [
      { en: 'Pickup or small truck', hi: 'पिकअप या छोटा ट्रक' },
      { en: '14 ft truck', hi: '14 फ़ुट ट्रक' },
      { en: '17 to 19 ft truck', hi: '17 से 19 फ़ुट ट्रक' },
      { en: '20 ft container', hi: '20 फ़ुट कंटेनर' },
      { en: '32 ft container', hi: '32 फ़ुट कंटेनर' },
      { en: 'Trailer', hi: 'ट्रेलर' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  { object: 'lead', label: { en: 'Loading date', hi: 'लोडिंग की तारीख' }, type: 'date', listColumn: true },
  { object: 'lead', label: { en: 'LR number', hi: 'LR/बिल्टी नंबर' }, type: 'text' },
];

// Pages this kind of business does not use. They can be switched back on in Settings → Team & Access.
const hiddenModules = ['projects'];

module.exports = { kit, products: [], fields, records: [vehicles, transporters], hiddenModules };
