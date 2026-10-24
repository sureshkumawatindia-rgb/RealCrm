const env = require('../config/env');
const { createLocalDiskStorage, createLocalNamedStorage } = require('./localDisk');
const { createR2Client } = require('./r2Client');
const { createR2DocumentStorage, createR2NamedStorage, withDiskFallback } = require('./r2');

// Private file storage (F5): documents, WhatsApp media and attachments by key; the companies'
// logos by file name. STORAGE_DRIVER=disk keeps them in DOCUMENT_DIR and UPLOAD_DIR on this
// server; r2 keeps them on Cloudflare R2, so more than one server can run. With r2, a file not
// found there is read from the disk folders (STORAGE_DISK_FALLBACK, on until the copy is done).

const r2Client = () => createR2Client(env.storage.r2);

function build() {
  const disk = { documents: createLocalDiskStorage(env.documentDir), logos: createLocalNamedStorage(env.uploadDir) };
  if (env.storage.driver !== 'r2') return disk;
  const client = r2Client();
  const r2 = {
    documents: createR2DocumentStorage({ client, bucket: env.storage.r2.bucket }),
    logos: createR2NamedStorage({ client, bucket: env.storage.r2.bucket }),
  };
  if (!env.storage.diskFallback) return r2;
  return { documents: withDiskFallback(r2.documents, disk.documents), logos: withDiskFallback(r2.logos, disk.logos) };
}

let current = build();

const documentStorage = {
  put: (...args) => current.documents.put(...args),
  open: (...args) => current.documents.open(...args),
  remove: (...args) => current.documents.remove(...args),
  removeOrganization: (...args) => current.documents.removeOrganization(...args),
};
const logoStorage = {
  put: (...args) => current.logos.put(...args),
  open: (...args) => current.logos.open(...args),
  read: (...args) => current.logos.read(...args),
  remove: (...args) => current.logos.remove(...args),
};

// Tests swap in another storage for a while; returns the function that puts the old one back.
function useStorage(next) {
  const previous = current;
  current = { ...current, ...next };
  return () => {
    current = previous;
  };
}

module.exports = { documentStorage, logoStorage, useStorage, r2Client };
