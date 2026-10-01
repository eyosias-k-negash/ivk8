import { describe, it, expect } from 'vitest';
import { ingest, IngestError } from '../../src/engine/loader';
import { ID, makeBackup, tx } from './fixtures';

describe('ingest', () => {
  it('accepts a minimal valid backup and resolves base currency', () => {
    const ds = ingest(makeBackup());
    expect(ds.baseCurrency).toBe('ETB');
    expect(ds.accounts.size).toBe(3);
  });

  it('rejects a backup missing required top-level keys', () => {
    const b: any = makeBackup();
    delete b.transactions;
    expect(() => ingest(b)).toThrow(IngestError);
  });

  it('fails clearly when no settings exist', () => {
    try {
      ingest(makeBackup({ settings: [] }));
      expect.unreachable();
    } catch (e) {
      expect((e as IngestError).code).toBe('NO_SETTINGS');
    }
  });

  it('treats missing tags/tagAssociations as empty (Day 0 #8)', () => {
    const ds = ingest(makeBackup());
    expect(ds.tagsByTransaction.size).toBe(0);
  });

  it('joins tags via associations, skipping deleted ones', () => {
    const t = tx({ accountId: ID.cash, type: 'EXPENSE', amount: 5, dateTime: 1 });
    const tagA = '00000000-0000-4000-8000-0000000000a1';
    const tagB = '00000000-0000-4000-8000-0000000000a2';
    const ds = ingest(
      makeBackup({
        transactions: [t],
        tags: [
          { id: tagA, name: 'trip' },
          { id: tagB, name: 'old', isDeleted: true },
        ],
        tagAssociations: [
          { tagId: tagA, associatedId: t.id },
          { tagId: tagB, associatedId: t.id },
          { tagId: tagA, associatedId: t.id, isDeleted: true },
        ],
      }),
    );
    expect(ds.tagsByTransaction.get(t.id)).toEqual(['trip']);
  });

  it('drops shell budgets and warns; keeps real ones; ignores accountIdsSerialized', () => {
    const ds = ingest(
      makeBackup({
        budgets: [
          { id: ID.budget, name: 'Food', amount: 100, categoryIdsSerialized: ID.food, accountIdsSerialized: '' },
          { id: ID.shell, name: 'Shell', amount: 50, categoryIdsSerialized: '', accountIdsSerialized: ID.cash },
        ],
      }),
    );
    expect(ds.budgets.map((b) => b.id)).toEqual([ID.budget]);
    expect(ds.warnings.find((w) => w.code === 'SHELL_BUDGETS')?.count).toBe(1);
  });

  it('warns about transactions with both dueDate and dateTime (treated as planned)', () => {
    const ds = ingest(
      makeBackup({
        transactions: [tx({ accountId: ID.cash, type: 'EXPENSE', amount: 5, dateTime: 1, dueDate: 2 })],
      }),
    );
    const w = ds.warnings.find((x) => x.code === 'PLANNED_WITH_DATETIME');
    expect(w?.count).toBe(1);
    expect(w?.message).toContain('planned');
  });

  it('warns about transactions with no dates and about dangling accounts', () => {
    const ds = ingest(
      makeBackup({
        transactions: [
          tx({ accountId: ID.cash, type: 'EXPENSE', amount: 5 }),
          tx({ accountId: '00000000-0000-4000-8000-00000000ffff', type: 'EXPENSE', amount: 5, dateTime: 1 }),
        ],
      }),
    );
    expect(ds.warnings.find((w) => w.code === 'NO_DATES')?.count).toBe(1);
    expect(ds.warnings.find((w) => w.code === 'DANGLING_ACCOUNT')?.count).toBe(1);
  });
});
