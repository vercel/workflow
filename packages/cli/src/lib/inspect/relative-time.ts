const MINUTES_IN_DAY = 1440;
const MINUTES_IN_ALMOST_TWO_DAYS = 2520;
const MINUTES_IN_MONTH = 43200;
const MINUTES_IN_TWO_MONTHS = 86400;

const plural = (count: number, unit: string) =>
  `${count} ${unit}${count === 1 ? '' : 's'}`;

/**
 * Whole months from `earlier` to `later` (`later >= earlier`), the way
 * `differenceInMonths` from `date-fns` counts them: step `later` back by the
 * calendar month difference and drop the last month if that lands before
 * `earlier`.
 */
function monthsBetween(earlier: Date, later: Date): number {
  const months =
    (later.getFullYear() - earlier.getFullYear()) * 12 +
    (later.getMonth() - earlier.getMonth());
  if (months < 1) return 0;
  const steppedBack = new Date(later.getTime());
  if (steppedBack.getMonth() === 1 && steppedBack.getDate() > 27) {
    steppedBack.setDate(30);
  }
  steppedBack.setMonth(steppedBack.getMonth() - months);
  return steppedBack.getTime() < earlier.getTime() ? months - 1 : months;
}

function yearsInWords(months: number): string {
  const years = Math.trunc(months / 12);
  const remainder = months % 12;
  if (remainder < 3) return `about ${plural(years, 'year')}`;
  if (remainder < 9) return `over ${plural(years, 'year')}`;
  return `almost ${plural(years + 1, 'year')}`;
}

function distanceInWords(minutes: number, earlier: Date, later: Date): string {
  if (minutes < 1) return 'less than a minute';
  if (minutes < 45) return plural(minutes, 'minute');
  if (minutes < 90) return 'about 1 hour';
  if (minutes < MINUTES_IN_DAY) {
    return `about ${plural(Math.round(minutes / 60), 'hour')}`;
  }
  if (minutes < MINUTES_IN_ALMOST_TWO_DAYS) return '1 day';
  if (minutes < MINUTES_IN_MONTH) {
    return plural(Math.round(minutes / MINUTES_IN_DAY), 'day');
  }
  if (minutes < MINUTES_IN_TWO_MONTHS) {
    return `about ${plural(Math.round(minutes / MINUTES_IN_MONTH), 'month')}`;
  }
  const months = monthsBetween(earlier, later);
  if (months < 12) {
    return plural(Math.round(minutes / MINUTES_IN_MONTH), 'month');
  }
  return yearsInWords(months);
}

/**
 * The distance between two dates in words, with a suffix ("3 minutes ago",
 * "in about 2 hours"). It uses the same thresholds and wording as
 * `formatDistance(date, baseDate, { addSuffix: true })` from `date-fns`,
 * which this replaces so the CLI does not install date-fns for one call.
 */
export function formatRelativeTime(date: Date, baseDate: Date): string {
  const future = date.getTime() > baseDate.getTime();
  const [earlier, later] = future ? [baseDate, date] : [date, baseDate];

  // Whole seconds, rounded toward zero (like `differenceInSeconds`), net of
  // any time zone offset change in between (a DST shift).
  const seconds = Math.trunc((later.getTime() - earlier.getTime()) / 1000);
  const offsetSeconds =
    (later.getTimezoneOffset() - earlier.getTimezoneOffset()) * 60;
  const minutes = Math.round((seconds - offsetSeconds) / 60);

  const words = distanceInWords(minutes, earlier, later);
  return future ? `in ${words}` : `${words} ago`;
}
