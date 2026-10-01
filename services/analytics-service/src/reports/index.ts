/**
 * Report builders: pure functions (dataset, params, rates) -> contract shapes.
 * Implemented: transactions table, balances/net worth.
 * TODO (plan section 7): summary, timeseries (Tier 0); budgets, planned, tags, payees (Tier 1).
 */
import type { AccountBalance, BalancesData, TransactionRow } from '@ivy/contracts';
import { computeBalances } from '../engine/balances';
import { toBase, type RateTable } from '../engine/currency';
import type { Dataset } from '../engine/loader';
import { classify } from '../engine/rules';

export function accountCurrency(ds: Dataset, accountId: string): string {
  return ds.accounts.get(accountId)?.currency || ds.baseCurrency;
}

/** Currencies actually in use (drives which rates we look up). */
export function currenciesInUse(ds: Dataset): Set<string> {
  const s = new Set<string>();
  for (const a of ds.accounts.values()) s.add(a.currency || ds.baseCurrency);
  return s;
}

export function transactionsTable(ds: Dataset, rates: RateTable): TransactionRow[] {
  return ds.transactions.map((t) => {
    const status = classify(t, ds.rules);
    const currency = accountCurrency(ds, t.accountId);
    return {
      id: t.id,
      type: t.type,
      status: status === 'DELETED' ? 'INVALID' : status,
      dateTime: t.dateTime ?? null,
      dueDate: t.dueDate ?? null,
      title: t.title ?? null,
      accountId: t.accountId,
      accountName: ds.accounts.get(t.accountId)?.name ?? '(unknown account)',
      toAccountName: t.toAccountId ? (ds.accounts.get(t.toAccountId)?.name ?? '(unknown account)') : null,
      categoryName: t.categoryId ? (ds.categories.get(t.categoryId)?.name ?? null) : null,
      tags: ds.tagsByTransaction.get(t.id) ?? [],
      amount: t.amount,
      currency,
      amountBase: toBase(t.amount, currency, ds.baseCurrency, rates),
    };
  });
}

export function balancesReport(ds: Dataset, asOf: number, rates: RateTable): BalancesData {
  const { balances } = computeBalances(ds, asOf);
  const unconverted = new Set<string>();
  let netWorth = 0;
  const accounts: AccountBalance[] = [];
  for (const [id, native] of balances) {
    const a = ds.accounts.get(id)!;
    const currency = a.currency || ds.baseCurrency;
    const base = toBase(native, currency, ds.baseCurrency, rates);
    const includeInBalance = a.includeInBalance !== false;
    if (includeInBalance) {
      if (base == null) unconverted.add(currency);
      else netWorth += base;
    }
    accounts.push({ accountId: id, name: a.name, currency, includeInBalance, native, base });
  }
  return { asOf, accounts, netWorth, unconverted: [...unconverted] };
}
