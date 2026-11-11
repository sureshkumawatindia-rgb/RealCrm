// How the CRM is set up for interior designers and construction contractors — home interiors,
// modular kitchens, renovation and civil work (docs/CRM_TYPES_PLAN.md), in English and Hindi. A
// rate list (BOQ) is each firm's own, so no products are added. The vendors and work teams are the
// company's own records. A won job becomes its 45-day project — design sign-off, material,
// carpentry, painting, handover and the payment at each stage — in one click from the template
// below (the Projects feature, D92).

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Interior and construction', hi: 'इंटीरियर और कंस्ट्रक्शन' },
  about: {
    en: 'Enquiries, site visits, designs, quotations and execution.',
    hi: 'पूछताछ, साइट विज़िट, डिज़ाइन, कोटेशन और काम।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Site visit and measurement', hi: 'साइट विज़िट और नाप' }, probability: 25, quietDays: 3 },
    { kind: 'Contacted', name: { en: 'Design shared', hi: 'डिज़ाइन भेजा' }, probability: 40, quietDays: 5 },
    { kind: 'Quote Sent', name: { en: 'Quotation sent', hi: 'कोटेशन भेजा' }, probability: 55, quietDays: 5 },
    { kind: 'Negotiation', name: { en: 'Negotiation', hi: 'मोलभाव' }, probability: 75, quietDays: 5 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the place', hi: 'जगह के बारे में पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Please tell us about your place (flat, house or office, how many rooms, area in sq ft), the work you want done, your budget and when you want to start.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। कृपया अपनी जगह के बारे में बताइए (फ़्लैट, मकान या ऑफ़िस, कितने कमरे, कितने वर्ग फ़ुट), कौन-सा काम करवाना है, आपका बजट और कब से शुरू करना है।',
      },
    },
    {
      shortcut: 'visit',
      title: { en: 'Site visit', hi: 'साइट विज़िट' },
      body: {
        en: 'Our designer will visit your site on ___ at ___ to take the measurements. Please share the location.',
        hi: 'हमारे डिज़ाइनर ___ को ___ बजे नाप लेने आपकी साइट पर आएँगे। कृपया लोकेशन भेज दीजिए।',
      },
    },
    {
      shortcut: 'design',
      title: { en: 'Design shared', hi: 'डिज़ाइन भेजा' },
      body: {
        en: 'Here is the design for your ___ (3D views attached). Tell us what you would like changed and we will update it.',
        hi: 'यह आपके ___ का डिज़ाइन है (3D व्यू साथ में हैं)। जो बदलना हो, बताइए — हम डिज़ाइन बदल देंगे।',
      },
    },
    {
      shortcut: 'quote',
      title: { en: 'Quotation', hi: 'कोटेशन' },
      body: {
        en: 'The quotation for your project is attached: ₹___, with ___ material. It covers ___. Shall we go through it together?',
        hi: 'आपके प्रोजेक्ट का कोटेशन साथ में है: ₹___, ___ मटेरियल के साथ। इसमें ___ शामिल है। क्या हम इसे साथ बैठकर देख लें?',
      },
    },
    {
      shortcut: 'payment',
      title: { en: 'Payment schedule', hi: 'भुगतान का शेड्यूल' },
      body: {
        en: 'Payment schedule: ___% at booking, ___% when the material arrives, ___% when the carpentry is done and ___% at handover.',
        hi: 'भुगतान का शेड्यूल: बुकिंग पर ___%, मटेरियल आने पर ___%, कारपेंट्री पूरी होने पर ___% और हैंडओवर पर ___%।',
      },
    },
    {
      shortcut: 'update',
      title: { en: 'Work update', hi: 'काम का अपडेट' },
      body: {
        en: 'Work update for your site: ___ is done and ___ is next. Photos attached.',
        hi: 'आपकी साइट का अपडेट: ___ हो गया है, अगला काम ___ है। फ़ोटो साथ में हैं।',
      },
    },
    {
      shortcut: 'handover',
      title: { en: 'Handover', hi: 'हैंडओवर' },
      body: {
        en: 'Your ___ is ready! The handover is on ___. Please check everything with our team and share your feedback.',
        hi: 'आपका ___ तैयार है! हैंडओवर ___ को है। कृपया हमारी टीम के साथ सब कुछ देख लीजिए और अपनी राय बताइए।',
      },
    },
    {
      shortcut: 'review',
      title: { en: 'Ask for a review', hi: 'रिव्यू माँगें' },
      body: {
        en: 'Thank you for choosing {{org.name}}! Please share a Google review and a few photos of your new space: ___',
        hi: '{{org.name}} को चुनने के लिए धन्यवाद! कृपया Google पर रिव्यू और अपनी नई जगह की कुछ फ़ोटो शेयर कीजिए: ___',
      },
    },
  ],
  terms: {
    en: [
      '1. Rates are per the unit shown; the final bill follows the quantity actually measured.',
      '2. GST is extra at the applicable rate.',
      '3. Payments follow the agreed schedule; the work moves to the next stage after each payment.',
      '4. Changes to the approved design after the work starts may change the cost and the time.',
      '5. Materials, brands and finishes are as in this quotation; another brand changes the rate.',
      '6. The site must be ready and open for work; delays at the site may move the handover date.',
      '7. Warranty: as per the makers on hardware and materials, and as agreed in writing on our workmanship.',
      '8. This quotation is valid until the date shown.',
      "9. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. रेट बताई गई यूनिट के हिसाब से हैं; अंतिम बिल असल में नापी गई मात्रा पर बनेगा।',
      '2. GST लागू दर से अलग।',
      '3. भुगतान तय शेड्यूल के अनुसार होगा; हर भुगतान के बाद काम अगले चरण में जाएगा।',
      '4. काम शुरू होने के बाद मंज़ूर डिज़ाइन में बदलाव से खर्च और समय बदल सकता है।',
      '5. मटेरियल, ब्रांड और फ़िनिश इस कोटेशन के अनुसार; दूसरा ब्रांड लेने पर रेट बदलेगा।',
      '6. साइट काम के लिए तैयार और खुली होनी चाहिए; साइट पर देरी से हैंडओवर की तारीख आगे खिसक सकती है।',
      '7. वारंटी: हार्डवेयर और मटेरियल पर बनाने वाली कंपनी के अनुसार, और हमारे काम पर जैसा लिखित में तय हो।',
      '8. यह कोटेशन दी गई तारीख तक मान्य है।',
      '9. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 15,
};

// The company's own kinds of record, shown under "Your records".
const records = [
  {
    singular: { en: 'Vendor', hi: 'वेंडर' },
    plural: { en: 'Vendors', hi: 'वेंडर' },
    icon: 'wrench',
    fields: [
      {
        label: { en: 'Trade', hi: 'काम' },
        type: 'dropdown',
        listColumn: true,
        options: [
          { en: 'Carpenter', hi: 'कारपेंटर' },
          { en: 'Electrician', hi: 'इलेक्ट्रीशियन' },
          { en: 'Plumber', hi: 'प्लंबर' },
          { en: 'Painter', hi: 'पेंटर' },
          { en: 'Mason', hi: 'मिस्त्री' },
          { en: 'Fabricator', hi: 'फ़ैब्रिकेटर' },
          { en: 'Material supplier', hi: 'मटेरियल सप्लायर' },
          { en: 'Other', hi: 'अन्य' },
        ],
      },
      { label: { en: 'Phone', hi: 'फ़ोन' }, type: 'text', listColumn: true },
      { label: { en: 'Rates and notes', hi: 'रेट और नोट' }, type: 'textarea' },
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
      { en: 'Home owner', hi: 'घर के मालिक' },
      { en: 'Business', hi: 'कारोबार' },
      { en: 'Builder', hi: 'बिल्डर' },
      { en: 'Architect or designer', hi: 'आर्किटेक्ट या डिज़ाइनर' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  {
    object: 'lead',
    label: { en: 'Work needed', hi: 'कौन-सा काम' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Full home interior', hi: 'पूरे घर का इंटीरियर' },
      { en: 'Modular kitchen', hi: 'मॉड्यूलर किचन' },
      { en: 'Wardrobes', hi: 'वॉर्डरोब' },
      { en: 'Renovation', hi: 'रेनोवेशन' },
      { en: 'Civil construction', hi: 'सिविल कंस्ट्रक्शन' },
      { en: 'Painting', hi: 'पेंटिंग' },
      { en: 'Office or shop interior', hi: 'ऑफ़िस या दुकान का इंटीरियर' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  {
    object: 'lead',
    label: { en: 'Property type', hi: 'प्रॉपर्टी का प्रकार' },
    type: 'dropdown',
    options: [
      { en: 'Flat', hi: 'फ़्लैट' },
      { en: 'Independent house or villa', hi: 'मकान या विला' },
      { en: 'Office', hi: 'ऑफ़िस' },
      { en: 'Shop or showroom', hi: 'दुकान या शोरूम' },
      { en: 'Restaurant or hotel', hi: 'रेस्टोरेंट या होटल' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  { object: 'lead', label: { en: 'Rooms or BHK', hi: 'कमरे या BHK' }, type: 'text' },
  { object: 'lead', label: { en: 'Area (sq ft)', hi: 'एरिया (वर्ग फ़ुट)' }, type: 'number' },
  { object: 'lead', label: { en: 'Budget (₹)', hi: 'बजट (₹)' }, type: 'number', listColumn: true },
  { object: 'lead', label: { en: 'Site address', hi: 'साइट का पता' }, type: 'text' },
  { object: 'lead', label: { en: 'Site visit date', hi: 'साइट विज़िट की तारीख' }, type: 'date', listColumn: true },
  { object: 'lead', label: { en: 'Start by', hi: 'काम कब से शुरू' }, type: 'date' },
  { object: 'lead', label: { en: 'Referred by', hi: 'किसने भेजा' }, type: 'text' },
];

// A won job's execution: Projects → "Start the project" on the won deal with this template.
const projectTemplates = [
  {
    name: { en: 'Interior project: 45 days', hi: 'इंटीरियर प्रोजेक्ट: 45 दिन' },
    days: 45,
    milestones: [
      { name: { en: 'Design sign-off', hi: 'डिज़ाइन मंज़ूर' }, dueAfterDays: 7 },
      { name: { en: 'Material ordered', hi: 'मटेरियल ऑर्डर' }, dueAfterDays: 14 },
      { name: { en: 'Carpentry and civil work', hi: 'कारपेंट्री और सिविल काम' }, dueAfterDays: 35 },
      { name: { en: 'Painting and finishing', hi: 'पेंटिंग और फ़िनिशिंग' }, dueAfterDays: 42 },
      { name: { en: 'Handover', hi: 'हैंडओवर' }, dueAfterDays: 45 },
    ],
    tasks: [
      { title: { en: 'Final design and the client\'s sign-off', hi: 'फ़ाइनल डिज़ाइन और क्लाइंट की मंज़ूरी' }, milestone: 0, dueAfterDays: 5, priority: 'High' },
      { title: { en: 'Collect the material payment (/payment)', hi: 'मटेरियल का भुगतान लें (/payment)' }, milestone: 1, dueAfterDays: 10, priority: 'High' },
      { title: { en: 'Order the materials', hi: 'मटेरियल ऑर्डर करें' }, milestone: 1, dueAfterDays: 12, priority: 'Medium' },
      { title: { en: 'Send a work update with photos (/update)', hi: 'फ़ोटो के साथ काम का अपडेट भेजें (/update)' }, milestone: 2, dueAfterDays: 21, priority: 'Medium' },
      { title: { en: 'Carpentry and civil work done; collect that payment', hi: 'कारपेंट्री और सिविल काम पूरा; उसका भुगतान लें' }, milestone: 2, dueAfterDays: 35, priority: 'High' },
      { title: { en: 'Send a work update with photos (/update)', hi: 'फ़ोटो के साथ काम का अपडेट भेजें (/update)' }, milestone: 3, dueAfterDays: 38, priority: 'Medium' },
      { title: { en: 'Painting and finishing done', hi: 'पेंटिंग और फ़िनिशिंग पूरी' }, milestone: 3, dueAfterDays: 42, priority: 'High' },
      { title: { en: 'Final cleaning and snag check', hi: 'आखिरी सफ़ाई और कमियों की जाँच' }, milestone: 4, dueAfterDays: 44, priority: 'High' },
      { title: { en: 'Handover and the last payment (/handover)', hi: 'हैंडओवर और आखिरी भुगतान (/handover)' }, milestone: 4, dueAfterDays: 45, priority: 'High' },
      { title: { en: 'Ask for a review with photos (/review)', hi: 'फ़ोटो के साथ रिव्यू माँगें (/review)' }, milestone: 4, dueAfterDays: 48, priority: 'Medium' },
    ],
  },
];

module.exports = { kit, products: [], fields, records, projectTemplates, hiddenModules: [] };
