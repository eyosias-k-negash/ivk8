/** Default timezone per Day 0 decision: GMT+3. Overridable per request. */
export const DEFAULT_TZ = '+03:00';

export type Granularity = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

/**
 * Parse a fixed UTC offset into milliseconds.
 * Accepts: "+03:00", "+0300", "+3", "GMT+3", "UTC-05:30", "Z".
 * Fixed offsets only (no DST rules); IANA zone support can be added later.
 */
export function parseTzOffsetMs(tz: string = DEFAULT_TZ): number {
  const s = tz.trim();
  if (/^(z|utc|gmt)$/i.test(s)) return 0;
  const m = /^(?:gmt|utc)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(s);
  if (!m) throw new Error(`Invalid timezone offset: "${tz}"`);
  const hours = Number(m[2]);
  const minutes = m[3] ? Number(m[3]) : 0;
  if (hours > 14 || minutes > 59) throw new Error(`Invalid timezone offset: "${tz}"`);
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (hours * 60 + minutes) * 60_000;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Bucket key for an instant, in the given offset. Weeks start Monday; key is the Monday's date. */
export function bucketKey(ms: number, granularity: Granularity, tz: string = DEFAULT_TZ): string {
  const d = new Date(ms + parseTzOffsetMs(tz)); // read with getUTC* = local wall clock
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  switch (granularity) {
    case 'YEAR':
      return String(y);
    case 'MONTH':
      return `${y}-${pad(mo)}`;
    case 'DAY':
      return `${y}-${pad(mo)}-${pad(day)}`;
    case 'WEEK': {
      const sinceMonday = (d.getUTCDay() + 6) % 7;
      const monday = new Date(Date.UTC(y, mo - 1, day - sinceMonday));
      return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
    }
  }
}

export interface MonthRange {
  /** Inclusive UTC ms of local month start (1st 00:00). */
  startMs: number;
  /** Exclusive UTC ms of next local month start. */
  endMs: number;
  daysInMonth: number;
  /** 1-based day of month for the reference instant, in local time. */
  dayOfMonth: number;
}

/** Calendar month containing `ms`, in the given offset. Budgets use this (Day 0 decision 2). */
export function monthRange(ms: number, tz: string = DEFAULT_TZ): MonthRange {
  const off = parseTzOffsetMs(tz);
  const d = new Date(ms + off);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    startMs: Date.UTC(y, m, 1) - off,
    endMs: Date.UTC(y, m + 1, 1) - off,
    daysInMonth: new Date(Date.UTC(y, m + 1, 0)).getUTCDate(),
    dayOfMonth: d.getUTCDate(),
  };
}
