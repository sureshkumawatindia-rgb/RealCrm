// Ready settings for the first day (100 phases, phase 5, D117): what a trader or a manufacturer
// usually needs — the sales pipeline's stages, quick replies for the Inbox and the quotation
// terms — in English and Hindi. Applying a kit fills only what the company has not set itself
// (services/gettingStartedService.js). A "___" in a quick reply is for the person to fill in
// before sending; {{contact.name}} and {{org.name}} fill themselves.
const pestControl = require('./crmTypeSetups/pestControl');
const realEstate = require('./crmTypeSetups/realEstate');
const education = require('./crmTypeSetups/education');
const clinic = require('./crmTypeSetups/clinic');
const travel = require('./crmTypeSetups/travel');
const insurance = require('./crmTypeSetups/insurance');
const salon = require('./crmTypeSetups/salon');
const gym = require('./crmTypeSetups/gym');
const interior = require('./crmTypeSetups/interior');
const solar = require('./crmTypeSetups/solar');

const KIT_LANGUAGES = Object.freeze(['en', 'hi']);

const KITS = Object.freeze({
  trader: {
    name: { en: 'Trader or wholesaler', hi: 'ट्रेडर या होलसेलर' },
    about: {
      en: 'You buy and sell goods: rates change often and orders are quick.',
      hi: 'आप माल खरीदते-बेचते हैं: रेट अक्सर बदलते हैं और ऑर्डर जल्दी होते हैं।',
    },
    // In order; each stage stands for one fixed stage (its kind). Won and Lost end every pipeline.
    stages: [
      { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 1 },
      { kind: 'Contacted', name: { en: 'Rate shared', hi: 'रेट भेजा' }, probability: 30, quietDays: 2 },
      { kind: 'Quote Sent', name: { en: 'Quotation sent', hi: 'कोटेशन भेजा' }, probability: 50, quietDays: 3 },
      { kind: 'Negotiation', name: { en: 'Negotiation', hi: 'मोलभाव' }, probability: 75, quietDays: 3 },
    ],
    quickReplies: [
      {
        shortcut: 'rate',
        title: { en: 'Rate list', hi: 'रेट लिस्ट' },
        body: {
          en: "Namaste {{contact.name}} ji! Here is today's rate list. Rates change with the market, so tell us the item and quantity and we will confirm the final rate.",
          hi: 'नमस्ते {{contact.name}} जी! यह आज की रेट लिस्ट है। रेट बाज़ार के साथ बदलते हैं, इसलिए आइटम और मात्रा बताइए, हम फ़ाइनल रेट बता देंगे।',
        },
      },
      {
        shortcut: 'followup',
        title: { en: 'Follow-up', hi: 'फ़ॉलो-अप' },
        body: {
          en: "Namaste {{contact.name}} ji, did you get a chance to look at our rates? Rates may go up soon — shall we book your order at today's rate?",
          hi: 'नमस्ते {{contact.name}} जी, क्या आपने हमारे रेट देखे? रेट जल्द बढ़ सकते हैं — क्या आज के रेट पर आपका ऑर्डर बुक कर दें?',
        },
      },
      {
        shortcut: 'moq',
        title: { en: 'Minimum order', hi: 'कम से कम ऑर्डर' },
        body: {
          en: 'Our minimum order is ___. On bigger quantities we give a better rate.',
          hi: 'हमारा कम से कम ऑर्डर ___ है। ज़्यादा मात्रा पर हम बेहतर रेट देते हैं।',
        },
      },
      {
        shortcut: 'payment',
        title: { en: 'Payment details', hi: 'भुगतान की जानकारी' },
        body: {
          en: 'Our bank and UPI details are on the quotation. Please send a photo of the payment slip once you have paid, and we will dispatch your order.',
          hi: 'हमारे बैंक और UPI की जानकारी कोटेशन पर है। भुगतान के बाद उसकी पर्ची की फ़ोटो भेज दीजिए, हम आपका ऑर्डर भेज देंगे।',
        },
      },
      {
        shortcut: 'dispatch',
        title: { en: 'Dispatched', hi: 'माल रवाना' },
        body: {
          en: 'Your order has been dispatched today. Transport: ___, LR/bilty no.: ___. It should reach you in ___ days.',
          hi: 'आपका ऑर्डर आज रवाना हो गया है। ट्रांसपोर्ट: ___, LR/बिल्टी नंबर: ___। यह ___ दिन में पहुँच जाना चाहिए।',
        },
      },
      {
        shortcut: 'thanks',
        title: { en: 'Thank you', hi: 'धन्यवाद' },
        body: {
          en: 'Thank you for your order, {{contact.name}} ji! — {{org.name}}',
          hi: 'ऑर्डर के लिए धन्यवाद, {{contact.name}} जी! — {{org.name}}',
        },
      },
    ],
    terms: {
      en: [
        '1. Rates are ex-godown; GST is extra at the applicable rate.',
        '2. Payment: 100% advance, unless agreed otherwise in writing.',
        '3. Delivery within 3–5 working days of payment. Transport and loading are extra.',
        '4. Rates may change with the market; this quotation is valid until the date shown.',
        '5. Goods once sold will not be taken back.',
        "6. Subject to the jurisdiction of our city's courts.",
      ].join('\n'),
      hi: [
        '1. रेट गोदाम से (ex-godown) हैं; GST लागू दर से अलग लगेगा।',
        '2. भुगतान: 100% एडवांस, जब तक लिखित में अलग से तय न हो।',
        '3. भुगतान के 3–5 कामकाजी दिनों में डिलीवरी। ट्रांसपोर्ट और लोडिंग का खर्च अलग।',
        '4. रेट बाज़ार के साथ बदल सकते हैं; यह कोटेशन दी गई तारीख तक मान्य है।',
        '5. बिका हुआ माल वापस नहीं लिया जाएगा।',
        '6. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
      ].join('\n'),
    },
    validityDays: 7,
  },
  manufacturer: {
    name: { en: 'Manufacturer', hi: 'मैन्युफ़ैक्चरर (माल बनाने वाले)' },
    about: {
      en: 'You make goods to order: samples, purchase orders and production time.',
      hi: 'आप ऑर्डर पर माल बनाते हैं: सैंपल, परचेज़ ऑर्डर और माल बनने का समय।',
    },
    stages: [
      { kind: 'New', name: { en: 'New enquiry', hi: 'नई पूछताछ' }, probability: 10, quietDays: 2 },
      { kind: 'Contacted', name: { en: 'Requirement understood', hi: 'ज़रूरत समझ ली' }, probability: 20, quietDays: 3 },
      { kind: 'Contacted', name: { en: 'Sample sent', hi: 'सैंपल भेजा' }, probability: 35, quietDays: 7 },
      { kind: 'Quote Sent', name: { en: 'Quotation sent', hi: 'कोटेशन भेजा' }, probability: 50, quietDays: 5 },
      { kind: 'Negotiation', name: { en: 'Waiting for PO', hi: 'PO का इंतज़ार' }, probability: 75, quietDays: 7 },
    ],
    quickReplies: [
      {
        shortcut: 'catalogue',
        title: { en: 'Catalogue', hi: 'कैटलॉग' },
        body: {
          en: 'Namaste {{contact.name}} ji! Here is our catalogue. Tell us the item, size and quantity you need, and we will send a quotation.',
          hi: 'नमस्ते {{contact.name}} जी! यह हमारा कैटलॉग है। आपको कौन-सा आइटम, साइज़ और कितनी मात्रा चाहिए, बताइए — हम कोटेशन भेज देंगे।',
        },
      },
      {
        shortcut: 'sample',
        title: { en: 'Sample', hi: 'सैंपल' },
        body: {
          en: 'We can send you a sample. Please share your address and the item and size you want; any sample charge is adjusted in your first order.',
          hi: 'हम आपको सैंपल भेज सकते हैं। अपना पता और आइटम-साइज़ बताइए; सैंपल का खर्च (अगर हो) आपके पहले ऑर्डर में एडजस्ट हो जाएगा।',
        },
      },
      {
        shortcut: 'moq',
        title: { en: 'Minimum order', hi: 'कम से कम ऑर्डर' },
        body: {
          en: 'Our minimum order is ___ per item. Bigger orders get a better rate.',
          hi: 'हमारा कम से कम ऑर्डर ___ प्रति आइटम है। बड़े ऑर्डर पर बेहतर रेट मिलता है।',
        },
      },
      {
        shortcut: 'leadtime',
        title: { en: 'Production time', hi: 'माल बनने का समय' },
        body: {
          en: 'Production takes about ___ days after we receive your purchase order and advance.',
          hi: 'आपका परचेज़ ऑर्डर और एडवांस मिलने के बाद माल बनने में लगभग ___ दिन लगते हैं।',
        },
      },
      {
        shortcut: 'payment',
        title: { en: 'Payment terms', hi: 'भुगतान की शर्तें' },
        body: {
          en: 'Payment: 50% advance with the purchase order, the balance before dispatch. Our bank and UPI details are on the quotation.',
          hi: 'भुगतान: परचेज़ ऑर्डर के साथ 50% एडवांस, बाकी डिस्पैच से पहले। हमारे बैंक और UPI की जानकारी कोटेशन पर है।',
        },
      },
      {
        shortcut: 'dispatch',
        title: { en: 'Dispatched', hi: 'माल रवाना' },
        body: {
          en: 'Your order has been dispatched. Transport: ___, LR/bilty no.: ___. The invoice and e-way bill are attached.',
          hi: 'आपका ऑर्डर रवाना हो गया है। ट्रांसपोर्ट: ___, LR/बिल्टी नंबर: ___। इनवॉइस और ई-वे बिल साथ में हैं।',
        },
      },
      {
        shortcut: 'thanks',
        title: { en: 'Thank you', hi: 'धन्यवाद' },
        body: {
          en: 'Thank you for your purchase order, {{contact.name}} ji! We will share the production and dispatch dates soon. — {{org.name}}',
          hi: 'परचेज़ ऑर्डर के लिए धन्यवाद, {{contact.name}} जी! हम जल्द ही माल बनने और डिस्पैच की तारीख बताएँगे। — {{org.name}}',
        },
      },
    ],
    terms: {
      en: [
        '1. Prices are ex-works; GST, freight and insurance are extra as applicable.',
        '2. Payment: 50% advance with the purchase order, the balance before dispatch.',
        '3. Production starts once the purchase order and advance are received; the dispatch date is confirmed then.',
        '4. Goods as per the approved sample or drawing.',
        '5. This quotation is valid until the date shown.',
        "6. Subject to the jurisdiction of our city's courts.",
      ].join('\n'),
      hi: [
        '1. दाम फ़ैक्ट्री से (ex-works) हैं; GST, भाड़ा और बीमा लागू होने पर अलग से।',
        '2. भुगतान: परचेज़ ऑर्डर के साथ 50% एडवांस, बाकी डिस्पैच से पहले।',
        '3. परचेज़ ऑर्डर और एडवांस मिलने के बाद माल बनना शुरू होगा; तभी डिस्पैच की तारीख पक्की होगी।',
        '4. माल मंज़ूर सैंपल या ड्रॉइंग के अनुसार।',
        '5. यह कोटेशन दी गई तारीख तक मान्य है।',
        '6. सभी विवाद हमारे शहर के न्यायालय के अधीन।',
      ].join('\n'),
    },
    validityDays: 15,
  },
  pest_control: pestControl.kit,
  real_estate: realEstate.kit,
  education: education.kit,
  clinic: clinic.kit,
  travel: travel.kit,
  insurance: insurance.kit,
  salon: salon.kit,
  gym: gym.kit,
  interior: interior.kit,
  solar: solar.kit,
});
const KIT_IDS = Object.freeze(Object.keys(KITS));
// The kits offered in "Ready settings"; the others come with a CRM type (constants/crmTypes.js).
const CHOOSABLE_KIT_IDS = Object.freeze(KIT_IDS.filter((id) => !KITS[id].crmTypeOnly));

// The "Getting started" checklist's steps, in order.
const GETTING_STARTED_STEPS = Object.freeze(['business', 'kit', 'whatsapp', 'products', 'leads', 'team', 'quote']);

module.exports = { KITS, KIT_IDS, CHOOSABLE_KIT_IDS, KIT_LANGUAGES, GETTING_STARTED_STEPS };
