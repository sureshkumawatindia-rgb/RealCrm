// How the CRM is set up for an insurance or loan agent — insurance agents and POSPs, and loan DSAs
// (docs/CRM_TYPES_PLAN.md), in English and Hindi. The products are the usual insurance and loan
// products, so an enquiry's "interested product" and the reports work at once; the insurer or the
// bank bills the client, so their price stays 0 and they carry no GST here. The policies sold are
// the company's own records, with their renewal dates; a new policy's year of renewal reminders
// comes in one click from the project template below (the Projects feature, D92).

const policy = { en: 'policy', hi: 'पॉलिसी' };
const loan = { en: 'loan', hi: 'लोन' };
const product = (en, hi, unit) => ({ name: { en, hi }, unit, hsnSac: '', gstRatePct: 0 });
const products = [
  product('Term insurance', 'टर्म इंश्योरेंस', policy),
  product('Health insurance', 'हेल्थ इंश्योरेंस', policy),
  product('Life insurance', 'लाइफ़ इंश्योरेंस', policy),
  product('Motor insurance', 'मोटर इंश्योरेंस', policy),
  product('Home loan', 'होम लोन', loan),
  product('Personal loan', 'पर्सनल लोन', loan),
  product('Business loan', 'बिज़नेस लोन', loan),
  product('Loan against property', 'प्रॉपर्टी पर लोन', loan),
  product('Car loan', 'कार लोन', loan),
];

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Insurance and loan agent', hi: 'इंश्योरेंस और लोन एजेंट' },
  about: {
    en: 'Enquiries, options, documents, applications and renewals.',
    hi: 'पूछताछ, विकल्प, कागज़, आवेदन और रिन्यूअल।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Need understood', hi: 'ज़रूरत समझ ली' }, probability: 20, quietDays: 2 },
    { kind: 'Quote Sent', name: { en: 'Options shared', hi: 'विकल्प भेजे' }, probability: 40, quietDays: 3 },
    { kind: 'Negotiation', name: { en: 'Documents collected', hi: 'कागज़ मिल गए' }, probability: 60, quietDays: 3 },
    { kind: 'Negotiation', name: { en: 'Application submitted', hi: 'आवेदन जमा' }, probability: 80, quietDays: 7 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the need', hi: 'ज़रूरत पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Please tell us what you are looking for — which insurance or loan, for whom, and roughly how much — and we will share the best options.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। कृपया बताइए आपको क्या चाहिए — कौन-सा इंश्योरेंस या लोन, किसके लिए, और लगभग कितनी रकम का — हम आपको सबसे अच्छे विकल्प भेजेंगे।',
      },
    },
    {
      shortcut: 'options',
      title: { en: 'Options', hi: 'विकल्प' },
      body: {
        en: 'Here are the options for you: ___. Premium or EMI: ₹___. Shall we go ahead with one of them?',
        hi: 'आपके लिए ये विकल्प हैं: ___। प्रीमियम या EMI: ₹___। क्या इनमें से किसी के साथ आगे बढ़ें?',
      },
    },
    {
      shortcut: 'documents',
      title: { en: 'Documents needed', hi: 'ज़रूरी कागज़' },
      body: {
        en: "Please send these documents: PAN card, Aadhaar card, a photo and ___. For a loan, also the last 6 months' bank statement and the salary slips or ITR.",
        hi: 'कृपया ये कागज़ भेजिए: PAN कार्ड, आधार कार्ड, एक फ़ोटो और ___। लोन के लिए पिछले 6 महीने का बैंक स्टेटमेंट और सैलरी स्लिप या ITR भी।',
      },
    },
    {
      shortcut: 'submitted',
      title: { en: 'Application submitted', hi: 'आवेदन जमा' },
      body: {
        en: 'Your application has been submitted to ___. We will tell you as soon as there is an update; it usually takes ___ days.',
        hi: 'आपका आवेदन ___ में जमा हो गया है। कोई भी खबर आते ही हम बताएँगे; आम तौर पर ___ दिन लगते हैं।',
      },
    },
    {
      shortcut: 'approved',
      title: { en: 'Approved', hi: 'मंज़ूर' },
      body: {
        en: 'Good news, {{contact.name}} ji! Your ___ is approved. ___',
        hi: 'खुशखबरी, {{contact.name}} जी! आपका ___ मंज़ूर हो गया है। ___',
      },
    },
    {
      shortcut: 'renewal',
      title: { en: 'Renewal reminder', hi: 'रिन्यूअल की याद' },
      body: {
        en: 'Namaste {{contact.name}} ji, your ___ policy is due for renewal on ___. Premium: ₹___. Shall we renew it so your cover does not stop?',
        hi: 'नमस्ते {{contact.name}} जी, आपकी ___ पॉलिसी का रिन्यूअल ___ को है। प्रीमियम: ₹___। क्या इसे रिन्यू कर दें ताकि आपका कवर न रुके?',
      },
    },
    {
      shortcut: 'referral',
      title: { en: 'Thanks and referral', hi: 'धन्यवाद और रेफ़रल' },
      body: {
        en: 'Thank you for trusting {{org.name}}, {{contact.name}} ji! If a friend or relative needs insurance or a loan, please share our number: ___',
        hi: '{{org.name}} पर भरोसा करने के लिए धन्यवाद, {{contact.name}} जी! अगर किसी दोस्त या रिश्तेदार को इंश्योरेंस या लोन चाहिए, तो हमारा नंबर दीजिए: ___',
      },
    },
  ],
  terms: {
    en: [
      '1. Premiums, rates and offers are as given by the insurer or the bank on the date shown, and may change.',
      "2. The policy or the loan depends on the insurer's or the bank's approval and their terms and conditions.",
      '3. Please read the policy wording or the loan agreement before you sign; what it says is final.',
      '4. The information you give must be true and complete; wrong or hidden details can lead to a rejected claim or loan.',
      '5. Premiums and loan charges are paid to the insurer or the bank directly.',
      '6. This quotation is valid until the date shown.',
      "7. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. प्रीमियम, ब्याज दर और ऑफ़र बीमा कंपनी या बैंक के अनुसार दी गई तारीख के हैं, और बदल सकते हैं।',
      '2. पॉलिसी या लोन बीमा कंपनी या बैंक की मंज़ूरी और उनकी शर्तों पर निर्भर है।',
      '3. साइन करने से पहले पॉलिसी के नियम या लोन का एग्रीमेंट पढ़ लें; उसमें लिखी बात ही अंतिम है।',
      '4. आपकी दी जानकारी सच्ची और पूरी होनी चाहिए; गलत या छिपाई गई जानकारी से क्लेम या लोन रद्द हो सकता है।',
      '5. प्रीमियम और लोन के चार्ज सीधे बीमा कंपनी या बैंक को दिए जाते हैं।',
      '6. यह कोटेशन दी गई तारीख तक मान्य है।',
      '7. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 7,
};

// The company's own kinds of record, shown under "Your records". The record's own customer link is
// the policy holder.
const records = [
  {
    singular: { en: 'Policy', hi: 'पॉलिसी' },
    plural: { en: 'Policies', hi: 'पॉलिसी' },
    icon: 'shield-halved',
    fields: [
      {
        label: { en: 'Policy type', hi: 'पॉलिसी का प्रकार' },
        type: 'dropdown',
        options: [
          { en: 'Term', hi: 'टर्म' },
          { en: 'Health', hi: 'हेल्थ' },
          { en: 'Life', hi: 'लाइफ़' },
          { en: 'Motor', hi: 'मोटर' },
          { en: 'Home', hi: 'होम' },
          { en: 'Travel', hi: 'ट्रैवल' },
          { en: 'Other', hi: 'अन्य' },
        ],
      },
      { label: { en: 'Insurer', hi: 'बीमा कंपनी' }, type: 'text' },
      { label: { en: 'Policy number', hi: 'पॉलिसी नंबर' }, type: 'text' },
      { label: { en: 'Premium (₹)', hi: 'प्रीमियम (₹)' }, type: 'number', listColumn: true },
      {
        label: { en: 'Premium frequency', hi: 'प्रीमियम कितनी बार' },
        type: 'dropdown',
        options: [
          { en: 'Yearly', hi: 'सालाना' },
          { en: 'Half-yearly', hi: 'छमाही' },
          { en: 'Quarterly', hi: 'तिमाही' },
          { en: 'Monthly', hi: 'मासिक' },
        ],
      },
      { label: { en: 'Renewal date', hi: 'रिन्यूअल की तारीख' }, type: 'date', listColumn: true },
      {
        label: { en: 'Status', hi: 'स्थिति' },
        type: 'dropdown',
        listColumn: true,
        options: [
          { en: 'Active', hi: 'चालू' },
          { en: 'Renewal due', hi: 'रिन्यूअल बाकी' },
          { en: 'Lapsed', hi: 'बंद हो गई' },
          { en: 'Cancelled', hi: 'रद्द' },
        ],
      },
    ],
  },
];

const fields = [
  { object: 'contact', label: { en: 'Date of birth', hi: 'जन्म तारीख' }, type: 'date' },
  {
    object: 'contact',
    label: { en: 'Occupation', hi: 'पेशा' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Salaried', hi: 'नौकरी' },
      { en: 'Self-employed', hi: 'स्वरोज़गार' },
      { en: 'Business owner', hi: 'कारोबारी' },
      { en: 'Professional', hi: 'प्रोफ़ेशनल' },
      { en: 'Retired', hi: 'रिटायर्ड' },
      { en: 'Student', hi: 'छात्र' },
      { en: 'Homemaker', hi: 'गृहिणी' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  { object: 'lead', label: { en: 'Cover or loan amount (₹)', hi: 'बीमा राशि या लोन की रकम (₹)' }, type: 'number', listColumn: true },
  { object: 'lead', label: { en: 'Monthly income (₹)', hi: 'मासिक आय (₹)' }, type: 'number' },
  { object: 'lead', label: { en: 'Insurer or bank', hi: 'बीमा कंपनी या बैंक' }, type: 'text', listColumn: true },
  { object: 'lead', label: { en: 'Application number', hi: 'आवेदन नंबर' }, type: 'text' },
];

// A new policy's year: Projects → "Start the project" on the won case with this template gives the
// welcome, two renewal reminders (the /renewal quick reply) and the renewal itself.
const projectTemplates = [
  {
    name: { en: 'Policy: a year to the renewal', hi: 'पॉलिसी: रिन्यूअल तक का साल' },
    days: 365,
    milestones: [
      { name: { en: 'Policy issued', hi: 'पॉलिसी जारी' }, dueAfterDays: 0 },
      { name: { en: 'Renewal', hi: 'रिन्यूअल' }, dueAfterDays: 365 },
    ],
    tasks: [
      { title: { en: 'Send the policy copy and thank the client (/referral)', hi: 'पॉलिसी की कॉपी भेजें और धन्यवाद कहें (/referral)' }, milestone: 0, dueAfterDays: 0, priority: 'High' },
      { title: { en: 'Call to check the client has the policy papers', hi: 'फ़ोन करके पूछें कि पॉलिसी के कागज़ मिल गए' }, milestone: 0, dueAfterDays: 15, priority: 'Medium' },
      { title: { en: 'First renewal reminder (/renewal)', hi: 'रिन्यूअल की पहली याद (/renewal)' }, milestone: 1, dueAfterDays: 335, priority: 'Medium' },
      { title: { en: 'Second renewal reminder (/renewal)', hi: 'रिन्यूअल की दूसरी याद (/renewal)' }, milestone: 1, dueAfterDays: 358, priority: 'High' },
      { title: { en: 'Renew the policy', hi: 'पॉलिसी रिन्यू करें' }, milestone: 1, dueAfterDays: 365, priority: 'High' },
    ],
  },
];

module.exports = { kit, products, fields, records, projectTemplates, hiddenModules: [] };
