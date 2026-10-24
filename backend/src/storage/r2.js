const crypto = require('crypto');
const { KEY_PATTERN, NAME_PATTERN } = require('./localDisk');

// Files on Cloudflare R2 (F5), with the same functions as the disk folders, so nothing else
// changes. Documents keep their key ("<organization id>/<32 hex>") under "documents/", so a key
// saved before the move finds its copied file; logos keep their file name under "logos/".

function createR2DocumentStorage({ client, bucket, prefix = 'documents/' }) {
  const objectKey = (key) => {
    if (!KEY_PATTERN.test(key || '')) throw new Error('Invalid storage key');
    return `${prefix}${key}`;
  };
  return {
    async put(organizationId, buffer) {
      const key = `${String(organizationId)}/${crypto.randomBytes(16).toString('hex')}`;
      await client.putObject(bucket, objectKey(key), buffer);
      return key;
    },
    open: (key) => client.getObject(bucket, objectKey(key)),
    async remove(key) {
      if (!key) return;
      await client.deleteObject(bucket, objectKey(key));
    },
    async removeOrganization(organizationId) {
      const id = String(organizationId);
      if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid organization id');
      for (const item of await client.listObjects(bucket, `${prefix}${id}/`)) await client.deleteObject(bucket, item.key);
    },
  };
}

function createR2NamedStorage({ client, bucket, prefix = 'logos/' }) {
  const objectKey = (name) => {
    if (!NAME_PATTERN.test(name || '')) throw new Error('Invalid file name');
    return `${prefix}${name}`;
  };
  return {
    async put(name, buffer, { contentType } = {}) {
      await client.putObject(bucket, objectKey(name), buffer, { contentType });
    },
    open: (name) => client.getObject(bucket, objectKey(name)),
    read: (name) => client.getBuffer(bucket, objectKey(name)),
    async remove(name) {
      if (!name) return;
      await client.deleteObject(bucket, objectKey(name));
    },
  };
}

// While files are being copied from the disk (F5): R2 first, then the disk folder.
function withDiskFallback(primary, disk) {
  const fallback = {
    async open(key) {
      return (await primary.open(key)) ?? disk.open(key);
    },
    async remove(key) {
      await primary.remove(key);
      await disk.remove(key).catch(() => {});
    },
  };
  if (primary.read) {
    fallback.read = async (name) => (await primary.read(name)) ?? disk.read(name);
  }
  if (primary.removeOrganization) {
    fallback.removeOrganization = async (organizationId) => {
      await primary.removeOrganization(organizationId);
      await disk.removeOrganization(organizationId).catch(() => {});
    };
  }
  return { ...primary, ...fallback };
}

module.exports = { createR2DocumentStorage, createR2NamedStorage, withDiskFallback };
