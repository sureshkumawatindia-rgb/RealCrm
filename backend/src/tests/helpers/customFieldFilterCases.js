// Phase 1B (D74): one table of filter cases, checked on the server (?cf= on /contacts) and in the
// browser (crm/frontend/js/custom-fields.js cfMatches), so both always give the same answer.
// Fields are created in this order; dropdown choices get the values o1, o2, o3.
const FIELDS = [
  { label: 'Model', type: 'text' },
  { label: 'Notes', type: 'textarea' },
  { label: 'Credit', type: 'number' },
  { label: 'Visit', type: 'date' },
  { label: 'Dealer', type: 'dropdown', options: [{ label: 'Retail' }, { label: 'Wholesale' }, { label: 'Distributor' }] },
  { label: 'GST', type: 'checkbox' },
];

// Record name → its values (keys come from the labels: model, notes, credit …).
const RECORDS = {
  A: { model: 'CNC-200', notes: 'Gate 2', credit: 30, visit: '2026-10-20', dealer: 'o2', gst: true },
  B: { model: 'cnc-100 lathe', credit: 45.5, visit: '2026-11-01', dealer: 'o1' },
  C: { notes: 'Ask for Ravi', credit: -5, dealer: 'o3' },
  D: {},
};

// cf filter → the records it must find.
const CASES = [
  ['model:has:cnc', ['A', 'B']],
  ['model:is:cnc-200', ['A']],
  ['model:is:CNC', []],
  ['model:empty', ['C', 'D']],
  ['model:filled', ['A', 'B']],
  ['notes:has:RAVI', ['C']],
  ['notes:has:gate 2', ['A']],
  ['credit:eq:30', ['A']],
  ['credit:gt:30', ['B']],
  ['credit:gte:30', ['A', 'B']],
  ['credit:lt:30', ['C']],
  ['credit:lte:1,25,000', ['A', 'B', 'C']],
  ['credit:empty', ['D']],
  ['visit:eq:2026-10-20', ['A']],
  ['visit:before:2026-11-01', ['A']],
  ['visit:after:2026-10-20', ['B']],
  ['visit:from:2026-10-20', ['A', 'B']],
  ['visit:to:2026-10-31', ['A']],
  ['visit:empty', ['C', 'D']],
  ['dealer:in:o1,o3', ['B', 'C']],
  ['dealer:in:o2', ['A']],
  ['dealer:empty', ['D']],
  ['dealer:filled', ['A', 'B', 'C']],
  ['gst:yes', ['A']],
  ['gst:no', ['B', 'C', 'D']],
];

module.exports = { FIELDS, RECORDS, CASES };
