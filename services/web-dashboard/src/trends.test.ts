import { describe, it, expect } from 'vitest';
import type { Granularity, TimeseriesData, TimeseriesPoint } from '@ivy/contracts';
import { PATTERNS, foldTrend, isoWeek } from './trends';

const day = (s: string) => new Date(`${s}T00:00:00Z`);

/** Series over local dates [from, to] (inclusive, like the range picker), in the given offset. */
function series(from: string, to: string, granularity: Granularity, points: TimeseriesPoint[], tzMs = 0, groupBy: TimeseriesData['groupBy'] = 'none'): TimeseriesData {
  const buckets = [...new Set(points.map((p) => p.bucket))];
  return { from: Date.parse(from) - tzMs, to: Date.parse(to) + 86_400_000 - tzMs, granularity, groupBy, buckets, points, unconverted: [] };
}

describe('isoWeek', () => {
  it('numbers Monday-start weeks, with week 1 holding the first Thursday', () => {
    expect(isoWeek(day('2026-01-01'))).toEqual({ year: 2026, week: 1 }); // a Thursday
    expect(isoWeek(day('2025-12-29'))).toEqual({ year: 2026, week: 1 }); // the Monday before it
    expect(isoWeek(day('2021-01-03'))).toEqual({ year: 2020, week: 53 }); // a Sunday
    expect(isoWeek(day('2026-10-29'))).toEqual({ year: 2026, week: 44 });
  });
});

describe('pattern slots', () => {
  it('maps dates to their place in the cycle', () => {
    expect(PATTERNS.dayOfYear.slots[PATTERNS.dayOfYear.slot(day('2024-02-29'))]).toBe('Feb 29');
    expect(PATTERNS.dayOfYear.slots[PATTERNS.dayOfYear.slot(day('2026-03-01'))]).toBe('Mar 1');
    expect(PATTERNS.dayOfYear.slots).toHaveLength(366);
    expect(PATTERNS.weekOfMonth.slots[PATTERNS.weekOfMonth.slot(day('2026-01-29'))]).toBe('5th (29–31)');
    expect(PATTERNS.weekOfMonth.slots[PATTERNS.weekOfMonth.slot(day('2026-01-28'))]).toBe('4th (22–28)');
    expect(PATTERNS.dayOfWeek.slots[PATTERNS.dayOfWeek.slot(day('2026-10-26'))]).toBe('Mon');
    expect(PATTERNS.dayOfMonth.slots.slice(0, 3).concat(PATTERNS.dayOfMonth.slots.slice(10, 13), PATTERNS.dayOfMonth.slots[21]!)).toEqual(
      ['1st', '2nd', '3rd', '11th', '12th', '13th', '22nd'],
    );
  });
});

describe('foldTrend', () => {
  // Nov 2024 – Jan 2026: November, December and January occur twice, every other month once.
  const months = series('2024-11-01', '2026-01-31', 'MONTH', [
    { bucket: '2024-11', income: 0, expense: 100 },
    { bucket: '2025-06', income: 500, expense: 20 },
    { bucket: '2025-11', income: 0, expense: 50 },
    { bucket: '2026-01', income: 10, expense: 30 },
  ]);

  it('adds up every occurrence of a slot, with every slot present', () => {
    const t = foldTrend(months, 'monthOfYear', 'Z', 'total');
    expect(t.slots).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
    expect(t.occurrences).toEqual([2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2]);
    expect(t.data.points.map((p) => [p.bucket, p.expense])).toEqual([
      ['Jan', 30], ['Feb', 0], ['Mar', 0], ['Apr', 0], ['May', 0], ['Jun', 20],
      ['Jul', 0], ['Aug', 0], ['Sep', 0], ['Oct', 0], ['Nov', 150], ['Dec', 0],
    ]);
    expect([t.income, t.expense]).toEqual([510, 200]);
  });

  it('averages per occurrence, keeping the range totals', () => {
    const t = foldTrend(months, 'monthOfYear', 'Z', 'average');
    const nov = t.data.points.find((p) => p.bucket === 'Nov')!;
    const jun = t.data.points.find((p) => p.bucket === 'Jun')!;
    expect(nov.expense).toBe(75);
    expect(jun.income).toBe(500);
    expect([t.income, t.expense]).toEqual([510, 200]);
  });

  it('leaves out slots the range never reaches', () => {
    const t = foldTrend(series('2026-03-15', '2026-05-10', 'MONTH', []), 'monthOfYear', 'Z', 'total');
    expect(t.slots).toEqual(['Mar', 'Apr', 'May']);
    // Short February has no 29th to 31st, so no 5th week.
    const feb = foldTrend(series('2026-02-01', '2026-02-28', 'DAY', []), 'weekOfMonth', 'Z', 'total');
    expect(feb.slots).toEqual(['1st (1–7)', '2nd (8–14)', '3rd (15–21)', '4th (22–28)']);
    expect(feb.occurrences).toEqual([1, 1, 1, 1]);
  });

  it('counts local days in the request offset', () => {
    const tz = 3 * 3_600_000;
    // Mon 26 Oct – Sun 8 Nov 2026 (+03:00): two of each weekday.
    const t = foldTrend(series('2026-10-26', '2026-11-08', 'DAY', [], tz), 'dayOfWeek', '+03:00', 'total');
    expect(t.slots).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(t.occurrences).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });

  it('sums each group per slot', () => {
    const d = series(
      '2026-10-26',
      '2026-11-08',
      'DAY',
      [
        { bucket: '2026-10-26', groupId: 'food', groupName: 'Food', income: 0, expense: 10 },
        { bucket: '2026-10-26', groupId: 'rent', groupName: 'Rent', income: 0, expense: 300 },
        { bucket: '2026-11-02', groupId: 'food', groupName: 'Food', income: 0, expense: 30 },
        { bucket: '2026-11-07', groupId: 'food', groupName: 'Food', income: 0, expense: 5 },
      ],
      0,
      'category',
    );
    const total = foldTrend(d, 'dayOfWeek', 'Z', 'total');
    // Grouped data stays sparse: the chart fills empty slots from `slots`.
    expect(total.data.points.map((p) => [p.bucket, p.groupId, p.expense])).toEqual([
      ['Mon', 'food', 40],
      ['Mon', 'rent', 300],
      ['Sat', 'food', 5],
    ]);
    expect(foldTrend(d, 'dayOfWeek', 'Z', 'average').data.points[0]!.expense).toBe(20);
  });

  it('files a week bucket that starts before the range under its ISO week', () => {
    // Wed 7 Jan 2026 is in the week of Mon 5 Jan, ISO week 2.
    const t = foldTrend(series('2026-01-07', '2026-01-20', 'WEEK', [{ bucket: '2026-01-05', income: 0, expense: 12 }]), 'weekOfYear', 'Z', 'total');
    expect(t.slots).toEqual(['W2', 'W3', 'W4']);
    expect(t.data.points.map((p) => [p.bucket, p.expense])).toEqual([['W2', 12], ['W3', 0], ['W4', 0]]);
  });
});
