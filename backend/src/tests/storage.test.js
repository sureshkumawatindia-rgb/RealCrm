jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const env = require('../config/env');
const Document = require('../models/Document');
const { sign } = require('../storage/s3Signer');
const { createR2Client } = require('../storage/r2Client');
const { createR2DocumentStorage, createR2NamedStorage, withDiskFallback } = require('../storage/r2');
const { createLocalDiskStorage, createLocalNamedStorage } = require('../storage/localDisk');
const { useStorage } = require('../storage');
const { copyToR2 } = require('../storage/copyToR2');
const backups = require('../services/backupService');
const { startFakeS3 } = require('./helpers/fakeS3');
const { api, bearer, login } = require('./helpers/api');

// Week 2 of the foundation (F5, F4a): files on Cloudflare R2 (S3 protocol, signed without the AWS
// SDK), the disk read as a fallback while files are copied, the copy itself, and the weekly
// encrypted backup copy.

// Binary answers (downloads, images) as a Buffer.
const bytes = (request) => request.buffer(true).parse((res, done) => { const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => done(null, Buffer.concat(parts))); });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
let s3;
let client;
beforeAll(async () => {
  s3 = await startFakeS3();
  client = createR2Client({ endpoint: s3.endpoint, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey });
});
afterAll(() => s3.close());

describe('S3 signing (SigV4)', () => {
  it('matches AWS\'s signing test suite', () => {
    const base = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service', date: new Date('2015-08-30T12:36:00Z'), contentHashHeader: false };
    // botocore tests/unit/auth/aws4_testsuite: get-vanilla, get-vanilla-query-order-key.
    expect(sign({ ...base, method: 'GET', url: 'https://example.amazonaws.com/' }).authorization)
      .toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(sign({ ...base, method: 'GET', url: 'https://example.amazonaws.com/?Param1=value2&Param1=Value1' }).authorization)
      .toMatch(/Signature=eedbc4e291e521cf13422ffca22be7d2eb8146eecf653089df300a15b2382bd1$/);
  });
});

describe('R2 client', () => {
  it('puts, reads, lists page by page, uploads large files in parts and deletes', async () => {
    await client.putObject('crm-files', 'a/one.txt', Buffer.from('hello'));
    expect((await client.getBuffer('crm-files', 'a/one.txt')).toString()).toBe('hello');
    expect(await client.headObject('crm-files', 'a/one.txt')).toEqual({ size: 5, etag: '5d41402abc4b2a76b9719d911017c592' });
    expect(await client.getObject('crm-files', 'a/none')).toBeNull();
    expect(await client.headObject('crm-files', 'a/none')).toBeNull();

    for (let i = 0; i < 4; i += 1) await client.putObject('crm-files', `a/page-${i}`, Buffer.from(String(i)));
    expect((await client.listObjects('crm-files', 'a/', { pageSize: 2 })).map((o) => o.key)).toEqual(['a/one.txt', 'a/page-0', 'a/page-1', 'a/page-2', 'a/page-3']);

    const big = Buffer.alloc(3000, 1);
    async function* chunks() { for (let i = 0; i < 3000; i += 700) yield big.subarray(i, i + 700); }
    const result = await client.putStream('crm-files', 'a/big.bin', chunks(), { partBytes: 1024 });
    expect(result.bytes).toBe(3000);
    expect((await client.getBuffer('crm-files', 'a/big.bin')).equals(big)).toBe(true);
    expect(s3.requests.filter((r) => r.query.partNumber).length).toBe(3);
    expect(s3.uploads.size).toBe(0);

    await client.deleteObject('crm-files', 'a/one.txt');
    expect(await client.headObject('crm-files', 'a/one.txt')).toBeNull();
    await expect(createR2Client({ endpoint: s3.endpoint, accessKeyId: s3.accessKeyId, secretAccessKey: 'wrong' }).putObject('crm-files', 'x', Buffer.from('x')))
      .rejects.toThrow('R2 PUT x: 403 SignatureDoesNotMatch');
  });
});

describe('Files on R2 (F5)', () => {
  it('keeps new documents and logos on R2, still reads old ones from the disk, and copies them over', async () => {
    const owner = await login('f5-owner@example.com');
    const o = (method, url) => api()[method](`/api/v1${url}`).set(bearer(owner.token));
    // A document saved on the disk before the move.
    const old = (await o('post', '/documents').field('name', 'Old price list').attach('file', Buffer.from('old file'), 'old.txt')).body.data;
    const oldDoc = await Document.findById(old.id);
    expect(fs.existsSync(path.join(env.documentDir, ...oldDoc.storageKey.split('/')))).toBe(true);

    const disk = { documents: createLocalDiskStorage(env.documentDir), logos: createLocalNamedStorage(env.uploadDir) };
    const restore = useStorage({
      documents: withDiskFallback(createR2DocumentStorage({ client, bucket: 'crm-files' }), disk.documents),
      logos: withDiskFallback(createR2NamedStorage({ client, bucket: 'crm-files' }), disk.logos),
    });
    try {
      // Old document: from the disk. New one: on R2 only.
      expect((await bytes(o('get', `/documents/${old.id}/download`))).body.toString()).toBe('old file');
      const fresh = (await o('post', '/documents').field('name', 'New price list').attach('file', Buffer.from('new file'), 'new.txt')).body.data;
      const freshDoc = await Document.findById(fresh.id);
      expect(s3.objects.get(`crm-files/documents/${freshDoc.storageKey}`).body.toString()).toBe('new file');
      expect(fs.existsSync(path.join(env.documentDir, ...freshDoc.storageKey.split('/')))).toBe(false);
      expect((await bytes(o('get', `/documents/${fresh.id}/download`))).body.toString()).toBe('new file');

      // A logo: on R2, served at the same address as before, never as a page.
      const logo = (await o('post', '/organization/logo').attach('logo', PNG, 'logo.png')).body.data;
      const name = path.basename(new URL(logo.logoUrl).pathname);
      expect(s3.objects.has(`crm-files/logos/${name}`)).toBe(true);
      const served = await bytes(api().get(`/uploads/${name}`));
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe('image/png');
      expect(served.headers['content-security-policy']).toMatch(/^sandbox/);
      expect(Buffer.compare(served.body, PNG)).toBe(0);
      expect((await api().get('/uploads/..%2Fsecret.png')).status).toBe(404);
      expect((await api().get('/uploads/nothing-here.png')).status).toBe(404);

      // The copy: the old file goes over; a second run finds everything there.
      const first = await copyToR2({ client, bucket: 'crm-files', documentDir: env.documentDir, uploadDir: env.uploadDir });
      expect(first.ok).toBe(true);
      expect(first.copied).toBeGreaterThanOrEqual(1);
      expect(s3.objects.get(`crm-files/documents/${oldDoc.storageKey}`).body.toString()).toBe('old file');
      const again = await copyToR2({ client, bucket: 'crm-files', documentDir: env.documentDir, uploadDir: env.uploadDir, check: true });
      expect(again).toMatchObject({ ok: true, copied: 0, missing: [], failed: [] });
      expect(again.alreadyThere).toBe(again.files);
      // A copy that changed is caught.
      s3.objects.set(`crm-files/documents/${oldDoc.storageKey}`, { body: Buffer.from('broken!!'), etag: 'x' });
      expect((await copyToR2({ client, bucket: 'crm-files', documentDir: env.documentDir, uploadDir: env.uploadDir, check: true })).missing).toContain(`documents/${oldDoc.storageKey}`);

    } finally {
      restore();
    }
  });
});

describe('Weekly backup copy (F4a)', () => {
  const saved = { ...env.storage.r2 };
  beforeAll(() => Object.assign(env.storage.r2, { backupBucket: 'crm-backups', accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, endpoint: s3.endpoint }));
  afterAll(() => Object.assign(env.storage.r2, saved));

  it('writes every collection encrypted with a manifest, reads it back, catches changes and keeps the newest', async () => {
    await login('f4-owner@example.com');
    const result = await backups.run({ client, now: new Date('2026-10-24T21:00:00Z') });
    expect(result.day).toBe('2026-10-25');
    expect(result.documents).toBeGreaterThan(0);
    const manifest = JSON.parse(s3.objects.get('crm-backups/backups/2026-10-25/manifest.json').body.toString());
    expect(manifest).toMatchObject({ format: 'yellow-crm-backup/1', encryption: { cipher: 'aes-256-gcm', keyFrom: 'GMAIL_TOKEN_ENCRYPTION_KEY' } });
    const users = manifest.collections.find((c) => c.name === 'users');
    expect(users.count).toBeGreaterThan(0);
    // Encrypted: no email in the file.
    expect(s3.objects.get(`crm-backups/${users.file}`).body.toString('latin1')).not.toContain('f4-owner@example.com');
    const lines = backups.decryptFile(s3.objects.get(`crm-backups/${users.file}`).body, backups.backupKey().key);
    expect(lines.some((line) => line.includes('f4-owner@example.com'))).toBe(true);
    expect(lines[0]).toMatch(/"\$oid"/); // ids come back as ids

    expect(await backups.check('2026-10-25', { client })).toMatchObject({ ok: true, problems: [] });
    const original = s3.objects.get(`crm-backups/${users.file}`);
    const tampered = Buffer.from(original.body);
    tampered[tampered.length - 20] ^= 1;
    s3.objects.set(`crm-backups/${users.file}`, { body: tampered, etag: 'x' });
    const broken = await backups.check('2026-10-25', { client });
    expect(broken.ok).toBe(false);
    expect(broken.problems.join(' ')).toMatch(/users: file changed.*users: cannot be read/);
    s3.objects.set(`crm-backups/${users.file}`, original);

    // Older backups beyond BACKUP_KEEP_WEEKS go; an incomplete one is listed as such.
    for (const day of ['2026-08-01', '2026-08-08', '2026-08-15']) s3.objects.set(`crm-backups/backups/${day}/users.ndjson.gz.enc`, { body: Buffer.from('x'), etag: 'x' });
    const keep = env.storage.backupKeepWeeks;
    env.storage.backupKeepWeeks = 2;
    try {
      const next = await backups.run({ client, now: new Date('2026-11-01T21:00:00Z') });
      expect(next.removed.sort()).toEqual(['2026-08-01', '2026-08-08', '2026-08-15']);
      expect((await backups.list({ client })).map((b) => [b.day, b.complete])).toEqual([['2026-11-02', true], ['2026-10-25', true]]);
    } finally {
      env.storage.backupKeepWeeks = keep;
    }
  });

  it('restores a backup into an empty database and counts it (the drill, F4b)', async () => {
    await login('f4b-owner@example.com');
    const backup = await backups.run({ client, now: new Date('2026-11-08T21:00:00Z') });
    const target = mongoose.connection.client.db(`restore_drill_${process.pid}`);
    try {
      const result = await backups.restore(backup.day, { client, targetDb: target });
      expect(result).toMatchObject({ day: backup.day, ok: true, problems: [] });
      expect(result.documents).toBe(backup.documents);
      const user = await target.collection('users').findOne({ email: 'f4b-owner@example.com' });
      expect(user._id).toBeInstanceOf(mongoose.Types.ObjectId); // ids and dates come back as they were
      expect(user.createdAt).toBeInstanceOf(Date);
      // Never into a database with data, nor the CRM's own.
      await expect(backups.restore(backup.day, { client, targetDb: target })).rejects.toThrow('is not empty');
      await expect(backups.restore(backup.day, { client, targetUri: env.mongoUri })).rejects.toThrow('another, empty database');
    } finally {
      await target.dropDatabase();
    }
  });

  it('runs on Sundays at 2:30 in India', () => {
    expect(backups.nextRun(new Date('2026-10-21T10:00:00Z')).toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(backups.nextRun(new Date('2026-10-24T22:00:00Z')).toISOString()).toBe('2026-10-31T21:00:00.000Z');
  });
});
