// How the CRM is set up for a clinic or a hospital (docs/CRM_TYPES_PLAN.md), in English and Hindi.
// It is for enquiries, appointments, follow-ups and packages, not a medical record: no diagnosis or
// history fields are added (the less health data a CRM keeps, the better). The doctors are the
// company's own records, and an enquiry links its doctor. A package of sittings becomes its
// schedule in one click from the project template below (the Projects feature, D92).

// Health care by a clinic or a doctor is exempt from GST (Notification 12/2017-CT (Rate), entry 74);
// a cosmetic treatment is not, and its rate is set on that treatment. Prices start at 0.
const consultation = (en, hi) => ({ name: { en, hi }, unit: { en: 'visit', hi: 'विज़िट' }, hsnSac: '', gstRatePct: 0 });
const products = [
  consultation('Consultation', 'परामर्श'),
  consultation('Follow-up consultation', 'फ़ॉलो-अप परामर्श'),
];

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Clinic or hospital', hi: 'क्लिनिक या अस्पताल' },
  about: {
    en: 'Patient enquiries, appointments, follow-ups and treatment packages.',
    hi: 'मरीज़ों की पूछताछ, अपॉइंटमेंट, फ़ॉलो-अप और ट्रीटमेंट पैकेज।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Appointment booked', hi: 'अपॉइंटमेंट बुक' }, probability: 30, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Consulted', hi: 'डॉक्टर ने देखा' }, probability: 45, quietDays: 2 },
    { kind: 'Quote Sent', name: { en: 'Treatment advised', hi: 'इलाज बताया' }, probability: 60, quietDays: 3 },
    { kind: 'Negotiation', name: { en: 'Follow-up', hi: 'फ़ॉलो-अप' }, probability: 70, quietDays: 3 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Book an appointment', hi: 'अपॉइंटमेंट के लिए पूछें' },
      body: {
        en: "Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Please tell us the patient's name, the problem in a few words, and a day and time that suits you, and we will book the appointment.",
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। कृपया मरीज़ का नाम, समस्या कुछ शब्दों में, और आपके लिए सही दिन और समय बताइए — हम अपॉइंटमेंट बुक कर देंगे।',
      },
    },
    {
      shortcut: 'appointment',
      title: { en: 'Appointment booked', hi: 'अपॉइंटमेंट बुक' },
      body: {
        en: 'Your appointment with ___ is booked for ___ at ___. Please come 10 minutes early.',
        hi: '___ के साथ आपका अपॉइंटमेंट ___ को ___ बजे बुक है। कृपया 10 मिनट पहले आ जाइए।',
      },
    },
    {
      shortcut: 'reminder',
      title: { en: 'Appointment reminder', hi: 'अपॉइंटमेंट की याद' },
      body: {
        en: 'A reminder: your appointment at {{org.name}} is on ___ at ___. Reply YES to confirm, or tell us a better time.',
        hi: 'याद दिला दें: {{org.name}} में आपका अपॉइंटमेंट ___ को ___ बजे है। पक्का करने के लिए YES लिखें, या कोई और समय बताइए।',
      },
    },
    {
      shortcut: 'location',
      title: { en: 'Address and timings', hi: 'पता और समय' },
      body: {
        en: 'Our clinic: ___ (on Google Maps: ___). Timings: ___.',
        hi: 'हमारा क्लिनिक: ___ (Google Maps पर: ___)। समय: ___।',
      },
    },
    {
      shortcut: 'reports',
      title: { en: 'Bring old reports', hi: 'पुरानी रिपोर्ट लाएँ' },
      body: {
        en: 'Please bring your old prescriptions and test reports, if you have any.',
        hi: 'अगर आपके पास पुराने पर्चे और जाँच की रिपोर्ट हैं, तो कृपया साथ लाएँ।',
      },
    },
    {
      shortcut: 'followup',
      title: { en: 'Follow-up visit', hi: 'फ़ॉलो-अप विज़िट' },
      body: {
        en: 'Namaste {{contact.name}} ji, how are you feeling now? Your follow-up visit is due on ___. Shall we book it?',
        hi: 'नमस्ते {{contact.name}} जी, अब आप कैसा महसूस कर रहे हैं? आपकी फ़ॉलो-अप विज़िट ___ को है। क्या हम उसे बुक कर दें?',
      },
    },
    {
      shortcut: 'estimate',
      title: { en: 'Treatment estimate', hi: 'इलाज का खर्च' },
      body: {
        en: 'The estimate for the advised treatment is ₹___. It includes ___. You can pay by UPI, card or cash at the clinic.',
        hi: 'बताए गए इलाज का अनुमानित खर्च ₹___ है। इसमें ___ शामिल है। आप क्लिनिक पर UPI, कार्ड या नकद से भुगतान कर सकते हैं।',
      },
    },
    {
      shortcut: 'review',
      title: { en: 'Ask for a review', hi: 'रिव्यू माँगें' },
      body: {
        en: 'Thank you for visiting {{org.name}}! If you are happy with our care, please leave us a Google review: ___',
        hi: '{{org.name}} आने के लिए धन्यवाद! अगर आप हमारी देखभाल से खुश हैं, तो कृपया Google पर रिव्यू दीजिए: ___',
      },
    },
  ],
  terms: {
    en: [
      '1. This is an estimate for the advised treatment; the final bill depends on the treatment actually given.',
      '2. Medicines, tests and materials are charged separately unless they are included above.',
      '3. Payment is due at each visit, unless a package is agreed.',
      '4. A package covers the sessions listed; please tell us at least a few hours ahead to change a session.',
      '5. GST applies only where the law requires it (for example, cosmetic treatments).',
      '6. This estimate is valid until the date shown.',
      "7. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. यह बताए गए इलाज का अनुमानित खर्च है; अंतिम बिल असल में दिए गए इलाज पर निर्भर करेगा।',
      '2. दवाइयाँ, जाँच और सामान अलग से लगेंगे, जब तक ऊपर शामिल न हों।',
      '3. भुगतान हर विज़िट पर होगा, जब तक कोई पैकेज तय न हो।',
      '4. पैकेज में लिखे सेशन शामिल हैं; सेशन बदलना हो तो कुछ घंटे पहले बताएँ।',
      '5. GST सिर्फ़ वहीं लगेगा जहाँ कानून कहता है (जैसे कॉस्मेटिक इलाज)।',
      '6. यह अनुमान दी गई तारीख तक मान्य है।',
      '7. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 15,
};

// The company's own kinds of record, shown under "Your records".
const records = [
  {
    singular: { en: 'Doctor', hi: 'डॉक्टर' },
    plural: { en: 'Doctors', hi: 'डॉक्टर' },
    icon: 'user-gear',
    fields: [
      { label: { en: 'Speciality', hi: 'विशेषज्ञता' }, type: 'text', listColumn: true },
      { label: { en: 'OPD days and timings', hi: 'OPD के दिन और समय' }, type: 'text', listColumn: true },
      { label: { en: 'Consultation fee (₹)', hi: 'परामर्श फ़ीस (₹)' }, type: 'number', listColumn: true },
      { label: { en: 'Phone', hi: 'फ़ोन' }, type: 'text' },
    ],
  },
];

// Extra fields on an enquiry.
const fields = [
  { object: 'lead', label: { en: 'Patient name', hi: 'मरीज़ का नाम' }, type: 'text' },
  {
    object: 'lead',
    label: { en: 'Department', hi: 'विभाग' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'General physician', hi: 'सामान्य डॉक्टर' },
      { en: 'Dental', hi: 'दाँत' },
      { en: 'Eye', hi: 'आँख' },
      { en: 'Skin and hair', hi: 'त्वचा और बाल' },
      { en: 'Physiotherapy', hi: 'फ़िज़ियोथेरेपी' },
      { en: 'Gynaecology', hi: 'स्त्री रोग' },
      { en: 'Children', hi: 'बच्चों के डॉक्टर' },
      { en: 'Bones and joints', hi: 'हड्डी और जोड़' },
      { en: 'Ear, nose and throat', hi: 'नाक, कान, गला' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  // A link to one of the records above (records[0], Doctors).
  { object: 'lead', label: { en: 'Doctor', hi: 'डॉक्टर' }, type: 'lookup', lookupRecord: 0 },
  { object: 'lead', label: { en: 'Appointment date', hi: 'अपॉइंटमेंट की तारीख' }, type: 'date', listColumn: true },
  {
    object: 'lead',
    label: { en: 'Visit type', hi: 'विज़िट का प्रकार' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'First visit', hi: 'पहली विज़िट' },
      { en: 'Follow-up', hi: 'फ़ॉलो-अप' },
      { en: 'Procedure', hi: 'प्रोसीजर' },
    ],
  },
];

// A package of sittings (physiotherapy, skin, dental …) in one click: Projects → "Start the project"
// on the won case gives a task for each weekly session, a WhatsApp reminder the day before sessions
// 2 to 6 (the /reminder quick reply) and a review request after the last one.
const SESSIONS = 6;
const EVERY_DAYS = 7;
const sessions = Array.from({ length: SESSIONS }, (unused, index) => index + 1);
const projectTemplates = [
  {
    name: { en: 'Treatment: 6 weekly sessions', hi: 'ट्रीटमेंट: हर हफ़्ते 6 सेशन' },
    days: (SESSIONS - 1) * EVERY_DAYS + 1,
    milestones: [
      ...sessions.map((n) => ({ name: { en: `Session ${n}`, hi: `सेशन ${n}` }, dueAfterDays: (n - 1) * EVERY_DAYS })),
      { name: { en: 'Feedback', hi: 'राय' }, dueAfterDays: (SESSIONS - 1) * EVERY_DAYS + 1 },
    ],
    tasks: [
      ...sessions.flatMap((n) => [
        ...(n > 1 ? [{
          title: { en: `Send the reminder for session ${n} (/reminder)`, hi: `सेशन ${n} की याद भेजें (/reminder)` },
          milestone: n - 1,
          dueAfterDays: (n - 1) * EVERY_DAYS - 1,
          priority: 'Medium',
        }] : []),
        { title: { en: `Session ${n}: treatment`, hi: `सेशन ${n}: ट्रीटमेंट` }, milestone: n - 1, dueAfterDays: (n - 1) * EVERY_DAYS, priority: 'High' },
      ]),
      { title: { en: 'Ask for a Google review (/review)', hi: 'Google रिव्यू माँगें (/review)' }, milestone: SESSIONS, dueAfterDays: (SESSIONS - 1) * EVERY_DAYS + 1, priority: 'Medium' },
    ],
  },
];

module.exports = { kit, products, fields, records, projectTemplates, hiddenModules: [] };
