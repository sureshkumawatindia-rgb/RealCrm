const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NAME_PATTERN } = require('./localDisk');

// The one-time copy of the disk's files to R2 (F5, scripts/files-to-r2.js). Documents keep their
// key under "documents/", logos their name under "logos/". A file already there with the same
// size and content is left alone; every copied file is checked after the copy. check = only
// compare. The report counts each file once; nothing on the disk is changed.

async function listLocal(documentDir, uploadDir) {
  const files = [];
  const documents = path.resolve(documentDir);
  for (const organization of await fs.promises.readdir(documents).catch(() => [])) {
    if (!/^[a-f0-9]{24}$/.test(organization)) continue;
    for (const name of await fs.promises.readdir(path.join(documents, organization)).catch(() => [])) {
      if (/^[a-f0-9]{32}$/.test(name)) files.push({ file: path.join(documents, organization, name), key: `documents/${organization}/${name}` });
    }
  }
  const uploads = path.resolve(uploadDir);
  for (const name of await fs.promises.readdir(uploads).catch(() => [])) {
    if (NAME_PATTERN.test(name) && (await fs.promises.stat(path.join(uploads, name))).isFile()) files.push({ file: path.join(uploads, name), key: `logos/${name}` });
  }
  return files;
}

const digest = (algorithm, buffer) => crypto.createHash(algorithm).update(buffer).digest('hex');

async function sameInR2(client, bucket, key, buffer) {
  const head = await client.headObject(bucket, key);
  if (!head || head.size !== buffer.length) return false;
  if (head.etag === digest('md5', buffer)) return true;
  const remote = await client.getBuffer(bucket, key); // an ETag that is not the MD5: compare the bytes
  return Boolean(remote) && digest('sha256', remote) === digest('sha256', buffer);
}

async function copyToR2({ client, bucket, documentDir, uploadDir, check = false, log = () => {} }) {
  const report = { files: 0, alreadyThere: 0, copied: 0, missing: [], failed: [] };
  for (const { file, key } of await listLocal(documentDir, uploadDir)) {
    report.files += 1;
    try {
      const buffer = await fs.promises.readFile(file);
      if (await sameInR2(client, bucket, key, buffer)) {
        report.alreadyThere += 1;
        continue;
      }
      if (check) {
        report.missing.push(key);
        continue;
      }
      await client.putObject(bucket, key, buffer);
      if (await sameInR2(client, bucket, key, buffer)) {
        report.copied += 1;
        log(`copied ${key}`);
      } else {
        report.failed.push(key);
      }
    } catch (error) {
      report.failed.push(`${key}: ${error.message}`);
    }
  }
  report.ok = !report.missing.length && !report.failed.length;
  return report;
}

module.exports = { copyToR2, listLocal };
