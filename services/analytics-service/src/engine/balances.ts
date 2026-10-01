import type { Dataset } from './loader';
import { classify } from './rules';

export interface BalanceResult {
  /** accountId -> balance in the account's own currency. Every live account is present. */
  balances: Map<string, number>;
  /** Count of postings skipped because they referenced an unknown/deleted account. */
  skipped: number;
}

/**
 * Account balances as of `asOfMs`, in each account's native currency.
 * Only EXECUTED transactions count (planned ones never do).
 * Loan-linked transactions are normal transactions. Starting balances are
 * ordinary transactions in Ivy, so there is no separate initial-balance field.
 */
export function computeBalances(ds: Dataset, asOfMs: number): BalanceResult {
  const balances = new Map<string, number>();
  for (const id of ds.accounts.keys()) balances.set(id, 0);
  let skipped = 0;

  const post = (accountId: string | null | undefined, delta: number) => {
    if (!accountId || !balances.has(accountId)) {
      skipped++;
      return;
    }
    balances.set(accountId, (balances.get(accountId) as number) + delta);
  };

  for (const t of ds.transactions) {
    if (classify(t, ds.rules) !== 'EXECUTED') continue;
    if ((t.dateTime as number) > asOfMs) continue;
    switch (t.type) {
      case 'INCOME':
        post(t.accountId, t.amount);
        break;
      case 'EXPENSE':
        post(t.accountId, -t.amount);
        break;
      case 'TRANSFER':
        post(t.accountId, -t.amount);
        if (t.toAccountId) post(t.toAccountId, t.toAmount ?? t.amount);
        break;
    }
  }
  return { balances, skipped };
}
