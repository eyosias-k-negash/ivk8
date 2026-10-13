/**
 * Net worth projected from recent flows (Projected tab, "moving average" mode).
 *
 * Rules applied here:
 * - Every executed transaction that moves money into or out of net worth counts, whatever its date: income and
 *   expense on accounts included in the balance, and transfers to or from an excluded account. A transfer between two
 *   included accounts is never a flow, whatever the currencies; it moves the net worth line only by valuation, as in
 *   the Balances tab. Flows are filed under their category, transfers included; an uncategorized transfer is filed
 *   under its two accounts.
 * - Starts from net worth at `asOf`. Executed transactions dated later are not in it; they count on their own date.
 * - The average is taken over the `window` complete buckets before the one holding `asOf`. Buckets that end
 *   before the first executed transaction have no history and are dropped, so young data averages fewer.
 * - Planned items are ignored: recurring ones are already in the history, so adding them would count them twice.
 * - From the current bucket on, each flow is topped up to its average, never below what is already executed in
 *   the bucket. Prorating by time would be wrong for lumpy items: a salary paid on the 1st would be counted again
 *   for the rest of the month. When `to` cuts the time still ahead in a bucket short, the top-up shrinks with it.
 * - Amounts are converted at the current rate; a currency with no rate is skipped and listed in `unconverted`.
 */
import type { Granularity, ProjectionBucket, ProjectionData } from '@ivy/contracts';
import type { RateTable } from '../engine/currency';
import type { Dataset } from '../engine/loader';
import { classify } from '../engine/rules';
import { bucketEndMs, bucketKey, bucketStartMs } from '../engine/time';
import { flowOf, moneyFlow, netWorthDelta } from './index';
import { bucketKeys, earliestExecuted } from './flows';

const round = (n: number) => Math.round(n * 100) / 100;

export const DEFAULT_WINDOW = 4;
export const MAX_WINDOW = 36;

type Amounts = Record<string, number>;

export function projectionReport(
  ds: Dataset,
  asOf: number,
  to: number,
  granularity: Granularity,
  window: number,
  tz: string,
  rates: RateTable,
): ProjectionData {
  const unconverted = new Set<string>();

  // Walk back from the current bucket; the bucket ending at `start` has history only if the data began before it.
  const current = bucketKey(asOf, granularity, tz);
  const first = earliestExecuted(ds);
  const past: string[] = [];
  let windowStart = bucketStartMs(current, granularity, tz);
  while (past.length < window && first !== undefined && first < windowStart) {
    const key = bucketKey(windowStart - 1, granularity, tz);
    past.unshift(key);
    windowStart = bucketStartMs(key, granularity, tz);
  }
  const ahead = bucketKeys(asOf, to, granularity, tz); // starts with the current bucket

  const flows = new Map<string, { income: Amounts; expense: Amounts }>([...past, ...ahead].map((k) => [k, { income: {}, expense: {} }]));
  const names = new Map<string, string>();
  const events: { at: number; delta: number }[] = [];

  for (const t of ds.transactions) {
    if (classify(t, ds.rules) !== 'EXECUTED') continue;
    const at = t.dateTime as number;
    const delta = netWorthDelta(ds, t, rates, unconverted);
    if (delta) events.push({ at, delta });

    if (at < windowStart || at >= to) continue;
    const money = moneyFlow(ds, t, rates, unconverted);
    if (!money?.base) continue; // not money in or out, or no rate (listed in unconverted)
    const flow = flowOf(ds, t);
    names.set(flow.id, flow.name);
    const side = flows.get(bucketKey(at, granularity, tz))?.[money.direction === 'in' ? 'income' : 'expense'];
    if (side) side[flow.id] = (side[flow.id] ?? 0) + money.base;
  }

  const average = (side: 'income' | 'expense'): Amounts => {
    const sum: Amounts = {};
    for (const k of past) for (const [id, v] of Object.entries(flows.get(k)![side])) sum[id] = (sum[id] ?? 0) + v;
    return Object.fromEntries(Object.entries(sum).map(([id, v]) => [id, v / past.length]));
  };
  const avgIncome = average('income');
  const avgExpense = average('expense');
  const total = (m: Amounts) => Object.values(m).reduce((s, v) => s + v, 0);
  const rounded = (m: Amounts) => Object.fromEntries(Object.entries(m).flatMap(([id, v]) => (round(v) ? [[id, round(v)]] : [])));

  // Sweep the time-ordered events once: executed net worth at each bucket end, with the average's top-ups added from today on.
  events.sort((a, b) => a.at - b.at);
  let executed = 0;
  let i = 0;
  const sweep = (until: number) => {
    while (i < events.length && events[i]!.at < until) executed += events[i++]!.delta;
  };
  const out: ProjectionBucket[] = past.map((k) => {
    sweep(bucketEndMs(k, granularity, tz));
    const f = flows.get(k)!;
    return { bucket: k, phase: 'actual', income: rounded(f.income), expense: rounded(f.expense), projectedIncome: {}, projectedExpense: {}, netWorth: round(executed) };
  });
  const currentNetWorth = events.reduce((s, e) => (e.at <= asOf ? s + e.delta : s), 0);

  let assumed = 0;
  for (const k of ahead) {
    const end = bucketEndMs(k, granularity, tz);
    const from = Math.max(bucketStartMs(k, granularity, tz), asOf);
    const share = (Math.min(end, to) - from) / (end - from);
    const f = flows.get(k)!;
    const topUp = (avg: Amounts, done: Amounts) =>
      Object.fromEntries(Object.entries(avg).map(([id, v]) => [id, Math.max(0, v - (done[id] ?? 0)) * share]));
    const rest = { income: topUp(avgIncome, f.income), expense: topUp(avgExpense, f.expense) };
    sweep(Math.min(end, to));
    assumed += total(rest.income) - total(rest.expense);
    out.push({
      bucket: k,
      phase: k === current ? 'current' : 'projected',
      income: rounded(f.income),
      expense: rounded(f.expense),
      projectedIncome: rounded(rest.income),
      projectedExpense: rounded(rest.expense),
      netWorth: round(executed + assumed),
    });
  }

  return {
    asOf,
    to,
    granularity,
    window,
    windowUsed: past.length,
    categories: [...names].map(([id, name]) => ({ id, name })),
    averageIncome: rounded(avgIncome),
    averageExpense: rounded(avgExpense),
    currentNetWorth: round(currentNetWorth),
    buckets: out,
    unconverted: [...unconverted].sort(),
  };
}

export function parseWindow(v: unknown): number | null {
  if (v == null || v === '') return DEFAULT_WINDOW;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_WINDOW ? n : null;
}
