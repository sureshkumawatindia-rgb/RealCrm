const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

// A Google Sheet the CRM fills (G4, D108, services/sheetSyncService.js): the company's new leads or
// new orders go to the end of a sheet the CRM made in the Google Drive of the owner or admin who
// switched it on (userId, memberId; googleEmail is that Google account), through their own Google
// connection. cursorAt/cursorId: the last record sent (its createdAt and id); what comes after goes
// next. Paused (pausedReason: GOOGLE_RECONNECT, GOOGLE_NO_DRIVE, SHEET_GONE, MEMBER_GONE) until
// Resume; stopping removes this record and leaves the sheet in their Drive. One per company and kind.
const sheetSyncSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    kind: { type: String, enum: ['leads', 'orders'], required: true },
    userId: { type: ObjectId, ref: 'User', required: true },
    memberId: { type: ObjectId, ref: 'OrganizationMember', required: true },
    googleEmail: { type: String, default: '' },
    spreadsheetId: { type: String, required: true },
    sheetId: { type: Number, default: 0 }, // the tab's id: renaming the tab changes nothing
    url: { type: String, required: true },
    title: { type: String, default: '' },
    status: { type: String, enum: ['active', 'paused'], default: 'active' },
    pausedReason: { type: String, default: '' },
    cursorAt: { type: Date, required: true },
    cursorId: { type: ObjectId },
    rowsAdded: { type: Number, default: 0 },
    lastRowAt: { type: Date },
    lastRunAt: { type: Date },
    lastError: { type: String, default: '' },
  },
  { timestamps: true },
);
sheetSyncSchema.index({ organizationId: 1, kind: 1 }, { unique: true });
sheetSyncSchema.index({ status: 1 });

module.exports = mongoose.model('SheetSync', sheetSyncSchema);
