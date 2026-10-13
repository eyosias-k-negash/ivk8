/**
 * Report builders: pure functions (dataset, params, rates) -> contract shapes.
 * Here: transactions table, balances/net worth, and the money-flow rules every other report shares.
 * Elsewhere in reports/: flows (summary, timeseries), budgets, planned, projection, tags. TODO: payees (plan section 7).
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
 * convert differently at today's rates; it is never money in or out (see `moneyFlow`). A side whose currency
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

export interface MoneyFlow {
  direction: 'in' | 'out';
  /** The side included in the balance, and the amount in its own currency. */
  accountId: string;
  currency: string;
  native: number;
  /** In base currency; null when the currency has no rate (then listed in `unconverted`). */
  base: number | null;
}

/**
 * Money into or out of net worth, as every income and expense view counts it: income and expense on accounts
 * included in the balance, and transfers to or from an excluded account (out when money leaves an included account,
 * in when it arrives). Null for everything else: income and expense on an excluded account, and transfers between
 * two included accounts, whatever their currencies.
 */
export function moneyFlow(ds: Dataset, t: Transaction, rates: RateTable, unconverted: Set<string>): MoneyFlow | null {
  let direction: MoneyFlow['direction'];
  let accountId: string;
  let native: number;
  if (t.type === 'TRANSFER') {
    const fromIn = inBalance(ds, t.accountId);
    if (fromIn === inBalance(ds, t.toAccountId)) return null;
    [direction, accountId, native] = fromIn ? ['out', t.accountId, t.amount] : ['in', t.toAccountId!, t.toAmount ?? t.amount];
  } else {
    if (!inBalance(ds, t.accountId)) return null;
    [direction, accountId, native] = [t.type === 'INCOME' ? 'in' : 'out', t.accountId, t.amount];
  }
  const currency = accountCurrency(ds, accountId);
  const base = toBase(native, currency, ds.baseCurrency, rates);
  if (base == null) unconverted.add(currency);
  return { direction, accountId, currency, native, base };
}

/**
 * What a breakdown files a transaction under: its category whenever it has one, transfers included; otherwise
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
      tags: (ds.tagsByTransaction.get(t.id) ?? []).map((id) => ds.tags.get(id)!.name),
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
