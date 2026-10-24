const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Keys are made here ("<organization id>/<32 hex characters>") and never contain anything the
// browser sent, so a key can never point outside the storage folder. Files have no extension,
// so the development server (nodemon) does not restart when one is written.
const KEY_PATTERN = /^[a-f0-9]{24}\/[a-f0-9]{32}$/;
// Logos keep a file name made by the CRM ("<organization id>-<uuid>.png"): letters, digits,
// dots, dashes and underscores only, so it stays inside its folder too.
const NAME_PATTERN = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

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

    // Every file of one organization (its folder), when the organization is deleted.
    async removeOrganization(organizationId) {
      const id = String(organizationId);
      if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid organization id');
      await fs.promises.rm(path.join(root, id), { recursive: true, force: true });
    },
  };
}

// Files kept by name in one folder (the logos in UPLOAD_DIR), F5.
function createLocalNamedStorage(rootDir) {
  const root = path.resolve(rootDir);

  function fullPath(name) {
    if (!NAME_PATTERN.test(name || '')) throw new Error('Invalid file name');
    return path.join(root, name);
  }

  return {
    async put(name, buffer) {
      await fs.promises.mkdir(root, { recursive: true });
      await fs.promises.writeFile(fullPath(name), buffer);
    },
    async open(name) {
      const file = fullPath(name);
      try {
        await fs.promises.access(file, fs.constants.R_OK);
      } catch {
        return null;
      }
      return fs.createReadStream(file);
    },
    async read(name) {
      try {
        return await fs.promises.readFile(fullPath(name));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async remove(name) {
      if (!name) return;
      await fs.promises.rm(fullPath(name), { force: true });
    },
  };
}

module.exports = { createLocalDiskStorage, createLocalNamedStorage, KEY_PATTERN, NAME_PATTERN };
