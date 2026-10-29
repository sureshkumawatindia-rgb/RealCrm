// The website's WhatsApp button (D102): the script a company puts on its site. A round button in a
// corner (their colour) opens a small card — their name, or an agent's name and photo, "usually
// replies within …" from the working hours, the greeting — and "Chat on WhatsApp" opens wa.me with
// the ready message and a short ref code. The click (code, page, campaign tags) goes to the CRM as
// a beacon; the code in the customer's first message tells the CRM where the lead came from.
// It draws itself in a shadow root (the site's CSS cannot reach it and it reaches nothing of the
// site), builds every element without innerHTML, sets no cookie and stores nothing.
//
// browser() runs in the visitor's browser: it is sent as text (Function.prototype.toString), so it
// may use nothing outside itself. ES5 style, for old phones' browsers.

/* eslint-disable no-var, prefer-arrow-callback, func-names, vars-on-top, prefer-template, object-shorthand, no-plusplus */
function browser(cfg, script) {
  var ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O, 1/I: easy to read back
  var TAGS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'];
  var WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var TEXT = {
    en: {
      chat: 'Chat on WhatsApp', open: 'Chat with us on WhatsApp', close: 'Close',
      replies: { minutes: 'Usually replies within minutes', hour: 'Usually replies within an hour', hours: 'Usually replies within a few hours', day: 'Usually replies within a day' },
      away: function (time, when) { return 'Away now · back at ' + time + ' ' + when; },
      today: 'today', tomorrow: 'tomorrow', on: function (day) { return 'on ' + day; },
      days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    },
    hi: {
      chat: 'WhatsApp पर बात करें', open: 'WhatsApp पर हमसे बात करें', close: 'बंद करें',
      replies: { minutes: 'आमतौर पर कुछ ही मिनट में जवाब', hour: 'आमतौर पर एक घंटे में जवाब', hours: 'आमतौर पर कुछ घंटों में जवाब', day: 'आमतौर पर एक दिन में जवाब' },
      away: function (time, when) { return 'अभी ऑफ़लाइन · ' + when + ' ' + time + ' बजे से'; },
      today: 'आज', tomorrow: 'कल', on: function (day) { return day + ' को'; },
      days: ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'],
    },
  };
  // A plain speech bubble (not WhatsApp's logo).
  var ICON = 'M12 2C6.48 2 2 6.03 2 11c0 2.4 1.05 4.58 2.78 6.2L4 22l4.95-1.98C9.92 20.33 10.94 20.5 12 20.5c5.52 0 10-4.03 10-9S17.52 2 12 2z';

  function refCode() {
    var bytes = new Uint8Array(6);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256);
    var out = '';
    for (var j = 0; j < 6; j++) out += ALPHABET.charAt(bytes[j] % 32);
    return out;
  }
  // Dark or white ink, whichever reads better on the chosen colour.
  function inkOn(hex) {
    var n = parseInt(String(hex).slice(1), 16);
    var lin = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    var l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.0631) ? '#ffffff' : '#0b2e26';
  }
  function minutesOf(time) {
    var p = String(time).split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  }
  // In working hours: "usually replies within …"; outside them: when the team is back.
  function status(c, words) {
    var reply = words.replies[c.replyTime] || words.replies.minutes;
    var h = c.hours;
    if (!c.showHours || !h || !h.days || !h.days.length) return { open: true, text: reply };
    try {
      var parts = {};
      new Intl.DateTimeFormat('en-US', { timeZone: h.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
      var day = WEEKDAY[parts.weekday];
      var minute = Number(parts.hour) * 60 + Number(parts.minute);
      var start = minutesOf(h.start);
      if (h.days.indexOf(day) >= 0 && minute >= start && minute < minutesOf(h.end)) return { open: true, text: reply };
      for (var ahead = 0; ahead <= 7; ahead++) {
        var next = (day + ahead) % 7;
        if (h.days.indexOf(next) < 0 || (ahead === 0 && minute >= start)) continue;
        var when = ahead === 0 ? words.today : ahead === 1 ? words.tomorrow : words.on(words.days[next]);
        return { open: false, text: words.away(h.start, when) };
      }
    } catch (e) { /* no time zones in this browser */ }
    return { open: true, text: reply };
  }
  // The page's campaign tags and an outside referrer, for the CRM's "where it came from".
  function visit() {
    var data = { page: String(window.location.href).slice(0, 2000) };
    try {
      var params = new URLSearchParams(window.location.search);
      TAGS.forEach(function (k) { var v = params.get(k); if (v) data[k] = v.slice(0, 200); });
    } catch (e) { /* an old browser: no tags */ }
    try {
      if (document.referrer && new URL(document.referrer).host !== window.location.host) data.referrer = document.referrer.slice(0, 2000);
    } catch (e) { /* no referrer */ }
    return data;
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }
  function icon() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON);
    svg.appendChild(path);
    return svg;
  }

  // c: the settings; options.mount: draw inside this element (the Settings preview) instead of
  // the page's corner; options.preview: no beacon; options.open: the card shown at once.
  function render(c, options) {
    options = options || {};
    var words = TEXT[c.language] || TEXT.en;
    var color = /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? c.color : '#25D366';
    var ink = inkOn(color);
    var side = c.position === 'left' ? 'left' : 'right';
    var host = document.createElement('div');
    host.setAttribute('data-yellow-crm-whatsapp', '');
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var css = el('style');
    css.textContent = ':host{all:initial}'
      + '.wrap{position:' + (options.mount ? 'absolute' : 'fixed') + ';bottom:20px;' + side + ':20px;z-index:2147483000;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;font-size:14px;line-height:1.45;color:#111;text-align:left}'
      + '.fab{width:56px;height:56px;border-radius:50%;border:0;padding:0;margin:0;background:' + color + ';color:' + ink + ';box-shadow:0 6px 18px rgba(0,0,0,.24);cursor:pointer;display:flex;align-items:center;justify-content:center}'
      + '.fab svg{width:28px;height:28px;fill:currentColor}'
      + 'button:focus-visible{outline:3px solid #1a73e8;outline-offset:2px}'
      + '.card{position:absolute;bottom:70px;' + side + ':0;width:300px;max-width:calc(100vw - 40px);background:#fff;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.24);overflow:hidden}'
      + '.card[hidden]{display:none}'
      + '.head{background:' + color + ';color:' + ink + ';padding:12px 14px;display:flex;gap:10px;align-items:center}'
      + '.avatar{width:40px;height:40px;border-radius:50%;flex:none;background:rgba(255,255,255,.35);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;overflow:hidden}'
      + '.avatar img{width:100%;height:100%;object-fit:cover}'
      + '.who{min-width:0;flex:1}.name{font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.status{font-size:12px;display:flex;gap:6px;align-items:center}.dot{width:8px;height:8px;border-radius:50%;flex:none;background:#1f9d55;box-shadow:0 0 0 2px rgba(255,255,255,.7)}.dot.away{background:#9a9a9a}'
      + '.close{background:none;border:0;color:inherit;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:22px;line-height:1;flex:none}'
      + '.body{background:#efeae2;padding:16px 14px}'
      + '.bubble{background:#fff;color:#111;border-radius:0 10px 10px 10px;padding:9px 12px;max-width:85%;box-shadow:0 1px 1px rgba(0,0,0,.1);white-space:pre-wrap;overflow-wrap:anywhere}'
      + '.foot{padding:12px 14px;background:#fff}'
      + '.go{display:flex;width:100%;gap:8px;align-items:center;justify-content:center;border:0;border-radius:999px;padding:11px 16px;background:' + color + ';color:' + ink + ';font:inherit;font-weight:600;cursor:pointer}'
      + '.go svg{width:18px;height:18px;fill:currentColor}'
      + '@media (max-width:480px){.wrap{bottom:16px;' + side + ':16px}.card{width:calc(100vw - 32px)}}';
    root.appendChild(css);

    var wrap = el('div', 'wrap');
    var card = el('div', 'card');
    card.hidden = true;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', words.open);
    var head = el('div', 'head');
    var avatar = el('div', 'avatar');
    var title = c.agentName || c.name || '';
    if (/^https:\/\//.test(c.agentPhotoUrl || '')) {
      var photo = el('img');
      photo.alt = '';
      photo.src = c.agentPhotoUrl;
      avatar.appendChild(photo);
    } else {
      avatar.textContent = title.split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('') || '?';
    }
    var who = el('div', 'who');
    who.appendChild(el('div', 'name', title));
    var now = status(c, words);
    var line = el('div', 'status');
    line.appendChild(el('span', 'dot' + (now.open ? '' : ' away')));
    line.appendChild(el('span', '', now.text));
    who.appendChild(line);
    var close = el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', words.close);
    head.appendChild(avatar);
    head.appendChild(who);
    head.appendChild(close);
    var body = el('div', 'body');
    if (c.greeting) body.appendChild(el('div', 'bubble', c.greeting));
    var foot = el('div', 'foot');
    var go = el('button', 'go');
    go.type = 'button';
    go.appendChild(icon());
    go.appendChild(el('span', '', words.chat));
    foot.appendChild(go);
    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(foot);

    var fab = el('button', 'fab');
    fab.type = 'button';
    fab.setAttribute('aria-label', words.open);
    fab.setAttribute('aria-expanded', 'false');
    fab.appendChild(icon());
    function toggle(open) {
      card.hidden = !open;
      fab.setAttribute('aria-expanded', String(open));
      if (open) go.focus();
    }
    fab.addEventListener('click', function () { toggle(card.hidden); });
    close.addEventListener('click', function () { toggle(false); fab.focus(); });
    root.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !card.hidden) { toggle(false); fab.focus(); } });
    go.addEventListener('click', function () {
      var code = refCode();
      var text = (c.message ? c.message + '\n\n' : '') + 'Ref: ' + code;
      if (!options.preview && c.clickUrl) {
        var data = visit();
        data.code = code;
        var form = new URLSearchParams();
        Object.keys(data).forEach(function (k) { form.append(k, data[k]); });
        try {
          if (!(navigator.sendBeacon && navigator.sendBeacon(c.clickUrl, form))) fetch(c.clickUrl, { method: 'POST', body: form, keepalive: true, mode: 'no-cors' });
        } catch (e) { /* the chat still opens */ }
      }
      window.open('https://wa.me/' + c.phone + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
    });
    wrap.appendChild(card);
    wrap.appendChild(fab);
    root.appendChild(wrap);
    if (options.open) {
      card.hidden = false;
      fab.setAttribute('aria-expanded', 'true');
    }
    (options.mount || document.body).appendChild(host);
    return host;
  }

  window.YellowCrmWhatsAppButton = { render: render, config: cfg };
  // Loaded by the Settings preview (data-preview): only the drawing function.
  if (script && script.hasAttribute('data-preview')) return;
  if (document.body) render(cfg);
  else document.addEventListener('DOMContentLoaded', function () { render(cfg); });
}
/* eslint-enable */

// The script for one button: the browser code with its settings.
function scriptFor(config) {
  // "<" as < keeps the JSON from ever closing a <script> tag.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `/* YELLOW CRM WhatsApp button */\n(${browser.toString()})(${json}, document.currentScript);\n`;
}

// The ref code in a customer's message ("Ref: 7K2Q9X"), or ''.
const REF_PATTERN = /(?:^|\s)Ref:\s*([2-9A-HJ-NP-Z]{6})(?=$|[\s.,!)\]])/i;
function refCodeIn(text) {
  const match = String(text || '').match(REF_PATTERN);
  return match ? match[1].toUpperCase() : '';
}

module.exports = { scriptFor, refCodeIn, REF_PATTERN, browser };
