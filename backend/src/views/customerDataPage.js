const { formatRupees } = require('../utils/money');

// A customer's data file as a page (Phase 8, D120): one file that opens on any phone or computer
// and prints well, in the language of the person who made it. Drawn from the same object as the
// JSON file (services/customerDataService.js); every text comes from the pages' i18n files (t).

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A link the file may open: web addresses only (never javascript: or a local file).
const link = (url) => (/^https?:\/\//i.test(String(url || '')) ? `<a href="${esc(url)}" rel="noopener noreferrer">${esc(url)}</a>` : esc(url));

const CSS = `
  :root { color-scheme: light; --text: #1d1d1f; --muted: #5f5f66; --line: #e3e3e8; --soft: #f6f6f8; --accent: #8a6500; --in: #ffffff; --out: #fff6d6; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--soft); color: var(--text); font: 15px/1.55 -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", "Nirmala UI", Mangal, Arial, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 40px; }
  header, section, nav { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; margin: 0 0 14px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  h2 { font-size: 17px; margin: 0 0 10px; color: var(--accent); }
  h3 { font-size: 15px; margin: 14px 0 6px; }
  p { margin: 4px 0; }
  .muted, .none { color: var(--muted); }
  nav ol { margin: 0; padding-left: 20px; columns: 2; column-gap: 28px; }
  nav li { break-inside: avoid; }
  a { color: #0b57d0; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: minmax(120px, 34%) 1fr; gap: 6px 14px; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; vertical-align: top; padding: 7px 8px; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
  th { color: var(--muted); font-weight: 600; border-top: 0; }
  td.num { text-align: right; white-space: nowrap; }
  .tag { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--soft); border: 1px solid var(--line); color: var(--muted); margin-left: 6px; }
  ol.msgs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  ol.msgs li { max-width: 88%; padding: 7px 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--in); overflow-wrap: anywhere; white-space: pre-wrap; }
  ol.msgs li.company { margin-left: auto; background: var(--out); }
  ol.msgs time { display: block; font-size: 12px; color: var(--muted); white-space: normal; }
  ul.plain { margin: 0; padding-left: 18px; }
  footer { text-align: center; color: var(--muted); font-size: 13px; padding: 6px 0 0; }
  @media (max-width: 560px) { dl { grid-template-columns: 1fr; gap: 0 0; } dd { margin: 0 0 8px; } nav ol { columns: 1; } th, td { padding: 6px 4px; } }
  @media print { body { background: #fff; } nav { display: none; } header, section { border: 0; padding: 0; margin: 0 0 18px; break-inside: auto; } a { color: inherit; } }
`;

function formatters(t) {
  const locale = t.language === 'hi' ? 'hi-IN' : 'en-IN';
  const day = (value) => (value ? new Date(value).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');
  const time = (value) => (value ? new Date(value).toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
  const dateOnly = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return String(value || '');
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  return { day, time, dateOnly, money: (paise) => formatRupees(paise) };
}

function render(data, t) {
  const f = formatters(t);
  const company = data.company.name;
  const deletedTag = (row) => (row.deleted ? `<span class="tag">${esc(t('pdata.deleted'))}</span>` : '');
  const none = `<p class="none">${esc(t('pdata.none'))}</p>`;
  const table = (heads, rows) => (rows.length
    ? `<table><thead><tr>${heads.map((h) => `<th${h.num ? ' class="num"' : ''}>${esc(h.label || h)}</th>`).join('')}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((cell, i) => `<td${heads[i].num ? ' class="num"' : ''}>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : none);
  const num = (label) => ({ label, num: true });
  const c = data.customer;
  const consentText = { opted_in: t('c360.consent.in'), opted_out: t('c360.consent.out'), unknown: t('c360.consent.unknown') };
  const MEDIA = { image: 'inbox.media.image', video: 'inbox.media.video', audio: 'inbox.media.audio', document: 'inbox.media.document', sticker: 'inbox.media.sticker' };
  const CHANNEL = { whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger' };

  // Each section: [id, title, count, html].
  const sections = [];
  const add = (id, title, count, html) => sections.push({ id, title, count, html });

  const details = [
    [t('pdata.f.name'), c.name], [t('pdata.f.phone'), c.phone], [t('pdata.f.email'), c.email], [t('pdata.f.company'), c.company],
    [t('pdata.f.gstin'), c.gstin], [t('pdata.f.address'), [c.address, c.city, c.state].filter(Boolean).join(', ')],
    [t('pdata.f.tags'), (c.tags || []).join(', ')], [t('pdata.f.status'), t.label('stage', c.status)],
    [t('pdata.f.source'), t.label('source', c.source)], [t('pdata.f.added'), f.day(c.addedAt)], [t('pdata.f.since'), f.day(c.customerSince)],
    ...(c.customFields || []).map((field) => [field.label, field.value]),
  ].filter(([, value]) => value);
  add('details', t('pdata.s.details'), null, `<dl>${details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${c.deleted ? `<p class="muted">${esc(t('pdata.deletedCustomer'))}</p>` : ''}`);

  const choices = [
    [t('pdata.f.offers'), consentText[c.marketingConsent] || c.marketingConsent],
    [t('pdata.f.sms'), c.smsOptOut ? t('pdata.smsStopped', { date: f.day(c.smsOptOut) }) : t('pdata.smsOk')],
    ...(c.blocked ? [[t('pdata.f.blocked'), t('pdata.yes')]] : []),
  ];
  add('choices', t('pdata.s.consent'), null, `<dl>${choices.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${
    data.consentHistory.length ? `<h3>${esc(t('pdata.consentHistory'))}</h3>${table([t('pdata.c.date'), t('pdata.c.change'), t('pdata.c.how')], data.consentHistory.map((e) => [
      esc(f.time(e.at)), esc(`${e.channel === 'sms' ? 'SMS: ' : ''}${consentText[e.from] || e.from} → ${consentText[e.to] || e.to}`), esc(t.has(`c360.consent.by.${e.method}`) ? t(`c360.consent.by.${e.method}`) : e.method),
    ]))}` : ''}`);

  const reach = data.howYouReachedUs;
  const reachRows = [
    ...(reach.firstTouch ? [[esc(f.day(reach.firstTouch.at)), esc(t('pdata.firstTouch')), esc([t.label('rep.ch', reach.firstTouch.channel), reach.firstTouch.source, reach.firstTouch.campaign].filter(Boolean).join(' · '))]] : []),
    ...reach.touchpoints.map((tp) => [esc(f.day(tp.at)), esc(t.label('rep.ch', tp.channel)), esc([tp.source, tp.campaign, tp.page].filter(Boolean).join(' · '))]),
    ...reach.enquiries.map((e) => [esc(f.day(e.at)), esc(e.source), esc(e.summary)]),
  ];
  add('reach', t('pdata.s.origin'), reachRows.length, table([t('pdata.c.date'), t('pdata.c.where'), t('pdata.c.details')], reachRows));

  add('leads', t('pdata.s.leads'), data.leads.length, data.leads.length ? data.leads.map((l) => `
    <h3>${esc(l.title || l.product || t('pdata.enquiry'))} ${deletedTag(l)}</h3>
    <dl>${[
    [t('pdata.c.date'), f.day(l.at)], [t('pdata.c.status'), l.stageName || t.label('stage', l.stage)], [t('pdata.f.product'), l.product],
    [t('pdata.f.quantity'), l.quantity ?? ''], [t('pdata.f.value'), l.expectedValuePaise ? f.money(l.expectedValuePaise) : ''], [t('pdata.f.source'), t.label('source', l.source)],
    [t('pdata.f.lostReason'), l.lostReason], ...(l.customFields || []).map((field) => [field.label, field.value]),
  ].filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${l.activities.length ? `<ul class="plain">${l.activities.map((a) => `<li>${esc(f.day(a.at))} — ${esc(a.text)}</li>`).join('')}</ul>` : ''}`).join('') : none);

  const docRows = (list, status) => list.map((d) => [esc(d.number), esc(f.day(d.at)), `${esc(status(d))}${deletedTag(d)}`, esc(d.items?.map((i) => `${i.name} × ${i.quantity}${i.unit ? ` ${i.unit}` : ''}`).join(', ') || ''), esc(f.money(d.totalPaise))]);
  add('quotations', t('pdata.s.quotations'), data.quotations.length, table([t('pdata.c.number'), t('pdata.c.date'), t('pdata.c.status'), t('pdata.c.items'), num(t('pdata.c.amount'))], docRows(data.quotations, (q) => t.label('quoteStatus', q.status))));
  add('orders', t('pdata.s.orders'), data.orders.length, table([t('pdata.c.number'), t('pdata.c.date'), t('pdata.c.status'), t('pdata.c.items'), num(t('pdata.c.amount'))], docRows(data.orders, (o) => t.label('orderStage', o.stage))));
  add('invoices', t('pdata.s.invoices'), data.taxInvoices.length, `${table([t('pdata.c.number'), t('pdata.c.date'), t('pdata.c.billTo'), num(t('pdata.c.amount'))], data.taxInvoices.map((i) => [
    `${esc(i.number)}${i.kind === 'credit_note' ? ` <span class="tag">${esc(t('pdata.creditNote'))}</span>` : ''}`, esc(f.day(i.at)), esc([i.billTo.name, i.billTo.company, i.billTo.gstin].filter(Boolean).join(' · ')), esc(f.money(i.totalPaise)),
  ]))}${data.taxInvoices.length ? `<p class="muted">${esc(t('pdata.invoicesKept'))}</p>` : ''}`);
  add('payments', t('pdata.s.payments'), data.payments.length + data.paymentLinks.length, `${table([t('pdata.c.number'), t('pdata.c.date'), t('pdata.c.how'), num(t('pdata.c.amount'))], data.payments.map((p) => [esc(p.number), esc(f.day(p.at)), esc([p.method, p.reference].filter(Boolean).join(' · ')), esc(f.money(p.amountPaise))]))}${
    data.paymentLinks.length ? `<h3>${esc(t('pdata.paymentLinks'))}</h3>${table([t('pdata.c.date'), t('pdata.c.details'), t('pdata.c.status'), num(t('pdata.c.amount'))], data.paymentLinks.map((l) => [esc(f.day(l.at)), esc([l.gateway, l.about].filter(Boolean).join(' · ')), esc(l.status), esc(f.money(l.amountPaise))]))}` : ''}`);
  add('tickets', t('pdata.s.tickets'), data.supportRequests.length, table([t('pdata.c.number'), t('pdata.c.date'), t('pdata.c.details'), t('pdata.c.status')], data.supportRequests.map((s) => [
    esc(`#${s.number}`), esc(f.day(s.at)), esc([s.subject, s.description].filter(Boolean).join(' — ')), `${esc(t.label('ticketStatus', s.status))}${deletedTag(s)}`,
  ])));
  add('work', t('pdata.s.work'), data.tasks.length + data.meetings.length, table([t('pdata.c.date'), t('pdata.c.title'), t('pdata.c.status')], [
    ...data.tasks.map((task) => [esc(f.dateOnly(task.dueDate)), esc(task.title), `${esc(t.label('taskStatus', task.status))}${deletedTag(task)}`]),
    ...data.meetings.map((m) => [esc(`${f.dateOnly(m.date)}${m.time ? ` ${m.time}` : ''}`), esc(m.title), `${esc(m.type)}${deletedTag(m)}`]),
  ]));
  add('notes', t('pdata.s.notes'), data.notes.length, table([t('pdata.c.date'), t('pdata.c.text')], data.notes.map((n) => [esc(f.day(n.at)), esc(n.text)])));
  add('calls', t('pdata.s.calls'), data.calls.length, table([t('pdata.c.date'), t('pdata.c.details'), t('pdata.c.text')], data.calls.map((call) => [
    esc(f.time(call.at)), esc([t(call.direction === 'in' ? 'pdata.callIn' : 'pdata.callOut'), call.durationSec ? t('pdata.minutes', { n: Math.max(1, Math.round(call.durationSec / 60)) }) : '', t.label('call.outcome', call.outcome)].filter(Boolean).join(' · ')), esc(call.notes),
  ])));

  const messageLine = (m) => {
    const parts = [];
    if (MEDIA[m.type]) parts.push(`[${m.voice ? t('pdata.voice') : t(MEDIA[m.type])}${m.file ? `: ${m.file}` : ''}]`);
    if (m.type === 'location') parts.push(`[${t('inbox.location')}${m.location ? `: ${m.location}` : ''}]`);
    if (m.type === 'contacts') parts.push(`[${t('inbox.contactCard')}]`);
    if (m.reaction) parts.push(`${t('c360.reaction')}: ${m.reaction}`);
    if (m.text) parts.push(m.text);
    if (m.answers) parts.push(m.answers.map((a) => `${a.label}: ${a.value}`).join('\n'));
    if (!parts.length) parts.push(`[${m.template || m.type}]`);
    return parts.join(' ');
  };
  const messageCount = data.chats.reduce((n, chat) => n + chat.messages.length, 0);
  add('chats', t('pdata.s.chats'), messageCount, data.chats.length ? data.chats.map((chat) => `
    <h3>${esc(CHANNEL[chat.channel] || chat.channel)} <span class="muted">· ${esc(t('pdata.messages', { n: chat.messages.length }))}</span></h3>
    ${chat.messages.length ? `<ol class="msgs">${chat.messages.map((m) => `<li class="${m.from === 'customer' ? 'customer' : 'company'}"><time>${esc(f.time(m.at))} · ${esc(m.from === 'customer' ? t('pdata.you') : company)}</time>${esc(messageLine(m))}</li>`).join('')}</ol>` : none}`).join('') : none);
  add('sms', 'SMS', data.sms.length, table([t('pdata.c.date'), t('pdata.c.text')], data.sms.map((s) => [esc(`${f.time(s.at)} · ${s.direction === 'in' ? t('pdata.you') : company}`), esc(s.text)])));
  add('emails', t('pdata.s.emails'), data.emails.length, table([t('pdata.c.date'), t('pdata.c.title'), t('pdata.c.text')], data.emails.map((e) => [esc(f.time(e.at)), esc(e.subject), esc(e.snippet)])));
  add('files', t('pdata.s.files'), data.files.length, table([t('pdata.c.date'), t('pdata.c.title'), num(t('pdata.c.size'))], data.files.map((d) => [
    esc(f.day(d.at)), `${esc(d.name)}${d.fileName && d.fileName !== d.name ? ` <span class="muted">(${esc(d.fileName)})</span>` : ''}${d.link ? ` ${link(d.link)}` : ''}${deletedTag(d)}`, esc(d.sizeBytes ? `${Math.max(1, Math.round(d.sizeBytes / 1024))} KB` : ''),
  ])));
  const outreach = [
    ...data.campaigns.map((b) => [esc(f.day(b.at)), esc(b.name), esc(b.status)]),
    ...data.sequences.map((s) => [esc(f.day(s.at)), esc(s.name), esc(s.status)]),
    ...data.scheduledMessages.map((s) => [esc(f.time(s.at)), esc(s.text), esc(t('pdata.scheduled'))]),
  ];
  add('campaigns', t('pdata.s.campaigns'), outreach.length, table([t('pdata.c.date'), t('pdata.c.title'), t('pdata.c.status')], outreach));
  const other = [
    ...data.linkedRecords.map((r) => [esc(r.kind === 'project' ? t('pdata.project') : r.kind), esc(r.name)]),
    ...data.feedback.map((s) => [esc(`${t('pdata.feedback')} · ${f.day(s.at)}`), esc(s.rating)]),
  ];
  add('other', t('pdata.s.other'), other.length, table([t('pdata.c.where'), t('pdata.c.details')], other));
  add('shared', t('pdata.s.shared'), data.sharedWith.length, `<p class="muted">${esc(t('pdata.sharedIntro', { company }))}</p>${table([t('pdata.c.who'), t('pdata.c.why')], data.sharedWith.map((s) => [esc(s.name), esc(s.purpose)]))}`);

  const contact = data.company.privacyContact;
  const reachUs = [contact.name, contact.email, contact.phone].filter(Boolean).join(' · ');
  const title = t('pdata.title', { company });
  return `<!doctype html>
<html lang="${t.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
  <h1>${esc(title)}</h1>
  <p>${esc(t('pdata.intro', { company, name: c.name || '', date: f.day(data.madeAt) }))}</p>
  ${data.askedAt ? `<p class="muted">${esc(t('pdata.asked', { date: f.day(data.askedAt) }))}</p>` : ''}
  ${reachUs ? `<p>${esc(t('pdata.contactUs'))} <strong>${esc(reachUs)}</strong></p>` : ''}
  ${data.company.privacyNotice ? `<p>${esc(t('pdata.notice'))} ${link(data.company.privacyNotice)}</p>` : ''}
</header>
<nav aria-label="${esc(t('pdata.toc'))}">
  <h2>${esc(t('pdata.toc'))}</h2>
  <ol>${sections.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a>${s.count === null ? '' : ` <span class="muted">(${s.count})</span>`}</li>`).join('')}</ol>
</nav>
${sections.map((s) => `<section id="${s.id}"><h2>${esc(s.title)}</h2>${s.html}</section>`).join('\n')}
<footer>${esc(t('pdata.footer', { company, date: f.time(data.madeAt) }))}</footer>
</main>
</body>
</html>
`;
}

module.exports = { render };
