const env = require('../config/env');
const { formatRupees } = require('../utils/money');

// The platform's emails (D104): a subject, a branded HTML part and a plain-text part, in English
// or Hindi (the person's language in Settings). Everything that comes from people or companies
// is escaped. No images or tracking: a yellow bar with the product's name is the brand.
const BRAND = 'AgreemCRM';
const LINKS = {
  plan: () => `${env.frontendUrl}/Settings.html?tab=plan`,
  data: () => `${env.frontendUrl}/Settings.html?tab=data`,
  devices: () => `${env.frontendUrl}/Settings.html?tab=profile#devicesSection`,
};
const ROLE_NAMES = {
  en: { owner: 'Owner', admin: 'Admin', agent: 'Agent', viewer: 'Viewer' },
  hi: { owner: 'मालिक', admin: 'एडमिन', agent: 'एजेंट', viewer: 'व्यूअर' },
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const locale = (language) => (language === 'hi' ? 'hi-IN' : 'en-IN');
const dateText = (date, language) => (date ? new Intl.DateTimeFormat(locale(language), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(date)) : '');
const timeText = (date, language) => new Intl.DateTimeFormat(locale(language), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).format(new Date(date));
const days = (n, language) => (language === 'hi' ? `${n} दिन` : `${n} day${n === 1 ? '' : 's'}`);

// Each email: (data, language) → { subject, heading, paragraphs, button?: { label, url }, note? }.
const TEMPLATES = {
  invite(d, l) {
    const role = ROLE_NAMES[l][d.role] || d.role;
    return l === 'hi' ? {
      subject: `${d.inviterName} ने आपको ${BRAND} पर ${d.organizationName} में बुलाया है`,
      heading: `${BRAND} पर ${d.organizationName} से जुड़ें`,
      paragraphs: [
        `${d.inviterName} ने आपको ${d.organizationName} की टीम में ${role} के रूप में जोड़ा है।`,
        `इनवाइट खोलें और ${d.to} वाले Google अकाउंट से साइन इन करें। लिंक ${dateText(d.expiresAt, l)} तक चलेगा।`,
      ],
      button: { label: `${d.organizationName} से जुड़ें`, url: d.link },
      note: 'अगर आपको इस इनवाइट की उम्मीद नहीं थी, तो इस ईमेल को अनदेखा करें।',
    } : {
      subject: `${d.inviterName} invited you to ${d.organizationName} on ${BRAND}`,
      heading: `Join ${d.organizationName} on ${BRAND}`,
      paragraphs: [
        `${d.inviterName} added you to the team of ${d.organizationName} as ${role}.`,
        `Open the invite and sign in with the Google account of ${d.to}. The link works until ${dateText(d.expiresAt, l)}.`,
      ],
      button: { label: `Join ${d.organizationName}`, url: d.link },
      note: "If you weren't expecting this invite, you can ignore this email.",
    };
  },
  trial_reminder(d, l) {
    return l === 'hi' ? {
      subject: `आपका ${BRAND} ट्रायल ${days(d.daysLeft, l)} में खत्म होगा`,
      heading: `ट्रायल ${days(d.daysLeft, l)} में खत्म होगा`,
      paragraphs: [
        `${d.organizationName} का फ़्री ट्रायल ${dateText(d.trialEndsAt, l)} को खत्म होगा।`,
        'कॉन्टैक्ट, कोटेशन, ब्रॉडकास्ट और टीम सदस्य जोड़ते रहने के लिए Settings → Plan & usage में प्लान चुनें। आपका डेटा हर हाल में सुरक्षित रहेगा।',
      ],
      button: { label: 'प्लान चुनें', url: LINKS.plan() },
    } : {
      subject: `Your ${BRAND} trial ends in ${days(d.daysLeft, l)}`,
      heading: `Your trial ends in ${days(d.daysLeft, l)}`,
      paragraphs: [
        `The free trial of ${d.organizationName} ends on ${dateText(d.trialEndsAt, l)}.`,
        'Choose a plan in Settings → Plan & usage to keep adding contacts, quotations, broadcasts and teammates. Your data stays safe either way.',
      ],
      button: { label: 'Choose a plan', url: LINKS.plan() },
    };
  },
  trial_ended(d, l) {
    return l === 'hi' ? {
      subject: `आपका ${BRAND} ट्रायल खत्म हो गया`,
      heading: 'फ़्री ट्रायल खत्म हो गया',
      paragraphs: [
        `${d.organizationName} का फ़्री ट्रायल खत्म हो गया।`,
        'आपका डेटा सुरक्षित है और चैट चलती रहेंगी। कॉन्टैक्ट, कोटेशन, ब्रॉडकास्ट और टीम सदस्य फिर से जोड़ने के लिए प्लान चुनें।',
      ],
      button: { label: 'प्लान चुनें', url: LINKS.plan() },
    } : {
      subject: `Your ${BRAND} trial has ended`,
      heading: 'Your free trial has ended',
      paragraphs: [
        `The free trial of ${d.organizationName} has ended.`,
        'Your data is safe and chats keep working. Choose a plan to add contacts, quotations, broadcasts and teammates again.',
      ],
      button: { label: 'Choose a plan', url: LINKS.plan() },
    };
  },
  payment_failed(d, l) {
    const stopped = d.stage === 'stopped';
    if (l === 'hi') {
      return stopped ? {
        subject: `आपका ${d.planName} प्लान रुक गया है`,
        heading: 'प्लान रुक गया है',
        paragraphs: [
          `${d.organizationName} के ${d.planName} प्लान के पेमेंट नहीं हो पाए, इसलिए प्लान रुक गया है।`,
          'आपका डेटा सुरक्षित है और चैट चलती रहेंगी। कॉन्टैक्ट, कोटेशन, ब्रॉडकास्ट और टीम सदस्य फिर से जोड़ने के लिए दोबारा प्लान चुनें।',
        ],
        button: { label: 'प्लान चुनें', url: LINKS.plan() },
      } : {
        subject: `आपके ${d.planName} प्लान का पेमेंट नहीं हो पाया`,
        heading: 'पेमेंट नहीं हो पाया',
        paragraphs: [
          `${d.organizationName} के ${d.planName} प्लान का पेमेंट नहीं कट पाया।`,
          'Razorpay फिर से कोशिश करेगा। प्लान चालू रखने के लिए Settings → Plan & usage में कार्ड या UPI मैंडेट जाँच लें।',
        ],
        button: { label: 'Plan & usage खोलें', url: LINKS.plan() },
      };
    }
    return stopped ? {
      subject: `Your ${d.planName} plan has stopped`,
      heading: 'Your plan has stopped',
      paragraphs: [
        `The payments for the ${d.planName} plan of ${d.organizationName} failed, so the plan has stopped.`,
        'Your data is safe and chats keep working. Choose a plan again to add contacts, quotations, broadcasts and teammates.',
      ],
      button: { label: 'Choose a plan', url: LINKS.plan() },
    } : {
      subject: `The payment for your ${d.planName} plan did not go through`,
      heading: 'The payment did not go through',
      paragraphs: [
        `We could not charge the ${d.planName} plan of ${d.organizationName}.`,
        'Razorpay will try again. Check the card or UPI mandate in Settings → Plan & usage to keep your plan.',
      ],
      button: { label: 'Open Plan & usage', url: LINKS.plan() },
    };
  },
  plan_invoice(d, l) {
    const amount = formatRupees(d.totalPaise);
    const period = d.periodStart && d.periodEnd ? `${dateText(d.periodStart, l)} – ${dateText(d.periodEnd, l)}` : '';
    return l === 'hi' ? {
      subject: `आपके ${d.planName} प्लान का इनवॉइस ${d.number}`,
      heading: 'पेमेंट मिल गया, धन्यवाद!',
      paragraphs: [
        `${d.organizationName} के ${d.planName} प्लान के लिए ${amount} मिल गए${period ? ` (${period})` : ''}।`,
        `GST टैक्स इनवॉइस ${d.number} PDF के रूप में साथ में है। इसे Settings → Plan & usage से भी डाउनलोड कर सकते हैं।`,
      ],
      button: { label: 'Plan & usage खोलें', url: LINKS.plan() },
    } : {
      subject: `Invoice ${d.number} for your ${d.planName} plan`,
      heading: 'Payment received, thank you!',
      paragraphs: [
        `We received ${amount} for the ${d.planName} plan of ${d.organizationName}${period ? ` (${period})` : ''}.`,
        `The GST tax invoice ${d.number} is attached as a PDF. You can also download it from Settings → Plan & usage.`,
      ],
      button: { label: 'Open Plan & usage', url: LINKS.plan() },
    };
  },
  deletion_scheduled(d, l) {
    return l === 'hi' ? {
      subject: `${d.organizationName} ${dateText(d.scheduledFor, l)} को डिलीट हो जाएगी`,
      heading: 'कंपनी डिलीट होने वाली है',
      paragraphs: [
        `${d.requestedBy || 'एक मालिक'} ने ${BRAND} से ${d.organizationName} और उसका सारा डेटा डिलीट करने को कहा है। यह ${dateText(d.scheduledFor, l)} को हमेशा के लिए डिलीट हो जाएगी।`,
        'तब तक कंपनी चलती रहेगी: Settings → Data & Privacy में अपना डेटा डाउनलोड करें; कोई भी मालिक वहीं से डिलीट करना रद्द कर सकता है।',
      ],
      button: { label: 'Data & Privacy खोलें', url: LINKS.data() },
    } : {
      subject: `${d.organizationName} will be deleted on ${dateText(d.scheduledFor, l)}`,
      heading: 'Your company is set to be deleted',
      paragraphs: [
        `${d.requestedBy || 'An owner'} asked to delete ${d.organizationName} and all its data from ${BRAND}. It will be deleted for good on ${dateText(d.scheduledFor, l)}.`,
        'Until then the company keeps working: download your data in Settings → Data & Privacy, and any owner can cancel the deletion there.',
      ],
      button: { label: 'Open Data & Privacy', url: LINKS.data() },
    };
  },
  deletion_tomorrow(d, l) {
    return l === 'hi' ? {
      subject: `${d.organizationName} कल डिलीट हो जाएगी`,
      heading: 'कल डिलीट हो जाएगी',
      paragraphs: [
        `${d.organizationName} और उसका सारा डेटा ${dateText(d.scheduledFor, l)} को हमेशा के लिए डिलीट हो जाएगा।`,
        'Settings → Data & Privacy में अपना डेटा डाउनलोड करने या डिलीट करना रद्द करने का यह आखिरी मौका है।',
      ],
      button: { label: 'Data & Privacy खोलें', url: LINKS.data() },
    } : {
      subject: `${d.organizationName} will be deleted tomorrow`,
      heading: 'Deleted for good tomorrow',
      paragraphs: [
        `${d.organizationName} and all its data will be deleted for good on ${dateText(d.scheduledFor, l)}.`,
        'This is the last chance to download your data or cancel the deletion in Settings → Data & Privacy.',
      ],
      button: { label: 'Open Data & Privacy', url: LINKS.data() },
    };
  },
  login_alert(d, l) {
    return l === 'hi' ? {
      subject: `${BRAND} में नया लॉगिन: ${d.device}`,
      heading: `नया लॉगिन: ${d.device}`,
      paragraphs: [
        `आपका ${BRAND} अकाउंट (${d.to}) ${timeText(d.at, l)} पर ${d.device} पर खोला गया।`,
        'अगर यह आप थे, तो कुछ नहीं करना। अगर नहीं, तो Settings → Your profile → Where you\'re logged in में उस डिवाइस से लॉग आउट करें, और अपने Google अकाउंट की सुरक्षा जाँचें।',
      ],
      button: { label: 'देखें कहाँ लॉग इन है', url: LINKS.devices() },
      note: 'ये ईमेल Settings → Your profile में बंद कर सकते हैं।',
    } : {
      subject: `New login to ${BRAND}: ${d.device}`,
      heading: `New login: ${d.device}`,
      paragraphs: [
        `Your ${BRAND} account (${d.to}) was opened on ${d.device} on ${timeText(d.at, l)}.`,
        "If this was you, there's nothing to do. If not, log out that device in Settings → Your profile → Where you're logged in, and check your Google account's security.",
      ],
      button: { label: "See where you're logged in", url: LINKS.devices() },
      note: 'You can turn these emails off in Settings → Your profile.',
    };
  },
};
const KINDS = Object.freeze(Object.keys(TEMPLATES));

function html(language, { subject, heading, paragraphs, button, note }, footer) {
  const p = (text, style = 'margin:0 0 12px;font-size:15px;line-height:1.6') => `<p style="${style}">${escapeHtml(text)}</p>`;
  const fallback = language === 'hi' ? 'बटन न चले तो यह लिंक खोलें:' : "If the button doesn't work, open this link:";
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;color:#1d1d1f;font-family:-apple-system,'Segoe UI',Roboto,'Noto Sans','Noto Sans Devanagari',Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(paragraphs[0] || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#ffde59;padding:14px 24px;font-size:16px;font-weight:800;letter-spacing:0.5px;color:#1d1d1f">${BRAND}</td></tr>
<tr><td style="padding:28px 24px 12px">
<h1 style="margin:0 0 14px;font-size:20px;line-height:1.35">${escapeHtml(heading)}</h1>
${paragraphs.map((text) => p(text)).join('\n')}
${button ? `<p style="margin:22px 0 10px"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:#1d1d1f;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:999px">${escapeHtml(button.label)}</a></p>
${p(`${fallback} ${button.url}`, 'margin:0 0 12px;font-size:12px;line-height:1.5;color:#6e6e73;word-break:break-all')}` : ''}
${note ? p(note, 'margin:16px 0 0;font-size:13px;line-height:1.5;color:#6e6e73') : ''}
</td></tr>
<tr><td style="padding:16px 24px 22px;border-top:1px solid #ececef;font-size:12px;line-height:1.5;color:#8e8e93">${escapeHtml(footer)}</td></tr>
</table></td></tr></table>
</body></html>`;
}

function text({ heading, paragraphs, button, note }, footer) {
  return [BRAND, '', heading, '', ...paragraphs.flatMap((line) => [line, '']), ...(button ? [`${button.label}: ${button.url}`, ''] : []), ...(note ? [note, ''] : []), '—', footer].join('\n');
}

// → { subject, html, text } for one email in one language ('en' or 'hi').
function render(kind, language, data) {
  const template = TEMPLATES[kind];
  if (!template) throw new Error(`Unknown email: ${kind}`);
  const lang = language === 'hi' ? 'hi' : 'en';
  const parts = template(data, lang);
  const footer = lang === 'hi' ? `${BRAND} से ${data.to} पर भेजा गया।` : `Sent by ${BRAND} to ${data.to}.`;
  const subject = String(parts.subject).replace(/\s+/g, ' ').trim().slice(0, 200); // one line, whatever a name holds
  return { subject, html: html(lang, { ...parts, subject }, footer), text: text(parts, footer) };
}

module.exports = { render, KINDS, escapeHtml };
