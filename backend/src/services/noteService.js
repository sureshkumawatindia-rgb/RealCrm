const Note = require('../models/Note');
const { audit } = require('../utils/audit');

// Notes on a ticket or a contact. Callers first check that the member may see the parent
// (ticketService.findVisible / contactService.findVisible); notes follow their parent's access.
const LIST_LIMIT = 200;

function serializeNote(note) {
  return {
    id: note._id,
    parentType: note.parentType,
    parentId: note.parentId,
    text: note.text,
    authorName: note.authorName,
    authorMemberId: note.authorMemberId || null,
    createdAt: note.createdAt,
  };
}

// Newest first.
async function list(req, parentType, parentId) {
  const notes = await Note.find({ organizationId: req.tenant.organizationId, parentType, parentId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(LIST_LIMIT);
  return notes.map(serializeNote);
}

async function add(req, parentType, parentId, { text }) {
  const note = await Note.create({
    organizationId: req.tenant.organizationId,
    parentType,
    parentId,
    text,
    authorUserId: req.user._id,
    authorMemberId: req.member._id,
    authorName: req.member.displayName || req.user.name || req.user.email,
  });
  await audit(req, { action: 'note.created', entityType: 'Note', entityId: note._id, changes: { parentType, parentId: String(parentId) } });
  return serializeNote(note);
}

module.exports = { list, add, serializeNote };
