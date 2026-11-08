const crypto = require('crypto');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');
const { Readable, pipeline } = require('stream');
const mongoose = require('mongoose');
const env = require('../config/env');
const logger = require('../config/logger');
const PlatformSetting = require('../models/PlatformSetting');
const errorReporter = require('./errorReporter');
const { r2Client } = require('../storage');

// The weekly extra copy of the database on R2 (F4a): a copy outside Atlas, in its own bucket
// (R2_BACKUP_BUCKET), every Sunday at 2:30 in India. Each collection is one file:
// one document per line (Extended JSON, so ids and dates come back as they were), gzipped and
// encrypted with AES-256-GCM under a key made from DATA_ENCRYPTION_KEY (so the bucket alone
// reveals nothing; that key is needed to read a backup). A manifest with each file's count, size
// and SHA-256 is written last: a backup without it is incomplete. The newest
// BACKUP_KEEP_WEEKS backups are kept.
//
// The restore drill (F4b, shown on the platform admin page since Phase 8, D120): the newest
// backup is put back into a separate, empty database next to the CRM's own (<name>_drill), every
// collection is counted against the manifest, and that database is dropped. Every four weeks by
// itself (Sunday 4:30 in India, after the backup), or from the platform admin page. Customers
// erased since a backup are noted in the backup bucket (erasures/…, ids only) so a restore of that
// backup can erase them again (node scripts/backup.js reapply-erasures <day>).

const JOB = 'backup.weekly';
const DRILL_JOB = 'backup.drill';
const DRILL_KEY = 'backupDrill';
const DRILL_EVERY_MS = 28 * 24 * 60 * 60 * 1000;
const DRILL_STALE_MS = 2 * 60 * 60 * 1000; // a drill "running" longer stopped with its server
const DAY_MS = 24 * 60 * 60 * 1000;
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

// A backup file's documents one line at a time, without holding the whole collection in memory
// (the restore of a big messages collection on a small server). The tag is checked at the end:
// a changed file or a wrong key throws then (or earlier, when the gzip cannot be read).
async function* fileLines(buffer, key) {
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a YELLOW CRM backup file');
  const iv = buffer.subarray(MAGIC.length, MAGIC.length + 12);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(buffer.subarray(buffer.length - 16));
  const source = Readable.from([buffer.subarray(MAGIC.length + 12, buffer.length - 16)]);
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of pipeline(source, decipher, zlib.createGunzip(), () => {})) {
    const lines = (rest + decoder.write(chunk)).split('\n');
    rest = lines.pop();
    for (const line of lines) if (line) yield line;
  }
  rest += decoder.end();
  if (rest) yield rest;
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
  await pruneErasures(client, bucket).catch((error) => logger.warn(`Old erasure notes could not be removed: ${error.message}`));
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

// The restore drill (F4b): a backup back into another, EMPTY database (never the CRM's own), and
// each collection counted against the manifest. targetUri: a temporary database's address;
// targetDb: a database handle (tests).
async function restore(day, { client = r2Client(), targetUri, targetDb } = {}) {
  const started = Date.now();
  if (!targetDb && (!targetUri || targetUri.trim() === env.mongoUri.trim())) throw new Error('Give the address of another, empty database to restore into');
  const bucket = env.storage.r2.backupBucket;
  const manifestBytes = await client.getBuffer(bucket, `backups/${day}/manifest.json`);
  if (!manifestBytes) throw new Error(`No complete backup for ${day}`);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const connection = targetDb ? null : await mongoose.createConnection(targetUri).asPromise();
  const db = targetDb || connection.db;
  try {
    const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).filter((c) => !c.name.startsWith('system.'));
    if (existing.length) throw new Error(`The database to restore into is not empty (${existing.length} collections): use a new, empty one`);
    const { key } = backupKey();
    const problems = [];
    let documents = 0;
    for (const entry of manifest.collections) {
      const buffer = await client.getBuffer(bucket, entry.file);
      if (!buffer) {
        problems.push(`${entry.name}: file missing`);
        continue;
      }
      if (crypto.createHash('sha256').update(buffer).digest('hex') !== entry.sha256) {
        problems.push(`${entry.name}: file changed`);
        continue;
      }
      // A thousand documents at a time (Phase 8: never the whole collection in memory).
      const collection = db.collection(entry.name);
      let batch = [];
      try {
        for await (const line of fileLines(buffer, key)) {
          batch.push(EJSON.parse(line, { relaxed: false }));
          if (batch.length === 1000) {
            await collection.insertMany(batch, { ordered: false });
            batch = [];
          }
        }
        if (batch.length) await collection.insertMany(batch, { ordered: false });
      } catch (error) {
        problems.push(`${entry.name}: cannot be read (${error.message})`);
        continue;
      }
      if (!entry.count) await db.createCollection(entry.name).catch(() => {});
      const count = await collection.countDocuments();
      if (count !== entry.count) problems.push(`${entry.name}: ${count} restored, the manifest says ${entry.count}`);
      documents += count;
    }
    return { day, ok: !problems.length, collections: manifest.collections.length, documents, problems, seconds: Math.round((Date.now() - started) / 1000), createdAt: manifest.createdAt };
  } finally {
    if (connection) await connection.close();
  }
}

// --- erasures since a backup (Phase 8, D120) ----------------------------------------------------

const ERASURES = 'erasures/';
// erasures/<day in India>/<organization>-<contact>-<when, ms>.json
const ERASURE_KEY = /^erasures\/(\d{4}-\d{2}-\d{2})\/([0-9a-f]{24})-([0-9a-f]{24})(?:-(\d+))?\.json$/;

// A customer erased (services/erasureService.js): a note in the backup bucket with the ids only.
async function markErased({ organizationId, contactIds, at = new Date() }, { client = r2Client() } = {}) {
  if (!configured()) return 0;
  const day = indiaDay(at);
  for (const contactId of contactIds) {
    const body = Buffer.from(JSON.stringify({ organizationId: String(organizationId), contactId: String(contactId), at: at.toISOString() }));
    await client.putObject(env.storage.r2.backupBucket, `${ERASURES}${day}/${organizationId}-${contactId}-${at.getTime()}.json`, body, { contentType: 'application/json' });
  }
  return contactIds.length;
}

// The customers erased on the day or after it (a backup of that day may still have them); with
// after (a backup's time), only those erased after it.
async function erasuresSince(day, { client = r2Client(), after } = {}) {
  const items = await client.listObjects(env.storage.r2.backupBucket, ERASURES);
  return items
    .map((item) => ERASURE_KEY.exec(item.key))
    .filter((m) => m && m[1] >= day && (!after || !m[4] || Number(m[4]) >= new Date(after).getTime()))
    .map(([, on, organizationId, contactId, ms]) => ({ day: on, organizationId, contactId, at: ms ? new Date(Number(ms)).toISOString() : null }));
}

// Notes older than the oldest backup kept are never needed again.
async function pruneErasures(client, bucket) {
  const oldest = (await list({ client })).filter((b) => b.complete).map((b) => b.day).sort()[0];
  if (!oldest) return 0;
  const old = (await client.listObjects(bucket, ERASURES)).filter((item) => (ERASURE_KEY.exec(item.key) || [])[1] < oldest);
  for (const item of old) await client.deleteObject(bucket, item.key);
  return old.length;
}

// After a real restore (the CRM pointed at the restored database): every customer erased on the
// backup's day or after is erased again. → how many.
async function reapplyErasures(day, { client = r2Client() } = {}) {
  const Contact = require('../models/Contact'); // eslint-disable-line global-require
  const erasure = require('./erasureService'); // eslint-disable-line global-require
  const { textsFor } = require('./frontendTexts'); // eslint-disable-line global-require
  let erased = 0;
  for (const note of await erasuresSince(day, { client })) {
    const contact = await Contact.collection.findOne({ _id: new mongoose.Types.ObjectId(note.contactId), organizationId: new mongoose.Types.ObjectId(note.organizationId) });
    if (!contact || contact.erasure?.at) continue;
    await erasure.eraseContact({ organizationId: note.organizationId, contact, label: textsFor('en')('pdata.erasedCustomer') });
    erased += 1;
  }
  return erased;
}

// --- the restore drill ---------------------------------------------------------------------------

const drillDbName = () => `${mongoose.connection.db.databaseName}_drill`.slice(0, 60);

// The next drill: Sunday 4:30 in India, two hours after that day's backup.
const nextDrillRun = (now = new Date()) => new Date(nextRun(now).getTime() + 2 * 60 * 60 * 1000);

async function drillState() {
  return (await PlatformSetting.findOne({ key: DRILL_KEY }).lean())?.value || { history: [] };
}

// The newest complete backup back into <the CRM's database>_drill, counted, then dropped.
// by: who asked (a platform admin's email) or "schedule". → the result kept for the page.
async function drill({ client = r2Client(), by = 'schedule', now = new Date() } = {}) {
  const started = Date.now();
  let result;
  const target = mongoose.connection.client.db(drillDbName());
  try {
    if (!configured()) throw new Error('Backups are not set up (R2_BACKUP_BUCKET)');
    const newest = (await list({ client })).find((b) => b.complete);
    if (!newest) throw new Error('No complete backup to restore');
    await target.dropDatabase(); // a drill that stopped half-way left it behind
    const restored = await restore(newest.day, { client, targetDb: target });
    const since = await erasuresSince(newest.day, { client, after: restored.createdAt }).catch(() => []);
    result = {
      ok: restored.ok, day: newest.day, backupAt: restored.createdAt || null, collections: restored.collections, documents: restored.documents,
      problems: restored.problems.slice(0, 20), erasuresSince: since.length,
    };
  } catch (error) {
    result = { ok: false, problems: [error.message] };
  } finally {
    await target.dropDatabase().catch((error) => logger.error(`The drill database could not be dropped: ${error.message}`));
  }
  const entry = { ...result, at: now, by, seconds: Math.round((Date.now() - started) / 1000) };
  const state = await drillState();
  await PlatformSetting.updateOne(
    { key: DRILL_KEY },
    { $set: { value: { last: entry, history: [entry, ...(state.history || [])].slice(0, 12), running: null } } },
    { upsert: true },
  );
  if (entry.ok) {
    logger.info(`Restore drill of ${entry.day}: ${entry.collections} collections, ${entry.documents} documents in ${entry.seconds} s`);
  } else {
    logger.error(`Restore drill failed: ${entry.problems.join('; ')}`);
    errorReporter.capture(new Error(`Restore drill failed: ${entry.problems[0] || 'unknown'}`), { source: 'job', tags: { job: DRILL_JOB } });
  }
  return entry;
}

// POST /platform/backups/drill: one at a time; the page follows it.
async function startDrill(by, queue = require('../jobs/queue')) {
  const state = await drillState();
  if (state.running && Date.now() - new Date(state.running.startedAt).getTime() < DRILL_STALE_MS) return { running: state.running, started: false };
  const running = { startedAt: new Date(), by };
  await PlatformSetting.updateOne({ key: DRILL_KEY }, { $set: { 'value.running': running } }, { upsert: true });
  await queue.enqueue(DRILL_JOB, { by }, { uniqueKey: `${DRILL_JOB}:now`, maxAttempts: 1 });
  return { running, started: true };
}

// GET /platform/backups: what the platform admin page shows.
async function status({ client = r2Client(), now = new Date() } = {}) {
  const state = await drillState();
  const running = state.running && now - new Date(state.running.startedAt) < DRILL_STALE_MS ? state.running : null;
  const base = { configured: configured(), keepWeeks: env.storage.backupKeepWeeks, running, last: state.last || null, history: state.history || [] };
  if (!base.configured) return { ...base, backups: [], nextBackupAt: null, nextDrillAt: null, warnings: ['not_configured'] };
  let backups = [];
  const warnings = [];
  try {
    backups = (await list({ client })).map(({ day, files, bytes, complete }) => ({ day, files, bytes, complete }));
  } catch (error) {
    logger.warn(`The backups could not be listed: ${error.message}`);
    warnings.push('unreachable');
  }
  const newest = backups.find((b) => b.complete);
  if (!warnings.length && !newest) warnings.push('no_backup');
  if (newest && now - new Date(`${newest.day}T02:30:00+05:30`) > 8 * DAY_MS) warnings.push('old_backup');
  if (state.last && !state.last.ok) warnings.push('drill_failed');
  if (!state.last || now - new Date(state.last.at) > 35 * DAY_MS) warnings.push('no_drill');
  return { ...base, backups, nextBackupAt: nextRun(now), nextDrillAt: nextDrillRun(now), warnings };
}

function register(queue) {
  queue.define(JOB, () => run(), { maxAttempts: 3 });
  queue.define(DRILL_JOB, (data) => drill({ by: data.by || 'schedule' }), { maxAttempts: 1 });
  if (configured()) {
    queue.every(JOB, WEEK_MS, {}, { firstRunAt: nextRun() }).catch((error) => logger.error(`Scheduling ${JOB} failed: ${error.message}`));
    queue.every(DRILL_JOB, DRILL_EVERY_MS, { by: 'schedule' }, { uniqueKey: `${DRILL_JOB}:schedule`, firstRunAt: nextDrillRun() }).catch((error) => logger.error(`Scheduling ${DRILL_JOB} failed: ${error.message}`));
  } else {
    queue.cancel(JOB).catch(() => {});
    queue.cancel(`${DRILL_JOB}:schedule`).catch(() => {});
  }
}

module.exports = {
  JOB, DRILL_JOB, run, list, check, restore, register, nextRun, nextDrillRun, decryptFile, fileLines, backupKey, configured,
  markErased, erasuresSince, reapplyErasures, drill, startDrill, status, drillDbName,
};
