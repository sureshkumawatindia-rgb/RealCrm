// Projects after the sale (Phase 10, D92).
const PROJECT_STATUSES = Object.freeze(['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled']);
const OPEN_PROJECT_STATUSES = Object.freeze(['not_started', 'in_progress', 'on_hold']);
const MAX_MILESTONES = 50;
const MAX_TEMPLATE_TASKS = 100;
const MAX_TEAM = 30;

module.exports = { PROJECT_STATUSES, OPEN_PROJECT_STATUSES, MAX_MILESTONES, MAX_TEMPLATE_TASKS, MAX_TEAM };
