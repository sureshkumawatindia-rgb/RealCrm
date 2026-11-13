// How the CRM is set up for event and wedding planners — weddings, engagements, birthdays,
// corporate events (docs/CRM_TYPES_PLAN.md), in English and Hindi. The packages are the Products
// list (named Packages for this type), with the usual ones at price 0 for the planner to fill in;
// catering is left out, as its GST depends on how and where it is served. The vendors are the
// company's own records, and a booked wedding's planning comes in one click from the project
// template below (the Projects feature, D92).

// Event management, decoration, photography and sound: 18% GST. The SAC is left for the planner.
const GST_RATE_PCT = 18;
const EVENT = { en: 'event', hi: 'कार्यक्रम' };
const pack = (en, hi, unit = EVENT) => ({ name: { en, hi }, unit, hsnSac: '', gstRatePct: GST_RATE_PCT });
const products = [
  pack('Full wedding planning', 'पूरी शादी की प्लानिंग'),
  pack('Event management', 'इवेंट मैनेजमेंट'),
  pack('Decoration', 'डेकोरेशन'),
  pack('Photography and video', 'फ़ोटोग्राफ़ी और वीडियो'),
  pack('Sound, lights and DJ', 'साउंड, लाइट और DJ'),
  pack('Mehendi and haldi set-up', 'मेहंदी और हल्दी का सेट-अप', { en: 'function', hi: 'फ़ंक्शन' }),
  pack('Birthday party package', 'बर्थडे पार्टी पैकेज'),
];

const kit = {
  crmTypeOnly: true, // comes with the CRM type; not one of the choices in "Ready settings"
  name: { en: 'Event and wedding planner', hi: 'इवेंट और वेडिंग प्लानर' },
  about: {
    en: 'Enquiries, meetings, proposals, bookings and event-day planning.',
    hi: 'पूछताछ, मीटिंग, प्रपोज़ल, बुकिंग और कार्यक्रम के दिन की तैयारी।',
  },
  stages: [
    { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
    { kind: 'Contacted', name: { en: 'Requirement understood', hi: 'ज़रूरत समझ ली' }, probability: 25, quietDays: 2 },
    { kind: 'Contacted', name: { en: 'Meeting or venue visit', hi: 'मीटिंग या वेन्यू विज़िट' }, probability: 40, quietDays: 3 },
    { kind: 'Quote Sent', name: { en: 'Proposal sent', hi: 'प्रपोज़ल भेजा' }, probability: 55, quietDays: 3 },
    { kind: 'Negotiation', name: { en: 'Negotiation', hi: 'मोलभाव' }, probability: 75, quietDays: 3 },
  ],
  quickReplies: [
    {
      shortcut: 'details',
      title: { en: 'Ask about the occasion', hi: 'मौके के बारे में पूछें' },
      body: {
        en: 'Namaste {{contact.name}} ji! Thank you for contacting {{org.name}}. Please tell us the occasion, the date and city, the number of guests, the venue (if fixed) and your budget, and we will plan the best for you.',
        hi: 'नमस्ते {{contact.name}} जी! {{org.name}} से संपर्क करने के लिए धन्यवाद। कृपया मौका, तारीख और शहर, कितने मेहमान, वेन्यू (अगर तय है) और अपना बजट बताइए — हम आपके लिए सबसे अच्छी प्लानिंग करेंगे।',
      },
    },
    {
      shortcut: 'meeting',
      title: { en: 'Meeting', hi: 'मीटिंग' },
      body: {
        en: 'Our planner will meet you on ___ at ___, at ___. We will bring ideas and sample photos.',
        hi: 'हमारे प्लानर ___ को ___ बजे ___ पर आपसे मिलेंगे। हम आइडिया और सैंपल फ़ोटो साथ लाएँगे।',
      },
    },
    {
      shortcut: 'proposal',
      title: { en: 'Proposal', hi: 'प्रपोज़ल' },
      body: {
        en: 'Here is our proposal for your ___ on ___: ___. Total ₹___ for ___ guests. Shall we lock the date?',
        hi: '___ को आपके ___ के लिए हमारा प्रपोज़ल: ___। ___ मेहमानों के लिए कुल ₹___। क्या तारीख पक्की कर दें?',
      },
    },
    {
      shortcut: 'advance',
      title: { en: 'Advance to book the date', hi: 'तारीख पक्की करने का एडवांस' },
      body: {
        en: 'To book the date, please pay an advance of ₹___; the rest is due ___. Dates go fast in the wedding season!',
        hi: 'तारीख पक्की करने के लिए ₹___ का एडवांस भेजिए; बाकी रकम ___ तक। शादियों के सीज़न में तारीखें जल्दी भर जाती हैं!',
      },
    },
    {
      shortcut: 'checklist',
      title: { en: 'Event checklist', hi: 'कार्यक्रम की चेकलिस्ट' },
      body: {
        en: 'Your event checklist: ___. Please confirm the final guest count by ___.',
        hi: 'आपके कार्यक्रम की चेकलिस्ट: ___। कृपया ___ तक मेहमानों की पक्की संख्या बता दीजिए।',
      },
    },
    {
      shortcut: 'payment',
      title: { en: 'Payment reminder', hi: 'भुगतान की याद' },
      body: {
        en: 'A reminder: the balance of ₹___ is due by ___.',
        hi: 'याद दिला दें: बाकी ₹___ ___ तक देना है।',
      },
    },
    {
      shortcut: 'eventday',
      title: { en: 'Event day', hi: 'कार्यक्रम का दिन' },
      body: {
        en: 'All set for ___! Our team lead ___ (phone ___) will be at the venue from ___.',
        hi: '___ के लिए सब तैयार है! हमारी टीम के प्रमुख ___ (फ़ोन ___) ___ बजे से वेन्यू पर रहेंगे।',
      },
    },
    {
      shortcut: 'thanks',
      title: { en: 'Thanks and review', hi: 'धन्यवाद और रिव्यू' },
      body: {
        en: 'Thank you for letting us be part of your ___! Please share a few photos and a Google review: ___',
        hi: 'अपने ___ का हिस्सा बनाने के लिए धन्यवाद! कृपया कुछ फ़ोटो और Google रिव्यू शेयर कीजिए: ___',
      },
    },
  ],
  terms: {
    en: [
      '1. The quotation is for the date, venue, guest count and items listed; changes may change the cost.',
      '2. The date is booked when the advance is received; the balance is due before the event as agreed.',
      "3. Vendor and venue charges follow their own terms; a rise in them is charged at actual cost.",
      '4. On cancellation, amounts already paid to vendors cannot be refunded; the rest follows our cancellation policy.',
      '5. Extra guests, extra hours and overtime are charged at actuals.',
      "6. Permissions (venue, music, police) follow local rules; the venue's permission is the client's.",
      '7. GST is extra at the applicable rate.',
      '8. This quotation is valid until the date shown.',
      "9. Subject to the jurisdiction of our city's courts.",
    ].join('\n'),
    hi: [
      '1. कोटेशन लिखी गई तारीख, वेन्यू, मेहमानों की संख्या और सामान के लिए है; बदलाव से खर्च बदल सकता है।',
      '2. एडवांस मिलने पर तारीख बुक होगी; बाकी रकम तय अनुसार कार्यक्रम से पहले देनी होगी।',
      '3. वेंडर और वेन्यू के चार्ज उनकी शर्तों के अनुसार; उनमें बढ़ोतरी असल खर्च के हिसाब से लगेगी।',
      '4. कैंसिल करने पर वेंडरों को दी जा चुकी रकम वापस नहीं हो सकती; बाकी हमारी कैंसिलेशन नीति के अनुसार।',
      '5. ज़्यादा मेहमान, ज़्यादा घंटे और ओवरटाइम असल के हिसाब से लगेंगे।',
      '6. अनुमतियाँ (वेन्यू, म्यूज़िक, पुलिस) स्थानीय नियमों के अनुसार; वेन्यू की अनुमति क्लाइंट की ज़िम्मेदारी।',
      '7. GST लागू दर से अलग।',
      '8. यह कोटेशन दी गई तारीख तक मान्य है।',
      '9. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
    ].join('\n'),
  },
  validityDays: 7,
};

// The company's own kinds of record, shown under "Your records".
const records = [
  {
    singular: { en: 'Vendor', hi: 'वेंडर' },
    plural: { en: 'Vendors', hi: 'वेंडर' },
    icon: 'user-gear',
    fields: [
      {
        label: { en: 'Category', hi: 'श्रेणी' },
        type: 'dropdown',
        listColumn: true,
        options: [
          { en: 'Venue', hi: 'वेन्यू' },
          { en: 'Caterer', hi: 'कैटरर' },
          { en: 'Decorator', hi: 'डेकोरेटर' },
          { en: 'Photographer', hi: 'फ़ोटोग्राफ़र' },
          { en: 'DJ and sound', hi: 'DJ और साउंड' },
          { en: 'Makeup artist', hi: 'मेकअप आर्टिस्ट' },
          { en: 'Mehendi artist', hi: 'मेहंदी आर्टिस्ट' },
          { en: 'Band or dhol', hi: 'बैंड या ढोल' },
          { en: 'Transport', hi: 'ट्रांसपोर्ट' },
          { en: 'Other', hi: 'अन्य' },
        ],
      },
      { label: { en: 'City', hi: 'शहर' }, type: 'text', listColumn: true },
      { label: { en: 'Phone', hi: 'फ़ोन' }, type: 'text', listColumn: true },
      { label: { en: 'Rates and notes', hi: 'रेट और नोट' }, type: 'textarea' },
    ],
  },
];

// Extra fields on an enquiry.
const fields = [
  {
    object: 'lead',
    label: { en: 'Occasion', hi: 'मौका' },
    type: 'dropdown',
    listColumn: true,
    options: [
      { en: 'Wedding', hi: 'शादी' },
      { en: 'Engagement', hi: 'सगाई' },
      { en: 'Reception', hi: 'रिसेप्शन' },
      { en: 'Birthday', hi: 'जन्मदिन' },
      { en: 'Anniversary', hi: 'सालगिरह' },
      { en: 'Corporate event', hi: 'कॉर्पोरेट इवेंट' },
      { en: 'Religious function', hi: 'धार्मिक कार्यक्रम' },
      { en: 'Other', hi: 'अन्य' },
    ],
  },
  { object: 'lead', label: { en: 'Event date', hi: 'कार्यक्रम की तारीख' }, type: 'date', listColumn: true },
  { object: 'lead', label: { en: 'Guests', hi: 'मेहमान' }, type: 'number' },
  { object: 'lead', label: { en: 'Budget (₹)', hi: 'बजट (₹)' }, type: 'number', listColumn: true },
  { object: 'lead', label: { en: 'City', hi: 'शहर' }, type: 'text' },
  { object: 'lead', label: { en: 'Venue', hi: 'वेन्यू' }, type: 'text' },
  { object: 'lead', label: { en: 'Functions', hi: 'कौन-कौन से फ़ंक्शन' }, type: 'text' },
];

// A booked wedding's planning: Projects → "Start the project" on the won booking with this
// template; the planner moves the dates to fit the wedding day.
const projectTemplates = [
  {
    name: { en: 'Wedding: 60 days of planning', hi: 'शादी: 60 दिन की तैयारी' },
    days: 62,
    milestones: [
      { name: { en: 'Booking', hi: 'बुकिंग' }, dueAfterDays: 0 },
      { name: { en: 'Venue and vendors locked', hi: 'वेन्यू और वेंडर पक्के' }, dueAfterDays: 14 },
      { name: { en: 'Decor and menu final', hi: 'डेकोर और मेन्यू फ़ाइनल' }, dueAfterDays: 30 },
      { name: { en: 'Guests and logistics', hi: 'मेहमान और इंतज़ाम' }, dueAfterDays: 45 },
      { name: { en: 'Event day', hi: 'कार्यक्रम का दिन' }, dueAfterDays: 60 },
      { name: { en: 'Settlement', hi: 'हिसाब' }, dueAfterDays: 62 },
    ],
    tasks: [
      { title: { en: 'Collect the advance and sign the agreement', hi: 'एडवांस लें और एग्रीमेंट साइन करवाएँ' }, milestone: 0, dueAfterDays: 0, priority: 'High' },
      { title: { en: 'Lock the venue and the main vendors', hi: 'वेन्यू और मुख्य वेंडर पक्के करें' }, milestone: 1, dueAfterDays: 14, priority: 'High' },
      { title: { en: 'Final decor design and the menu tasting', hi: 'फ़ाइनल डेकोर डिज़ाइन और खाने की टेस्टिंग' }, milestone: 2, dueAfterDays: 30, priority: 'High' },
      { title: { en: 'Collect the second payment (/payment)', hi: 'दूसरा भुगतान लें (/payment)' }, milestone: 2, dueAfterDays: 35, priority: 'High' },
      { title: { en: 'Guest list, rooms and transport', hi: 'मेहमानों की लिस्ट, कमरे और ट्रांसपोर्ट' }, milestone: 3, dueAfterDays: 45, priority: 'Medium' },
      { title: { en: 'Share the event checklist (/checklist)', hi: 'कार्यक्रम की चेकलिस्ट भेजें (/checklist)' }, milestone: 3, dueAfterDays: 50, priority: 'Medium' },
      { title: { en: 'Rehearsal and the vendors\' briefing', hi: 'रिहर्सल और वेंडरों को पूरी जानकारी' }, milestone: 4, dueAfterDays: 58, priority: 'High' },
      { title: { en: 'Event day (/eventday)', hi: 'कार्यक्रम का दिन (/eventday)' }, milestone: 4, dueAfterDays: 60, priority: 'High' },
      { title: { en: 'Settle the vendors and collect the balance', hi: 'वेंडरों का हिसाब करें और बाकी रकम लें' }, milestone: 5, dueAfterDays: 62, priority: 'High' },
      { title: { en: 'Thank the client and ask for a review (/thanks)', hi: 'क्लाइंट को धन्यवाद दें और रिव्यू माँगें (/thanks)' }, milestone: 5, dueAfterDays: 63, priority: 'Medium' },
    ],
  },
];

module.exports = { kit, products, fields, records, projectTemplates, hiddenModules: [] };
