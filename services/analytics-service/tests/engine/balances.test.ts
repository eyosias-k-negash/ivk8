import { describe, it, expect } from 'vitest';
import { ingest } from '../../src/engine/loader';
import { computeBalances } from '../../src/engine/balances';
import { ID, makeBackup, tx, utc } from './fixtures';

const T = utc('2026-09-10T12:00:00Z');
const ASOF = utc('2026-09-30T00:00:00Z');

describe('computeBalances', () => {
  it('income adds, expense subtracts, per account', () => {
    const ds = ingest(
      makeBackup({
        transactions: [
          tx({ accountId: ID.cash, type: 'INCOME', amount: 1000, dateTime: T }),
          tx({ accountId: ID.cash, type: 'EXPENSE', amount: 250, dateTime: T }),
        ],
      }),
    );
    expect(computeBalances(ds, ASOF).balances.get(ID.cash)).toBeCloseTo(750);
  });

  it('cross-currency transfer debits amount and credits toAmount', () => {
    const ds = ingest(
      makeBackup({
        transactions: [
          tx({ accountId: ID.cash, type: 'TRANSFER', amount: 13000, toAccountId: ID.usd, toAmount: 100, dateTime: T }),
        ],
      }),
    );
    const { balances } = computeBalances(ds, ASOF);
    expect(balances.get(ID.cash)).toBeCloseTo(-13000);
    expect(balances.get(ID.usd)).toBeCloseTo(100);
  });

  it('same-currency transfer without toAmount credits the same amount', () => {
    const ds = ingest(
      makeBackup({
        transactions: [tx({ accountId: ID.cash, type: 'TRANSFER', amount: 40, toAccountId: ID.excluded, dateTime: T })],
      }),
    );
    expect(computeBalances(ds, ASOF).balances.get(ID.excluded)).toBeCloseTo(40);
  });

  it('planned transactions never count, even overdue or with dateTime', () => {
    const ds = ingest(
      makeBackup({
        transactions: [
          tx({ accountId: ID.cash, type: 'EXPENSE', amount: 100, dueDate: utc('2026-01-01T00:00:00Z') }), // overdue
          tx({ accountId: ID.cash, type: 'EXPENSE', amount: 100, dueDate: utc('2027-01-01T00:00:00Z') }), // future
          tx({ accountId: ID.cash, type: 'EXPENSE', amount: 100, dueDate: T, dateTime: T }), // both
        ],
      }),
    );
    expect(computeBalances(ds, ASOF).balances.get(ID.cash)).toBe(0);
  });

  it('respects asOf and deleted flags', () => {
    const ds = ingest(
      makeBackup({
        transactions: [
          tx({ accountId: ID.cash, type: 'INCOME', amount: 10, dateTime: utc('2026-10-05T00:00:00Z') }), // after asOf
          tx({ accountId: ID.cash, type: 'INCOME', amount: 20, dateTime: T, isDeleted: true }),
          tx({ accountId: ID.cash, type: 'INCOME', amount: 5, dateTime: T }),
        ],
      }),
    );
    expect(computeBalances(ds, ASOF).balances.get(ID.cash)).toBeCloseTo(5);
  });

  it('loan-linked transactions count as normal (Day 0 #4)', () => {
    const t = { ...tx({ accountId: ID.cash, type: 'INCOME', amount: 500, dateTime: T }), loanId: '00000000-0000-4000-8000-0000000000b1', loanRecordId: '00000000-0000-4000-8000-0000000000b2' };
    const ds = ingest(makeBackup({ transactions: [t] }));
    expect(computeBalances(ds, ASOF).balances.get(ID.cash)).toBeCloseTo(500);
  });

  it('counts skipped postings for unknown accounts instead of crashing', () => {
    const ds = ingest(
      makeBackup({
        transactions: [tx({ accountId: '00000000-0000-4000-8000-00000000ffff', type: 'INCOME', amount: 1, dateTime: T })],
      }),
    );
    expect(computeBalances(ds, ASOF).skipped).toBe(1);
  });
});
