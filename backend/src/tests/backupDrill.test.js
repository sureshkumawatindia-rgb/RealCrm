jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const env = require('../config/env');
const AuditLog = require('../models/AuditLog');
const Contact = require('../models/Contact');
const PlatformSetting = require('../models/PlatformSetting');
const User = require('../models/User');
const backups = require('../services/backupService');
const queue = require('../jobs/queue');
const totp = require('../utils/totp');
const { indiaDate } = require('../utils/dates');
const { createR2Client } = require('../storage/r2Client');
const { startFakeS3 } = require('./helpers/fakeS3');
const { api, bearer, login } = require('./helpers/api');

// Phase 8 of the 100 phases (D120): the restore drill on the platform admin page. The newest
// weekly backup goes back into a separate, empty database next to the CRM's own (read line by
// line, never a whole collection in memory), is counted against its manifest, and that database
// is dropped; the result is kept for the page. Customers erased after a backup are noted, so a
// restore of that backup erases them again.
const ADMIN = 'drill-admin@example.com';
const codeAt = (secret) => totp.codeAt(totp.base32Decode(secret), Date.now());

describe('The restore drill (Phase 8, D120)', () => {
  let s3;
  let client;
  const saved = { ...env.storage.r2 };
  const savedAdmins = env.platformAdminEmails;

  beforeAll(async () => {
    s3 = await startFakeS3();
    client = createR2Client({ endpoint: s3.endpoint, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey });
    Object.assign(env.storage.r2, { backupBucket: 'crm-backups', accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, endpoint: s3.endpoint });
    env.platformAdminEmails = [ADMIN];
  });
  afterAll(async () => {
    Object.assign(env.storage.r2, saved);
    env.platformAdminEmails = savedAdmins;
    await s3.close();
  });

  it('reads a backup file line by line, the same as the whole file', async () => {
    const scratch = mongoose.connection.db.collection('zz_drill_lines');
    await scratch.insertMany(Array.from({ length: 3000 }, (_, i) => ({ n: i, text: `line ${i} — हिंदी ${'x'.repeat(i % 50)}`, at: new Date(1_700_000_000_000 + i) })));
    try {
      const backup = await backups.run({ client, now: new Date('2026-11-01T21:00:00Z') });
      const manifest = JSON.parse(s3.objects.get(`crm-backups/backups/${backup.day}/manifest.json`).body.toString());
      const entry = manifest.collections.find((c) => c.name === 'zz_drill_lines');
      const buffer = s3.objects.get(`crm-backups/${entry.file}`).body;
      const { key } = backups.backupKey();
      const streamed = [];
      for await (const line of backups.fileLines(buffer, key)) streamed.push(line);
      expect(streamed).toHaveLength(3000);
      expect(streamed).toEqual(backups.decryptFile(buffer, key));
      // A changed byte is caught (the tag at the end).
      const changed = Buffer.from(buffer);
      changed[changed.length - 30] ^= 1;
      await expect((async () => { for await (const line of backups.fileLines(changed, key)) void line; })()).rejects.toThrow();
    } finally {
      await scratch.drop();
    }
  });

  it('puts the newest backup back into a separate database, counts it, drops that database and keeps the result', async () => {
    await login('drill-owner@example.com');
    const backup = await backups.run({ client });
    const result = await backups.drill({ client, by: ADMIN });
    expect(result).toMatchObject({ ok: true, day: backup.day, collections: backup.collections, documents: backup.documents, problems: [], by: ADMIN, erasuresSince: 0 });
    expect(backups.drillDbName()).toBe(`${mongoose.connection.db.databaseName}_drill`);
    const databases = (await mongoose.connection.db.admin().listDatabases()).databases.map((d) => d.name);
    expect(databases).not.toContain(backups.drillDbName());
    const state = (await PlatformSetting.findOne({ key: 'backupDrill' }).lean()).value;
    expect(state).toMatchObject({ last: { ok: true, day: backup.day }, running: null });
    expect(state.history).toHaveLength(1);

    const status = await backups.status({ client });
    expect(status).toMatchObject({ configured: true, keepWeeks: env.storage.backupKeepWeeks, running: null, last: { ok: true }, warnings: [] });
    expect(status.backups[0]).toEqual({ day: backup.day, files: backup.collections + 1, bytes: expect.any(Number), complete: true });
    expect(new Date(status.nextDrillAt) - new Date(status.nextBackupAt)).toBe(2 * 60 * 60 * 1000); // two hours after the backup
  });

  it('fails when a backup file was changed, and the page says so', async () => {
    const day = (await backups.list({ client })).find((b) => b.complete).day;
    const manifest = JSON.parse(s3.objects.get(`crm-backups/backups/${day}/manifest.json`).body.toString());
    const users = manifest.collections.find((c) => c.name === 'users');
    const original = s3.objects.get(`crm-backups/${users.file}`);
    const tampered = Buffer.from(original.body);
    tampered[tampered.length - 20] ^= 1;
    s3.objects.set(`crm-backups/${users.file}`, { body: tampered, etag: 'x' });
    try {
      const result = await backups.drill({ client });
      expect(result.ok).toBe(false);
      expect(result.problems).toContain('users: file changed');
      expect((await backups.status({ client })).warnings).toContain('drill_failed');
      const databases = (await mongoose.connection.db.admin().listDatabases()).databases.map((d) => d.name);
      expect(databases).not.toContain(backups.drillDbName()); // dropped even so
    } finally {
      s3.objects.set(`crm-backups/${users.file}`, original);
    }
    expect((await backups.drill({ client })).ok).toBe(true);
  });

  it('notes each erasure, so a restore of an older backup erases those customers again', async () => {
    const owner = await login('drill-erase@example.com');
    const contact = (await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Back From Backup', phone: '98290 71777' })).body.data;
    const before = await Contact.collection.findOne({ _id: new mongoose.Types.ObjectId(contact.id) });
    expect((await api().post(`/api/v1/contacts/${contact.id}/privacy/erase`).set(bearer(owner.token)).send({ confirmName: 'Back From Backup' })).status).toBe(200);
    const day = indiaDate();
    expect(await backups.erasuresSince(day, { client })).toEqual([{ day, organizationId: owner.data.organizationId, contactId: contact.id, at: expect.any(String) }]);

    // A restore of a backup from before the erasure would bring the customer back …
    await Contact.collection.replaceOne({ _id: before._id }, before);
    expect((await Contact.collection.findOne({ _id: before._id })).name).toBe('Back From Backup');
    // … the notes erase them again, once.
    expect(await backups.reapplyErasures(day, { client })).toBe(1);
    expect(await Contact.collection.findOne({ _id: before._id })).toMatchObject({ name: 'Erased customer', erasure: { at: expect.any(Date) } });
    expect(await backups.reapplyErasures(day, { client })).toBe(0);
    // The drill tells how many were erased after its backup: none once a newer backup has them.
    expect((await backups.drill({ client })).erasuresSince).toBe(1);
    await backups.run({ client });
    expect((await backups.drill({ client })).erasuresSince).toBe(0);
  });

  it('runs from the platform admin page, one at a time, for the platform\'s admins only', async () => {
    backups.register(queue);
    const admin = await login(ADMIN, { name: 'Boss' });
    const stranger = await login('drill-stranger@example.com');
    const setup = (await api().post('/api/v1/auth/totp/setup').set(bearer(admin.token))).body.data;
    const secret = setup.secret.replace(/\s/g, '');
    expect((await api().post('/api/v1/auth/totp/enable').set(bearer(admin.token)).send({ code: codeAt(secret) })).status).toBe(200);
    await User.updateOne({ email: ADMIN }, { $unset: { 'totp.lastStep': 1 } });
    expect((await api().post('/api/v1/platform/unlock').set(bearer(admin.token)).send({ code: codeAt(secret) })).status).toBe(200);
    const get = (who) => api().get('/api/v1/platform/backups').set(bearer(who.token));
    const start = (who) => api().post('/api/v1/platform/backups/drill').set(bearer(who.token));

    expect((await get(stranger)).status).toBe(404);
    expect((await start(stranger)).status).toBe(404);
    const first = await start(admin);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ message: 'Restore drill started', data: { running: { by: ADMIN } } });
    expect((await start(admin)).body.message).toBe('A restore drill is already running');
    expect(await AuditLog.countDocuments({ action: 'platform.restore_drill_started' })).toBe(1);
    await queue.runDue();
    const after = (await get(admin)).body.data;
    expect(after).toMatchObject({ running: null, last: { ok: true, by: ADMIN } });
    expect(after.history.length).toBeGreaterThanOrEqual(2);

    // Not set up: the page says what is missing, and nothing starts.
    const bucket = env.storage.r2.backupBucket;
    env.storage.r2.backupBucket = '';
    try {
      expect((await get(admin)).body.data).toMatchObject({ configured: false, warnings: ['not_configured'], backups: [] });
      expect((await start(admin)).body.code).toBe('BACKUPS_NOT_SET_UP');
    } finally {
      env.storage.r2.backupBucket = bucket;
    }
  });
});
