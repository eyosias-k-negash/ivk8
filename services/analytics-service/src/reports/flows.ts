/**
 * Income / expense reports (plan §5 "Income/expense summary", §7 "Summary + timeseries").
 *
 * Rules applied here:
 * - Only EXECUTED transactions count (planned never do; see rules.ts).
 * - Only INCOME and EXPENSE count. TRANSFER is neither (business rule).
 * - Loan-linked transactions are normal transactions.
 * - Range is [from, to) on dateTime; bucketing follows the request timezone.
 * - Amounts are converted to base at the current rate. A currency with no rate is left out of
 *   base totals and listed in `unconverted` (never silently dropped).
 */
import type { BreakdownRow, Granularity, GroupBy, SummaryData, TimeseriesData, TimeseriesPoint } from '@ivy/contracts';
import { toBase, type RateTable } from '../engine/currency';
import type { Dataset } from '../engine/loader';
import { classify } from '../engine/rules';
import { bucketKey, parseTzOffsetMs } from '../engine/time';
import type { Transaction } from '../engine/types';
import { accountCurrency } from './index';

const DAY_MS = 86_400_000;
/** Guard against absurd ranges (e.g. DAY buckets over centuries). */
const MAX_BUCKETS = 5000;

export class RangeTooLarge extends Error {}

const UNCATEGORIZED = { id: 'uncategorized', name: 'Uncategorized' };

interface Flow {
  t: Transaction;
  type: 'INCOME' | 'EXPENSE';
  currency: string;
  base: number | null;
}

/** Executed INCOME/EXPENSE in [from, to), with base amounts resolved once. */
function flows(ds: Dataset, from: number, to: number, rates: RateTable, unconverted: Set<string>): Flow[] {
  const out: Flow[] = [];
  for (const t of ds.transactions) {
    if (t.type === 'TRANSFER') continue;
    if (classify(t, ds.rules) !== 'EXECUTED') continue;
    const at = t.dateTime as number;
    if (at < from || at >= to) continue;
    const currency = accountCurrency(ds, t.accountId);
    const base = toBase(t.amount, currency, ds.baseCurrency, rates);
    if (base == null) unconverted.add(currency);
    out.push({ t, type: t.type, currency, base });
  }
  return out;
}

function category(ds: Dataset, t: Transaction): { id: string; name: string } {
  if (!t.categoryId) return UNCATEGORIZED;
  return { id: t.categoryId, name: ds.categories.get(t.categoryId)?.name ?? '(unknown category)' };
}

function account(ds: Dataset, t: Transaction): { id: string; name: string } {
  return { id: t.accountId, name: ds.accounts.get(t.accountId)?.name ?? '(unknown account)' };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Earliest executed transaction, for "all time" ranges. */
export function earliestExecuted(ds: Dataset): number | undefined {
  let min: number | undefined;
  for (const t of ds.transactions) {
    if (classify(t, ds.rules) !== 'EXECUTED') continue;
    const at = t.dateTime as number;
    if (min === undefined || at < min) min = at;
  }
  return min;
}

export function summaryReport(ds: Dataset, from: number, to: number, rates: RateTable): SummaryData {
  const unconverted = new Set<string>();
  const rows = flows(ds, from, to, rates, unconverted);

  let income = 0;
  let expense = 0;
  const byCat = new Map<string, BreakdownRow>();
  const byAcc = new Map<string, SummaryData['byAccount'][number]>();

  for (const f of rows) {
    const c = category(ds, f.t);
    const a = account(ds, f.t);
    const cat = byCat.get(c.id) ?? { id: c.id, name: c.name, income: 0, expense: 0, net: 0 };
    const acc =
      byAcc.get(a.id) ??
      { id: a.id, name: a.name, currency: f.currency, income: 0, expense: 0, net: 0, incomeNative: 0, expenseNative: 0 };

    // Native amounts are always known; base only when a rate exists.
    if (f.type === 'INCOME') acc.incomeNative += f.t.amount;
    else acc.expenseNative += f.t.amount;

    if (f.base != null) {
      if (f.type === 'INCOME') {
        income += f.base;
        cat.income += f.base;
        acc.income += f.base;
      } else {
        expense += f.base;
        cat.expense += f.base;
        acc.expense += f.base;
      }
    }
    byCat.set(c.id, cat);
    byAcc.set(a.id, acc);
  }

  const finish = <T extends BreakdownRow>(r: T): T => ({
    ...r,
    income: round(r.income),
    expense: round(r.expense),
    net: round(r.income - r.expense),
  });
  const bySize = (a: BreakdownRow, b: BreakdownRow) => b.expense + b.income - (a.expense + a.income);

  return {
    from,
    to,
    income: round(income),
    expense: round(expense),
    net: round(income - expense),
    byCategory: [...byCat.values()].map(finish).sort(bySize),
    byAccount: [...byAcc.values()]
      .map((r) => ({ ...finish(r), incomeNative: round(r.incomeNative), expenseNative: round(r.expenseNative) }))
      .sort(bySize),
    count: rows.length,
    unconverted: [...unconverted].sort(),
  };
}

/** Every bucket key touched by [from, to), in order. Walks local days, so DST-free offsets are exact. */
export function bucketKeys(from: number, to: number, granularity: Granularity, tz: string): string[] {
  const off = parseTzOffsetMs(tz);
  const firstLocalDay = Math.floor((from + off) / DAY_MS) * DAY_MS - off;
  const keys: string[] = [];
  let last = '';
  for (let d = firstLocalDay; d < to; d += DAY_MS) {
    const k = bucketKey(Math.max(d, from), granularity, tz);
    if (k !== last) {
      keys.push(k);
      last = k;
      if (keys.length > MAX_BUCKETS) throw new RangeTooLarge(`Range produces more than ${MAX_BUCKETS} ${granularity} buckets`);
    }
  }
  return keys;
}

export function timeseriesReport(
  ds: Dataset,
  from: number,
  to: number,
  granularity: Granularity,
  groupBy: GroupBy,
  tz: string,
  rates: RateTable,
): TimeseriesData {
  const unconverted = new Set<string>();
  const keys = bucketKeys(from, to, granularity, tz);
  const points = new Map<string, TimeseriesPoint>();

  if (groupBy === 'none') for (const k of keys) points.set(k, { bucket: k, income: 0, expense: 0 });

  for (const f of flows(ds, from, to, rates, unconverted)) {
    if (f.base == null) continue;
    const bucket = bucketKey(f.t.dateTime as number, granularity, tz);
    const g = groupBy === 'category' ? category(ds, f.t) : groupBy === 'account' ? account(ds, f.t) : null;
    const id = g ? `${bucket}\0${g.id}` : bucket;
    const p = points.get(id) ?? { bucket, ...(g ? { groupId: g.id, groupName: g.name } : {}), income: 0, expense: 0 };
    if (f.type === 'INCOME') p.income += f.base;
    else p.expense += f.base;
    points.set(id, p);
  }

  const sorted = [...points.values()]
    .map((p) => ({ ...p, income: round(p.income), expense: round(p.expense) }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket) || (a.groupName ?? '').localeCompare(b.groupName ?? ''));

  return { from, to, granularity, groupBy, points: sorted, unconverted: [...unconverted].sort() };
}

const GRANULARITIES: Granularity[] = ['DAY', 'WEEK', 'MONTH', 'YEAR'];
const GROUP_BYS: GroupBy[] = ['none', 'category', 'account'];

export function parseGranularity(v: unknown): Granularity | null {
  if (v == null || v === '') return 'MONTH';
  const g = String(v).toUpperCase() as Granularity;
  return GRANULARITIES.includes(g) ? g : null;
}

export function parseGroupBy(v: unknown): GroupBy | null {
  if (v == null || v === '') return 'none';
  const g = String(v).toLowerCase() as GroupBy;
  return GROUP_BYS.includes(g) ? g : null;
}
