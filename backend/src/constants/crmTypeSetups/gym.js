// How the CRM is set up for a gym or a fitness centre — gyms, yoga centres, Zumba and fitness
// studios (docs/CRM_TYPES_PLAN.md), in English and Hindi. The packages are the Products list (named
// Packages for this type). Customers keep their name: "members" would be mixed up with the team's
// members. Each member's membership, with its end date, is the company's own record, and a new
// membership's three months come in one click from the project template below (Projects, D92).

// Physical well-being services (health clubs, fitness centres, yoga): 5% GST without input tax
// credit since 22 September 2025 (56th GST Council; 18% before). SAC heading 9997.
const SAC = '9997';
const GST_RATE_PCT = 5;
const MONTH = { en: 'month', hi: 'महीना' };
const pack = (en, hi, unit) => ({ name: { en, hi }, unit, hsnSac: SAC, gstRatePct: GST_RATE_PCT });
const products = [
  pack('Monthly membership', 'मासिक मेंबरशिप', MONTH),
  pack('Quarterly membership', 'तिमाही मेंबरशिप', { en: '3 months', hi: '3 महीने' }),
  pack('Half-yearly membership', 'छमाही मेंबरशिप', { en: '6 months', hi: '6 महीने' }),
  pack('Yearly membership', 'सालाना मेंबरशिप', { en: 'year', hi: 'साल' }),
  pack('Personal training', 'पर्सनल ट्रेनिंग', MONTH),
  pack('Group classes (yoga, Zumba …)', 'ग्रुप क्लास (योग, ज़ुम्बा …)', MONTH),
];

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Gym and fitness', hi: 'जिम और फ़िटनेस' },
  about: {
    en: 'Enquiries, trial sessions, memberships and renewals.',
    hi: 'पूछताछ, ट्रायल सेशन, मेंबरशिप और रिन्यूअल।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Trial booked', hi: 'ट्रायल बुक' }, probability: 30, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Trial done', hi: 'ट्रायल हो गया' }, probability: 50, quietDays: 2 },
    { kind: 'Quote Sent', name: { en: 'Package shared', hi: 'पैकेज बताया' }, probability: 60, quietDays: 2 },
    { kind: 'Negotiation', name: { en: 'Ready to join', hi: 'जॉइन करने को तैयार' }, probability: 80, quietDays: 2 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the goal', hi: 'लक्ष्य पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. What is your fitness goal (weight loss, muscle gain, general fitness), and when would you like to come for a trial session?',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। आपका फ़िटनेस लक्ष्य क्या है (वज़न घटाना, मसल बनाना, फ़िट रहना), और आप ट्रायल सेशन के लिए कब आना चाहेंगे?',
      },
    },
    {
      shortcut: 'trial',
      title: { en: 'Trial booked', hi: 'ट्रायल बुक' },
      body: {
        en: 'Your trial session is booked for ___ at ___. Please bring sports shoes, a towel and a water bottle.',
        hi: 'आपका ट्रायल सेशन ___ को ___ बजे बुक है। कृपया स्पोर्ट्स शूज़, तौलिया और पानी की बोतल साथ लाएँ।',
      },
    },
    {
      shortcut: 'packages',
      title: { en: 'Packages and fees', hi: 'पैकेज और फ़ीस' },
      body: {
        en: 'Our packages: monthly ₹___, quarterly ₹___, half-yearly ₹___, yearly ₹___. Personal training: ₹___ a month. Which one shall we start?',
        hi: 'हमारे पैकेज: मासिक ₹___, तिमाही ₹___, छमाही ₹___, सालाना ₹___। पर्सनल ट्रेनिंग: ₹___ महीना। कौन-सा शुरू करें?',
      },
    },
    {
      shortcut: 'welcome',
      title: { en: 'Welcome', hi: 'स्वागत' },
      body: {
        en: 'Welcome to {{org.name}}, {{contact.name}} ji! Your membership runs from ___ to ___. Timings: ___.',
        hi: '{{org.name}} में आपका स्वागत है, {{contact.name}} जी! आपकी मेंबरशिप ___ से ___ तक है। समय: ___।',
      },
    },
    {
      shortcut: 'renewal',
      title: { en: 'Renewal reminder', hi: 'रिन्यूअल की याद' },
      body: {
        en: 'Namaste {{contact.name}} ji, your membership ends on ___. Renew now to keep going: ___.',
        hi: 'नमस्ते {{contact.name}} जी, आपकी मेंबरशिप ___ को खत्म हो रही है। लगातार आते रहने के लिए अभी रिन्यू करें: ___।',
      },
    },
    {
      shortcut: 'missed',
      title: { en: 'We missed you', hi: 'आपकी कमी खली' },
      body: {
        en: 'We missed you at {{org.name}}, {{contact.name}} ji! It has been ___ days since your last visit. Shall we see you tomorrow?',
        hi: '{{org.name}} में आपकी कमी खली, {{contact.name}} जी! पिछली बार आए ___ दिन हो गए। क्या कल मिलें?',
      },
    },
    {
      shortcut: 'referral',
      title: { en: 'Bring a friend', hi: 'दोस्त को लाएँ' },
      body: {
        en: 'Bring a friend to {{org.name}}! If your friend joins, you both get ___.',
        hi: 'अपने दोस्त को {{org.name}} लाइए! दोस्त के जॉइन करने पर आप दोनों को ___ मिलेगा।',
      },
    },
    {
      shortcut: 'review',
      title: { en: 'Ask for a review', hi: 'रिव्यू माँगें' },
      body: {
        en: 'Thank you for training with {{org.name}}! Please leave us a Google review: ___',
        hi: '{{org.name}} के साथ ट्रेनिंग के लिए धन्यवाद! कृपया Google पर रिव्यू दीजिए: ___',
      },
    },
  ],
  terms: {
    en: [
      '1. Fees are for the package and the period shown; GST is extra at the applicable rate.',
      '2. A membership starts on the date given and is for the member named only.',
      '3. Refunds and pauses follow our membership policy.',
      '4. Please tell us about any medical condition or injury before you start, and use the equipment as the trainer shows.',
      '5. Gym timings and holidays are as displayed at the gym.',
      '6. Personal training sessions are used within the package validity.',
      '7. This quotation is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. फ़ीस बताए गए पैकेज और अवधि के लिए है; GST लागू दर से अलग।',
      '2. मेंबरशिप दी गई तारीख से शुरू होगी और सिर्फ़ उसी व्यक्ति के लिए है जिसका नाम लिखा है।',
      '3. रिफ़ंड और मेंबरशिप रोकना हमारी मेंबरशिप नीति के अनुसार होगा।',
      '4. शुरू करने से पहले कोई बीमारी या चोट हो तो ज़रूर बताइए, और मशीनें ट्रेनर के बताए तरीके से चलाइए।',
      '5. जिम का समय और छुट्टियाँ जिम में लिखे अनुसार।',
      '6. पर्सनल ट्रेनिंग के सेशन पैकेज की अवधि में इस्तेमाल करने होंगे।',
      '7. यह कोटेशन दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 7,
};

// The company's own kinds of record, shown under "Your records". The record's own customer link is
// the member.
const records = [
  {
    singular: { en: 'Membership', hi: 'मेंबरशिप' },
    plural: { en: 'Memberships', hi: 'मेंबरशिप' },
    icon: 'tag',
    fields: [
      { label: { en: 'Package', hi: 'पैकेज' }, type: 'text', listColumn: true },
      { label: { en: 'Start date', hi: 'शुरू होने की तारीख' }, type: 'date' },
      { label: { en: 'End date', hi: 'ख़त्म होने की तारीख' }, type: 'date', listColumn: true },
      { label: { en: 'Amount paid (₹)', hi: 'दी गई रकम (₹)' }, type: 'number' },
      { label: { en: 'Personal trainer', hi: 'पर्सनल ट्रेनर' }, type: 'text' },
      {
        label: { en: 'Status', hi: 'स्थिति' },
        type: 'dropdown',
        listColumn: true,
        options: [
          { en: 'Active', hi: 'चालू' },
          { en: 'Ending soon', hi: 'जल्द ख़त्म' },
          { en: 'Ended', hi: 'ख़त्म' },
          { en: 'Paused', hi: 'रुकी हुई' },
          { en: 'Cancelled', hi: 'रद्द' },
        ],
      },
    ],
  },
];

const fields = [
  { object: 'contact', label: { en: 'Birthday', hi: 'जन्मदिन' }, type: 'date' },
  {
    object: 'contact',
    label: { en: 'Fitness goal', hi: 'फ़िटनेस लक्ष्य' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Weight loss', hi: 'वज़न घटाना' },
      { en: 'Muscle gain', hi: 'मसल बनाना' },
      { en: 'General fitness', hi: 'फ़िट रहना' },
      { en: 'Strength', hi: 'ताकत' },
      { en: 'Flexibility and yoga', hi: 'लचीलापन और योग' },
      { en: 'Sports', hi: 'खेल' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  // For the trainer's care: what to avoid. Kept short, and only what training needs.
  { object: 'contact', label: { en: 'Injuries or health notes', hi: 'चोट या सेहत के नोट' }, type: 'textarea' },
  { object: 'lead', label: { en: 'Trial date', hi: 'ट्रायल की तारीख' }, type: 'date', listColumn: true },
  {
    object: 'lead',
    label: { en: 'Preferred time', hi: 'पसंदीदा समय' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Early morning', hi: 'सुबह जल्दी' },
      { en: 'Morning', hi: 'सुबह' },
      { en: 'Evening', hi: 'शाम' },
      { en: 'Late evening', hi: 'देर शाम' },
    ],
  },
];

// A new member's three months: Projects → "Start the project" on the won deal with this template
// gives the welcome, a first-week check-in, two monthly progress checks, two renewal reminders
// (the /renewal quick reply) and the renewal.
const projectTemplates = [
  {
    name: { en: 'Membership: 3 months', hi: 'मेंबरशिप: 3 महीने' },
    days: 90,
    milestones: [
      { name: { en: 'Joined', hi: 'जॉइन किया' }, dueAfterDays: 0 },
      { name: { en: 'Month 1', hi: 'पहला महीना' }, dueAfterDays: 30 },
      { name: { en: 'Month 2', hi: 'दूसरा महीना' }, dueAfterDays: 60 },
      { name: { en: 'Renewal', hi: 'रिन्यूअल' }, dueAfterDays: 90 },
    ],
    tasks: [
      { title: { en: 'Welcome and induction (/welcome)', hi: 'स्वागत और शुरुआती जानकारी (/welcome)' }, milestone: 0, dueAfterDays: 0, priority: 'High' },
      { title: { en: 'Ask how the first week went', hi: 'पूछें कि पहला हफ़्ता कैसा रहा' }, milestone: 0, dueAfterDays: 7, priority: 'Medium' },
      { title: { en: 'Progress check: weight and measurements', hi: 'प्रगति देखें: वज़न और नाप' }, milestone: 1, dueAfterDays: 30, priority: 'Medium' },
      { title: { en: 'Progress check: weight and measurements', hi: 'प्रगति देखें: वज़न और नाप' }, milestone: 2, dueAfterDays: 60, priority: 'Medium' },
      { title: { en: 'First renewal reminder (/renewal)', hi: 'रिन्यूअल की पहली याद (/renewal)' }, milestone: 3, dueAfterDays: 80, priority: 'Medium' },
      { title: { en: 'Second renewal reminder (/renewal)', hi: 'रिन्यूअल की दूसरी याद (/renewal)' }, milestone: 3, dueAfterDays: 87, priority: 'High' },
      { title: { en: 'Renew the membership', hi: 'मेंबरशिप रिन्यू करें' }, milestone: 3, dueAfterDays: 90, priority: 'High' },
    ],
  },
];

module.exports = { kit, products, fields, records, projectTemplates, hiddenModules: [] };
