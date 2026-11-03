// Helpers for list endpoints: text search and allowlisted sorting.

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// { $or: [{ name: /q/i }, ...] } for a search term, or {} when there is none.
function searchFilter(q, fields) {
  const term = String(q || '').trim();
  if (!term) return {};
  const pattern = new RegExp(escapeRegex(term.slice(0, 100)), 'i');
  return { $or: fields.map((field) => ({ [field]: pattern })) };
}

// "name" → { name: 1 }, "-createdAt" → { createdAt: -1 }; anything not allowed → the default.
function sortSpec(sort, allowed, fallback = { createdAt: -1 }) {
  if (!sort) return fallback;
  const descending = sort.startsWith('-');
  const field = descending ? sort.slice(1) : sort;
  if (!allowed.includes(field)) return fallback;
  return { [field]: descending ? -1 : 1, _id: descending ? -1 : 1 };
}

// "Select all" in the Leads and Customers lists (Phase 3, D115): at most this many matching ids,
// the bulk actions' own limit (D100).
const MATCH_MAX = 5000;

module.exports = { escapeRegex, searchFilter, sortSpec, MATCH_MAX };
