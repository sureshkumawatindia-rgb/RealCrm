// Boards (Phase 7B, D87): saved views of leads or tasks as a table, a Kanban board or a calendar.
// Each object lists the fields a view may show (the company's own lead fields are added as
// "cf.<key>"), what a Kanban board may group by, which date a calendar uses, and its filters.
const BOARD_LAYOUTS = Object.freeze(['table', 'kanban', 'calendar']);

const BOARD_OBJECTS = Object.freeze({
  lead: {
    modules: ['leads', 'deals'],
    fields: ['title', 'contact', 'company', 'phone', 'stage', 'source', 'owner', 'value', 'expectedCloseDate', 'followUpAt', 'probability', 'lastActivityAt', 'createdAt'],
    defaultColumns: ['title', 'contact', 'stage', 'value', 'owner', 'followUpAt'],
    groupBy: ['stage', 'source', 'owner'],
    dateFields: ['followUpAt', 'expectedCloseDate', 'createdAt'],
    sorts: ['createdAt', 'updatedAt', 'expectedValuePaise', 'expectedCloseDate', 'followUpAt', 'stage', 'title'],
    customFields: true,
  },
  task: {
    modules: ['tasks'],
    fields: ['title', 'status', 'priority', 'dueDate', 'assignee', 'related', 'createdAt'],
    defaultColumns: ['title', 'status', 'priority', 'dueDate', 'assignee'],
    groupBy: ['status', 'priority', 'assignee'],
    dateFields: ['dueDate', 'createdAt'],
    sorts: ['dueDate', 'createdAt', 'updatedAt', 'priority', 'title'],
    customFields: false,
  },
});
const BOARD_OBJECT_KEYS = Object.freeze(Object.keys(BOARD_OBJECTS));
const MAX_COLUMNS = 12;
const MAX_VIEWS_PER_MEMBER = 30;
const MAX_SHARED_VIEWS = 50;
// A board shows at most this many records at once (Kanban and calendar read them all).
const MAX_BOARD_ITEMS = 300;

module.exports = { BOARD_LAYOUTS, BOARD_OBJECTS, BOARD_OBJECT_KEYS, MAX_COLUMNS, MAX_VIEWS_PER_MEMBER, MAX_SHARED_VIEWS, MAX_BOARD_ITEMS };
