jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Document = require('../models/Document');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;
// Collects a download as bytes (supertest does not buffer application/octet-stream by itself).
const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
const download = (token, id) => api().get(`/api/v1/documents/${id}/download`).set(bearer(token)).buffer(true).parse(binary);
const upload = (token, fields, file = { content: Buffer.from('price list v1'), name: 'price-list.pdf' }) => {
  const req = api().post('/api/v1/documents').set(bearer(token));
  Object.entries(fields).forEach(([key, value]) => req.field(key, value));
  return file ? req.attach('file', file.content, file.name) : req;
};
const storedPath = async (id) => {
  const doc = await Document.findById(id);
  return doc.storageKey ? path.join(process.env.DOCUMENT_DIR, ...doc.storageKey.split('/')) : null;
};

describe('Documents', () => {
  let owner;
  beforeAll(async () => { owner = await login('docs-owner@example.com', { name: 'Dev Owner' }); });

  it('stores an uploaded file privately and gives it back only as a download', async () => {
    const res = await upload(owner.token, { name: 'Price list', category: 'Proposal', tags: 'gst, 2026 ,gst', description: 'October' });
    expect(res.status).toBe(201);
    const content = Buffer.from('price list v1');
    expect(res.body.data).toMatchObject({
      name: 'Price list', category: 'Proposal', tags: ['gst', '2026'], hasFile: true, fileName: 'price-list.pdf',
      sizeBytes: content.length, checksum: crypto.createHash('sha256').update(content).digest('hex'), linkUrl: '',
    });
    expect(res.body.data).not.toHaveProperty('storageKey');

    const file = await storedPath(res.body.data.id);
    expect(file.startsWith(path.resolve(process.env.DOCUMENT_DIR))).toBe(true);
    expect(fs.readFileSync(file).equals(content)).toBe(true);

    const got = await download(owner.token, res.body.data.id);
    expect(got.status).toBe(200);
    expect(got.body.equals(content)).toBe(true);
    expect(got.headers['content-type']).toBe('application/octet-stream');
    expect(got.headers['content-disposition']).toMatch(/^attachment; filename="price-list.pdf"/);
    expect(got.headers['content-security-policy']).toMatch(/sandbox/);

    expect((await api().get(`/api/v1/documents/${res.body.data.id}/download`)).status).toBe(401);
  });

  it('keeps non-English file names', async () => {
    const res = await upload(owner.token, { name: 'Bill' }, { content: Buffer.from('bill'), name: 'बिल सितंबर.pdf' });
    expect(res.body.data.fileName).toBe('बिल सितंबर.pdf');
    expect((await download(owner.token, res.body.data.id)).headers['content-disposition']).toContain("filename*=UTF-8''");
  });

  it('refuses big files, programs, empty files, and needs exactly one of file or link', async () => {
    const big = await upload(owner.token, { name: 'Big' }, { content: Buffer.alloc(1024 * 1024 + 10, 1), name: 'big.zip' });
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('FILE_TOO_LARGE');

    const exe = await upload(owner.token, { name: 'Tool' }, { content: Buffer.from('MZ'), name: 'setup.EXE' });
    expect(exe.status).toBe(400);
    expect(exe.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect((await upload(owner.token, { name: 'Empty' }, { content: Buffer.alloc(0), name: 'empty.txt' })).body.code).toBe('EMPTY_FILE');

    expect((await upload(owner.token, { name: 'Nothing' }, null)).body.code).toBe('FILE_OR_LINK_REQUIRED');
    expect((await upload(owner.token, { name: 'Both', linkUrl: 'https://example.com/a.pdf' })).body.code).toBe('FILE_OR_LINK_REQUIRED');
    expect((await upload(owner.token, { category: 'Other' })).status).toBe(400); // no name
  });

  it('saves web links only', async () => {
    const link = await api().post('/api/v1/documents').set(bearer(owner.token)).send({ name: 'Catalogue', linkUrl: 'https://drive.google.com/file/d/abc' });
    expect(link.status).toBe(201);
    expect(link.body.data).toMatchObject({ hasFile: false, linkUrl: 'https://drive.google.com/file/d/abc' });
    expect((await api().get(`/api/v1/documents/${link.body.data.id}/download`).set(bearer(owner.token))).body.code).toBe('NO_FILE');

    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'not a link']) {
      const res = await api().post('/api/v1/documents').set(bearer(owner.token)).send({ name: 'x', linkUrl: bad });
      expect(res.status).toBe(400);
    }
  });

  it('replaces the file, switches to a link, and removes files it no longer needs', async () => {
    const doc = (await upload(owner.token, { name: 'Contract' })).body.data;
    const firstFile = await storedPath(doc.id);

    const replaced = await api().patch(`/api/v1/documents/${doc.id}`).set(bearer(owner.token))
      .field('category', 'Contract').attach('file', Buffer.from('contract v2'), 'contract-v2.pdf');
    expect(replaced.status).toBe(200);
    expect(replaced.body.data).toMatchObject({ fileName: 'contract-v2.pdf', category: 'Contract' });
    expect(fs.existsSync(firstFile)).toBe(false);
    expect((await download(owner.token, doc.id)).body.toString()).toBe('contract v2');

    const secondFile = await storedPath(doc.id);
    const asLink = await api().patch(`/api/v1/documents/${doc.id}`).set(bearer(owner.token)).send({ linkUrl: 'https://example.com/contract' });
    expect(asLink.body.data).toMatchObject({ hasFile: false, fileName: '', sizeBytes: 0, linkUrl: 'https://example.com/contract' });
    expect(fs.existsSync(secondFile)).toBe(false);

    // Clearing the link of a link-only document would leave nothing.
    expect((await api().patch(`/api/v1/documents/${doc.id}`).set(bearer(owner.token)).send({ linkUrl: '' })).body.code).toBe('FILE_OR_LINK_REQUIRED');

    await api().delete(`/api/v1/documents/${doc.id}`).set(bearer(owner.token));
    expect((await api().get(`/api/v1/documents/${doc.id}`).set(bearer(owner.token))).status).toBe(404);
  });

  it('links a document to a customer and filters by it', async () => {
    const contact = (await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Ravi Traders', lifecycle: 'customer' })).body.data;
    const doc = (await upload(owner.token, { name: 'Ravi invoice', category: 'Invoice', relatedType: 'Customer', relatedId: contact.id, relatedName: 'typo' })).body.data;
    expect(doc).toMatchObject({ relatedType: 'Customer', relatedId: contact.id, relatedName: 'Ravi Traders' });
    const byCustomer = await api().get(`/api/v1/documents?relatedType=Customer&relatedId=${contact.id}`).set(bearer(owner.token));
    expect(byCustomer.body.data.map((d) => d.id)).toEqual([doc.id]);
    const byTag = await api().get('/api/v1/documents?q=gst').set(bearer(owner.token));
    expect(byTag.body.data.map((d) => d.name)).toEqual(['Price list']);
  });

  it('agents own what they upload and see only their documents; other organizations see nothing', async () => {
    const agent = await inviteAndJoin(owner.token, 'docs-agent@example.com', { role: 'agent', modules: ['documents'] });
    const agentId = await memberId(owner.token, 'docs-agent@example.com');
    const ownerId = await memberId(owner.token, 'docs-owner@example.com');

    const mine = await upload(agent.token, { name: 'Agent file', ownerId });
    expect(mine.body.data.ownerId).toBe(agentId); // agents cannot give documents to others
    const given = (await upload(owner.token, { name: 'For the agent', ownerId: agentId })).body.data;
    const ownersOnly = (await api().get('/api/v1/documents').set(bearer(owner.token))).body.data.find((d) => d.name === 'Price list');

    const view = await api().get('/api/v1/documents').set(bearer(agent.token));
    expect(view.body.data.map((d) => d.id).sort()).toEqual([mine.body.data.id, given.id].sort());
    expect((await download(agent.token, ownersOnly.id)).status).toBe(404);
    expect((await api().delete(`/api/v1/documents/${mine.body.data.id}`).set(bearer(agent.token))).status).toBe(403);

    const viewer = await inviteAndJoin(owner.token, 'docs-viewer@example.com', { role: 'viewer', modules: ['documents'] });
    expect((await upload(viewer.token, { name: 'x' })).status).toBe(403);

    const stranger = await login('docs-stranger@example.com');
    expect((await api().get('/api/v1/documents').set(bearer(stranger.token))).body.data).toEqual([]);
    expect((await download(stranger.token, given.id)).status).toBe(404);
  });
});
