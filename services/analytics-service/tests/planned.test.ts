import { describe, it, expect } from 'vitest';
import { ingest } from '../src/engine/loader';
import type { RateTable } from '../src/engine/currency';
import { plannedReport } from '../src/reports/planned';
import { parseRange } from '../src/params';
import { ID, makeBackup, tx, utc } from './engine/fixtures';

const rates: RateTable = new Map([['USD', { currency: 'USD', rateToBase: 100, source: 'manual' }]]);

const ds = ingest(
  makeBackup({
    transactions: [
      tx({ accountId: ID.cash, type: 'INCOME', amount: 1000, dateTime: utc('2026-08-15T09:00:00Z') }), // executed, before range
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 100, categoryId: ID.food, dueDate: utc('2026-09-10T09:00:00Z') }),
      tx({ accountId: ID.usd, type: 'EXPENSE', amount: 2, categoryId: ID.food, dueDate: utc('2026-09-12T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'INCOME', amount: 500, dueDate: utc('2026-10-05T09:00:00Z') }), // uncategorized
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 40, categoryId: ID.fun, dueDate: utc('2026-10-06T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'TRANSFER', amount: 300, toAccountId: ID.excluded, dueDate: utc('2026-10-07T09:00:00Z') }), // leaves net worth
      // from an excluded account, with a category: money in, filed under Food
      tx({ accountId: ID.excluded, type: 'TRANSFER', amount: 120, toAccountId: ID.cash, categoryId: ID.food, dueDate: utc('2026-09-15T09:00:00Z') }),
      // only touches an account excluded from the balance: no bar, no line move
      tx({ accountId: ID.excluded, type: 'EXPENSE', amount: 77, categoryId: ID.fun, dueDate: utc('2026-10-09T09:00:00Z') }),
      tx({ accountId: ID.excluded, type: 'INCOME', amount: 88, dueDate: utc('2026-09-09T09:00:00Z') }),
      // between included accounts, even in other currencies and with a category: never a bar (130 ETB -> 1 USD = 100 ETB today)
      tx({ accountId: ID.cash, type: 'TRANSFER', amount: 130, toAccountId: ID.usd, toAmount: 1, categoryId: ID.fun, dueDate: utc('2026-10-08T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 7, categoryId: ID.fun, dateTime: utc('2026-09-20T09:00:00Z') }), // executed, not a bar
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 999, categoryId: ID.fun, dueDate: utc('2026-12-01T09:00:00Z') }), // out of range
    ],
  }),
);

describe('plannedReport', () => {
  const r = parseRange({ from: '2026-09-01', to: '2026-10-31' }, '+03:00');
  const out = plannedReport(ds, r.from, r.to, 'MONTH', '+03:00', rates);

  it('stacks planned income and expense per category, converted to base, one bucket per period', () => {
    expect(out.buckets.map((b) => b.bucket)).toEqual(['2026-09', '2026-10']);
    expect(out.buckets[0]).toMatchObject({ expense: { [ID.food]: 300 } });
    expect(out.buckets[1]).toMatchObject({ income: { uncategorized: 500 } });
  });

  it('only draws money in or out of net worth: never transfers between included accounts or items on excluded ones alone', () => {
    expect(out.buckets[0]!.income).toEqual({ [ID.food]: 120 });
    expect(out.buckets[1]!.expense).toEqual({ [ID.fun]: 40, [`transfer:${ID.cash}>${ID.excluded}`]: 300 });
    expect(out.categories.map((c) => c.name).sort()).toEqual(['Food', 'Fun', 'Transfer Cash → Hidden', 'Uncategorized']);
  });

  it('projects net worth from executed history plus planned items due by each bucket end', () => {
    expect(out.startingNetWorth).toBe(1000);
    // Sep: -300 (planned) -7 (executed) +120 from the excluded account; Oct: +500 -40 -300 to the excluded account,
    // and -30 from valuing the 1 USD bought for 130 ETB at today's 100, as the Balances tab would
    expect(out.buckets[0]!.netWorth).toBe(813);
    expect(out.buckets[1]!.netWorth).toBe(943);
  });

  it('reports currencies without a rate instead of mixing them in', () => {
    const none = plannedReport(ds, r.from, r.to, 'MONTH', '+03:00', new Map());
    expect(none.unconverted).toEqual(['USD']);
    expect(none.buckets[0]!.expense).toEqual({ [ID.food]: 100 }); // only the ETB item
  });
});
