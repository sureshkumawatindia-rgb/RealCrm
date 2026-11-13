// How the CRM is set up for a digital marketing agency — SEO, social media, Google and Meta ads,
// websites, branding (docs/CRM_TYPES_PLAN.md), in English and Hindi. The services are the Products
// list (named Services for this type), with the usual ones at price 0 for the agency to fill in.
// The clients' ongoing retainers are the company's own records, and a new client's first month
// comes in one click from the project template below (the Projects feature, D92).

// Advertising, marketing and web design services: 18% GST (heading 9983). Both can be changed.
const SAC = '9983';
const GST_RATE_PCT = 18;
const MONTH = { en: 'month', hi: 'महीना' };
const PROJECT = { en: 'project', hi: 'प्रोजेक्ट' };
const service = (en, hi, unit) => ({ name: { en, hi }, unit, hsnSac: SAC, gstRatePct: GST_RATE_PCT });
const products = [
  service('SEO', 'SEO', MONTH),
  service('Social media management', 'सोशल मीडिया मैनेजमेंट', MONTH),
  service('Google Ads management', 'Google Ads मैनेजमेंट', MONTH),
  service('Meta ads management (Facebook and Instagram)', 'Meta ऐड्स मैनेजमेंट (Facebook और Instagram)', MONTH),
  service('Website design', 'वेबसाइट डिज़ाइन', PROJECT),
  service('Logo and branding', 'लोगो और ब्रांडिंग', PROJECT),
  service('Content writing', 'कंटेंट राइटिंग', { en: 'article', hi: 'आर्टिकल' }),
  service('Video editing', 'वीडियो एडिटिंग', { en: 'video', hi: 'वीडियो' }),
];

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Digital marketing agency', hi: 'डिजिटल मार्केटिंग एजेंसी' },
  about: {
    en: 'Enquiries, discovery calls, proposals, retainers and monthly reports.',
    hi: 'पूछताछ, शुरुआती कॉल, प्रपोज़ल, रिटेनर और महीने की रिपोर्ट।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Discovery call done', hi: 'शुरुआती कॉल हो गई' }, probability: 25, quietDays: 3 },
    { kind: 'Quote Sent', name: { en: 'Proposal sent', hi: 'प्रपोज़ल भेजा' }, probability: 45, quietDays: 5 },
    { kind: 'Negotiation', name: { en: 'Negotiation', hi: 'मोलभाव' }, probability: 65, quietDays: 5 },
    { kind: 'Negotiation', name: { en: 'Agreement and advance', hi: 'एग्रीमेंट और एडवांस' }, probability: 85, quietDays: 3 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the business', hi: 'कारोबार के बारे में पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Please tell us about your business, your website and social pages, your goal (more leads, more sales or your brand) and your monthly budget. Shall we set up a short call?',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। कृपया अपने कारोबार, वेबसाइट और सोशल पेज, अपने लक्ष्य (ज़्यादा लीड, ज़्यादा बिक्री या ब्रांड) और महीने के बजट के बारे में बताइए। क्या एक छोटी कॉल रख लें?',
      },
    },
    {
      shortcut: 'call',
      title: { en: 'Call fixed', hi: 'कॉल तय' },
      body: {
        en: 'Our call is fixed for ___ at ___. Link: ___. We will look at your current marketing and share ideas.',
        hi: 'हमारी कॉल ___ को ___ बजे तय है। लिंक: ___। हम आपकी अभी की मार्केटिंग देखकर आइडिया बताएँगे।',
      },
    },
    {
      shortcut: 'proposal',
      title: { en: 'Proposal', hi: 'प्रपोज़ल' },
      body: {
        en: 'Here is our proposal for ___: ___. Monthly fee ₹___ (ad spend is separate). What we aim for: ___.',
        hi: '___ के लिए हमारा प्रपोज़ल: ___। महीने की फ़ीस ₹___ (ऐड का खर्च अलग)। हमारा लक्ष्य: ___।',
      },
    },
    {
      shortcut: 'onboarding',
      title: { en: 'Onboarding', hi: 'शुरुआत' },
      body: {
        en: 'Welcome aboard! To start, please share your logo and brand files, access to your website, your Google and Meta ad accounts (as a partner), and your product photos.',
        hi: 'हमारे साथ जुड़ने के लिए धन्यवाद! शुरू करने के लिए अपना लोगो और ब्रांड फ़ाइलें, वेबसाइट का एक्सेस, Google और Meta ऐड अकाउंट (पार्टनर के रूप में) और प्रोडक्ट की फ़ोटो भेजिए।',
      },
    },
    {
      shortcut: 'report',
      title: { en: 'Monthly report', hi: 'महीने की रिपोर्ट' },
      body: {
        en: 'Your monthly report for ___ is ready: ___ leads, ___ reach, cost per lead ₹___. The full report: ___',
        hi: '___ की आपकी महीने की रिपोर्ट तैयार है: ___ लीड, ___ रीच, प्रति लीड खर्च ₹___। पूरी रिपोर्ट: ___',
      },
    },
    {
      shortcut: 'invoice',
      title: { en: 'Invoice', hi: 'इनवॉइस' },
      body: {
        en: 'Your invoice for ___ is attached: ₹___ + GST. Please pay by ___ so the campaigns keep running.',
        hi: '___ का आपका इनवॉइस साथ में है: ₹___ + GST। कैंपेन चलते रहें, इसलिए कृपया ___ तक भुगतान कर दीजिए।',
      },
    },
    {
      shortcut: 'renewal',
      title: { en: 'Renewal', hi: 'रिन्यूअल' },
      body: {
        en: "Our contract renews on ___. Shall we continue, and plan next quarter's goals together?",
        hi: 'हमारा कॉन्ट्रैक्ट ___ को रिन्यू होता है। क्या हम साथ जारी रखें और अगली तिमाही के लक्ष्य तय करें?',
      },
    },
    {
      shortcut: 'review',
      title: { en: 'Ask for a review', hi: 'रिव्यू माँगें' },
      body: {
        en: 'Thank you for working with {{org.name}}! A Google review would mean a lot to us: ___',
        hi: '{{org.name}} के साथ काम करने के लिए धन्यवाद! आपका Google रिव्यू हमारे लिए बहुत मायने रखेगा: ___',
      },
    },
  ],
  terms: {
    en: [
      '1. Fees are monthly for the scope in this proposal; GST is extra at the applicable rate.',
      '2. Ad spend is paid by the client directly to Google, Meta or the other platforms, and is not part of our fee.',
      '3. Work starts once the advance and the onboarding details are received.',
      '4. Results depend on the market, the budget and the platforms; we do not promise a fixed number of leads or sales.',
      '5. Work outside this scope is quoted separately.',
      '6. Either side may end the retainer with 30 days\' notice in writing.',
      '7. The client owns their accounts, content and data; we hand over all access when the work ends.',
      '8. This proposal is valid until the date shown.',
      "9. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. फ़ीस इस प्रपोज़ल में लिखे काम के लिए हर महीने की है; GST लागू दर से अलग।',
      '2. ऐड का खर्च क्लाइंट सीधे Google, Meta या दूसरे प्लेटफ़ॉर्म को देगा; यह हमारी फ़ीस में शामिल नहीं।',
      '3. एडवांस और शुरुआत की जानकारी मिलने पर काम शुरू होगा।',
      '4. नतीजे बाज़ार, बजट और प्लेटफ़ॉर्म पर निर्भर हैं; हम तय संख्या में लीड या बिक्री का वादा नहीं करते।',
      '5. इस दायरे से बाहर का काम अलग से कोटेशन पर होगा।',
      '6. कोई भी पक्ष 30 दिन का लिखित नोटिस देकर रिटेनर खत्म कर सकता है।',
      '7. अकाउंट, कंटेंट और डेटा क्लाइंट के हैं; काम खत्म होने पर हम सारा एक्सेस वापस सौंप देंगे।',
      '8. यह प्रपोज़ल दी गई तारीख तक मान्य है।',
      '9. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 15,
};

// The company's own kinds of record, shown under "Your records". The record's own customer link is
// the client.
const records = [
  {
    singular: { en: 'Retainer', hi: 'रिटेनर' },
    plural: { en: 'Retainers', hi: 'रिटेनर' },
    icon: 'file-contract',
    fields: [
      { label: { en: 'Services', hi: 'सर्विस' }, type: 'text' },
      { label: { en: 'Monthly fee (₹)', hi: 'महीने की फ़ीस (₹)' }, type: 'number', listColumn: true },
      { label: { en: 'Start date', hi: 'शुरू होने की तारीख' }, type: 'date' },
      { label: { en: 'Renewal date', hi: 'रिन्यूअल की तारीख' }, type: 'date', listColumn: true },
      { label: { en: 'Account manager', hi: 'अकाउंट मैनेजर' }, type: 'text' },
      {
        label: { en: 'Status', hi: 'स्थिति' },
        type: 'dropdown',
        listColumn: true,
        options: [{ en: 'Active', hi: 'चालू' }, { en: 'Paused', hi: 'रुका हुआ' }, { en: 'Ended', hi: 'ख़त्म' }],
      },
    ],
  },
];

const fields = [
  { object: 'contact', label: { en: 'Industry', hi: 'उद्योग' }, type: 'text', listColumn: true },
  { object: 'contact', label: { en: 'Website', hi: 'वेबसाइट' }, type: 'text' },
  { object: 'lead', label: { en: 'Monthly budget (₹)', hi: 'महीने का बजट (₹)' }, type: 'number', listColumn: true },
  {
    object: 'lead',
    label: { en: 'Goal', hi: 'लक्ष्य' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'More leads', hi: 'ज़्यादा लीड' },
      { en: 'More sales', hi: 'ज़्यादा बिक्री' },
      { en: 'Brand awareness', hi: 'ब्रांड की पहचान' },
      { en: 'Website traffic', hi: 'वेबसाइट ट्रैफ़िक' },
      { en: 'App installs', hi: 'ऐप इंस्टॉल' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  { object: 'lead', label: { en: 'Website or social link', hi: 'वेबसाइट या सोशल लिंक' }, type: 'text' },
  { object: 'lead', label: { en: 'Call date', hi: 'कॉल की तारीख' }, type: 'date' },
  { object: 'lead', label: { en: 'Competitors', hi: 'प्रतियोगी' }, type: 'text' },
];

// A new client's first month: Projects → "Start the project" on the won deal with this template.
const projectTemplates = [
  {
    name: { en: 'Client onboarding: first month', hi: 'नया क्लाइंट: पहला महीना' },
    days: 30,
    milestones: [
      { name: { en: 'Kick-off', hi: 'शुरुआत' }, dueAfterDays: 0 },
      { name: { en: 'Audit and strategy', hi: 'ऑडिट और रणनीति' }, dueAfterDays: 7 },
      { name: { en: 'Campaigns live', hi: 'कैंपेन चालू' }, dueAfterDays: 10 },
      { name: { en: 'First monthly report', hi: 'पहली महीने की रिपोर्ट' }, dueAfterDays: 30 },
    ],
    tasks: [
      { title: { en: 'Kick-off call; collect the brand files and accesses (/onboarding)', hi: 'शुरुआती कॉल; ब्रांड फ़ाइलें और एक्सेस लें (/onboarding)' }, milestone: 0, dueAfterDays: 0, priority: 'High' },
      { title: { en: 'Audit the website, SEO, social pages and ad accounts', hi: 'वेबसाइट, SEO, सोशल पेज और ऐड अकाउंट का ऑडिट करें' }, milestone: 1, dueAfterDays: 3, priority: 'High' },
      { title: { en: 'Get the strategy and the content calendar approved', hi: 'रणनीति और कंटेंट कैलेंडर मंज़ूर करवाएँ' }, milestone: 1, dueAfterDays: 7, priority: 'High' },
      { title: { en: 'Launch the campaigns and set up the tracking', hi: 'कैंपेन शुरू करें और ट्रैकिंग लगाएँ' }, milestone: 2, dueAfterDays: 10, priority: 'High' },
      { title: { en: 'Mid-month check of the results', hi: 'महीने के बीच नतीजों की जाँच' }, milestone: 3, dueAfterDays: 20, priority: 'Medium' },
      { title: { en: 'Send the first monthly report (/report)', hi: 'पहली महीने की रिपोर्ट भेजें (/report)' }, milestone: 3, dueAfterDays: 30, priority: 'High' },
      { title: { en: 'Send the invoice for the next month (/invoice)', hi: 'अगले महीने का इनवॉइस भेजें (/invoice)' }, milestone: 3, dueAfterDays: 30, priority: 'High' },
    ],
  },
];

module.exports = { kit, products, fields, records, projectTemplates, hiddenModules: [] };
