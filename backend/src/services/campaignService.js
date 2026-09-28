const Campaign = require('../models/Campaign');
const httpError = require('../utils/httpError');
const { createOwnedRecordService } = require('./ownedRecordService');

// Campaigns show on Marketing, the dashboard and reports.
const MODULES = ['marketing', 'dashboard', 'reports'];

function serializeCampaign(campaign) {
  return {
    id: campaign._id,
    name: campaign.name,
    type: campaign.type,
    status: campaign.status,
    startDate: campaign.startDate || '',
    endDate: campaign.endDate || '',
    budgetPaise: campaign.budgetPaise,
    leadsGenerated: campaign.leadsGenerated,
    audience: campaign.audience,
    description: campaign.description,
    ownerId: campaign.ownerId || null,
    createdByMemberId: campaign.createdByMemberId || null,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}

module.exports = {
  MODULES,
  serializeCampaign,
  ...createOwnedRecordService({
    Model: Campaign,
    modules: MODULES,
    entityType: 'Campaign',
    label: 'Campaign',
    fields: ['name', 'type', 'status', 'startDate', 'endDate', 'budgetPaise', 'leadsGenerated', 'audience', 'description'],
    searchFields: ['name', 'audience', 'description'],
    sorts: ['startDate', 'createdAt', 'updatedAt', 'name', 'budgetPaise', 'status'],
    defaultSort: { createdAt: -1 },
    filters: (query) => ({
      ...(query.type && { type: query.type }),
      ...(query.status && { status: query.status }),
      ...(query.ownerId && { ownerId: query.ownerId }),
      ...((query.startFrom || query.startTo) && { startDate: { ...(query.startFrom && { $gte: query.startFrom }), ...(query.startTo && { $lte: query.startTo }) } }),
    }),
    prepare(campaign) {
      if (campaign.startDate && campaign.endDate && campaign.endDate < campaign.startDate) {
        throw httpError(400, 'VALIDATION_ERROR', 'The end date is before the start date.', [{ field: 'endDate', code: 'END_BEFORE_START', message: 'Pick an end date on or after the start date.' }]);
      }
    },
    serialize: serializeCampaign,
  }),
};
