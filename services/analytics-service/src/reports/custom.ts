/**
 * The configurable report behind the Reports tab: income and expense over time for the transactions that pass the
 * filters, optionally split by category or account.
 *
 * Rules applied here:
 * - Money counts exactly as in every income and expense view (see `moneyFlow`, `flowOf`): executed only; income and
 *   expense on accounts included in the balance, and transfers to or from an excluded account, filed under the
 *   included side and under their category (or their two accounts when they have none). Income and expense on an
 *   excluded account, and transfers between two included accounts, never count, whatever the filters.
 * - Filters are optional and all must pass: the included side is one of `accounts`; the flow id the category
 *   breakdown files it under is one of `categories`; it carries one of `tags` and none of `excludeTags`; its title or
 *   description contains one of `keywords` and none of `excludeKeywords` (case-insensitive); its base amount, to the
 *   cent, lies within [minAmount, maxAmount]. Unknown ids match nothing rather than failing, so a filter made
 *   against another backup still runs.
 * - Range is [from, to) on dateTime, bucketed in the request timezone. Amounts are in base at the current rate; a
 *   currency with no rate can be neither bounded nor totalled, so it is left out and listed in `unconverted`.
 */
import type { CustomReportBucket, CustomReportData, CustomReportGroup, CustomReportOption, Granularity, GroupBy } from '@ivy/contracts';
import type { RateTable } from '../engine/currency';
import type { Dataset } from '../engine/loader';
import { classify } from '../engine/rules';
import { bucketKey } from '../engine/time';
import type { Transaction } from '../engine/types';
import { BadRequest } from '../params';
import { flowOf, moneyFlow } from './index';
import { bucketKeys } from './flows';

export interface CustomFilters {
  accounts?: ReadonlySet<string>;
  categories?: ReadonlySet<string>;
  tags?: ReadonlySet<string>;
  excludeTags?: ReadonlySet<string>;
  /** Lower-cased. */
  keywords?: string[];
  excludeKeywords?: string[];
  minAmount?: number;
  maxAmount?: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Comma-separated, trimmed, blanks dropped; nothing left = no filter. */
function list(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined;
  const items = String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function bound(v: unknown, name: string): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new BadRequest(`${name} must be a number of 0 or more`);
  return n;
}

export function parseCustomFilters(q: Record<string, unknown>): CustomFilters {
  const set = (v: unknown) => {
    const items = list(v);
    return items && new Set(items);
  };
  const words = (v: unknown) => list(v)?.map((w) => w.toLowerCase());
  const minAmount = bound(q.minAmount, 'minAmount');
  const maxAmount = bound(q.maxAmount, 'maxAmount');
  if (minAmount !== undefined && maxAmount !== undefined && minAmount > maxAmount)
    throw new BadRequest('minAmount must not be more than maxAmount');
  return {
    accounts: set(q.accounts),
    categories: set(q.categories),
    tags: set(q.tags),
    excludeTags: set(q.excludeTags),
    keywords: words(q.keywords),
    excludeKeywords: words(q.excludeKeywords),
    minAmount,
    maxAmount,
  };
}

/** Every filter but the amount bounds, which need the base amount. */
function matches(ds: Dataset, t: Transaction, accountId: string, flowId: string, f: CustomFilters): boolean {
  if (f.accounts && !f.accounts.has(accountId)) return false;
  if (f.categories && !f.categories.has(flowId)) return false;
  if (f.tags || f.excludeTags) {
    const tags = ds.tagsByTransaction.get(t.id) ?? [];
    if (f.tags && !tags.some((id) => f.tags!.has(id))) return false;
    if (f.excludeTags && tags.some((id) => f.excludeTags!.has(id))) return false;
  }
  if (f.keywords || f.excludeKeywords) {
    const text = [t.title, t.description].filter(Boolean).join('\n').toLowerCase();
    if (f.keywords && !f.keywords.some((w) => text.includes(w))) return false;
    if (f.excludeKeywords?.some((w) => text.includes(w))) return false;
  }
  return true;
}

const withinBounds = (base: number, f: CustomFilters) => {
  const v = round(Math.abs(base));
  return (f.minAmount === undefined || v >= f.minAmount) && (f.maxAmount === undefined || v <= f.maxAmount);
};

const roundAll = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round(v)]));

export function customReport(
  ds: Dataset,
  from: number,
  to: number,
  granularity: Granularity,
  groupBy: GroupBy,
  filters: CustomFilters,
  tz: string,
  rates: RateTable,
): CustomReportData {
  const unconverted = new Set<string>();
  const ignored = new Set<string>(); // moneyFlow's own list; only matching transactions are reported
  // Flow ids money has been filed under that are not live categories (uncategorized transfer pairs, deleted
  // categories), from the whole history, so the category options don't change with the range.
  const otherFlows = new Map<string, string>();
  const buckets = new Map<string, CustomReportBucket>();
  for (const k of bucketKeys(from, to, granularity, tz))
    buckets.set(k, { bucket: k, income: 0, expense: 0, incomeBy: {}, expenseBy: {}, count: 0 });
  const groups = new Map<string, CustomReportGroup>();
  const transactionIds: string[] = [];
  let income = 0;
  let expense = 0;

  for (const t of ds.transactions) {
    if (classify(t, ds.rules) !== 'EXECUTED') continue;
    const money = moneyFlow(ds, t, rates, ignored);
    if (!money) continue;
    const flow = flowOf(ds, t);
    if (!ds.categories.has(flow.id) && flow.id !== 'uncategorized') otherFlows.set(flow.id, flow.name);

    const at = t.dateTime as number;
    if (at < from || at >= to) continue;
    if (!matches(ds, t, money.accountId, flow.id, filters)) continue;
    if (money.base == null) {
      unconverted.add(money.currency);
      continue;
    }
    if (!withinBounds(money.base, filters)) continue;

    const side = money.direction === 'in' ? 'income' : 'expense';
    const b = buckets.get(bucketKey(at, granularity, tz))!;
    b[side] += money.base;
    b.count++;
    if (groupBy !== 'none') {
      const g =
        groupBy === 'category'
          ? flow
          : { id: money.accountId, name: ds.accounts.get(money.accountId)?.name ?? '(unknown account)' };
      const by = side === 'income' ? b.incomeBy : b.expenseBy;
      by[g.id] = (by[g.id] ?? 0) + money.base;
      const group = groups.get(g.id) ?? { id: g.id, name: g.name, income: 0, expense: 0 };
      group[side] += money.base;
      groups.set(g.id, group);
    }
    if (side === 'income') income += money.base;
    else expense += money.base;
    transactionIds.push(t.id);
  }

  const byName = (a: CustomReportOption, b: CustomReportOption) => a.name.localeCompare(b.name);
  const option = ({ id, name }: CustomReportOption) => ({ id, name });

  return {
    from,
    to,
    granularity,
    groupBy,
    options: {
      accounts: [...ds.accounts.values()]
        .filter((a) => a.includeInBalance !== false)
        .map((a) => ({ id: a.id, name: a.name, currency: a.currency || ds.baseCurrency }))
        .sort(byName),
      categories: [
        ...[...ds.categories.values()].map(option).sort(byName),
        { id: 'uncategorized', name: 'Uncategorized' },
        ...[...otherFlows].map(([id, name]) => ({ id, name })).sort(byName),
      ],
      tags: [...ds.tags.values()].map(option).sort(byName),
    },
    income: round(income),
    expense: round(expense),
    net: round(income - expense),
    count: transactionIds.length,
    groups: [...groups.values()]
      .map((g) => ({ ...g, income: round(g.income), expense: round(g.expense) }))
      .sort((a, b) => b.income + b.expense - (a.income + a.expense) || a.name.localeCompare(b.name)),
    buckets: [...buckets.values()].map((b) => ({
      ...b,
      income: round(b.income),
      expense: round(b.expense),
      incomeBy: roundAll(b.incomeBy),
      expenseBy: roundAll(b.expenseBy),
    })),
    transactionIds,
    unconverted: [...unconverted].sort(),
  };
}
