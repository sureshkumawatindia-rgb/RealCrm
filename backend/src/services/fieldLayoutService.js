const mongoose = require('mongoose');
const CustomFieldLayout = require('../models/CustomFieldLayout');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { can, isManager } = require('../constants/permissions');
const { modulesOf, MAX_SECTIONS } = require('../constants/customFields');
const customFieldService = require('./customFieldService');

// Sections (Phase 1D, D76): how an object's custom fields are grouped in the forms. Everyone who
// can view the object reads them (the forms draw them); owners and admins change them in
// Settings → Custom fields. Removing a section never removes a field: it moves to "More details".

const forbidden = () => httpError(403, 'FORBIDDEN', 'You do not have permission to do this.');
const scope = (req, filter = {}) => ({ ...filter, organizationId: req.tenant.organizationId });
const conflict = () => httpError(409, 'VERSION_CONFLICT', 'Someone else changed the sections. Reload and try again.');
const invalidSection = (message) => httpError(400, 'VALIDATION_ERROR', message, [{ field: 'sections', code: 'INVALID_SECTION', message }]);

function serialize(object, layout) {
  return {
    object,
    sections: (layout?.sections || []).map((s) => ({ id: s.id, label: s.label, columns: s.columns || 1 })),
    version: layout?.version ?? 0,
  };
}

async function get(req, { object }) {
  if (!modulesOf(object).some((module) => can(req.member, module, 'view'))) throw forbidden();
  await customFieldService.assertObject(req, object, { activeOnly: !isManager(req.member) });
  return serialize(object, await CustomFieldLayout.findOne(scope(req, { object })).lean());
}

// PUT /custom-fields/layout: the whole list of sections, in order. A section without an id is
// new; one left out is removed. fieldIds (optional, per section): exactly the fields that are in
// that section from now on; a field in no section is shown under "More details".
async function put(req, { object, sections, version }) {
  await customFieldService.assertObject(req, object);
  if (sections.length > MAX_SECTIONS) throw httpError(422, 'SECTION_LIMIT', `Up to ${MAX_SECTIONS} sections per page. Remove one first.`);
  let saved;
  try {
    await mongoose.connection.transaction(async (session) => {
      saved = null;
      const layout = await CustomFieldLayout.findOne(scope(req, { object })).session(session);
      const current = layout?.version ?? 0;
      if (version !== undefined && version !== current) throw conflict();
      const known = new Set((layout?.sections || []).map((s) => s.id));
      let last = layout?.lastSectionNumber || 0;
      const ids = new Set();
      const next = sections.map((s) => {
        if (s.id !== undefined && (!known.has(s.id) || ids.has(s.id))) throw invalidSection('A section in the list is unknown or repeated. Reload and try again.');
        const id = s.id ?? `s${(last += 1)}`;
        ids.add(id);
        return { id, label: s.label, columns: s.columns || 1, fieldIds: s.fieldIds };
      });

      // Where each field of the object goes now. fieldIds lists active fields only; an archived
      // field stays in its section while the section exists.
      const fields = await CustomFieldDefinition.find(scope(req, { object })).select('_id sectionId status').session(session);
      const active = new Set(fields.filter((f) => f.status === 'active').map((f) => String(f._id)));
      const placed = new Map();
      for (const s of next) {
        for (const fieldId of s.fieldIds || []) {
          if (!active.has(fieldId) || placed.has(fieldId)) throw invalidSection('A field is unknown or in two sections. Reload and try again.');
          placed.set(fieldId, s.id);
        }
      }
      const listed = new Set(next.filter((s) => s.fieldIds).map((s) => s.id));
      const writes = [];
      for (const field of fields) {
        const fieldId = String(field._id);
        const stays = ids.has(field.sectionId) && (field.status !== 'active' || !listed.has(field.sectionId));
        const target = placed.get(fieldId) ?? (stays ? field.sectionId : undefined);
        if ((field.sectionId || undefined) === target) continue;
        writes.push({ updateOne: { filter: scope(req, { _id: field._id }), update: target ? { $set: { sectionId: target } } : { $unset: { sectionId: 1 } } } });
      }
      if (writes.length) await CustomFieldDefinition.bulkWrite(writes, { session });

      const doc = { sections: next.map(({ id, label, columns }) => ({ id, label, columns })), lastSectionNumber: last, updatedById: req.user._id };
      if (layout) {
        saved = await CustomFieldLayout.findOneAndUpdate(scope(req, { _id: layout._id, version: current }), { $set: doc, $inc: { version: 1 } }, { returnDocument: 'after', session });
        if (!saved) throw conflict();
      } else {
        [saved] = await CustomFieldLayout.create([{ ...doc, organizationId: req.tenant.organizationId, object, version: 1 }], { session });
      }
    });
  } catch (error) {
    if (error.code === 11000) throw conflict(); // two admins made the first sections at the same moment
    throw error;
  }
  await audit(req, { action: 'custom_field.layout_updated', entityType: 'CustomFieldLayout', entityId: saved._id, changes: { object, sections: saved.sections.length } });
  return serialize(object, saved);
}

module.exports = { get, put, serialize };
