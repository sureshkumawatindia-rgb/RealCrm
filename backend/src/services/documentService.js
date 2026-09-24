const crypto = require('crypto');
const path = require('path');
const Document = require('../models/Document');
const httpError = require('../utils/httpError');
const logger = require('../config/logger');
const { audit } = require('../utils/audit');
const { toPage, paginationMeta } = require('../utils/pagination');
const { searchFilter, sortSpec } = require('../utils/listQuery');
const { visibilityFilter, resolveOwnerId, ownerPatch } = require('./access');
const { resolveRelated } = require('./workItemService');
const { documentStorage } = require('../storage');
const { BLOCKED_FILE_EXTENSIONS } = require('../constants/crm');

// Documents show on the Documents page and in Customer 360. Agents and viewers see the
// documents they own unless they have view_all (D17).
const MODULES = ['documents', 'customers'];
const EDITABLE = ['name', 'description', 'category'];
const RELATED_KEYS = ['relatedType', 'relatedId', 'relatedName'];
const NO_FILE = { storageKey: undefined, fileName: '', mimeType: '', sizeBytes: 0, checksum: '' };

function serializeDocument(doc) {
  return {
    id: doc._id,
    name: doc.name,
    description: doc.description,
    category: doc.category,
    ownerId: doc.ownerId || null,
    relatedType: doc.relatedType,
    relatedId: doc.relatedId || null,
    relatedName: doc.relatedName,
    tags: doc.tags,
    hasFile: Boolean(doc.storageKey),
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    checksum: doc.checksum,
    linkUrl: doc.linkUrl,
    createdByMemberId: doc.createdByMemberId || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// "a, b ,a" or ["a", "b"] → ["a", "b"]: trimmed, no duplicates, at most 20.
function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return [...new Set(list.map((tag) => String(tag).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
}

// The name without any folder part or control characters (it is shown and used for downloads).
function cleanFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'file';
}

const isBlockedFile = (fileName) => BLOCKED_FILE_EXTENSIONS.includes(path.extname(fileName).slice(1).toLowerCase());
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// Checks and stores an uploaded file; returns the document fields for it.
async function storeFile(req, file) {
  const fileName = cleanFileName(file.originalname);
  if (isBlockedFile(fileName)) {
    throw httpError(400, 'FILE_TYPE_NOT_ALLOWED', 'Programs and scripts (.exe, .bat, .js, ...) cannot be stored. Share a link instead.');
  }
  if (!file.size) throw httpError(400, 'EMPTY_FILE', 'The file is empty.');
  const storageKey = await documentStorage.put(req.tenant.organizationId, file.buffer);
  return {
    storageKey,
    fileName,
    mimeType: String(file.mimetype || '').slice(0, 100),
    sizeBytes: file.size,
    checksum: sha256(file.buffer),
    linkUrl: '',
  };
}

async function removeStoredFile(key) {
  try {
    await documentStorage.remove(key);
  } catch (error) {
    logger.error(`Could not remove a stored document file: ${error.message}`);
  }
}

async function findVisible(req, id) {
  const doc = await Document.findOne({ _id: id, organizationId: req.tenant.organizationId, ...visibilityFilter(req, MODULES) });
  if (!doc) throw httpError(404, 'NOT_FOUND', 'Document not found');
  return doc;
}

async function applyFields(req, doc, body) {
  for (const key of EDITABLE) if (key in body) doc.set(key, body[key]);
  if ('tags' in body) doc.tags = normalizeTags(body.tags);
  if (RELATED_KEYS.some((key) => key in body)) {
    Object.assign(doc, await resolveRelated(req, {
      relatedType: 'relatedType' in body ? body.relatedType : doc.relatedType,
      relatedId: 'relatedId' in body ? body.relatedId : doc.relatedId,
      relatedName: 'relatedName' in body ? body.relatedName : doc.relatedName,
    }));
  }
}

const fileOrLink = () => httpError(400, 'FILE_OR_LINK_REQUIRED', 'Attach a file or add a link (one of the two).');

async function list(req, query) {
  const conditions = [visibilityFilter(req, MODULES), searchFilter(query.q, ['name', 'description', 'fileName', 'relatedName', 'tags'])]
    .filter((condition) => Object.keys(condition).length);
  const filter = {
    organizationId: req.tenant.organizationId,
    ...(query.category && { category: query.category }),
    ...(query.relatedType && { relatedType: query.relatedType }),
    ...(query.relatedId && { relatedId: query.relatedId }),
    ...(query.ownerId && { ownerId: query.ownerId }),
    ...(conditions.length && { $and: conditions }),
  };
  const page = toPage(query);
  const [items, total] = await Promise.all([
    Document.find(filter).sort(sortSpec(query.sort, ['createdAt', 'updatedAt', 'name', 'sizeBytes', 'category'], { createdAt: -1 })).skip(page.skip).limit(page.limit),
    Document.countDocuments(filter),
  ]);
  return { items: items.map(serializeDocument), pagination: paginationMeta(page, total) };
}

async function create(req, body, file) {
  if (Boolean(file) === Boolean(body.linkUrl)) throw fileOrLink();
  const doc = new Document({
    organizationId: req.tenant.organizationId,
    ownerId: await resolveOwnerId(req, body.ownerId),
    createdById: req.user._id,
    createdByMemberId: req.member._id,
  });
  await applyFields(req, doc, body);
  if (file) Object.assign(doc, await storeFile(req, file));
  else doc.linkUrl = body.linkUrl;
  try {
    await doc.save();
  } catch (error) {
    if (doc.storageKey) await removeStoredFile(doc.storageKey);
    throw error;
  }
  await audit(req, { action: 'document.created', entityType: 'Document', entityId: doc._id });
  return serializeDocument(doc);
}

// A new file replaces the old one (and any link); a link replaces the file.
async function update(req, id, body, file) {
  if (file && body.linkUrl) throw fileOrLink();
  const doc = await findVisible(req, id);
  await applyFields(req, doc, body);
  Object.assign(doc, await ownerPatch(req, body));
  const oldKey = doc.storageKey;
  if (file) {
    Object.assign(doc, await storeFile(req, file));
  } else if (body.linkUrl) {
    Object.assign(doc, NO_FILE, { linkUrl: body.linkUrl });
  } else if ('linkUrl' in body && !doc.storageKey) {
    throw fileOrLink();
  }
  try {
    await doc.save();
  } catch (error) {
    if (doc.storageKey && doc.storageKey !== oldKey) await removeStoredFile(doc.storageKey);
    throw error;
  }
  if (oldKey && oldKey !== doc.storageKey) await removeStoredFile(oldKey);
  await audit(req, { action: 'document.updated', entityType: 'Document', entityId: doc._id, changes: [...Object.keys(body), ...(file ? ['file'] : [])] });
  return serializeDocument(doc);
}

// Soft delete: the file stays in storage so the document can be restored.
async function remove(req, id) {
  const doc = await findVisible(req, id);
  await doc.softDelete();
  await audit(req, { action: 'document.deleted', entityType: 'Document', entityId: doc._id });
}

// For GET /documents/:id/download. Returns a read stream and the download name.
async function openFile(req, id) {
  const doc = await findVisible(req, id);
  if (!doc.storageKey) throw httpError(404, 'NO_FILE', 'This document is a link, not a file.');
  const stream = await documentStorage.open(doc.storageKey);
  if (!stream) throw httpError(404, 'FILE_MISSING', 'The file is missing from storage.');
  await audit(req, { action: 'document.downloaded', entityType: 'Document', entityId: doc._id });
  return { stream, fileName: doc.fileName || doc.name };
}

module.exports = {
  MODULES,
  list,
  get: async (req, id) => serializeDocument(await findVisible(req, id)),
  create,
  update,
  remove,
  openFile,
  serializeDocument,
  cleanFileName,
  isBlockedFile,
  sha256,
};
