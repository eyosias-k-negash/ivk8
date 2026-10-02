import { describe, it, expect } from 'vitest';
import { ingest } from '../src/engine/loader';
import type { RateTable } from '../src/engine/currency';
import { bucketKeys, summaryReport, timeseriesReport } from '../src/reports/flows';
import { parseRange } from '../src/params';
import { ID, makeBackup, tx, utc } from './engine/fixtures';

// Base is ETB; USD converts at 100 ETB.
const rates: RateTable = new Map([['USD', { currency: 'USD', rateToBase: 100, source: 'manual' }]]);
const none: RateTable = new Map([['USD', { currency: 'USD', rateToBase: null, source: 'unavailable' }]]);

const ds = ingest(
  makeBackup({
    transactions: [
      tx({ accountId: ID.cash, type: 'INCOME', amount: 1000, categoryId: ID.fun, dateTime: utc('2026-09-01T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 200, categoryId: ID.food, dateTime: utc('2026-09-05T09:00:00Z') }),
      tx({ accountId: ID.usd, type: 'EXPENSE', amount: 3, categoryId: ID.food, dateTime: utc('2026-09-10T09:00:00Z') }),
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 50, dateTime: utc('2026-09-12T09:00:00Z') }), // uncategorized
      // transfer: neither income nor expense
      tx({ accountId: ID.cash, type: 'TRANSFER', amount: 400, toAccountId: ID.usd, toAmount: 4, dateTime: utc('2026-09-15T09:00:00Z') }),
      // planned (due date set, even with dateTime): excluded
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 999, dueDate: utc('2026-09-20T09:00:00Z'), dateTime: utc('2026-09-20T09:00:00Z') }),
      // 22:30 UTC on Sep 30 = 01:30 Oct 1 at +03:00 -> October, not September
      tx({ accountId: ID.cash, type: 'EXPENSE', amount: 70, categoryId: ID.food, dateTime: utc('2026-09-30T22:30:00Z') }),
      // loan-linked transaction counts normally (loanId is ignored by the engine)
      tx({ accountId: ID.cash, type: 'INCOME', amount: 30, dateTime: utc('2026-10-02T09:00:00Z') }),
    ],
  }),
);

const sept = parseRange({ from: '2026-09-01', to: '2026-09-30' }, '+03:00');

describe('parseRange', () => {
  it('reads date-only values as whole local days', () => {
    expect(sept.from).toBe(utc('2026-08-31T21:00:00Z'));
    expect(sept.to).toBe(utc('2026-09-30T21:00:00Z'));
  });
  it('defaults to the current local month up to now', () => {
    const now = utc('2026-10-15T12:00:00Z');
    expect(parseRange({}, '+03:00', now)).toEqual({ from: utc('2026-09-30T21:00:00Z'), to: now });
  });
  it('rejects inverted ranges', () => {
    expect(() => parseRange({ from: '2026-09-10', to: '2026-09-01' }, '+03:00')).toThrow();
  });
});

describe('summaryReport', () => {
  const s = summaryReport(ds, sept.from, sept.to, rates);

  it('counts executed income/expense only, converted to base', () => {
    expect(s.income).toBe(1000);
    expect(s.expense).toBe(200 + 300 + 50); // transfer, planned and the Oct 1 (local) expense excluded
    expect(s.net).toBe(450);
    expect(s.count).toBe(4);
  });

  it('splits by category, with an Uncategorized bucket', () => {
    const food = s.byCategory.find((c) => c.name === 'Food');
    expect(food).toMatchObject({ expense: 500, income: 0, net: -500 });
    expect(s.byCategory.find((c) => c.id === 'uncategorized')?.expense).toBe(50);
  });

  it('splits by account with native amounts', () => {
    const usd = s.byAccount.find((a) => a.name === 'USD Wallet');
    expect(usd).toMatchObject({ currency: 'USD', expenseNative: 3, expense: 300 });
  });

  it('reports unconvertible currencies instead of mixing them in', () => {
    const u = summaryReport(ds, sept.from, sept.to, none);
    expect(u.expense).toBe(250);
    expect(u.unconverted).toEqual(['USD']);
    expect(u.byAccount.find((a) => a.currency === 'USD')?.expenseNative).toBe(3);
  });

  it('moves the 22:30 UTC month-end expense when the timezone changes', () => {
    const utcSept = parseRange({ from: '2026-09-01', to: '2026-09-30' }, 'Z');
    expect(summaryReport(ds, utcSept.from, utcSept.to, rates).expense).toBe(550 + 70);
  });
});

describe('bucketKeys', () => {
  it('enumerates months and Monday-start weeks in local time', () => {
    const r = parseRange({ from: '2026-08-15', to: '2026-10-05' }, '+03:00');
    expect(bucketKeys(r.from, r.to, 'MONTH', '+03:00')).toEqual(['2026-08', '2026-09', '2026-10']);
    const w = parseRange({ from: '2026-09-28', to: '2026-10-12' }, '+03:00');
    expect(bucketKeys(w.from, w.to, 'WEEK', '+03:00')).toEqual(['2026-09-28', '2026-10-05', '2026-10-12']);
  });
  it('refuses absurd ranges', () => {
    expect(() => bucketKeys(0, utc('2026-01-01T00:00:00Z'), 'DAY', 'Z')).toThrow();
  });
});

describe('timeseriesReport', () => {
  const r = parseRange({ from: '2026-09-01', to: '2026-10-31' }, '+03:00');

  it('fills every bucket and puts the month-end expense in October at +03:00', () => {
    const t = timeseriesReport(ds, r.from, r.to, 'MONTH', 'none', '+03:00', rates);
    expect(t.points).toEqual([
      { bucket: '2026-09', income: 1000, expense: 550 },
      { bucket: '2026-10', income: 30, expense: 70 },
    ]);
  });

  it('includes empty buckets as zeros', () => {
    const t = timeseriesReport(ds, r.from, r.to, 'WEEK', 'none', '+03:00', rates);
    expect(t.points.length).toBeGreaterThan(8);
    expect(t.points.some((p) => p.income === 0 && p.expense === 0)).toBe(true);
  });

  it('splits by category', () => {
    const t = timeseriesReport(ds, r.from, r.to, 'MONTH', 'category', '+03:00', rates);
    expect(t.points.filter((p) => p.groupName === 'Food')).toEqual([
      { bucket: '2026-09', groupId: ID.food, groupName: 'Food', income: 0, expense: 500 },
      { bucket: '2026-10', groupId: ID.food, groupName: 'Food', income: 0, expense: 70 },
    ]);
  });

  it('splits by account', () => {
    const t = timeseriesReport(ds, r.from, r.to, 'YEAR', 'account', '+03:00', rates);
    expect(t.points.find((p) => p.groupName === 'USD Wallet')).toMatchObject({ bucket: '2026', expense: 300 });
  });
});
