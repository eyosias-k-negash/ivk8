import { describe, it, expect } from 'vitest';
import { classify, isShellBudget, parseIds, plannedState } from '../../src/engine/rules';
import { ID, tx } from './fixtures';

const base = { accountId: ID.cash, type: 'EXPENSE' as const, amount: 10 };

describe('classify (Day 0: dueDate = planned, dateTime = executed)', () => {
  it('dateTime only -> EXECUTED', () => {
    expect(classify(tx({ ...base, dateTime: 1 }))).toBe('EXECUTED');
  });
  it('dueDate only -> PLANNED', () => {
    expect(classify(tx({ ...base, dueDate: 1 }))).toBe('PLANNED');
  });
  it('both set -> PLANNED by default', () => {
    expect(classify(tx({ ...base, dateTime: 1, dueDate: 2 }))).toBe('PLANNED');
  });
  it('both set -> EXECUTED when plannedWins=false', () => {
    expect(classify(tx({ ...base, dateTime: 1, dueDate: 2 }), { plannedWins: false })).toBe('EXECUTED');
  });
  it('neither -> INVALID', () => {
    expect(classify(tx(base))).toBe('INVALID');
  });
  it('deleted wins over everything', () => {
    expect(classify(tx({ ...base, dateTime: 1, isDeleted: true }))).toBe('DELETED');
  });
  it('loanId/loanRecordId do not change classification', () => {
    const t = { ...tx({ ...base, dateTime: 1 }), loanId: '00000000-0000-4000-8000-0000000000b1', loanRecordId: '00000000-0000-4000-8000-0000000000b2' };
    expect(classify(t)).toBe('EXECUTED');
  });
});

describe('plannedState', () => {
  it('past dueDate is OVERDUE, future is UPCOMING', () => {
    expect(plannedState(tx({ ...base, dueDate: 100 }), 200)).toBe('OVERDUE');
    expect(plannedState(tx({ ...base, dueDate: 300 }), 200)).toBe('UPCOMING');
  });
});

describe('parseIds / shell budgets', () => {
  it('parses, trims, drops empties', () => {
    expect(parseIds('a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(parseIds('')).toEqual([]);
    expect(parseIds(null)).toEqual([]);
    expect(parseIds(undefined)).toEqual([]);
  });
  it('empty category list is a shell budget (Day 0: useless, ignored)', () => {
    expect(isShellBudget({ id: '1', name: 'x', amount: 5, categoryIdsSerialized: '' })).toBe(true);
    expect(isShellBudget({ id: '1', name: 'x', amount: 5, categoryIdsSerialized: null })).toBe(true);
    expect(isShellBudget({ id: '1', name: 'x', amount: 5, categoryIdsSerialized: ' , ' })).toBe(true);
    expect(isShellBudget({ id: '1', name: 'x', amount: 5, categoryIdsSerialized: 'a' })).toBe(false);
  });
  it('accountIdsSerialized is irrelevant', () => {
    expect(isShellBudget({ id: '1', name: 'x', amount: 5, categoryIdsSerialized: '', accountIdsSerialized: 'acc1' })).toBe(true);
  });
});
