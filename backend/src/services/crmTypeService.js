const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const CustomObjectDefinition = require('../models/CustomObjectDefinition');
const Product = require('../models/Product');
const ProjectTemplate = require('../models/ProjectTemplate');
const projectService = require('./projectService');
const customFieldService = require('./customFieldService');
const customObjectService = require('./customObjectService');
const productService = require('./productService');
const gettingStartedService = require('./gettingStartedService');
const teamSettingsService = require('./teamSettingsService');
const { audit } = require('../utils/audit');
const { CRM_TYPE_SETUPS } = require('../constants/crmTypes');
const { KITS, KIT_LANGUAGES } = require('../constants/businessKits');
const { MAX_LIST_COLUMNS } = require('../constants/customFields');

// When a company chooses a CRM type (docs/CRM_TYPES_PLAN.md), the same CRM is set up for that kind
// of work: only what the company does not have yet is added, in the language of the person who
// chose it, and nothing is ever removed, so choosing a type again adds nothing twice.

const languageOf = (req) => (KIT_LANGUAGES.includes(req.user.preferences?.language) ? req.user.preferences.language : 'en');
const namesOf = (words) => [words.en, words.hi].map((word) => word.toLowerCase());
const has = (known, words) => namesOf(words).some((name) => known.has(name));

async function addProducts(req, products, lang) {
  const known = new Set((await Product.find({ organizationId: req.tenant.organizationId }).select('name').lean()).map((product) => product.name.toLowerCase()));
  let added = 0;
  for (const product of products) {
    if (has(known, product.name)) continue;
    await productService.create(req, { name: product.name[lang], unit: product.unit[lang], hsnSac: product.hsnSac, gstRatePct: product.gstRatePct, pricePaise: 0 });
    added += 1;
  }
  return added;
}

async function addFields(req, object, fields, lang) {
  const existing = await CustomFieldDefinition.find({ organizationId: req.tenant.organizationId, object }).select('label status listColumn').lean();
  const known = new Set(existing.map((field) => field.label.toLowerCase()));
  let columnsFree = MAX_LIST_COLUMNS - existing.filter((field) => field.status === 'active' && field.listColumn).length;
  let added = 0;
  for (const field of fields) {
    if (has(known, field.label)) continue;
    const listColumn = Boolean(field.listColumn) && columnsFree > 0;
    try {
      await customFieldService.create(req, {
        object,
        label: field.label[lang],
        type: field.type,
        listColumn,
        ...(field.options && { options: field.options.map((option) => ({ label: option[lang] })) }),
        ...(field.lookupTarget && { lookupTarget: field.lookupTarget }),
      });
    } catch (error) {
      if (error.code === 'FIELD_LIMIT') break; // the company's own fields stay; there is no room for more
      throw error;
    }
    if (listColumn) columnsFree -= 1;
    added += 1;
  }
  return added;
}

// Each object's fields together (customers, enquiries …), in the set-up's order.
async function addAllFields(req, fields, lang) {
  let added = 0;
  for (const object of new Set(fields.map((field) => field.object))) {
    added += await addFields(req, object, fields.filter((field) => field.object === object), lang);
  }
  return added;
}

// Each kind of record: made, or the company's own of that name. → how many were made, and each
// one's object key in the set-up's order (null when the company archived it or has no room).
async function addRecords(req, records, lang) {
  const existing = await CustomObjectDefinition.find({ organizationId: req.tenant.organizationId }).select('key singular plural status').lean();
  let added = 0;
  const keys = [];
  for (const record of records) {
    const names = new Set([...namesOf(record.singular), ...namesOf(record.plural)]);
    let object = existing.find((one) => names.has(one.plural.toLowerCase()) || names.has(one.singular.toLowerCase()));
    if (object?.status === 'archived') { // the company put it away
      keys.push(null);
      continue;
    }
    if (!object) {
      try {
        object = await customObjectService.create(req, { singular: record.singular[lang], plural: record.plural[lang], icon: record.icon });
        added += 1;
      } catch (error) {
        if (error.code !== 'OBJECT_LIMIT') throw error;
        keys.push(null);
        continue;
      }
    }
    await addFields(req, object.key, record.fields, lang);
    keys.push(object.key);
  }
  return { added, keys };
}

// A field that links to one of the set-up's own records ({ lookupRecord: index }) links to that
// record's object; with no such object it is left out.
const linkedTo = (fields, keys) => fields
  .map((field) => (field.lookupRecord === undefined ? field : keys[field.lookupRecord] && { ...field, lookupTarget: keys[field.lookupRecord] }))
  .filter(Boolean);

// Project templates (Projects, D92): a won enquiry becomes a project with these steps in one click.
async function addProjectTemplates(req, templates, lang) {
  const known = new Set((await ProjectTemplate.find({ organizationId: req.tenant.organizationId }).select('name').lean()).map((template) => template.name.toLowerCase()));
  let added = 0;
  for (const template of templates) {
    if (has(known, template.name)) continue;
    await projectService.createTemplate(req, {
      name: template.name[lang],
      days: template.days,
      milestones: template.milestones.map((milestone) => ({ name: milestone.name[lang], dueAfterDays: milestone.dueAfterDays })),
      tasks: template.tasks.map((task) => ({ title: task.title[lang], milestone: task.milestone, dueAfterDays: task.dueAfterDays, priority: task.priority, forManager: true })),
    });
    added += 1;
  }
  return added;
}

// Pages the new type does not use leave the menu; those the old type had hidden come back.
async function updateMenu(req, hide = [], show = []) {
  const { hiddenModules } = await teamSettingsService.getSettings(req);
  const next = [...new Set([...hiddenModules.filter((module) => !show.includes(module)), ...hide])];
  await teamSettingsService.updateSettings(req, { hiddenModules: next });
}

// Called before the new type is saved: if a step fails the type stays as it was, and saving again
// finishes the set-up.
async function change(req, from, to) {
  const setup = CRM_TYPE_SETUPS[to];
  const lang = languageOf(req);
  let added = {};
  if (setup) {
    const kit = KITS[to] ? await gettingStartedService.applyKit(req, { kit: to, language: lang }) : null;
    const products = await addProducts(req, setup.products, lang);
    const records = await addRecords(req, setup.records, lang); // first: a field may link to one
    added = {
      kit,
      products,
      records: records.added,
      fields: await addAllFields(req, linkedTo(setup.fields, records.keys), lang),
      projectTemplates: await addProjectTemplates(req, setup.projectTemplates || [], lang),
    };
  }
  await updateMenu(req, setup?.hiddenModules, CRM_TYPE_SETUPS[from]?.hiddenModules);
  await audit(req, { action: 'organization.crm_type_changed', entityType: 'Organization', entityId: req.tenant.organizationId, changes: { from, to, ...added } });
}

module.exports = { change };
