const { once } = require('events');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Contact = require('../models/Contact');
const Product = require('../models/Product');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Quotation = require('../models/Quotation');
const Task = require('../models/Task');
const CalendarEvent = require('../models/CalendarEvent');
const Ticket = require('../models/Ticket');
const Note = require('../models/Note');
const Document = require('../models/Document');
const Campaign = require('../models/Campaign');
const Workflow = require('../models/Workflow');
const Sequence = require('../models/Sequence');
const { audit } = require('../utils/audit');
const { indiaDate } = require('../utils/dates');

// "Download CRM data": one JSON file with the organization's business records, for backups and
// for moving to another system. Deleted records, secrets (tokens, sessions, Gmail) and internal
// fields are left out; uploaded files are listed but not included (download them from Documents).
const SECTIONS = [
  ['contacts', Contact], ['products', Product], ['leads', Lead], ['leadActivities', LeadActivity],
  ['quotations', Quotation], ['tasks', Task], ['events', CalendarEvent], ['tickets', Ticket], ['notes', Note],
  ['documents', Document], ['campaigns', Campaign], ['workflows', Workflow], ['sequences', Sequence],
];
const HIDDEN_FIELDS = ['organizationId', '__v', 'deletedAt', 'storageKey'];

function clean(doc) {
  const copy = { ...doc };
  HIDDEN_FIELDS.forEach((field) => delete copy[field]);
  return copy;
}

function teamEntry(member) {
  return {
    id: member._id,
    name: member.displayName || member.userId?.name || '',
    email: member.userId?.email || '',
    role: member.role,
    title: member.title,
    mobile: member.mobile,
    modules: member.modules,
    permissions: member.permissions,
    status: member.status,
    joinedAt: member.createdAt,
  };
}

// Waits when the connection's buffer is full; false once the client has gone away.
async function send(res, chunk) {
  if (res.destroyed) return false;
  if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
  return !res.destroyed;
}

// Streams the file section by section, so a big organization never has to fit in memory.
async function streamExport(req, res) {
  const { organizationId } = req.tenant;
  const [organization, members] = await Promise.all([
    Organization.findById(organizationId).lean(),
    OrganizationMember.find({ organizationId }).populate({ path: 'userId', select: 'name email' }).lean(),
  ]);
  await audit(req, { action: 'export.crm', entityType: 'Organization', entityId: organizationId });

  res.attachment(`crm-export-${indiaDate()}.json`);
  res.type('application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    await send(res, `{"format":"yellow-crm-export","version":1,"exportedAt":${JSON.stringify(new Date())}`);
    await send(res, `,"organization":${JSON.stringify(clean(organization || {}))}`);
    await send(res, `,"team":${JSON.stringify(members.map(teamEntry))}`);
    for (const [name, Model] of SECTIONS) {
      if (!(await send(res, `,${JSON.stringify(name)}:[`))) return;
      let first = true;
      // deletedAt: null also matches collections without soft delete (the field is missing).
      for await (const doc of Model.find({ organizationId, deletedAt: null }).sort({ _id: 1 }).lean().cursor()) {
        if (!(await send(res, `${first ? '' : ','}${JSON.stringify(clean(doc))}`))) return;
        first = false;
      }
      await send(res, ']');
    }
    res.end('}');
  } catch (error) {
    // Headers are already sent: cut the download so a half file is never taken for a whole one.
    res.destroy(error);
  }
}

module.exports = { streamExport, SECTIONS };
