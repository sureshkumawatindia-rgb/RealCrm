const QRCode = require('qrcode');
const httpError = require('../utils/httpError');
const accountService = require('./whatsappAccountService');

// Click-to-chat: a wa.me link (and its QR code) that opens a WhatsApp chat with one of the
// organization's numbers, optionally with a message already typed. WhatsApp Help Center
// "How to use click to chat": https://wa.me/<number in international format, digits only>?text=<URL-encoded>.
const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 2, color: { dark: '#111111', light: '#ffffff' } };

async function link(req, { accountId, text = '' } = {}) {
  const account = accountId
    ? await accountService.findInOrg(req, accountId)
    : await accountService.defaultAccount(req.tenant.organizationId);
  if (!account) throw httpError(400, 'NO_WHATSAPP_NUMBER', 'Add a WhatsApp number in Settings → WhatsApp first.');
  const digits = String(account.displayPhone || '').replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw httpError(400, 'NO_DISPLAY_PHONE', 'The phone number of this WhatsApp number is not known yet. Press "Test" on it in Settings → WhatsApp.');
  }
  const url = `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
  const svg = await QRCode.toString(url, { ...QR_OPTIONS, type: 'svg' });
  return {
    accountId: account._id,
    phone: `+${digits}`,
    link: url,
    qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  };
}

// A print-quality PNG of the same QR code.
async function png(req, query) {
  const { link: url } = await link(req, query);
  return QRCode.toBuffer(url, { ...QR_OPTIONS, type: 'png', width: 800 });
}

module.exports = { link, png };
