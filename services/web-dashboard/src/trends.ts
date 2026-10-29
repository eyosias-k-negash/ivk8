import type { Granularity, TimeseriesData, TimeseriesPoint } from '@ivy/contracts';
import { offsetMs } from './format';

/** The repeating calendar positions the Trends tab folds a range into. */
export type Pattern = 'monthOfYear' | 'weekOfYear' | 'dayOfYear' | 'weekOfMonth' | 'dayOfMonth' | 'dayOfWeek';

/** "total" adds up every occurrence of a slot; "average" divides that by how many times the slot occurs in the range. */
export type Aggregate = 'total' | 'average';

interface PatternSpec {
  label: string;
  /** What one slot is, for KPI wording: "Highest month". */
  unit: string;
  /** The coarsest API bucket that still pins down the slot. */
  granularity: Granularity;
  /** Every slot's label, in calendar order. */
  slots: string[];
  /** Slot index of a local date (its UTC fields hold the wall clock). */
  slot: (d: Date) => number;
  /** The cycle a local date falls in (its year, month, week). One slot in one cycle is one occurrence. */
  cycle: (d: Date) => string;
}

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** Days before each month in a leap year: day-of-year slots are calendar dates, Feb 29 included. */
const LEAP_START = MONTHS.map((_, m) => (Date.UTC(2000, m, 1) - Date.UTC(2000, 0, 1)) / DAY_MS);
const CALENDAR = MONTHS.flatMap((name, m) => Array.from({ length: new Date(Date.UTC(2000, m + 1, 0)).getUTCDate() }, (_, i) => `${name} ${i + 1}`));

/** ISO 8601 week: Monday start, week 1 holds the year's first Thursday. Late-December days can be in next year's week 1. */
export function isoWeek(d: Date): { year: number; week: number } {
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)));
  const year = thursday.getUTCFullYear();
  return { year, week: Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7) };
}

const ym = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;

export const PATTERNS: Record<Pattern, PatternSpec> = {
  monthOfYear: {
    label: 'Months in a year',
    unit: 'month',
    granularity: 'MONTH',
    slots: MONTHS,
    slot: (d) => d.getUTCMonth(),
    cycle: (d) => String(d.getUTCFullYear()),
  },
  weekOfYear: {
    label: 'Weeks in a year (ISO)',
    unit: 'week',
    granularity: 'WEEK',
    slots: Array.from({ length: 53 }, (_, i) => `W${i + 1}`),
    slot: (d) => isoWeek(d).week - 1,
    cycle: (d) => String(isoWeek(d).year),
  },
  dayOfYear: {
    label: 'Days in a year',
    unit: 'day',
    granularity: 'DAY',
    slots: CALENDAR,
    slot: (d) => LEAP_START[d.getUTCMonth()]! + d.getUTCDate() - 1,
    cycle: (d) => String(d.getUTCFullYear()),
  },
  weekOfMonth: {
    label: 'Weeks in a month',
    unit: 'week',
    granularity: 'DAY',
    // Fixed day spans rather than calendar rows: weeks 1–4 always have 7 days, so they compare like for like.
    slots: ['1st (1–7)', '2nd (8–14)', '3rd (15–21)', '4th (22–28)', '5th (29–31)'],
    slot: (d) => Math.floor((d.getUTCDate() - 1) / 7),
    cycle: ym,
  },
  dayOfMonth: {
    label: 'Days in a month',
    unit: 'day',
    granularity: 'DAY',
    slots: Array.from({ length: 31 }, (_, i) => ordinal(i + 1)),
    slot: (d) => d.getUTCDate() - 1,
    cycle: ym,
  },
  dayOfWeek: {
    label: 'Days in a week',
    unit: 'weekday',
    granularity: 'DAY',
    slots: WEEKDAYS,
    slot: (d) => (d.getUTCDay() + 6) % 7,
    // Monday-start weeks counted from the epoch (a Thursday, hence the 3).
    cycle: (d) => String(Math.floor((d.getTime() / DAY_MS + 3) / 7)),
  },
};

/** "2026", "2026-03" or "2026-03-09" (an API bucket key) as a wall-clock date. */
function parseBucket(key: string): Date {
  const [y, m = 1, d = 1] = key.split('-').map(Number) as [number, number?, number?];
  return new Date(Date.UTC(y, m - 1, d));
}

export interface Trend {
  /** Labels of the slots that occur in the range, in calendar order. */
  slots: string[];
  /** How many times each of `slots` occurs in the range (whole or in part). */
  occurrences: number[];
  /** The API data re-bucketed by slot label, as totals or averages; `buckets` are the slots. With groupBy=none every slot has a point. */
  data: TimeseriesData;
  /** What actually moved over the range, whatever the aggregate. */
  income: number;
  expense: number;
}

/**
 * Folds a timeseries (bucketed at the pattern's granularity) into the pattern's slots: every March, every Monday.
 * Slots that never occur in the range are left out, so a range inside one year shows only the months it covers.
 */
export function foldTrend(d: TimeseriesData, pattern: Pattern, tz: string, aggregate: Aggregate): Trend {
  const spec = PATTERNS[pattern];
  const off = offsetMs(tz);

  // Every local day in [from, to), starting with the one `from` falls in.
  const cycles = spec.slots.map(() => new Set<string>());
  for (let t = Math.floor((d.from + off) / DAY_MS) * DAY_MS; t - off < d.to; t += DAY_MS) {
    const day = new Date(t);
    cycles[spec.slot(day)]!.add(spec.cycle(day));
  }
  const counts = cycles.map((c) => c.size);

  const points = new Map<string, TimeseriesPoint & { slot: number }>();
  let income = 0;
  let expense = 0;
  for (const p of d.points) {
    const slot = spec.slot(parseBucket(p.bucket));
    const id = `${slot}\0${p.groupId ?? ''}`;
    const q = points.get(id) ?? { slot, bucket: spec.slots[slot]!, ...(p.groupId != null ? { groupId: p.groupId, groupName: p.groupName } : {}), income: 0, expense: 0 };
    q.income += p.income;
    q.expense += p.expense;
    points.set(id, q);
    income += p.income;
    expense += p.expense;
  }

  // A bucket can only hold money from days in the range, so its slot occurred; the fallback is belt and braces.
  for (const p of points.values()) counts[p.slot] ||= 1;
  const present = spec.slots.map((_, i) => i).filter((i) => counts[i]! > 0);
  if (d.groupBy === 'none')
    for (const i of present) if (!points.has(`${i}\0`)) points.set(`${i}\0`, { slot: i, bucket: spec.slots[i]!, income: 0, expense: 0 });

  const folded = [...points.values()]
    .sort((a, b) => a.slot - b.slot || (a.groupName ?? '').localeCompare(b.groupName ?? ''))
    .map(({ slot, ...p }) => (aggregate === 'average' ? { ...p, income: p.income / counts[slot]!, expense: p.expense / counts[slot]! } : p));

  const slots = present.map((i) => spec.slots[i]!);
  return {
    slots,
    occurrences: present.map((i) => counts[i]!),
    data: { ...d, buckets: slots, points: folded },
    income,
    expense,
  };
}
