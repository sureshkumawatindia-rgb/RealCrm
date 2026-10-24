const crypto = require('crypto');
const zlib = require('zlib');
const { Readable, pipeline } = require('stream');
const mongoose = require('mongoose');
const env = require('../config/env');
const logger = require('../config/logger');
const { r2Client } = require('../storage');

// The weekly extra copy of the database on R2 (F4a): a copy outside Atlas, in its own bucket
// (R2_BACKUP_BUCKET), every Sunday at 2:30 in India. Each collection is one file:
// one document per line (Extended JSON, so ids and dates come back as they were), gzipped and
// encrypted with AES-256-GCM under a key made from DATA_ENCRYPTION_KEY (so the bucket alone
// reveals nothing; that key is needed to read a backup). A manifest with each file's count, size
// and SHA-256 is written last: a backup without it is incomplete. The newest
// BACKUP_KEEP_WEEKS backups are kept.

const JOB = 'backup.weekly';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FORMAT = 'yellow-crm-backup/1';
const MAGIC = Buffer.from('CRMBK1\n');
const { EJSON } = mongoose.mongo.BSON;

const configured = () => Boolean(env.storage.r2.backupBucket && env.storage.r2.accessKeyId && env.storage.r2.secretAccessKey && (env.storage.r2.accountId || env.storage.r2.endpoint));

function backupKey() {
  const secret = env.dataEncryptionKey || env.gmailTokenEncryptionKey;
  if (!secret) throw new Error('DATA_ENCRYPTION_KEY is needed to encrypt backups');
  return {
    key: Buffer.from(crypto.hkdfSync('sha256', secret, 'yellow-crm', 'backup v1', 32)),
    from: env.dataEncryptionKey ? 'DATA_ENCRYPTION_KEY' : 'GMAIL_TOKEN_ENCRYPTION_KEY',
  };
}

// A day in India as YYYY-MM-DD.
const indiaDay = (date) => new Date(date.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

// The next Sunday 02:30 in India (21:00 UTC on Saturday).
function nextRun(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(21, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + ((6 - next.getUTCDay() + 7) % 7));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

// One collection: lines → gzip → AES-256-GCM, as chunks (header, ciphertext, then the tag).
async function* encryptedLines(collection, key, counter) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const lines = Readable.from((async function* lines() {
    for await (const doc of collection.find({}, { batchSize: 500 })) {
      counter.count += 1;
      yield `${EJSON.stringify(doc, { relaxed: false })}\n`;
    }
  })());
  yield Buffer.concat([MAGIC, iv]);
  // pipeline: a database error ends the loop with that error instead of leaving it waiting.
  for await (const chunk of pipeline(lines, zlib.createGzip(), cipher, () => {})) yield chunk;
  yield cipher.getAuthTag();
}

// A backup file's documents (as EJSON lines); throws when the file was changed or the key is wrong.
function decryptFile(buffer, key) {
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a YELLOW CRM backup file');
  const iv = buffer.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buffer.subarray(buffer.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(buffer.subarray(MAGIC.length + 12, buffer.length - 16)), decipher.final()]);
  return zlib.gunzipSync(plain).toString('utf8').split('\n').filter(Boolean);
}

async function run({ now = new Date(), client = r2Client() } = {}) {
  if (!configured()) return { skipped: 'R2_BACKUP_BUCKET is not set' };
  const bucket = env.storage.r2.backupBucket;
  const { key, from } = backupKey();
  const day = indiaDay(now);
  const prefix = `backups/${day}/`;
  const names = (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name).filter((name) => !name.startsWith('system.')).sort();
  const collections = [];
  for (const name of names) {
    const counter = { count: 0 };
    const file = `${prefix}${name}.ndjson.gz.enc`;
    const { bytes, sha256 } = await client.putStream(bucket, file, encryptedLines(mongoose.connection.db.collection(name), key, counter), { contentType: 'application/octet-stream' });
    collections.push({ name, file, count: counter.count, bytes, sha256 });
  }
  const manifest = { format: FORMAT, createdAt: now.toISOString(), environment: env.appEnv, version: env.release || null, encryption: { cipher: 'aes-256-gcm', keyFrom: from }, collections };
  await client.putObject(bucket, `${prefix}manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), { contentType: 'application/json' });
  const removed = await prune(client, bucket, env.storage.backupKeepWeeks);
  logger.info(`Backup ${day}: ${collections.length} collections, ${collections.reduce((n, c) => n + c.count, 0)} documents; ${removed.length} old backups removed`);
  return { day, collections: collections.length, documents: collections.reduce((n, c) => n + c.count, 0), removed };
}

// The backups (days), newest first, and whether each is complete (has its manifest).
async function list({ client = r2Client() } = {}) {
  const items = await client.listObjects(env.storage.r2.backupBucket, 'backups/');
  const days = new Map();
  for (const item of items) {
    const [, day, rest] = /^backups\/(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(item.key) || [];
    if (!day) continue;
    const entry = days.get(day) || { day, files: 0, bytes: 0, complete: false, keys: [] };
    entry.files += 1;
    entry.bytes += item.size;
    entry.keys.push(item.key);
    if (rest === 'manifest.json') entry.complete = true;
    days.set(day, entry);
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

async function prune(client, bucket, keep) {
  const removed = [];
  for (const old of (await list({ client })).slice(keep)) {
    for (const key of old.keys) await client.deleteObject(bucket, key);
    removed.push(old.day);
  }
  return removed;
}

// Reads a backup back (F4a): every file is downloaded, decrypted and counted against the manifest.
async function check(day, { client = r2Client() } = {}) {
  const bucket = env.storage.r2.backupBucket;
  const manifestBytes = await client.getBuffer(bucket, `backups/${day}/manifest.json`);
  if (!manifestBytes) return { day, ok: false, problems: ['no manifest: the backup is missing or incomplete'] };
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const { key } = backupKey();
  const problems = [];
  let documents = 0;
  for (const entry of manifest.collections) {
    const buffer = await client.getBuffer(bucket, entry.file);
    if (!buffer) {
      problems.push(`${entry.name}: file missing`);
      continue;
    }
    if (crypto.createHash('sha256').update(buffer).digest('hex') !== entry.sha256) problems.push(`${entry.name}: file changed`);
    try {
      const lines = decryptFile(buffer, key);
      if (lines.length !== entry.count) problems.push(`${entry.name}: ${lines.length} documents, the manifest says ${entry.count}`);
      documents += lines.length;
    } catch (error) {
      problems.push(`${entry.name}: cannot be read (${error.message})`);
    }
  }
  return { day, ok: !problems.length, collections: manifest.collections.length, documents, problems };
}

function register(queue) {
  queue.define(JOB, () => run(), { maxAttempts: 3 });
  if (configured()) {
    queue.every(JOB, WEEK_MS, {}, { firstRunAt: nextRun() }).catch((error) => logger.error(`Scheduling ${JOB} failed: ${error.message}`));
  } else {
    queue.cancel(JOB).catch(() => {});
  }
}

module.exports = { JOB, run, list, check, register, nextRun, decryptFile, backupKey, configured };
