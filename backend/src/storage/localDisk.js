const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Keys are made here ("<organization id>/<32 hex characters>") and never contain anything the
// browser sent, so a key can never point outside the storage folder. Files have no extension,
// so the development server (nodemon) does not restart when one is written.
const KEY_PATTERN = /^[a-f0-9]{24}\/[a-f0-9]{32}$/;

function createLocalDiskStorage(rootDir) {
  const root = path.resolve(rootDir);

  function fullPath(key) {
    if (!KEY_PATTERN.test(key || '')) throw new Error('Invalid storage key');
    return path.join(root, ...key.split('/'));
  }

  return {
    // Saves the bytes and returns the new key.
    async put(organizationId, buffer) {
      const key = `${String(organizationId)}/${crypto.randomBytes(16).toString('hex')}`;
      const file = fullPath(key);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, buffer, { flag: 'wx' });
      return key;
    },

    // A read stream, or null when the file is gone.
    async open(key) {
      const file = fullPath(key);
      try {
        await fs.promises.access(file, fs.constants.R_OK);
      } catch {
        return null;
      }
      return fs.createReadStream(file);
    },

    async remove(key) {
      if (!key) return;
      await fs.promises.rm(fullPath(key), { force: true });
    },
  };
}

module.exports = { createLocalDiskStorage };
