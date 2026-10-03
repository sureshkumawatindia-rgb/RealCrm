const Workflow = require('../models/Workflow');
const { convertLegacyWorkflow } = require('../services/automation/legacy');

// Phase 2 workflows (a trigger text and actions with a free-text detail) get the Phase 6 shape
// (trigger type + params, conditions, steps). They come over paused (D32): the old ones never
// really ran, so nobody should get messages from them before a person checks them. What has
// no equivalent is listed in `notes`. Run counts are kept. Idempotent: only workflows without
// schemaVersion 2 are touched (deleted ones too, so the collection has one shape).
async function up() {
  const cursor = Workflow.collection.find({ schemaVersion: { $ne: 2 } });
  let updated = 0;
  for await (const doc of cursor) {
    const legacyTrigger = typeof doc.trigger === 'string' ? doc.trigger : '';
    const { trigger, steps, notes } = convertLegacyWorkflow({ trigger: legacyTrigger, actions: Array.isArray(doc.actions) ? doc.actions : [] });
    if (doc.status === 'Active') notes.unshift('This workflow was moved to the new automation engine and paused: check its steps, then turn it on.');
    await Workflow.collection.updateOne({ _id: doc._id }, {
      $set: {
        trigger,
        conditions: [],
        steps,
        notes: [...(Array.isArray(doc.notes) ? doc.notes : []), ...notes],
        status: doc.status === 'Active' ? 'Paused' : doc.status || 'Draft',
        stats: { runs: doc.runsCount || 0, done: 0, failed: 0, ...(doc.lastRunAt && { lastRunAt: doc.lastRunAt }) },
        schemaVersion: 2,
      },
      $unset: { actions: '', runsCount: '', lastRunAt: '' },
    });
    updated += 1;
  }
  return { updated };
}

module.exports = { name: '003-workflows-v2', up };
