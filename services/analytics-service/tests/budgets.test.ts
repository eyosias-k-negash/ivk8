import { describe, it, expect } from 'vitest';
import { ingest } from '../src/engine/loader';
import type { RateTable } from '../src/engine/currency';
import { bucketThreshold, budgetTimeseriesReport, budgetsList } from '../src/reports/budgets';
import { parseRange } from '../src/params';
import { ID, makeBackup, tx, utc } from './engine/fixtures';

const rates: RateTable = new Map([['USD', { currency: 'USD', rateToBase: 100, source: 'manual' }]]);

const ds = ingest(
  makeBackup({
    budgets: [
      { id: ID.budget, name: 'Living', amount: 3000, categoryIdsSerialized: `${ID.food}, ${ID.fun}` },
      { id: ID.shell, name: 'Empty', amount: 1, categoryIdsSerialized: '' },
    ],
    transactions: [
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 200, categoryId: ID.food, dateTime: utc('2026-09-05T09:00:00Z') }),
      tx({ accountId: ID.usd, type: 'EXPENSE', amount: 3, categoryId: ID.food, dateTime: utc('2026-09-10T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 40, categoryId: ID.fun, dateTime: utc('2026-10-02T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 999, dateTime: utc('2026-09-06T09:00:00Z') }), // uncategorized
      tx({ accountId: ID.cash, type: 'INCOME', amount: 999, categoryId: ID.food, dateTime: utc('2026-09-06T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 999, categoryId: ID.food, dueDate: utc('2026-09-20T09:00:00Z') }), // planned
    ],
  }),
);

describe('bucketThreshold', () => {
  it('keeps a month as is and a year at 12x', () => {
    expect(bucketThreshold(3000, '2026-09', 'MONTH')).toBe(3000);
    expect(bucketThreshold(3000, '2026', 'YEAR')).toBe(36000);
  });
  it('scales days and weeks by the days of their own month', () => {
    expect(bucketThreshold(3000, '2026-09-05', 'DAY')).toBeCloseTo(100); // 30-day month
    expect(bucketThreshold(3100, '2026-10-05', 'DAY')).toBeCloseTo(100); // 31-day month
    expect(bucketThreshold(3000, '2026-09-07', 'WEEK')).toBeCloseTo(700);
  });
  it('splits a week that straddles two months', () => {
    // Mon Sep 28 .. Sun Oct 4: 3 days at 3000/30 + 4 days at 3000/31
    expect(bucketThreshold(3000, '2026-09-28', 'WEEK')).toBeCloseTo(300 + 4 * (3000 / 31));
  });
});

describe('budgetsList', () => {
  it('lists live budgets with category names, without shells', () => {
    const l = budgetsList(ds).budgets;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ name: 'Living', amount: 3000, categories: [{ name: 'Food' }, { name: 'Fun' }] });
  });
});

describe('budgetTimeseriesReport', () => {
  const r = parseRange({ from: '2026-09-01', to: '2026-10-31' }, '+03:00');
  const out = budgetTimeseriesReport(ds, ID.budget, r.from, r.to, 'MONTH', '+03:00', rates)!;

  it('counts only executed expenses in the budget categories, converted to base', () => {
    expect(out.buckets.map((b) => b.bucket)).toEqual(['2026-09', '2026-10']);
    expect(out.buckets[0]!.spent).toEqual({ [ID.food]: 500 });
    expect(out.buckets[1]!.spent).toEqual({ [ID.fun]: 40 });
    expect(out.buckets.every((b) => b.threshold === 3000)).toBe(true);
  });

  it('reports unconvertible currencies instead of dropping them silently', () => {
    const none: RateTable = new Map([['USD', { currency: 'USD', rateToBase: null, source: 'unavailable' }]]);
    const o = budgetTimeseriesReport(ds, ID.budget, r.from, r.to, 'MONTH', '+03:00', none)!;
    expect(o.unconverted).toEqual(['USD']);
    expect(o.buckets[0]!.spent).toEqual({ [ID.food]: 200 });
  });

  it('returns null for an unknown or shell budget', () => {
    expect(budgetTimeseriesReport(ds, ID.shell, r.from, r.to, 'MONTH', '+03:00', rates)).toBeNull();
  });
});
