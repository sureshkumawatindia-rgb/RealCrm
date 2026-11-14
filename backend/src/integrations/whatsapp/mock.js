const crypto = require('crypto');
const zlib = require('zlib');
const httpError = require('../../utils/httpError');
const { normalizeTemplate } = require('./metaCloud');

// Stand-in for the Cloud API while there is no Meta account (development and tests only; the
// server refuses mock numbers in production). Nothing leaves this computer.

// --- sample files for simulated incoming photos, documents and voice notes ---
function samplePng(size = 96) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const stripe = Math.floor((x + y) / 12) % 2 === 0;
      row.set(stripe ? [255, 216, 77] : [37, 211, 102], 1 + x * 3); // yellow / WhatsApp green
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function samplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const text = 'BT /F1 18 Tf 24 80 Td (Sample document) Tj ET';
  objects[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// One second of a soft 440 Hz tone (16-bit mono WAV).
function sampleWav() {
  const rate = 8000;
  const samples = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i += 1) samples.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

const SAMPLE_FILES = {
  image: { mimeType: 'image/png', make: samplePng },
  document: { mimeType: 'application/pdf', make: samplePdf },
  audio: { mimeType: 'audio/wav', make: sampleWav },
};
const sampleCache = {};
function sampleFile(type) {
  const sample = SAMPLE_FILES[type];
  if (!sample) return null;
  sampleCache[type] = sampleCache[type] || sample.make();
  return { buffer: sampleCache[type], mimeType: sample.mimeType };
}
// Media ids the simulator hands out: "mock-media-<type>-<random>".
const mockMediaId = (type) => `mock-media-${type}-${crypto.randomBytes(8).toString('hex')}`;
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// --- templates: a few samples, plus the ones created while the server runs ---
const SAMPLE_TEMPLATES = [
  {
    id: 'mock-tpl-hello', name: 'hello_world', language: 'en_US', status: 'APPROVED', category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Hello World' },
      { type: 'BODY', text: 'Welcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API, hosted by Meta.' },
      { type: 'FOOTER', text: 'WhatsApp Business Platform sample message' },
    ],
  },
  {
    id: 'mock-tpl-order', name: 'order_update', language: 'en', status: 'APPROVED', category: 'UTILITY',
    components: [
      { type: 'BODY', text: 'Namaste {{1}}, your order {{2}} has been dispatched. We will share the tracking details soon.', example: { body_text: [['Ravi', '#45']] } },
      { type: 'FOOTER', text: 'Reply STOP to stop updates' },
    ],
  },
  {
    id: 'mock-tpl-followup', name: 'quote_follow_up', language: 'hi', status: 'APPROVED', category: 'MARKETING', parameter_format: 'NAMED',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Quotation for {{product}}', example: { header_text_named_params: [{ param_name: 'product', example: 'Cumin 25kg' }] } },
      {
        type: 'BODY', text: 'Namaste {{customer_name}} ji, humne aapko quotation bheja tha. Koi sawal ho to reply karein.',
        example: { body_text_named_params: [{ param_name: 'customer_name', example: 'Ravi' }] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Interested' }, { type: 'QUICK_REPLY', text: 'Not now' }] },
    ],
  },
  {
    id: 'mock-tpl-quotation', name: 'quotation_pdf', language: 'en', status: 'APPROVED', category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'DOCUMENT', example: { header_handle: ['4::mock-sample-quotation-pdf'] } },
      { type: 'BODY', text: 'Namaste {{1}}, please find our quotation {{2}} for {{3}} attached. Reply here if you have any question.', example: { body_text: [['Ravi', 'QT/2026-27/0001', '₹12,713.00']] } },
      { type: 'FOOTER', text: 'Thank you' },
    ],
  },
  {
    id: 'mock-tpl-diwali', name: 'diwali_offer', language: 'en', status: 'REJECTED', category: 'MARKETING', rejected_reason: 'INVALID_FORMAT',
    components: [{ type: 'BODY', text: 'Flat 20% off this Diwali!' }],
  },
];
const createdTemplates = new Map(); // phone number id → templates created on it
const createdFlows = new Map(); // G6: flow id → { flowId, phoneNumberId, name, categories, flowJson, status }
const callActions = []; // G7: what the CRM asked of calls ({ phoneNumberId, callId, action, sdp, to })
const callSettings = new Map(); // G7: phone number id → { enabled, callbackPermission }

// G7 (D111): a well-formed audio set-up (SDP, OPUS) for the simulator's calls, so a browser can
// answer a simulated call or hear a simulated answer (no sound flows: nobody is on the other end).
function sampleSdp(type = 'offer') {
  const fingerprint = crypto.randomBytes(32).toString('hex').toUpperCase().match(/../g).join(':');
  return [
    'v=0', `o=- ${Date.now()} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${crypto.randomBytes(4).toString('hex')}`, `a=ice-pwd:${crypto.randomBytes(12).toString('hex')}`,
    `a=fingerprint:sha-256 ${fingerprint}`, `a=setup:${type === 'offer' ? 'actpass' : 'active'}`, 'a=mid:0', 'a=sendrecv', 'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', '',
  ].join('\r\n');
}

// G6 (D110): what Meta would refuse in a form (a few of its Flow JSON checks).
function flowProblems(flowJson) {
  const problems = [];
  const screens = Array.isArray(flowJson?.screens) ? flowJson.screens : [];
  if (!flowJson?.version || !screens.length) problems.push('The Flow JSON needs a version and a screen.');
  for (const screen of screens) {
    const children = screen?.layout?.children || [];
    const footer = children.find((c) => c.type === 'Footer');
    if (screen.terminal && footer?.['on-click-action']?.name !== 'complete') problems.push('The last screen needs a Footer that completes.');
    for (const c of children) {
      const limit = c.type === 'DatePicker' ? 40 : 20;
      if (c.label && ['TextInput', 'TextArea', 'Dropdown', 'DatePicker'].includes(c.type) && c.label.length > limit) problems.push(`"${c.label}" is longer than ${limit} characters.`);
      if (c.type === 'Dropdown' && !(c['data-source'] || []).length) problems.push('A dropdown needs options.');
    }
  }
  return problems;
}

// D151: pretend Meta is in trouble (the developer tools, the browser tests).
let trouble = false;
let troubleUsed = false;

module.exports = {
  async getPhoneNumber() {
    return { displayPhone: '+91 90000 00000', verifiedName: 'Test Business (mock)', qualityRating: 'GREEN', messagingLimit: 'TIER_250' };
  },

  setTrouble(on) {
    trouble = Boolean(on);
    troubleUsed = true;
  },

  async sendMessage() {
    if (trouble) {
      require('../../services/serviceStatusService').record('whatsapp', false, 'test number: simulated trouble'); // eslint-disable-line global-require
      throw Object.assign(httpError(502, 'WHATSAPP_UNREACHABLE', 'Could not reach WhatsApp (Meta). Check the internet connection and try again.'), { temporary: true });
    }
    if (troubleUsed) require('../../services/serviceStatusService').record('whatsapp', true); // eslint-disable-line global-require
    return { providerMessageId: `wamid.MOCK${crypto.randomBytes(12).toString('hex')}` };
  },

  async markRead() {
    return { success: true };
  },

  async listTemplates({ phoneNumberId }) {
    return [...SAMPLE_TEMPLATES, ...(createdTemplates.get(phoneNumberId) || [])].map(normalizeTemplate);
  },

  // Test numbers approve a new template at once, so it can be tried straight away.
  async createTemplate({ phoneNumberId }, body) {
    const list = createdTemplates.get(phoneNumberId) || [];
    const all = [...SAMPLE_TEMPLATES, ...list];
    if (all.some((t) => t.name === body.name && t.language === body.language)) {
      throw httpError(400, 'WHATSAPP_ERROR', 'A template with this name and language already exists.');
    }
    const template = { ...body, id: `mock-tpl-${crypto.randomBytes(6).toString('hex')}`, status: 'APPROVED' };
    createdTemplates.set(phoneNumberId, [...list, template]);
    return { providerTemplateId: template.id, status: 'APPROVED', category: body.category };
  },

  async deleteTemplate({ phoneNumberId }, { name, providerTemplateId }) {
    const list = createdTemplates.get(phoneNumberId) || [];
    createdTemplates.set(phoneNumberId, list.filter((t) => !(t.name === name && (!providerTemplateId || t.id === providerTemplateId))));
  },

  // G6: a test number publishes a well-formed form at once; one Meta would refuse stays a draft.
  async createFlow({ phoneNumberId }, { name, categories, flowJson }) {
    const problems = flowProblems(flowJson);
    const flowId = `mock-flow-${crypto.randomBytes(6).toString('hex')}`;
    const status = problems.length ? 'DRAFT' : 'PUBLISHED';
    createdFlows.set(flowId, { flowId, phoneNumberId, name, categories, flowJson, status });
    return { flowId, status, problems };
  },
  async deprecateFlow(credentials, flowId) {
    const flow = createdFlows.get(flowId);
    if (flow) flow.status = 'DEPRECATED';
  },
  async deleteFlow(credentials, flowId) {
    createdFlows.delete(flowId);
  },
  flows: () => [...createdFlows.values()],

  // G7 (D111): a test number takes every call action; the simulator plays the customer.
  async setCalling({ phoneNumberId }, { enabled, callbackPermission }) {
    callSettings.set(phoneNumberId, { enabled: Boolean(enabled), callbackPermission: Boolean(callbackPermission) });
  },
  async callAction({ phoneNumberId }, { callId, action, sdp }) {
    callActions.push({ phoneNumberId, callId, action, sdp: sdp || '' });
  },
  async startCall({ phoneNumberId }, { to, sdp, tag }) {
    const callId = `wacid.MOCK${crypto.randomBytes(12).toString('hex')}`;
    callActions.push({ phoneNumberId, callId, action: 'connect', sdp, to, tag: tag || '' });
    return { callId };
  },
  callActions: () => [...callActions],
  callSettings: (phoneNumberId) => callSettings.get(phoneNumberId) || null,
  sampleSdp,

  // A pretend catalog: any id works, and every product is accepted.
  async getCatalog(credentials, catalogId) {
    return { catalogId: String(catalogId), name: 'Test catalog (mock)', productCount: 0 };
  },
  async catalogBatch(credentials, catalogId, requests) {
    return { handles: [`mock-handle-${requests.length}`], problems: [] };
  },
  async setCommerceSettings() {},

  // D103: a test number blocks and unblocks anyone.
  async blockUsers(credentials, users) {
    return { done: users.map((user) => ({ input: user, wa_id: user })), failed: [] };
  },

  async uploadMedia() {
    return { mediaId: `mock-media-upload-${crypto.randomBytes(8).toString('hex')}` };
  },

  async getMedia(credentials, mediaId) {
    const type = /^mock-media-([a-z]+)-/.exec(mediaId)?.[1];
    const file = sampleFile(type);
    if (!file) {
      throw httpError(404, 'MEDIA_UNAVAILABLE', 'WhatsApp no longer has this file.');
    }
    return { url: `https://mock.invalid/media/${mediaId}`, mimeType: file.mimeType, sha256: sha256(file.buffer), sizeBytes: file.buffer.length };
  },

  async downloadMedia(credentials, url) {
    const type = /\/media\/mock-media-([a-z]+)-/.exec(url)?.[1];
    return sampleFile(type);
  },

  mockMediaId,
  sampleFile,
};
