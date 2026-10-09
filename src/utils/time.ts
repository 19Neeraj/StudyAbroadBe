/** Offset (ms) of `timeZone` from UTC at the given instant, e.g. +19_800_000 for Asia/Kolkata. */
export function tzOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Midnight (start of the local day) in `timeZone` for the day containing `at`, as a UTC instant. */
export function startOfDayInTz(timeZone: string, at: Date = new Date()): Date {
  const local = new Date(at.getTime() + tzOffsetMs(timeZone, at));
  local.setUTCHours(0, 0, 0, 0);
  // Re-evaluate the offset at local midnight (differs across DST changes).
  const guess = new Date(local.getTime() - tzOffsetMs(timeZone, at));
  return new Date(local.getTime() - tzOffsetMs(timeZone, guess));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Local calendar parts of `at` in `timeZone`. */
export function localParts(timeZone: string, at: Date = new Date()) {
  const local = new Date(at.getTime() + tzOffsetMs(timeZone, at));
  return { year: local.getUTCFullYear(), month: local.getUTCMonth(), day: local.getUTCDate(), weekday: local.getUTCDay() };
}

/** Start of the local day `year-month-day` (month 0-based, may overflow) in `timeZone`, as a UTC instant. */
export function startOfLocalDate(timeZone: string, year: number, month: number, day: number): Date {
  // Local noon is inside the wanted day whatever the offset, so it anchors startOfDayInTz safely.
  const noonUtc = Date.UTC(year, month, day, 12);
  return startOfDayInTz(timeZone, new Date(noonUtc - tzOffsetMs(timeZone, new Date(noonUtc))));
}

export const PERIOD_PRESETS = [
  'today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'last_30_days',
  'previous_month', 'this_quarter', 'this_year', 'all_time', 'custom',
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export interface PeriodRange {
  /** null for all_time. */
  from: Date | null;
  /** Exclusive upper bound. */
  to: Date;
  /** The equally long period right before (null for all_time). */
  previous: { from: Date; to: Date } | null;
}

/**
 * Resolves a dashboard period in the organization's time zone. Weeks start on Monday.
 * Calendar presets compare against the previous calendar period (this month → last month);
 * rolling and custom ranges compare against the window of the same length just before.
 */
export function resolvePeriod(
  preset: PeriodPreset,
  timeZone: string,
  custom: { from?: Date; to?: Date } = {},
  now: Date = new Date(),
): PeriodRange {
  const { year, month, day, weekday } = localParts(timeZone, now);
  const today = startOfLocalDate(timeZone, year, month, day);
  const tomorrow = startOfLocalDate(timeZone, year, month, day + 1);
  const rolling = (from: Date, to: Date): PeriodRange => {
    const len = to.getTime() - from.getTime();
    return { from, to, previous: { from: new Date(from.getTime() - len), to: from } };
  };
  const calendar = (from: Date, to: Date, prevFrom: Date): PeriodRange => ({ from, to, previous: { from: prevFrom, to: from } });

  switch (preset) {
    case 'today':
      return rolling(today, tomorrow);
    case 'yesterday':
      return rolling(startOfLocalDate(timeZone, year, month, day - 1), today);
    case 'this_week': {
      const monday = startOfLocalDate(timeZone, year, month, day - ((weekday + 6) % 7));
      return calendar(monday, tomorrow, startOfLocalDate(timeZone, year, month, day - ((weekday + 6) % 7) - 7));
    }
    case 'last_7_days':
      return rolling(startOfLocalDate(timeZone, year, month, day - 6), tomorrow);
    case 'last_30_days':
      return rolling(startOfLocalDate(timeZone, year, month, day - 29), tomorrow);
    case 'this_month':
      return calendar(startOfLocalDate(timeZone, year, month, 1), tomorrow, startOfLocalDate(timeZone, year, month - 1, 1));
    case 'previous_month':
      return calendar(startOfLocalDate(timeZone, year, month - 1, 1), startOfLocalDate(timeZone, year, month, 1), startOfLocalDate(timeZone, year, month - 2, 1));
    case 'this_quarter': {
      const q = month - (month % 3);
      return calendar(startOfLocalDate(timeZone, year, q, 1), tomorrow, startOfLocalDate(timeZone, year, q - 3, 1));
    }
    case 'this_year':
      return calendar(startOfLocalDate(timeZone, year, 0, 1), tomorrow, startOfLocalDate(timeZone, year - 1, 0, 1));
    case 'all_time':
      return { from: null, to: tomorrow, previous: null };
    case 'custom': {
      const from = custom.from ? startOfDayInTz(timeZone, custom.from) : startOfLocalDate(timeZone, year, month, 1);
      const toDay = custom.to ?? now;
      const to = addDays(startOfDayInTz(timeZone, toDay), 1);
      return rolling(from, to > from ? to : addDays(from, 1));
    }
  }
}
