// How the CRM is set up for a solar installer — rooftop solar for homes, societies and businesses
// (docs/CRM_TYPES_PLAN.md), in English and Hindi. No products are added: a turnkey solar system is
// priced by its size and makes, and its GST is split between goods and services (the 70:30 rule),
// which one rate on a product cannot hold. The systems put up are the company's own records, for
// warranty, cleaning and AMC. A won job becomes its 30-day project — subsidy registration, material,
// installation, commissioning, net meter — in one click from the template below (Projects, D92).

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Solar installer', hi: 'सोलर इंस्टॉलर' },
  about: {
    en: 'Enquiries, site surveys, quotations, subsidy, installation and net metering.',
    hi: 'पूछताछ, साइट सर्वे, कोटेशन, सब्सिडी, इंस्टॉलेशन और नेट मीटर।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Site survey done', hi: 'साइट सर्वे हो गया' }, probability: 30, quietDays: 3 },
    { kind: 'Quote Sent', name: { en: 'Quotation sent', hi: 'कोटेशन भेजा' }, probability: 50, quietDays: 5 },
    { kind: 'Negotiation', name: { en: 'Documents and subsidy', hi: 'कागज़ और सब्सिडी' }, probability: 70, quietDays: 5 },
    { kind: 'Negotiation', name: { en: 'Advance awaited', hi: 'एडवांस का इंतज़ार' }, probability: 85, quietDays: 3 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask for the bill', hi: 'बिजली बिल माँगें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Please send a photo of your latest electricity bill and tell us your roof type and the free roof area, and we will suggest the right solar system.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। कृपया अपने पिछले बिजली बिल की फ़ोटो भेजिए और छत का प्रकार और खाली छत की जगह बताइए — हम आपके लिए सही सोलर सिस्टम बताएँगे।',
      },
    },
    {
      shortcut: 'survey',
      title: { en: 'Site survey', hi: 'साइट सर्वे' },
      body: {
        en: 'Our engineer will visit on ___ at ___ for the site survey. It takes about 30 minutes.',
        hi: 'हमारे इंजीनियर ___ को ___ बजे साइट सर्वे के लिए आएँगे। इसमें लगभग 30 मिनट लगते हैं।',
      },
    },
    {
      shortcut: 'quote',
      title: { en: 'Quotation', hi: 'कोटेशन' },
      body: {
        en: 'Here is the quotation for your ___ kW solar system: ₹___, with ___ panels and a ___ inverter. Expected saving: about ₹___ a month on your bill.',
        hi: 'आपके ___ kW सोलर सिस्टम का कोटेशन: ₹___, ___ पैनल और ___ इन्वर्टर के साथ। अंदाज़न बचत: बिल में लगभग ₹___ महीना।',
      },
    },
    {
      shortcut: 'subsidy',
      title: { en: 'Subsidy documents', hi: 'सब्सिडी के कागज़' },
      body: {
        en: 'You may get the government subsidy (PM Surya Ghar) for this system, and we will apply for you. Please send: the electricity bill, Aadhaar, PAN, a cancelled cheque or bank passbook, and a photo of the roof.',
        hi: 'इस सिस्टम पर आपको सरकारी सब्सिडी (पीएम सूर्य घर) मिल सकती है, आवेदन हम कर देंगे। कृपया भेजिए: बिजली बिल, आधार, PAN, कैंसिल चेक या बैंक पासबुक, और छत की फ़ोटो।',
      },
    },
    {
      shortcut: 'install',
      title: { en: 'Installation date', hi: 'इंस्टॉलेशन की तारीख' },
      body: {
        en: 'The installation at your site starts on ___. Our team (___, phone ___) will be there; it takes about ___ days.',
        hi: 'आपकी साइट पर इंस्टॉलेशन ___ से शुरू होगा। हमारी टीम (___, फ़ोन ___) वहाँ रहेगी; इसमें लगभग ___ दिन लगेंगे।',
      },
    },
    {
      shortcut: 'netmeter',
      title: { en: 'Net meter', hi: 'नेट मीटर' },
      body: {
        en: 'Your system is installed! We have applied for the net meter with the electricity board; their inspection is expected by ___.',
        hi: 'आपका सिस्टम लग गया है! हमने बिजली कंपनी में नेट मीटर के लिए आवेदन कर दिया है; उनकी जाँच ___ तक होने की उम्मीद है।',
      },
    },
    {
      shortcut: 'cleaning',
      title: { en: 'Panel cleaning', hi: 'पैनल की सफ़ाई' },
      body: {
        en: 'Clean panels make more power. Shall we book the panel cleaning for ___? Our AMC covers ___ cleanings a year.',
        hi: 'साफ़ पैनल ज़्यादा बिजली बनाते हैं। क्या ___ को पैनल की सफ़ाई बुक कर दें? हमारे AMC में साल में ___ सफ़ाई शामिल हैं।',
      },
    },
    {
      shortcut: 'review',
      title: { en: 'Ask for a review', hi: 'रिव्यू माँगें' },
      body: {
        en: 'Thank you for going solar with {{org.name}}! Please leave us a Google review: ___',
        hi: '{{org.name}} के साथ सोलर लगवाने के लिए धन्यवाद! कृपया Google पर रिव्यू दीजिए: ___',
      },
    },
  ],
  terms: {
    en: [
      '1. The price is for the system size and the makes shown; GST is extra as applicable.',
      '2. Payment as agreed: an advance at booking, the next part at material delivery, and the balance at commissioning.',
      "3. A subsidy, where it applies, is paid by the government into the customer's bank account under the scheme's rules; we help with the application.",
      "4. Net metering depends on the electricity board's inspection and approval, and on their timelines.",
      '5. Panel and inverter warranties are as per the makers; our workmanship warranty is as agreed in writing.',
      '6. The roof must be free of shadow and strong enough for the structure; civil changes are extra.',
      '7. This quotation is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. दाम बताए गए सिस्टम साइज़ और ब्रांड के लिए है; GST लागू होने पर अलग से।',
      '2. भुगतान तय अनुसार: बुकिंग पर एडवांस, मटेरियल आने पर अगला हिस्सा, और चालू होने पर बाकी।',
      '3. सब्सिडी, जहाँ लागू हो, योजना के नियमों के अनुसार सरकार ग्राहक के बैंक खाते में देती है; आवेदन में हम मदद करते हैं।',
      '4. नेट मीटर बिजली कंपनी की जाँच और मंज़ूरी पर, और उनके समय पर निर्भर है।',
      '5. पैनल और इन्वर्टर की वारंटी बनाने वाली कंपनी के अनुसार; हमारे काम की वारंटी जैसा लिखित में तय हो।',
      '6. छत पर छाया नहीं होनी चाहिए और वह ढाँचे के लिए मज़बूत होनी चाहिए; सिविल बदलाव का खर्च अलग।',
      '7. यह कोटेशन दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 15,
};

// The company's own kinds of record, shown under "Your records". The record's own customer link is
// the owner of the system.
const records = [
  {
    singular: { en: 'Installation', hi: 'इंस्टॉलेशन' },
    plural: { en: 'Installations', hi: 'इंस्टॉलेशन' },
    icon: 'bolt',
    fields: [
      { label: { en: 'System size (kW)', hi: 'सिस्टम साइज़ (kW)' }, type: 'number', listColumn: true },
      { label: { en: 'Commissioned on', hi: 'चालू होने की तारीख' }, type: 'date' },
      { label: { en: 'Net meter installed on', hi: 'नेट मीटर लगने की तारीख' }, type: 'date' },
      { label: { en: 'Panel warranty till', hi: 'पैनल की वारंटी कब तक' }, type: 'date' },
      { label: { en: 'AMC till', hi: 'AMC कब तक' }, type: 'date', listColumn: true },
      {
        label: { en: 'Status', hi: 'स्थिति' },
        type: 'dropdown',
        listColumn: true,
        options: [
          { en: 'Running', hi: 'चालू' },
          { en: 'Service due', hi: 'सर्विस बाकी' },
          { en: 'Fault', hi: 'खराबी' },
        ],
      },
    ],
  },
];

// Extra fields on an enquiry.
const fields = [
  {
    object: 'lead',
    label: { en: 'Category', hi: 'श्रेणी' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Home', hi: 'घर' },
      { en: 'Housing society', hi: 'हाउसिंग सोसाइटी' },
      { en: 'Commercial', hi: 'कमर्शियल' },
      { en: 'Industrial', hi: 'इंडस्ट्रियल' },
      { en: 'Agriculture', hi: 'खेती' },
    ],
  },
  { object: 'lead', label: { en: 'Monthly bill (₹)', hi: 'महीने का बिजली बिल (₹)' }, type: 'number', listColumn: true },
  { object: 'lead', label: { en: 'Sanctioned load (kW)', hi: 'स्वीकृत लोड (kW)' }, type: 'number' },
  { object: 'lead', label: { en: 'System size (kW)', hi: 'सिस्टम साइज़ (kW)' }, type: 'number', listColumn: true },
  {
    object: 'lead',
    label: { en: 'System type', hi: 'सिस्टम का प्रकार' },
    type: 'dropdown',
    options: [{ en: 'On-grid', hi: 'ऑन-ग्रिड' }, { en: 'Off-grid', hi: 'ऑफ़-ग्रिड' }, { en: 'Hybrid', hi: 'हाइब्रिड' }],
  },
  {
    object: 'lead',
    label: { en: 'Roof type', hi: 'छत का प्रकार' },
    type: 'dropdown',
    options: [
      { en: 'RCC flat roof', hi: 'पक्की (RCC) छत' },
      { en: 'Tin shed', hi: 'टीन शेड' },
      { en: 'Ground mount', hi: 'ज़मीन पर' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  { object: 'lead', label: { en: 'Shadow-free roof area (sq ft)', hi: 'बिना छाया की छत (वर्ग फ़ुट)' }, type: 'number' },
  { object: 'lead', label: { en: 'Electricity board', hi: 'बिजली कंपनी (DISCOM)' }, type: 'text' },
  { object: 'lead', label: { en: 'Consumer number', hi: 'कंज़्यूमर नंबर' }, type: 'text' },
  {
    object: 'lead',
    label: { en: 'Subsidy', hi: 'सब्सिडी' },
    type: 'dropdown',
    options: [
      { en: 'Applied', hi: 'आवेदन किया' },
      { en: 'Approved', hi: 'मंज़ूर' },
      { en: 'Received', hi: 'मिल गई' },
      { en: 'Not eligible', hi: 'लागू नहीं' },
    ],
  },
];

// A won job's work: Projects → "Start the project" on the won deal with this template.
const projectTemplates = [
  {
    name: { en: 'Rooftop solar: 30 days', hi: 'रूफ़टॉप सोलर: 30 दिन' },
    days: 30,
    milestones: [
      { name: { en: 'Documents and subsidy registration', hi: 'कागज़ और सब्सिडी रजिस्ट्रेशन' }, dueAfterDays: 3 },
      { name: { en: 'Material delivered', hi: 'मटेरियल पहुँचा' }, dueAfterDays: 10 },
      { name: { en: 'Structure and panels installed', hi: 'ढाँचा और पैनल लगे' }, dueAfterDays: 15 },
      { name: { en: 'Electrical work and commissioning', hi: 'बिजली का काम और सिस्टम चालू' }, dueAfterDays: 18 },
      { name: { en: 'Net metering', hi: 'नेट मीटर' }, dueAfterDays: 30 },
    ],
    tasks: [
      { title: { en: 'Register the subsidy and apply to the electricity board (/subsidy)', hi: 'सब्सिडी रजिस्टर करें और बिजली कंपनी में आवेदन करें (/subsidy)' }, milestone: 0, dueAfterDays: 2, priority: 'High' },
      { title: { en: 'Collect the payment for the material', hi: 'मटेरियल का भुगतान लें' }, milestone: 1, dueAfterDays: 8, priority: 'High' },
      { title: { en: 'Deliver the panels, inverter and structure', hi: 'पैनल, इन्वर्टर और ढाँचा पहुँचाएँ' }, milestone: 1, dueAfterDays: 10, priority: 'Medium' },
      { title: { en: 'Put up the structure and the panels (/install)', hi: 'ढाँचा और पैनल लगाएँ (/install)' }, milestone: 2, dueAfterDays: 14, priority: 'High' },
      { title: { en: 'Wiring, earthing and inverter; switch the system on', hi: 'वायरिंग, अर्थिंग और इन्वर्टर; सिस्टम चालू करें' }, milestone: 3, dueAfterDays: 18, priority: 'High' },
      { title: { en: 'Collect the balance at commissioning', hi: 'चालू होने पर बाकी भुगतान लें' }, milestone: 3, dueAfterDays: 18, priority: 'High' },
      { title: { en: 'Apply for the net meter inspection (/netmeter)', hi: 'नेट मीटर की जाँच के लिए आवेदन करें (/netmeter)' }, milestone: 4, dueAfterDays: 20, priority: 'Medium' },
      { title: { en: 'Follow up the net meter installation', hi: 'नेट मीटर लगवाने का फ़ॉलो-अप करें' }, milestone: 4, dueAfterDays: 28, priority: 'Medium' },
      { title: { en: 'Upload the documents for the subsidy claim', hi: 'सब्सिडी क्लेम के कागज़ अपलोड करें' }, milestone: 4, dueAfterDays: 30, priority: 'High' },
      { title: { en: 'Ask for a review (/review)', hi: 'रिव्यू माँगें (/review)' }, milestone: 4, dueAfterDays: 32, priority: 'Medium' },
    ],
  },
];

module.exports = { kit, products: [], fields, records, projectTemplates, hiddenModules: [] };
