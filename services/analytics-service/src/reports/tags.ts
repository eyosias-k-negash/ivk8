/**
 * Tagged money over time (Tags tab).
 *
 * Rules applied here:
 * - A transaction carries the live tags its live associations point to (see loader); no associations = untagged.
 * - Only executed money into or out of net worth counts, exactly as in every income and expense view (see
 *   `moneyFlow`): income and expense on accounts included in the balance, and transfers to or from an excluded
 *   account. Income and expense on an excluded account, and transfers between two included accounts, never count,
 *   tagged or not.
 * - Per-tag totals count a transaction under every tag it carries (plan §5), so they can add up to more than was
 *   spent. The buckets keep each transaction's whole tag set instead, so a view combining tags can count it once.
 * - Range is [from, to) on dateTime, bucketed in the request timezone. Amounts are in base at the current rate; a
 *   currency with no rate is left out and listed in `unconverted`.
 */
import type { Granularity, TagSetAmount, TagTotal, TagsData } from '@ivy/contracts';
import type { RateTable } from '../engine/currency';
import type { Dataset } from '../engine/loader';
import { classify } from '../engine/rules';
import { bucketKey } from '../engine/time';
import { moneyFlow } from './index';
import { bucketKeys } from './flows';

const round = (n: number) => Math.round(n * 100) / 100;

type Side = 'income' | 'expense';

export function tagsReport(
  ds: Dataset,
  from: number,
  to: number,
  granularity: Granularity,
  tz: string,
  rates: RateTable,
): TagsData {
  const unconverted = new Set<string>();
  const totals = new Map<string, TagTotal>();
  for (const t of ds.tags.values()) totals.set(t.id, { id: t.id, name: t.name, income: 0, expense: 0 });

  // bucket -> side -> sorted tag ids joined -> amount
  const buckets = new Map<string, Record<Side, Map<string, TagSetAmount>>>();
  for (const k of bucketKeys(from, to, granularity, tz)) buckets.set(k, { income: new Map(), expense: new Map() });

  for (const t of ds.transactions) {
    const tagIds = ds.tagsByTransaction.get(t.id);
    if (!tagIds) continue;
    if (classify(t, ds.rules) !== 'EXECUTED') continue;
    const at = t.dateTime as number;
    if (at < from || at >= to) continue;
    const money = moneyFlow(ds, t, rates, unconverted);
    if (money?.base == null) continue; // not money in or out, or no rate (listed in unconverted)
    const side: Side = money.direction === 'in' ? 'income' : 'expense';

    for (const id of tagIds) totals.get(id)![side] += money.base;
    const sets = buckets.get(bucketKey(at, granularity, tz))![side];
    const ids = [...tagIds].sort();
    const key = ids.join(',');
    const set = sets.get(key) ?? { tagIds: ids, amount: 0, count: 0 };
    set.amount += money.base;
    set.count++;
    sets.set(key, set);
  }

  const finish = (sets: Map<string, TagSetAmount>) =>
    [...sets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => ({ ...s, amount: round(s.amount) }));

  return {
    from,
    to,
    granularity,
    tags: [...totals.values()]
      .map((t) => ({ ...t, income: round(t.income), expense: round(t.expense) }))
      .sort((a, b) => b.income + b.expense - (a.income + a.expense) || a.name.localeCompare(b.name)),
    buckets: [...buckets].map(([bucket, s]) => ({ bucket, income: finish(s.income), expense: finish(s.expense) })),
    unconverted: [...unconverted].sort(),
  };
}
