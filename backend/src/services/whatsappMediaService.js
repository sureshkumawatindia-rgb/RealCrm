const crypto = require('crypto');
const path = require('path');
const Message = require('../models/Message');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const httpError = require('../utils/httpError');
const logger = require('../config/logger');
const bus = require('../realtime/bus');
const { documentStorage } = require('../storage');
const { providerFor } = require('../integrations/whatsapp');
const { credentials } = require('./whatsappAccountService');
const { OUTBOUND_MEDIA, MEDIA_MAX_BYTES } = require('../constants/whatsapp');

// Photos, videos, voice notes and documents in chats. Incoming files are copied from WhatsApp
// into the CRM's private storage (WhatsApp keeps them only 7 days); outgoing files are kept
// there too, then uploaded to WhatsApp and sent. Files only leave the CRM through a signed-in
// download.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
const EXTENSION_BY_MIME = {
  ...Object.fromEntries(Object.entries(OUTBOUND_MEDIA).reverse().map(([ext, info]) => [info.mimeType, ext])),
  'image/webp': 'webp', 'audio/wav': 'wav', 'audio/opus': 'opus', 'image/jpeg': 'jpg',
};
const MB = 1024 * 1024;

const sha256Hex = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// Meta's hash is hex in the media API and base64 in webhooks; an unknown format is not checked.
function hashMatches(expected, buffer) {
  const value = String(expected || '').trim();
  if (!value) return true;
  const digest = crypto.createHash('sha256').update(buffer).digest();
  if (/^[a-f0-9]{64}$/i.test(value)) return digest.toString('hex') === value.toLowerCase();
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) return digest.toString('base64') === value;
  return true;
}

// The name a file gets when it is downloaded.
function fileNameOf(message) {
  if (message.media?.fileName) return message.media.fileName;
  const mime = String(message.media?.mimeType || '').split(';')[0].trim();
  const ext = EXTENSION_BY_MIME[mime] || 'bin';
  const stamp = new Date(message.providerTimestamp || message.createdAt || Date.now()).toISOString().slice(0, 10);
  return `whatsapp-${message.type}-${stamp}.${ext}`;
}

// The number a message came through, even if it was removed from Settings since.
const accountOf = (message) => WhatsAppAccount.findOne({ _id: message.whatsappAccountId, organizationId: message.organizationId, deletedAt: { $exists: true } });

// Copies an incoming file into storage. Returns the updated message; throws when WhatsApp
// cannot give the file.
async function storeInbound(message) {
  if (message.media?.storageKey || !message.media?.providerMediaId) return message;
  const account = await accountOf(message);
  if (!account) throw httpError(404, 'MEDIA_UNAVAILABLE', 'The WhatsApp number of this chat is gone, so the file cannot be fetched.');
  const provider = providerFor(account);
  const creds = credentials(account);
  const info = await provider.getMedia(creds, message.media.providerMediaId);
  if (info.sizeBytes && info.sizeBytes > MEDIA_MAX_BYTES) throw httpError(413, 'FILE_TOO_LARGE', 'This file is too big to keep in the CRM.');
  const { buffer, mimeType } = await provider.downloadMedia(creds, info.url, { maxBytes: MEDIA_MAX_BYTES });
  if (!hashMatches(info.sha256 || message.media.sha256, buffer)) throw httpError(502, 'MEDIA_CORRUPT', 'The file from WhatsApp did not match its checksum.');

  const storageKey = await documentStorage.put(message.organizationId, buffer);
  const updated = await Message.findOneAndUpdate(
    { _id: message._id, 'media.storageKey': { $exists: false } },
    {
      $set: {
        'media.storageKey': storageKey,
        'media.sizeBytes': buffer.length,
        'media.sha256': sha256Hex(buffer),
        'media.mimeType': message.media.mimeType || info.mimeType || mimeType || 'application/octet-stream',
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) {
    // Another request stored it at the same moment: keep theirs.
    await documentStorage.remove(storageKey);
    return Message.findById(message._id);
  }
  bus.emit('message:status', { organizationId: updated.organizationId, message: updated });
  return updated;
}

// Right after a message arrives. A failure is only logged: opening the file tries again.
async function storeInboundQuietly(message) {
  try {
    return await storeInbound(message);
  } catch (error) {
    logger.warn(`WhatsApp media for message ${message._id} not stored yet: ${error.message}`);
    return message;
  }
}

// A stream of the message's file, fetching it from WhatsApp first if needed.
async function open(message) {
  if (!message.media?.storageKey && !message.media?.providerMediaId) throw httpError(404, 'NOT_FOUND', 'This message has no file.');
  let current = message;
  if (!current.media.storageKey) {
    if (current.direction !== 'in') throw httpError(404, 'MEDIA_UNAVAILABLE', 'This file is no longer available.');
    try {
      current = await storeInbound(current);
    } catch (error) {
      if (error.statusCode === 413) throw error;
      throw httpError(404, 'MEDIA_UNAVAILABLE', 'WhatsApp no longer has this file (it keeps received files for 7 days).');
    }
  }
  const stream = await documentStorage.open(current.media.storageKey);
  if (!stream) throw httpError(404, 'MEDIA_UNAVAILABLE', 'The file is missing from storage.');
  return { stream, fileName: fileNameOf(current), mimeType: current.media.mimeType || 'application/octet-stream' };
}

// An uploaded file → what WhatsApp calls it, or a clear refusal.
function classify(file) {
  if (!file?.buffer?.length) throw httpError(400, 'VALIDATION_ERROR', 'Choose a file to send.', [{ field: 'file', code: 'REQUIRED', message: 'Choose a file to send.' }]);
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const info = OUTBOUND_MEDIA[ext];
  if (!info) {
    throw httpError(400, 'UNSUPPORTED_FILE', 'WhatsApp accepts photos (JPG, PNG), videos (MP4, 3GP), audio (MP3, OGG, AAC, AMR, M4A) and documents (PDF, Word, Excel, PowerPoint, TXT).');
  }
  if (file.buffer.length > info.maxBytes) {
    const label = { image: 'Photos', video: 'Videos', audio: 'Audio files', document: 'Documents' }[info.type];
    throw httpError(413, 'FILE_TOO_LARGE', `${label} can be up to ${info.maxBytes / MB} MB on WhatsApp.`);
  }
  return { ...info, fileName: path.basename(file.originalname).slice(0, 200) };
}

module.exports = { storeInbound, storeInboundQuietly, open, classify, fileNameOf, hashMatches, sha256Hex };
