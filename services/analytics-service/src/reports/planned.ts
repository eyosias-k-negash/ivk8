/**
 * Planned income/expense and projected net worth (Planned tab).
 *
 * Rules applied here:
 * - Bars: PLANNED money into or out of net worth, bucketed by dueDate in [from, to): income and expense on accounts
 *   included in the balance, and transfers to or from an excluded account. A transfer between two included accounts
 *   is never a bar, whatever the currencies. Each is filed under its category, or an uncategorized transfer under its
 *   two accounts; up when money comes in, down when it goes out.
 * - Line: net worth at the end of each bucket (clipped to `to`) = every executed transaction plus every
 *   planned one due before that instant, counting only accounts included in the balance. Overdue planned
 *   items are assumed to happen on their due date. A transfer moves money between accounts, so it only
 *   changes net worth when exactly one side counts, or by valuation alone when the two currencies convert differently.
 * - Amounts are converted at the current rate; a currency with no rate is skipped and listed in `unconverted`.
 */
import type { Granularity, PlannedBucket, PlannedData } from '@ivy/contracts';
import type { RateTable } from '../engine/currency';
import type { Dataset } from '../engine/loader';
import { classify } from '../engine/rules';
import { bucketKey, bucketStartMs } from '../engine/time';
import { flowOf, moneyFlow, netWorthDelta } from './index';
import { bucketKeys } from './flows';

const round = (n: number) => Math.round(n * 100) / 100;

export function plannedReport(
  ds: Dataset,
  from: number,
  to: number,
  granularity: Granularity,
  tz: string,
  rates: RateTable,
): PlannedData {
  const unconverted = new Set<string>();

  const keys = bucketKeys(from, to, granularity, tz);
  const buckets = new Map<string, PlannedBucket>(keys.map((k) => [k, { bucket: k, income: {}, expense: {}, netWorth: 0 }]));
  // Bucket i ends where bucket i+1 starts; the last one ends at `to`.
  const ends = keys.map((_, i) => (i + 1 < keys.length ? Math.min(bucketStartMs(keys[i + 1]!, granularity, tz), to) : to));

  const names = new Map<string, string>();
  const events: { at: number; delta: number }[] = [];

  for (const t of ds.transactions) {
    const status = classify(t, ds.rules);
    if (status !== 'EXECUTED' && status !== 'PLANNED') continue;
    const planned = status === 'PLANNED';
    const at = (planned ? t.dueDate : t.dateTime) as number;

    // Net worth effect (a currency that cannot be converted counts as 0; it is reported instead).
    const delta = netWorthDelta(ds, t, rates, unconverted);
    if (delta) events.push({ at, delta });

    if (!planned || at < from || at >= to) continue;
    const money = moneyFlow(ds, t, rates, unconverted);
    if (!money?.base) continue; // not money in or out, or no rate (listed in unconverted)
    const flow = flowOf(ds, t);
    names.set(flow.id, flow.name);
    const side = buckets.get(bucketKey(at, granularity, tz))?.[money.direction === 'in' ? 'income' : 'expense'];
    if (side) side[flow.id] = (side[flow.id] ?? 0) + money.base;
  }

  // Sweep the time-ordered events once for the running net worth.
  events.sort((a, b) => a.at - b.at);
  let running = 0;
  let i = 0;
  while (i < events.length && events[i]!.at < from) running += events[i++]!.delta;
  const startingNetWorth = running;
  const out = keys.map((k, n) => {
    while (i < events.length && events[i]!.at < ends[n]!) running += events[i++]!.delta;
    const b = buckets.get(k)!;
    const rounded = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([id, v]) => [id, round(v)]));
    return { ...b, income: rounded(b.income), expense: rounded(b.expense), netWorth: round(running) };
  });

  return {
    from,
    to,
    granularity,
    categories: [...names].map(([id, name]) => ({ id, name })),
    startingNetWorth: round(startingNetWorth),
    buckets: out,
    unconverted: [...unconverted].sort(),
  };
}
