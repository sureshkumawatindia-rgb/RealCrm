jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const Organization = require('../models/Organization');
const { api, bearer, login } = require('./helpers/api');

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

describe('Organization profile', () => {
  let owner;
  beforeAll(async () => { owner = await login('org-owner@example.com'); });

  it('saves the standard field names and derives the GST state code', async () => {
    const res = await api().patch('/api/v1/organization').set(bearer(owner.token)).send({
      name: 'Rajasthan Spices', gstin: '08abcde1234f1z5', postalCode: '302001', foundedYear: 2015, size: '11-50',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Rajasthan Spices', gstin: '08ABCDE1234F1Z5', stateCode: '08', postalCode: '302001', foundedYear: 2015, size: '11-50' });
    expect(res.body.data).not.toHaveProperty('gst');
    expect(res.body.data).not.toHaveProperty('pincode');
  });

  it('rejects an invalid GSTIN with a helpful message', async () => {
    const res = await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ gstin: 'ABC' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toMatch(/GSTIN must be 15 characters/);
  });

  it('lets a field be cleared', async () => {
    const res = await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ gstin: '', foundedYear: '' });
    expect(res.status).toBe(200);
    expect(res.body.data.gstin).toBe('');
    expect(res.body.data.stateCode).toBe('');
    expect(res.body.data.foundedYear).toBe('');
  });

  it('reads old field names until the migration has run', async () => {
    await Organization.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(String(owner.data.organizationId)) }, { $set: { gst: '27ABCDE1234F1Z5', pincode: '400001' }, $unset: { gstin: '', postalCode: '' } });
    const res = await api().get('/api/v1/organization').set(bearer(owner.token));
    expect(res.body.data).toMatchObject({ gstin: '27ABCDE1234F1Z5', postalCode: '400001', stateCode: '27' });
  });

  it('uploads and removes the logo', async () => {
    const upload = await api().post('/api/v1/organization/logo').set(bearer(owner.token)).attach('logo', PNG, 'logo.png');
    expect(upload.status).toBe(200);
    const fileName = path.basename(new URL(upload.body.data.logoUrl).pathname);
    expect(fs.existsSync(path.resolve(env.uploadDir, fileName))).toBe(true);

    const removed = await api().delete('/api/v1/organization/logo').set(bearer(owner.token));
    expect(removed.body.data.logoUrl).toBe('');
    expect(fs.existsSync(path.resolve(env.uploadDir, fileName))).toBe(false);
  });

  it('rejects a file whose content does not match its extension', async () => {
    const res = await api().post('/api/v1/organization/logo').set(bearer(owner.token)).attach('logo', Buffer.from('not a png'), 'logo.png');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILE_CONTENT');
  });
});
