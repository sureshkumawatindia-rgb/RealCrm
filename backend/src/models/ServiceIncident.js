const mongoose = require('mongoose');
const { INCIDENT_SERVICES, INCIDENT_LEVELS } = require('../constants/serviceStatus');

// Something wrong (or worth saying) on the status page and in the banners (Phase 9, D151):
// source "auto" — found by services/serviceStatusService.js; "manual" — a notice the platform's
// admin wrote (maintenance, a known problem), in English and Hindi. endedAt empty: it is on now.
// until: a notice ends by itself then. Kept 6 months.
const words = { en: { type: String, trim: true, default: '' }, hi: { type: String, trim: true, default: '' } };

const serviceIncidentSchema = new mongoose.Schema(
  {
    service: { type: String, enum: INCIDENT_SERVICES, required: true },
    source: { type: String, enum: ['auto', 'manual'], required: true },
    level: { type: String, enum: INCIDENT_LEVELS, required: true },
    title: words,
    body: words,
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    until: { type: Date },
    by: { type: String, default: '' },
  },
  { timestamps: true },
);

serviceIncidentSchema.index({ endedAt: 1, startedAt: -1 });
serviceIncidentSchema.index({ startedAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('ServiceIncident', serviceIncidentSchema);
