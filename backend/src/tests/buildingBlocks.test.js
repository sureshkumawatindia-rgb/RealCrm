const mongoose = require('mongoose');
const softDelete = require('../models/plugins/softDelete');
const Organization = require('../models/Organization');
const Migration = require('../models/Migration');
const env = require('../config/env');
const { nextSequence } = require('../utils/counter');
const { toPage, paginationMeta } = require('../utils/pagination');
const { encrypt, decrypt } = require('../utils/secretBox');
const { redact } = require('../utils/audit');
const { runMigrations } = require('../migrations');

describe('Counters', () => {
  it('hands out unique numbers under concurrency, starting where asked', async () => {
    const organizationId = new mongoose.Types.ObjectId();
    const numbers = await Promise.all(Array.from({ length: 25 }, () => nextSequence(organizationId, 'ticket', { start: 1000 })));
    expect(new Set(numbers).size).toBe(25);
    expect(Math.min(...numbers)).toBe(1000);
    expect(Math.max(...numbers)).toBe(1024);

    const other = await nextSequence(new mongoose.Types.ObjectId(), 'ticket', { start: 1000 });
    expect(other).toBe(1000);
  });
});

describe('Soft delete plugin', () => {
  const schema = new mongoose.Schema({ organizationId: mongoose.Schema.Types.ObjectId, name: String });
  schema.plugin(softDelete);
  const Thing = mongoose.model('SoftDeleteThing', schema);

  it('hides deleted documents unless the filter asks for them', async () => {
    const organizationId = new mongoose.Types.ObjectId();
    const [keep, drop] = await Thing.create([{ organizationId, name: 'keep' }, { organizationId, name: 'drop' }]);
    await drop.softDelete();

    expect((await Thing.find({ organizationId })).map((t) => t.name)).toEqual(['keep']);
    expect(await Thing.countDocuments({ organizationId })).toBe(1);
    expect(await Thing.findById(drop._id)).toBeNull();
    expect(await Thing.findOne({ _id: drop._id, deletedAt: { $ne: null } })).not.toBeNull();
    const aggregated = await Thing.aggregate([{ $match: { organizationId } }]);
    expect(aggregated.map((t) => t.name)).toEqual(['keep']);
    expect(keep.deletedAt).toBeNull();
  });
});

describe('Pagination', () => {
  it('caps the limit at 100 and reports page metadata', () => {
    expect(toPage({ page: 3, limit: 500 })).toEqual({ page: 3, limit: 100, skip: 200 });
    expect(toPage({})).toEqual({ page: 1, limit: 20, skip: 0 });
    expect(paginationMeta({ page: 2, limit: 20 }, 45)).toEqual({
      page: 2, limit: 20, total: 45, totalPages: 3, hasNextPage: true, hasPreviousPage: true,
    });
  });
});

describe('secretBox', () => {
  afterEach(() => { env.dataEncryptionKey = ''; });

  it('keeps Gmail tokens written before DATA_ENCRYPTION_KEY readable', () => {
    const legacy = encrypt('gmail-refresh-token');
    expect(legacy.startsWith('v2.')).toBe(false);

    env.dataEncryptionKey = 'a-brand-new-data-encryption-key-0123456789';
    expect(decrypt(legacy)).toBe('gmail-refresh-token');

    const modern = encrypt('whatsapp-token');
    expect(modern.startsWith('v2.')).toBe(true);
    expect(decrypt(modern)).toBe('whatsapp-token');
  });

  it('fails on tampered ciphertext', () => {
    const [iv, tag, ciphertext] = encrypt('secret').split('.');
    const flipped = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
    expect(() => decrypt([iv, tag, flipped].join('.'))).toThrow();
  });
});

describe('Audit redaction', () => {
  it('never stores tokens or secrets', () => {
    expect(redact({ email: 'a@b.c', refreshToken: 'x', nested: { apiKey: 'y', ok: 1 } }))
      .toEqual({ email: 'a@b.c', refreshToken: '[redacted]', nested: { apiKey: '[redacted]', ok: 1 } });
  });
});

describe('Migration 001: organization field names', () => {
  it('renames gst/pincode/founded, derives the state code and runs only once', async () => {
    const { insertedId } = await Organization.collection.insertOne({
      name: 'Old Style Co', gst: ' 08abcde1234f1z5 ', pincode: '302001', founded: '2019',
    });
    const { insertedId: oddId } = await Organization.collection.insertOne({ name: 'Odd Co', founded: 'long ago' });

    await runMigrations();
    const migrated = await Organization.collection.findOne({ _id: insertedId });
    expect(migrated).toMatchObject({ gstin: '08ABCDE1234F1Z5', postalCode: '302001', foundedYear: 2019, stateCode: '08' });
    expect(migrated).not.toHaveProperty('gst');
    expect(migrated).not.toHaveProperty('pincode');
    expect(migrated).not.toHaveProperty('founded');

    const odd = await Organization.collection.findOne({ _id: oddId });
    expect(odd.founded).toBe('long ago');

    await runMigrations();
    expect(await Migration.countDocuments({ name: '001-organization-field-names' })).toBe(1);
  });
});
