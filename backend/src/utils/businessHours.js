// The organization's working hours (assignment rules can send leads outside them to a fallback
// person). Days are 0 (Sunday) … 6 (Saturday); times are "HH:MM" in the organization's time zone.
const DEFAULT_BUSINESS_HOURS = Object.freeze({ timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '19:00' });
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const minutesOf = (time) => {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
};

function validTimeZone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function businessHoursOf(organization) {
  const saved = organization?.businessHours || {};
  return { ...DEFAULT_BUSINESS_HOURS, ...saved, days: Array.isArray(saved.days) ? saved.days : [...DEFAULT_BUSINESS_HOURS.days] };
}

// Weekday and minute of the day in the given time zone.
function localClock(date, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).map((part) => [part.type, part.value]),
  );
  return { day: WEEKDAYS[parts.weekday], minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function isOpen(hours, date = new Date()) {
  const { day, minute } = localClock(date, hours.timezone || DEFAULT_BUSINESS_HOURS.timezone);
  return hours.days.includes(day) && minute >= minutesOf(hours.start) && minute < minutesOf(hours.end);
}

// The moment the organization is next open (the date itself when open now): sequence steps due
// at night wait for the morning. Without working days it is the date itself.
function nextOpening(hours, date = new Date()) {
  if (!hours.days?.length || isOpen(hours, date)) return date;
  const { day, minute } = localClock(date, hours.timezone || DEFAULT_BUSINESS_HOURS.timezone);
  const start = minutesOf(hours.start);
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    if (!hours.days.includes((day + ahead) % 7) || (ahead === 0 && minute >= start)) continue;
    const opening = new Date(date.getTime() + (ahead * 1440 + start - minute) * 60 * 1000);
    opening.setSeconds(0, 0);
    return opening;
  }
  return date;
}

module.exports = { DEFAULT_BUSINESS_HOURS, businessHoursOf, isOpen, nextOpening, validTimeZone, minutesOf };
