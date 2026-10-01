import type { Backup, Transaction } from '../../src/engine/types';

// Valid-looking UUIDs for fixtures
export const ID = {
  cash: '00000000-0000-4000-8000-000000000001',
  usd: '00000000-0000-4000-8000-000000000002',
  excluded: '00000000-0000-4000-8000-000000000003',
  food: '00000000-0000-4000-8000-000000000010',
  fun: '00000000-0000-4000-8000-000000000011',
  settings: '00000000-0000-4000-8000-000000000020',
  budget: '00000000-0000-4000-8000-000000000030',
  shell: '00000000-0000-4000-8000-000000000031',
};

let n = 100;
export const txId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

export const utc = (iso: string) => Date.parse(iso);

export function tx(p: Partial<Transaction> & Pick<Transaction, 'accountId' | 'type' | 'amount'>): Transaction {
  return { id: txId(), ...p };
}

export function makeBackup(over: Partial<Backup> = {}): Backup {
  return {
    accounts: [
      { id: ID.cash, name: 'Cash', currency: 'ETB' },
      { id: ID.usd, name: 'USD Wallet', currency: 'USD' },
      { id: ID.excluded, name: 'Hidden', currency: 'ETB', includeInBalance: false },
    ],
    budgets: [],
    categories: [
      { id: ID.food, name: 'Food' },
      { id: ID.fun, name: 'Fun' },
    ],
    loanRecords: [],
    loans: [],
    plannedPaymentRules: [],
    settings: [{ id: ID.settings, theme: 'AUTO', currency: 'ETB', bufferAmount: 0, name: 'Tester' }],
    transactions: [],
    sharedPrefs: {},
    ...over,
  };
}
