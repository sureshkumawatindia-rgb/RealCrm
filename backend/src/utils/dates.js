// Today's calendar day in India (YYYY-MM-DD), moved by a number of days. Tasks store calendar
// days as strings, so "due in 2 days" must be counted in IST, not in the server's timezone.
function indiaDate(addDays = 0, now = new Date()) {
  const india = new Date(now.getTime() + 330 * 60 * 1000);
  india.setUTCDate(india.getUTCDate() + Number(addDays || 0));
  return india.toISOString().slice(0, 10);
}

module.exports = { indiaDate };
