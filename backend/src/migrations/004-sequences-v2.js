const Sequence = require('../models/Sequence');
const { convertLegacySequence } = require('../services/automation/legacy');

// Phase 2 sequences (day + Email/Call/Task/Wait + note, "applies to") get the Phase 6B shape:
// day + workflow action. They come over paused (D32), with notes on what could not be carried
// over (emails); the old enroll count is kept. Idempotent: only sequences without
// schemaVersion 2 are touched (deleted ones too, so the collection has one shape).
async function up() {
  const cursor = Sequence.collection.find({ schemaVersion: { $ne: 2 } });
  let updated = 0;
  for await (const doc of cursor) {
    const { steps, notes } = convertLegacySequence({ steps: Array.isArray(doc.steps) ? doc.steps : [] });
    if (doc.status === 'Active') notes.unshift('This sequence was moved to the new follow-up engine and paused: check its steps, then turn it on.');
    await Sequence.collection.updateOne({ _id: doc._id }, {
      $set: {
        steps,
        notes: [...(Array.isArray(doc.notes) ? doc.notes : []), ...notes],
        status: doc.status === 'Active' ? 'Paused' : doc.status || 'Draft',
        stopOnReply: true,
        stopOnClose: true,
        workingHoursOnly: true,
        stats: { enrolled: doc.enrolledCount || 0, active: 0, completed: 0, stopped: 0, failed: 0, ...(doc.lastEnrolledAt && { lastEnrolledAt: doc.lastEnrolledAt }) },
        schemaVersion: 2,
      },
      $unset: { targetType: '', enrolledCount: '', lastEnrolledAt: '' },
    });
    updated += 1;
  }
  return { updated };
}

module.exports = { name: '004-sequences-v2', up };
