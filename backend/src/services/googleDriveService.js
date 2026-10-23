const Document = require('../models/Document');
const httpError = require('../utils/httpError');
const googleService = require('./googleService');
const documentService = require('./documentService');

// Google Drive (Phase 9B, D90): a new Google Doc or Sheet for a customer or a deal, made in the
// member's own Drive (only drive.file: the CRM reaches just the files it makes) and attached as a
// CRM document (a link that remembers the Google file). Deleting the CRM document leaves the
// file in the member's Drive.
const MIME = { doc: 'application/vnd.google-apps.document', sheet: 'application/vnd.google-apps.spreadsheet' };

// POST /google/drive/files { kind, name, relatedType, relatedId }
async function createFile(req, { kind, name, relatedType, relatedId }) {
  const connection = await googleService.connectionOf(req);
  if (!connection || !connection.features?.drive) throw httpError(409, 'GOOGLE_NO_DRIVE', 'Connect Google with Drive first: Settings → My profile → Google.');
  const file = await googleService.withGoogle(connection, (provider, creds) => provider.createFile(creds, { name, mimeType: MIME[kind] }));
  const doc = await documentService.create(req, { name: file.name || name, linkUrl: file.webViewLink, relatedType, relatedId, category: 'Other', description: '' });
  await Document.updateOne({ _id: doc.id }, { $set: { external: { google: { fileId: file.id, kind } } } });
  return { ...doc, google: { fileId: file.id, kind } };
}

module.exports = { createFile, MIME };
