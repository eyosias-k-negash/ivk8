/**
 * Planned income/expense and projected net worth (Planned tab).
 *
 * Rules applied here:
 * - Bars: PLANNED INCOME and EXPENSE, bucketed by dueDate in [from, to), per category. Transfers are not
 *   income or expense, so they never appear as bars.
 * - Line: net worth at the end of each bucket (clipped to `to`) = every executed transaction plus every
 *   planned one due before that instant, counting only accounts included in the balance. Overdue planned
 *   items are assumed to happen on their due date. A transfer moves money between accounts, so it only
 *   changes net worth when exactly one side counts or the two currencies convert differently.
 * - Amounts are converted at the current rate; a currency with no rate is skipped and listed in `unconverted`.
 */
import type { Granularity, PlannedBucket, PlannedData } from '@ivy/contracts';
import { toBase, type RateTable } from '../engine/currency';
import type { Dataset } from '../engine/loader';
import { classify } from '../engine/rules';
import { bucketKey, bucketStartMs } from '../engine/time';
import { accountCurrency } from './index';
import { bucketKeys } from './flows';

const round = (n: number) => Math.round(n * 100) / 100;
const UNCATEGORIZED = { id: 'uncategorized', name: 'Uncategorized' };

export function plannedReport(
  ds: Dataset,
  from: number,
  to: number,
  granularity: Granularity,
  tz: string,
  rates: RateTable,
): PlannedData {
  const unconverted = new Set<string>();
  const baseOf = (accountId: string | null | undefined, amount: number): number | null => {
    const a = accountId ? ds.accounts.get(accountId) : undefined;
    if (!a || a.includeInBalance === false) return 0; // not part of net worth
    const currency = accountCurrency(ds, a.id);
    const v = toBase(amount, currency, ds.baseCurrency, rates);
    if (v == null) unconverted.add(currency);
    return v;
  };

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

    // Net worth effect (skipped silently when a currency cannot be converted; it is reported instead).
    let delta = 0;
    if (t.type === 'INCOME') delta = baseOf(t.accountId, t.amount) ?? 0;
    else if (t.type === 'EXPENSE') delta = -(baseOf(t.accountId, t.amount) ?? 0);
    else {
      delta = -(baseOf(t.accountId, t.amount) ?? 0);
      if (t.toAccountId) delta += baseOf(t.toAccountId, t.toAmount ?? t.amount) ?? 0;
    }
    if (delta) events.push({ at, delta });

    if (!planned || t.type === 'TRANSFER' || at < from || at >= to) continue;
    const currency = accountCurrency(ds, t.accountId);
    const base = toBase(t.amount, currency, ds.baseCurrency, rates);
    if (base == null) {
      unconverted.add(currency);
      continue;
    }
    const cat = t.categoryId
      ? { id: t.categoryId, name: ds.categories.get(t.categoryId)?.name ?? '(unknown category)' }
      : UNCATEGORIZED;
    names.set(cat.id, cat.name);
    const side = buckets.get(bucketKey(at, granularity, tz))?.[t.type === 'INCOME' ? 'income' : 'expense'];
    if (side) side[cat.id] = (side[cat.id] ?? 0) + base;
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
