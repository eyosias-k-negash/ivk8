/**
 * Budget vs actual over time (Budgets tab).
 *
 * Rules applied here:
 * - A budget's `amount` is for one calendar month, in base currency (plan §5, Day 0 decision 2).
 * - Spend = executed EXPENSE in the budget's categories, all accounts (accountIdsSerialized is ignored).
 * - Each bucket's threshold scales by exact calendar days: every local day carries amount / days-in-its-month.
 *   A whole month is therefore exactly `amount`, a year exactly 12x, and a week is 7 days' worth.
 *   The threshold covers the whole bucket even when the range clips it, because the bar stands for the period.
 */
import type { BudgetBucket, BudgetInfo, BudgetTimeseriesData, BudgetsData, Granularity } from '@ivy/contracts';
import { toBase, type RateTable } from '../engine/currency';
import type { Dataset } from '../engine/loader';
import { classify, parseIds } from '../engine/rules';
import { bucketKey } from '../engine/time';
import type { Budget } from '../engine/types';
import { accountCurrency } from './index';
import { bucketKeys } from './flows';

const round = (n: number) => Math.round(n * 100) / 100;

function info(ds: Dataset, b: Budget): BudgetInfo {
  return {
    id: b.id,
    name: b.name,
    amount: b.amount,
    categories: parseIds(b.categoryIdsSerialized).map((id) => ({ id, name: ds.categories.get(id)?.name ?? '(unknown category)' })),
  };
}

export function budgetsList(ds: Dataset): BudgetsData {
  return { budgets: ds.budgets.map((b) => info(ds, b)) };
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Budget share of one bucket, by exact calendar days. `key` is a bucketKey() value. */
export function bucketThreshold(monthly: number, key: string, granularity: Granularity): number {
  switch (granularity) {
    case 'MONTH':
      return monthly;
    case 'YEAR':
      return monthly * 12;
    case 'DAY':
    case 'WEEK': {
      const [y, m, d] = key.split('-').map(Number) as [number, number, number];
      const days = granularity === 'DAY' ? 1 : 7;
      let sum = 0;
      for (let i = 0; i < days; i++) {
        const day = new Date(Date.UTC(y, m - 1, d + i));
        sum += monthly / daysInMonth(day.getUTCFullYear(), day.getUTCMonth());
      }
      return sum;
    }
  }
}

export function budgetTimeseriesReport(
  ds: Dataset,
  budgetId: string,
  from: number,
  to: number,
  granularity: Granularity,
  tz: string,
  rates: RateTable,
): BudgetTimeseriesData | null {
  const budget = ds.budgets.find((b) => b.id === budgetId);
  if (!budget) return null;
  const meta = info(ds, budget);
  const ids = new Set(meta.categories.map((c) => c.id));
  const unconverted = new Set<string>();

  const buckets = new Map<string, BudgetBucket>();
  for (const k of bucketKeys(from, to, granularity, tz))
    buckets.set(k, { bucket: k, threshold: bucketThreshold(budget.amount, k, granularity), spent: {} });

  for (const t of ds.transactions) {
    if (t.type !== 'EXPENSE' || !t.categoryId || !ids.has(t.categoryId)) continue;
    if (classify(t, ds.rules) !== 'EXECUTED') continue;
    const at = t.dateTime as number;
    if (at < from || at >= to) continue;
    const currency = accountCurrency(ds, t.accountId);
    const base = toBase(t.amount, currency, ds.baseCurrency, rates);
    if (base == null) {
      unconverted.add(currency);
      continue;
    }
    const row = buckets.get(bucketKey(at, granularity, tz));
    if (row) row.spent[t.categoryId] = (row.spent[t.categoryId] ?? 0) + base;
  }

  const out = [...buckets.values()].map((b) => ({
    ...b,
    threshold: round(b.threshold),
    spent: Object.fromEntries(Object.entries(b.spent).map(([id, v]) => [id, round(v)])),
  }));
  return { budget: meta, from, to, granularity, buckets: out, unconverted: [...unconverted].sort() };
}
