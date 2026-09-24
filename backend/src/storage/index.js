const env = require('../config/env');
const { createLocalDiskStorage } = require('./localDisk');

// Private file storage for documents (later also WhatsApp media and quotation PDFs).
// Today: a folder on this computer. A cloud driver (S3 / Cloudflare R2) only needs the same
// put / open / remove functions, so nothing else changes when it is added.
const documentStorage = createLocalDiskStorage(env.documentDir);

module.exports = { documentStorage };
