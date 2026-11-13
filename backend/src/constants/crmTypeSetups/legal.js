// How the CRM is set up for chartered accountants, tax consultants, GST practitioners, company
// secretaries and lawyers (docs/CRM_TYPES_PLAN.md), in English and Hindi. The usual CA and tax
// services are added; an advocate's legal services are not, as their GST works differently
// (reverse charge for a business, exempt for an individual). No quick reply asks for a review:
// the professions' own rules (ICAI, the Bar Council) restrict soliciting work. Each client's
// recurring filings are the company's own records, and a GST client's three months of returns come
// in one click from the project template below (the Projects feature, D92).

// Accounting, auditing and tax consultancy: 18% GST (heading 9982). Both can be changed.
const SAC = '9982';
const GST_RATE_PCT = 18;
const FILING = { en: 'filing', hi: 'फ़ाइलिंग' };
const MONTH = { en: 'month', hi: 'महीना' };
const WORK = { en: 'assignment', hi: 'काम' };
const service = (en, hi, unit) => ({ name: { en, hi }, unit, hsnSac: SAC, gstRatePct: GST_RATE_PCT });
const products = [
  service('Income tax return filing', 'इनकम टैक्स रिटर्न फ़ाइलिंग', FILING),
  service('GST registration', 'GST रजिस्ट्रेशन', WORK),
  service('GST return filing', 'GST रिटर्न फ़ाइलिंग', MONTH),
  service('TDS return filing', 'TDS रिटर्न फ़ाइलिंग', { en: 'quarter', hi: 'तिमाही' }),
  service('Bookkeeping', 'बहीखाता (बुककीपिंग)', MONTH),
  service('Company or LLP registration', 'कंपनी या LLP रजिस्ट्रेशन', WORK),
  service('Tax audit', 'टैक्स ऑडिट', WORK),
  service('Tax notice reply', 'टैक्स नोटिस का जवाब', WORK),
];

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'CA and legal services', hi: 'CA और लीगल सर्विस' },
  about: {
    en: 'Enquiries, consultations, documents, fees, filings and due dates.',
    hi: 'पूछताछ, सलाह, कागज़, फ़ीस, फ़ाइलिंग और आखिरी तारीखें।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Consultation done', hi: 'सलाह-मशविरा हो गया' }, probability: 30, quietDays: 3 },
    { kind: 'Contacted', name: { en: 'Documents received', hi: 'कागज़ मिल गए' }, probability: 45, quietDays: 3 },
    { kind: 'Quote Sent', name: { en: 'Fee quoted', hi: 'फ़ीस बताई' }, probability: 60, quietDays: 3 },
    { kind: 'Negotiation', name: { en: 'Engagement letter sent', hi: 'एंगेजमेंट लेटर भेजा' }, probability: 80, quietDays: 5 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the work', hi: 'काम के बारे में पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Please tell us what you need help with (income tax, GST, a company, an audit or a legal matter) and any due date, and we will guide you.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। कृपया बताइए किस काम में मदद चाहिए (इनकम टैक्स, GST, कंपनी, ऑडिट या कोई कानूनी मामला) और कोई आखिरी तारीख हो तो वह भी — हम आपको रास्ता बताएँगे।',
      },
    },
    {
      shortcut: 'meeting',
      title: { en: 'Meeting', hi: 'मीटिंग' },
      body: {
        en: 'Our meeting is fixed for ___ at ___ (___). Please keep ___ ready.',
        hi: 'हमारी मीटिंग ___ को ___ बजे (___) तय है। कृपया ___ तैयार रखिए।',
      },
    },
    {
      shortcut: 'documents',
      title: { en: 'Documents needed', hi: 'ज़रूरी कागज़' },
      body: {
        en: 'For this work we need: ___. Please send clear photos or PDFs here, or by email to ___.',
        hi: 'इस काम के लिए चाहिए: ___। कृपया साफ़ फ़ोटो या PDF यहीं भेजिए, या ___ पर ईमेल कीजिए।',
      },
    },
    {
      shortcut: 'fee',
      title: { en: 'Fee', hi: 'फ़ीस' },
      body: {
        en: 'Our fee for ___ is ₹___ + GST. It includes ___. Shall we start?',
        hi: '___ के लिए हमारी फ़ीस ₹___ + GST है। इसमें ___ शामिल है। क्या काम शुरू करें?',
      },
    },
    {
      shortcut: 'itr',
      title: { en: 'Income tax return', hi: 'इनकम टैक्स रिटर्न' },
      body: {
        en: 'Namaste {{contact.name}} ji, the last date to file your income tax return is ___. Please send your Form 16, bank statements and ___.',
        hi: 'नमस्ते {{contact.name}} जी, आपका इनकम टैक्स रिटर्न भरने की आखिरी तारीख ___ है। कृपया फ़ॉर्म 16, बैंक स्टेटमेंट और ___ भेजिए।',
      },
    },
    {
      shortcut: 'gst',
      title: { en: 'GST return reminder', hi: 'GST रिटर्न की याद' },
      body: {
        en: 'A reminder: the GST return for ___ is due on ___. Please share your sales and purchase bills by ___.',
        hi: 'याद दिला दें: ___ का GST रिटर्न ___ तक भरना है। कृपया अपने बिक्री और खरीद के बिल ___ तक भेज दीजिए।',
      },
    },
    {
      shortcut: 'filed',
      title: { en: 'Filed', hi: 'फ़ाइल हो गया' },
      body: {
        en: 'Your ___ has been filed. Acknowledgement no.: ___. A copy is attached.',
        hi: 'आपका ___ फ़ाइल हो गया है। पावती (Acknowledgement) नंबर: ___। कॉपी साथ में है।',
      },
    },
    {
      shortcut: 'invoice',
      title: { en: 'Fee invoice', hi: 'फ़ीस का इनवॉइस' },
      body: {
        en: 'Your invoice for ___ is attached: ₹___ + GST. Please pay by ___.',
        hi: '___ का आपका इनवॉइस साथ में है: ₹___ + GST। कृपया ___ तक भुगतान कर दीजिए।',
      },
    },
  ],
  terms: {
    en: [
      '1. The fee is for the work described; government fees, penalties and late fees are paid by the client at actuals.',
      '2. GST is extra at the applicable rate.',
      '3. The work starts once the documents and the advance fee (if any) are received.',
      '4. Due dates depend on complete documents reaching us in time; delays from late or missing documents are not ours.',
      '5. The client is responsible for the truth of the information and documents given.',
      '6. Recurring work (GST returns, TDS, bookkeeping) is billed monthly or quarterly as agreed.',
      '7. This quotation is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. फ़ीस बताए गए काम के लिए है; सरकारी फ़ीस, जुर्माना और लेट फ़ीस क्लाइंट असल के अनुसार देगा।',
      '2. GST लागू दर से अलग।',
      '3. कागज़ और एडवांस फ़ीस (अगर हो) मिलने पर काम शुरू होगा।',
      '4. आखिरी तारीखें समय पर पूरे कागज़ मिलने पर निर्भर हैं; देर से या अधूरे कागज़ से हुई देरी हमारी नहीं।',
      '5. दी गई जानकारी और कागज़ों की सच्चाई की ज़िम्मेदारी क्लाइंट की है।',
      '6. बार-बार होने वाला काम (GST रिटर्न, TDS, बहीखाता) तय अनुसार हर महीने या तिमाही बिल होगा।',
      '7. यह कोटेशन दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 15,
};

// The company's own kinds of record, shown under "Your records". The record's own customer link is
// the client.
const records = [
  {
    singular: { en: 'Compliance', hi: 'कंप्लायंस' },
    plural: { en: 'Compliances', hi: 'कंप्लायंस' },
    icon: 'file-contract',
    fields: [
      {
        label: { en: 'Filing', hi: 'फ़ाइलिंग' },
        type: 'dropdown',
        listColumn: true,
        options: [
          { en: 'GST return', hi: 'GST रिटर्न' },
          { en: 'TDS return', hi: 'TDS रिटर्न' },
          { en: 'Income tax return', hi: 'इनकम टैक्स रिटर्न' },
          { en: 'ROC filing', hi: 'ROC फ़ाइलिंग' },
          { en: 'Audit', hi: 'ऑडिट' },
          { en: 'Other', hi: 'अन्य' },
        ],
      },
      {
        label: { en: 'How often', hi: 'कितनी बार' },
        type: 'dropdown',
        options: [{ en: 'Monthly', hi: 'मासिक' }, { en: 'Quarterly', hi: 'तिमाही' }, { en: 'Yearly', hi: 'सालाना' }],
      },
      { label: { en: 'Next due date', hi: 'अगली आखिरी तारीख' }, type: 'date', listColumn: true },
      { label: { en: 'Handled by', hi: 'कौन देख रहा है' }, type: 'text' },
      {
        label: { en: 'Status', hi: 'स्थिति' },
        type: 'dropdown',
        listColumn: true,
        options: [{ en: 'Pending', hi: 'बाकी' }, { en: 'Filed', hi: 'फ़ाइल हो गया' }, { en: 'Late', hi: 'देर हो गई' }],
      },
    ],
  },
];

const fields = [
  {
    object: 'contact',
    label: { en: 'Client type', hi: 'क्लाइंट का प्रकार' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Individual', hi: 'व्यक्ति' },
      { en: 'Proprietor', hi: 'प्रोप्राइटर' },
      { en: 'Partnership or LLP', hi: 'पार्टनरशिप या LLP' },
      { en: 'Company', hi: 'कंपनी' },
      { en: 'Trust or society', hi: 'ट्रस्ट या संस्था' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  {
    object: 'lead',
    label: { en: 'Work area', hi: 'काम का क्षेत्र' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Income tax', hi: 'इनकम टैक्स' },
      { en: 'GST', hi: 'GST' },
      { en: 'Company or LLP', hi: 'कंपनी या LLP' },
      { en: 'Audit', hi: 'ऑडिट' },
      { en: 'Accounting', hi: 'अकाउंटिंग' },
      { en: 'Legal matter', hi: 'कानूनी मामला' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  { object: 'lead', label: { en: 'Due date', hi: 'आखिरी तारीख' }, type: 'date', listColumn: true },
  { object: 'lead', label: { en: 'Financial or assessment year', hi: 'वित्त वर्ष या आकलन वर्ष' }, type: 'text' },
  { object: 'lead', label: { en: 'Documents received', hi: 'कागज़ मिल गए' }, type: 'checkbox' },
];

// A GST client's quarter: Projects → "Start the project" on the won case, starting on the 1st of a
// month, gives each month's bills (the /gst reminder), GSTR-1 by the 11th and GSTR-3B by the 20th.
const months = [
  { en: 'Month 1', hi: 'पहला महीना' },
  { en: 'Month 2', hi: 'दूसरा महीना' },
  { en: 'Month 3', hi: 'तीसरा महीना' },
];
const projectTemplates = [
  {
    name: { en: 'GST returns: 3 months', hi: 'GST रिटर्न: 3 महीने' },
    days: 90,
    milestones: months.map((name, index) => ({ name, dueAfterDays: index * 30 + 19 })),
    tasks: months.flatMap((name, index) => [
      { title: { en: `${name.en}: collect the sales and purchase bills (/gst)`, hi: `${name.hi}: बिक्री और खरीद के बिल लें (/gst)` }, milestone: index, dueAfterDays: index * 30 + 3, priority: 'Medium' },
      { title: { en: `${name.en}: file GSTR-1`, hi: `${name.hi}: GSTR-1 फ़ाइल करें` }, milestone: index, dueAfterDays: index * 30 + 10, priority: 'High' },
      { title: { en: `${name.en}: file GSTR-3B and send the challan (/filed)`, hi: `${name.hi}: GSTR-3B फ़ाइल करें और चालान भेजें (/filed)` }, milestone: index, dueAfterDays: index * 30 + 19, priority: 'High' },
    ]),
  },
];

module.exports = { kit, products, fields, records, projectTemplates, hiddenModules: [] };
