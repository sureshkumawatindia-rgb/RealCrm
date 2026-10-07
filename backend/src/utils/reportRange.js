const httpError = require('./httpError');
const { indiaDate } = require('./dates');

// Report date ranges (Phase 9): calendar days in India (YYYY-MM-DD), both ends included.
// start/end are the UTC instants of 00:00 IST on the first day and the day after the last.
const IST_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 3 * 366;

const dayStart = (day) => new Date(new Date(`${day}T00:00:00.000Z`).getTime() - IST_MS);
const istDay = (date) => new Date(new Date(date).getTime() + IST_MS).toISOString().slice(0, 10);

// { from?, to? } → { from, to, start, end, days, unit }. Default: the last 30 days.
function rangeOf({ from, to } = {}) {
  const last = to || indiaDate(0);
  const first = from || indiaDate(-29, new Date(`${last}T12:00:00.000Z`));
  const start = dayStart(first);
  const end = new Date(dayStart(last).getTime() + DAY_MS);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw httpError(400, 'VALIDATION_ERROR', 'The date range is not valid.', [{ field: 'from', code: 'INVALID_RANGE', message: 'The first day must not be after the last day.' }]);
  }
  const days = Math.round((end - start) / DAY_MS);
  if (days > MAX_DAYS) throw httpError(400, 'VALIDATION_ERROR', 'Choose at most three years.', [{ field: 'from', code: 'RANGE_TOO_LONG', message: 'At most three years.' }]);
  // Trend buckets: days for up to two months, weeks for up to ~7 months, then months.
  const unit = days <= 62 ? 'day' : days <= 210 ? 'week' : 'month';
  return { from: first, to: last, start, end, days, unit };
}

// The bucket a moment falls in: "2026-10-07" (day), the Monday of its week, or "2026-10" (month).
function bucketOf(date, unit) {
  const day = istDay(date);
  if (unit === 'month') return day.slice(0, 7);
  if (unit === 'week') {
    const d = new Date(`${day}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return day;
}

// Every bucket of the range, in order (so a chart has its empty days too).
function bucketsOf(range) {
  const keys = [];
  for (let t = range.start.getTime(); t < range.end.getTime(); t += DAY_MS) {
    const key = bucketOf(new Date(t), range.unit);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

module.exports = { rangeOf, bucketOf, bucketsOf, istDay, dayStart, DAY_MS };
