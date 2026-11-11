// How the CRM is set up for education and coaching — coaching institutes, tuition and training
// classes (docs/CRM_TYPES_PLAN.md), in English and Hindi. The courses are the Products list
// (named Courses for this type), so an enquiry's "interested course" and a fee quotation work as
// they are; what an institute teaches is its own, so none is added. The batches are the company's
// own records, and an enquiry links the batch the student joins. A won admission becomes its fee
// schedule in one click from the project template below (the Projects feature, D92).

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Education and coaching', hi: 'शिक्षा और कोचिंग' },
  about: {
    en: 'Admission enquiries, counselling, demo classes, batches and fees.',
    hi: 'एडमिशन की पूछताछ, काउंसलिंग, डेमो क्लास, बैच और फ़ीस।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Counselling done', hi: 'काउंसलिंग हो गई' }, probability: 25, quietDays: 2 },
    { kind: 'Contacted', name: { en: 'Demo class', hi: 'डेमो क्लास' }, probability: 40, quietDays: 3 },
    { kind: 'Quote Sent', name: { en: 'Fees shared', hi: 'फ़ीस बताई' }, probability: 55, quietDays: 3 },
    { kind: 'Negotiation', name: { en: 'Ready to join', hi: 'जॉइन करने को तैयार' }, probability: 75, quietDays: 3 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the student', hi: 'छात्र के बारे में पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for your enquiry with {{org.name}}. Which course are you looking for, and for whom (yourself, or your child in which class)? We will share the details.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से पूछताछ के लिए धन्यवाद। आप कौन-सा कोर्स ढूँढ रहे हैं, और किसके लिए (अपने लिए, या आपका बच्चा किस क्लास में है)? हम पूरी जानकारी भेज देंगे।',
      },
    },
    {
      shortcut: 'course',
      title: { en: 'Course details', hi: 'कोर्स की जानकारी' },
      body: {
        en: 'Course details: ___. Duration ___, ___ classes a week, timings ___. Fees ₹___. The next batch starts on ___.',
        hi: 'कोर्स की जानकारी: ___। अवधि ___, हफ़्ते में ___ क्लास, समय ___। फ़ीस ₹___। अगला बैच ___ से शुरू है।',
      },
    },
    {
      shortcut: 'demo',
      title: { en: 'Demo class', hi: 'डेमो क्लास' },
      body: {
        en: 'You are welcome to a free demo class on ___ at ___. Address: ___.',
        hi: 'आप ___ को ___ बजे मुफ़्त डेमो क्लास में आइए। पता: ___।',
      },
    },
    {
      shortcut: 'fees',
      title: { en: 'Fees and instalments', hi: 'फ़ीस और किस्तें' },
      body: {
        en: 'The fees for ___ are ₹___, in ___ instalments of ₹___. You can pay by UPI or bank transfer; the details are on the fee quotation.',
        hi: '___ की फ़ीस ₹___ है, ₹___ की ___ किस्तों में। आप UPI या बैंक ट्रांसफ़र से भर सकते हैं; जानकारी फ़ीस के कोटेशन पर है।',
      },
    },
    {
      shortcut: 'reminder',
      title: { en: 'Fee reminder', hi: 'फ़ीस की याद' },
      body: {
        en: 'Namaste {{contact.name}} ji, a reminder: the fee instalment of ₹___ is due on ___. Please pay on time so the classes go on smoothly.',
        hi: 'नमस्ते {{contact.name}} जी, याद दिला दें: ₹___ की फ़ीस की किस्त ___ तक देनी है। कृपया समय पर भर दें ताकि क्लास बिना रुकावट चलती रहें।',
      },
    },
    {
      shortcut: 'batch',
      title: { en: 'Batch details', hi: 'बैच की जानकारी' },
      body: {
        en: 'Your batch starts on ___ at ___. Please bring ___. See you in class!',
        hi: 'आपका बैच ___ को ___ बजे से शुरू है। कृपया ___ साथ लाएँ। क्लास में मिलते हैं!',
      },
    },
    {
      shortcut: 'documents',
      title: { en: 'Admission documents', hi: 'एडमिशन के कागज़' },
      body: {
        en: 'For the admission, please bring 2 passport-size photos, an ID proof (Aadhaar) and the last mark sheet.',
        hi: 'एडमिशन के लिए 2 पासपोर्ट साइज़ फ़ोटो, एक पहचान पत्र (आधार) और पिछली मार्कशीट साथ लाएँ।',
      },
    },
    {
      shortcut: 'thanks',
      title: { en: 'Welcome', hi: 'स्वागत' },
      body: {
        en: 'Welcome to {{org.name}}, {{contact.name}} ji! Thank you for joining us.',
        hi: '{{org.name}} में आपका स्वागत है, {{contact.name}} जी! हमसे जुड़ने के लिए धन्यवाद।',
      },
    },
  ],
  terms: {
    en: [
      '1. The fees are for the course and the duration in this quotation. GST is extra where it applies.',
      '2. The admission is confirmed when the first instalment or the full fee is paid.',
      '3. Instalments are due on the dates shown; a late fee may apply after the due date.',
      '4. A student who leaves the course midway gets back the fee for the remaining period, on a pro-rata basis.',
      '5. Batch timings may change with notice; a missed class is not repeated unless agreed.',
      "6. Students follow the institute's rules.",
      '7. This quotation is valid until the date shown.',
      "8. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. फ़ीस इस कोटेशन में लिखे कोर्स और अवधि के लिए है। GST लागू होने पर अलग से।',
      '2. पहली किस्त या पूरी फ़ीस मिलने पर एडमिशन पक्का होगा।',
      '3. किस्तें दी गई तारीखों तक देनी हैं; देर होने पर लेट फ़ीस लग सकती है।',
      '4. बीच में कोर्स छोड़ने वाले छात्र को बाकी समय की फ़ीस हिसाब से (pro-rata) वापस मिलेगी।',
      '5. बैच का समय बताकर बदला जा सकता है; छूटी क्लास दोबारा नहीं होगी, जब तक तय न हो।',
      '6. छात्र संस्थान के नियमों का पालन करेंगे।',
      '7. यह कोटेशन दी गई तारीख तक मान्य है।',
      '8. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 7,
};

// The company's own kinds of record, shown under "Your records".
const records = [
  {
    singular: { en: 'Batch', hi: 'बैच' },
    plural: { en: 'Batches', hi: 'बैच' },
    icon: 'user-gear',
    fields: [
      { label: { en: 'Course', hi: 'कोर्स' }, type: 'text' },
      { label: { en: 'Start date', hi: 'शुरू होने की तारीख' }, type: 'date', listColumn: true },
      { label: { en: 'Timings', hi: 'समय' }, type: 'text', listColumn: true },
      { label: { en: 'Teacher', hi: 'टीचर' }, type: 'text' },
      { label: { en: 'Total seats', hi: 'कुल सीटें' }, type: 'number' },
      { label: { en: 'Seats filled', hi: 'भरी सीटें' }, type: 'number' },
      {
        label: { en: 'Status', hi: 'स्थिति' },
        type: 'dropdown',
        listColumn: true,
        options: [
          { en: 'Open for admission', hi: 'एडमिशन खुले' },
          { en: 'Full', hi: 'भर गया' },
          { en: 'Running', hi: 'चल रहा है' },
          { en: 'Finished', hi: 'पूरा हुआ' },
        ],
      },
    ],
  },
];

// Extra fields on an enquiry. Its course is the built-in "interested course" (Products).
const fields = [
  { object: 'lead', label: { en: 'Student name', hi: 'छात्र का नाम' }, type: 'text' },
  { object: 'lead', label: { en: 'Class or qualification', hi: 'क्लास या पढ़ाई' }, type: 'text', listColumn: true },
  { object: 'lead', label: { en: 'School or college', hi: 'स्कूल या कॉलेज' }, type: 'text' },
  {
    object: 'lead',
    label: { en: 'Preferred batch time', hi: 'पसंदीदा बैच का समय' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Morning', hi: 'सुबह' },
      { en: 'Afternoon', hi: 'दोपहर' },
      { en: 'Evening', hi: 'शाम' },
      { en: 'Weekend', hi: 'वीकेंड' },
      { en: 'Online', hi: 'ऑनलाइन' },
    ],
  },
  {
    object: 'lead',
    label: { en: 'Enquiry by', hi: 'पूछताछ किसने की' },
    type: 'dropdown',
    options: [{ en: 'Student', hi: 'छात्र' }, { en: 'Parent', hi: 'अभिभावक' }],
  },
  { object: 'lead', label: { en: 'Demo class date', hi: 'डेमो क्लास की तारीख' }, type: 'date' },
  // A link to one of the records above (records[0], Batches): the batch the student joins.
  { object: 'lead', label: { en: 'Batch', hi: 'बैच' }, type: 'lookup', lookupRecord: 0 },
];

// A won admission's fees, step by step: Projects → "Start the project" on the won admission. A
// reminder goes three days before each instalment (the /reminder quick reply).
const projectTemplates = [
  {
    name: { en: 'Admission: fees in 3 instalments', hi: 'एडमिशन: फ़ीस 3 किस्तों में' },
    days: 90,
    milestones: [
      { name: { en: 'Admission', hi: 'एडमिशन' }, dueAfterDays: 0 },
      { name: { en: 'Second instalment', hi: 'दूसरी किस्त' }, dueAfterDays: 30 },
      { name: { en: 'Third instalment', hi: 'तीसरी किस्त' }, dueAfterDays: 60 },
      { name: { en: 'Course feedback', hi: 'कोर्स पर राय' }, dueAfterDays: 90 },
    ],
    tasks: [
      { title: { en: 'Collect the first instalment and the documents', hi: 'पहली किस्त और कागज़ लें' }, milestone: 0, dueAfterDays: 0, priority: 'High' },
      { title: { en: 'Send the timetable and the batch details (/batch)', hi: 'टाइमटेबल और बैच की जानकारी भेजें (/batch)' }, milestone: 0, dueAfterDays: 1, priority: 'Medium' },
      { title: { en: 'Send the reminder for the second instalment (/reminder)', hi: 'दूसरी किस्त की याद भेजें (/reminder)' }, milestone: 1, dueAfterDays: 27, priority: 'Medium' },
      { title: { en: 'Collect the second instalment', hi: 'दूसरी किस्त लें' }, milestone: 1, dueAfterDays: 30, priority: 'High' },
      { title: { en: 'Send the reminder for the third instalment (/reminder)', hi: 'तीसरी किस्त की याद भेजें (/reminder)' }, milestone: 2, dueAfterDays: 57, priority: 'Medium' },
      { title: { en: 'Collect the third instalment', hi: 'तीसरी किस्त लें' }, milestone: 2, dueAfterDays: 60, priority: 'High' },
      { title: { en: 'Ask the student or parent for feedback', hi: 'छात्र या अभिभावक से राय लें' }, milestone: 3, dueAfterDays: 90, priority: 'Medium' },
    ],
  },
];

module.exports = { kit, products: [], fields, records, projectTemplates, hiddenModules: [] };
