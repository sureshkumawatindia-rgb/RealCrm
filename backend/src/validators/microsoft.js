const Joi = require('joi');
const { TEAMS_EVENTS } = require('../constants/microsoft');

// Microsoft 365 and Teams (Phase 4B, D83). The address itself is checked in the service (a Teams
// host, https, not a private network).
const events = Joi.array().items(Joi.string().valid(...TEAMS_EVENTS)).unique().max(TEAMS_EVENTS.length);

module.exports = {
  teamsCreate: Joi.object({
    name: Joi.string().trim().min(1).max(100).required(),
    url: Joi.string().trim().max(2000).required(),
    events: events.min(1).required(),
  }),
  teamsPatch: Joi.object({
    name: Joi.string().trim().min(1).max(100),
    url: Joi.string().trim().max(2000),
    events: events.min(1),
    active: Joi.boolean(),
  }).min(1),
};
