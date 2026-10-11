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
import type { Transaction } from '../engine/types';

export function accountCurrency(ds: Dataset, accountId: string): string {
  return ds.accounts.get(accountId)?.currency || ds.baseCurrency;
}

const inBalance = (ds: Dataset, accountId: string | null | undefined): boolean => {
  const a = accountId ? ds.accounts.get(accountId) : undefined;
  return !!a && a.includeInBalance !== false;
};

/**
 * A transaction's effect on net worth, in base currency, as the Balances tab would see it. Only accounts included
 * in the balance count. A transfer between two included accounts moves it only by valuation, when the two currencies
 * convert differently at today's rates; it is never money in or out (see `isInternalTransfer`). A side whose currency
 * has no rate counts as 0 and is listed in `unconverted`.
 */
export function netWorthDelta(ds: Dataset, t: Transaction, rates: RateTable, unconverted: Set<string>): number {
  const side = (accountId: string | null | undefined, amount: number): number => {
    if (!inBalance(ds, accountId)) return 0;
    const a = ds.accounts.get(accountId!)!;
    const currency = accountCurrency(ds, a.id);
    const v = toBase(amount, currency, ds.baseCurrency, rates);
    if (v == null) unconverted.add(currency);
    return v ?? 0;
  };
  if (t.type === 'INCOME') return side(t.accountId, t.amount);
  if (t.type === 'EXPENSE') return -side(t.accountId, t.amount);
  return -side(t.accountId, t.amount) + (t.toAccountId ? side(t.toAccountId, t.toAmount ?? t.amount) : 0);
}

/**
 * A transfer between two accounts included in the balance, whatever their currencies: neither money in nor out, so
 * it never shows in a flow chart. Only transfers to or from an excluded account do.
 */
export function isInternalTransfer(ds: Dataset, t: Transaction): boolean {
  return t.type === 'TRANSFER' && inBalance(ds, t.accountId) && inBalance(ds, t.toAccountId);
}

/**
 * What a flow chart files a transaction under: its category whenever it has one, transfers included; otherwise
 * "Uncategorized", or for an uncategorized transfer the two accounts it moves money between.
 */
export function flowOf(ds: Dataset, t: Transaction): { id: string; name: string } {
  if (t.categoryId) return { id: t.categoryId, name: ds.categories.get(t.categoryId)?.name ?? '(unknown category)' };
  if (t.type !== 'TRANSFER') return { id: 'uncategorized', name: 'Uncategorized' };
  const name = (id: string | null | undefined) => (id && ds.accounts.get(id)?.name) || '(unknown account)';
  return { id: `transfer:${t.accountId}>${t.toAccountId ?? ''}`, name: `Transfer ${name(t.accountId)} → ${name(t.toAccountId)}` };
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
