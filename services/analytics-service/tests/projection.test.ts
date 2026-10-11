import { describe, it, expect } from 'vitest';
import { ingest } from '../src/engine/loader';
import type { RateTable } from '../src/engine/currency';
import { parseLocalInstant } from '../src/params';
import { parseWindow, projectionReport } from '../src/reports/projection';
import { ID, makeBackup, tx, utc } from './engine/fixtures';

const rates: RateTable = new Map([['USD', { currency: 'USD', rateToBase: 100, source: 'manual' }]]);
const TZ = '+03:00';

const ds = ingest(
  makeBackup({
    transactions: [
      tx({ accountId: ID.cash, type: 'INCOME', amount: 600, dateTime: utc('2026-05-20T09:00:00Z') }), // first history, before a 4-month window
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 100, categoryId: ID.food, dateTime: utc('2026-06-10T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'INCOME', amount: 1200, dateTime: utc('2026-07-01T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 200, categoryId: ID.food, dateTime: utc('2026-07-12T09:00:00Z') }),
      // to an excluded account, with a category: money out, filed under Food
      tx({ accountId: ID.cash, type: 'TRANSFER', amount: 40, toAccountId: ID.excluded, categoryId: ID.food, dateTime: utc('2026-07-15T09:00:00Z') }),
      tx({ accountId: ID.usd, type: 'EXPENSE', amount: 1, categoryId: ID.food, dateTime: utc('2026-08-05T09:00:00Z') }), // 100 ETB
      // between included accounts, in other currencies and with a category: never a flow; the line moves -50 by valuation
      tx({ accountId: ID.cash, type: 'TRANSFER', amount: 150, toAccountId: ID.usd, toAmount: 1, categoryId: ID.fun, dateTime: utc('2026-08-10T09:00:00Z') }),
      // planned for July but executed in August: counts in August
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 100, categoryId: ID.food, dueDate: utc('2026-07-30T09:00:00Z'), dateTime: utc('2026-08-20T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 300, categoryId: ID.fun, dateTime: utc('2026-09-03T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'INCOME', amount: 400, dateTime: utc('2026-09-25T09:00:00Z') }),
      tx({ accountId: ID.excluded, type: 'INCOME', amount: 5000, dateTime: utc('2026-09-26T09:00:00Z') }), // outside net worth
      tx({ accountId: ID.cash, type: 'TRANSFER', amount: 200, toAccountId: ID.excluded, dateTime: utc('2026-09-27T09:00:00Z') }), // leaves net worth
      tx({ accountId: ID.cash, type: 'TRANSFER', amount: 30, toAccountId: ID.cash, dateTime: utc('2026-09-28T09:00:00Z') }), // stays in it
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 70, categoryId: ID.food, dateTime: utc('2026-10-05T09:00:00Z') }), // current month so far
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 999, categoryId: ID.fun, dateTime: utc('2026-10-20T09:00:00Z') }), // executed, dated ahead of asOf
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 500, categoryId: ID.fun, dueDate: utc('2026-11-01T09:00:00Z') }), // planned: ignored
    ],
  }),
);

const asOf = utc('2026-10-11T12:00:00Z'); // Oct 11 15:00 local
const to = parseLocalInstant('2026-12-15', 'to', TZ, true)!; // through Dec 15: 15 of December's 31 days
const TRANSFER_OUT = `transfer:${ID.cash}>${ID.excluded}`;

describe('projectionReport', () => {
  const out = projectionReport(ds, asOf, to, 'MONTH', 4, TZ, rates);

  it('averages money in and out of net worth over the complete buckets before the current one', () => {
    expect(out.windowUsed).toBe(4);
    expect(out.buckets.map((b) => [b.bucket, b.phase])).toEqual([
      ['2026-06', 'actual'],
      ['2026-07', 'actual'],
      ['2026-08', 'actual'],
      ['2026-09', 'actual'],
      ['2026-10', 'current'],
      ['2026-11', 'projected'],
      ['2026-12', 'projected'],
    ]);
    // Income: 1200 (Jul) + 400 (Sep) over 4 months; the excluded account's 5000 stays out.
    expect(out.averageIncome).toEqual({ uncategorized: 400 });
    // Food: 100 + (200 + 40 categorized transfer) + (100 + 100 executed late); the uncategorized transfer goes under its accounts.
    expect(out.averageExpense).toEqual({ [ID.food]: 135, [ID.fun]: 75, [TRANSFER_OUT]: 50 });
    expect(out.buckets[3]).toMatchObject({ income: { uncategorized: 400 }, expense: { [ID.fun]: 300, [TRANSFER_OUT]: 200 }, projectedIncome: {} });
    expect(out.categories.map((c) => c.name).sort()).toEqual(['Food', 'Fun', 'Transfer Cash → Hidden', 'Uncategorized']);
  });

  it('starts from net worth today and counts executed transactions dated later in their own bucket', () => {
    expect(out.buckets.slice(0, 4).map((b) => b.netWorth)).toEqual([500, 1460, 1210, 1110]);
    expect(out.currentNetWorth).toBe(1040); // the 999 on Oct 20 is not in today's figure; the planned 500 never is
    const oct = out.buckets[4]!;
    expect(oct.expense).toEqual({ [ID.food]: 70, [ID.fun]: 999 });
  });

  it('tops each flow up to its average from the current bucket on, never below what is executed', () => {
    const oct = out.buckets[4]!;
    expect(oct.projectedIncome).toEqual({ uncategorized: 400 });
    expect(oct.projectedExpense).toEqual({ [ID.food]: 65, [TRANSFER_OUT]: 50 }); // fun already passed its 75 with the 999
    // October: 1110 - 70 - 999 executed, +400 -65 -50 assumed; then 140 net per month: a full November, x 15/31 for December
    expect(out.buckets.slice(4).map((b) => b.netWorth)).toEqual([326, 466, 533.74]);
    expect(out.buckets[5]).toMatchObject({ income: {}, expense: {}, projectedIncome: { uncategorized: 400 } });
  });

  it('averages over fewer buckets when history is shorter than the window', () => {
    const six = projectionReport(ds, asOf, to, 'MONTH', 6, TZ, rates);
    expect(six.windowUsed).toBe(5); // May has history; April ends before the first transaction
    expect(six.buckets[0]!.bucket).toBe('2026-05');
    expect(six.averageIncome).toEqual({ uncategorized: 440 });
  });

  it('adds only executed transactions when there is no complete bucket to average yet', () => {
    const early = projectionReport(ds, utc('2026-05-25T12:00:00Z'), parseLocalInstant('2026-06-30', 'to', TZ, true)!, 'MONTH', 4, TZ, rates);
    expect(early.windowUsed).toBe(0);
    expect(early.averageIncome).toEqual({});
    expect(early.buckets.map((b) => [b.phase, b.netWorth])).toEqual([['current', 600], ['projected', 500]]);
  });

  it('cuts the top-up by time when `to` ends inside the current bucket', () => {
    const short = projectionReport(ds, asOf, utc('2026-10-21T12:00:00Z'), 'MONTH', 4, TZ, rates);
    // 10 of the 20.375 days left in October
    expect(short.buckets.at(-1)!.projectedIncome).toEqual({ uncategorized: 196.32 });
  });

  it('reports currencies without a rate instead of mixing them in', () => {
    const none = projectionReport(ds, asOf, to, 'MONTH', 4, TZ, new Map());
    expect(none.unconverted).toEqual(['USD']);
    expect(none.averageExpense[ID.food]).toBe(110); // the USD expense in August is left out
  });
});

describe('parseWindow', () => {
  it('defaults to 4 and accepts whole numbers in range only', () => {
    expect(parseWindow(undefined)).toBe(4);
    expect(parseWindow('6')).toBe(6);
    expect(parseWindow('0')).toBeNull();
    expect(parseWindow('2.5')).toBeNull();
    expect(parseWindow('99')).toBeNull();
  });
});
