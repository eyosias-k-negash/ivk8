/**
 * Report builders: pure functions (dataset, params, rates) -> contract shapes.
 * Here: transactions table, balances/net worth, and the money-flow rules every other report shares.
 * Elsewhere in reports/: flows (summary, timeseries), budgets, planned, projection, tags, custom. TODO: payees (plan section 7).
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
 * two included accounts, whatever their currencies (views that offer to count those use `moneyFlows`).
 */
export function moneyFlow(ds: Dataset, t: Transaction, rates: RateTable, unconverted: Set<string>): MoneyFlow | null {
  if (t.type === 'TRANSFER') {
    const fromIn = inBalance(ds, t.accountId);
    if (fromIn === inBalance(ds, t.toAccountId)) return null;
    return fromIn
      ? flowOn(ds, 'out', t.accountId, t.amount, rates, unconverted)
      : flowOn(ds, 'in', t.toAccountId!, t.toAmount ?? t.amount, rates, unconverted);
  }
  if (!inBalance(ds, t.accountId)) return null;
  return flowOn(ds, t.type === 'INCOME' ? 'in' : 'out', t.accountId, t.amount, rates, unconverted);
}

function flowOn(
  ds: Dataset,
  direction: MoneyFlow['direction'],
  accountId: string,
  native: number,
  rates: RateTable,
  unconverted: Set<string>,
): MoneyFlow {
  const currency = accountCurrency(ds, accountId);
  const base = toBase(native, currency, ds.baseCurrency, rates);
  if (base == null) unconverted.add(currency);
  return { direction, accountId, currency, native, base };
}

/** A money flow and what a breakdown by category files it under. */
export interface FiledFlow extends MoneyFlow {
  flow: { id: string; name: string };
}

/**
 * Every flow a transaction makes, filed by category: the one `moneyFlow` counts, under `flowOf`. With `transfers`
 * on, a transfer between two included accounts counts too, as two flows: expense on the account it leaves, filed
 * under "<account> OUT" (id "transfer-out:<account id>"), and income on the one it reaches, under "<account> IN"
 * ("transfer-in:<account id>"). Its own category is not used, so a transfer never inflates a real category on both
 * sides. Off, such a transfer makes no flow, as everywhere else.
 */
export function moneyFlows(ds: Dataset, t: Transaction, rates: RateTable, unconverted: Set<string>, transfers: boolean): FiledFlow[] {
  const m = moneyFlow(ds, t, rates, unconverted);
  if (m) return [{ ...m, flow: flowOf(ds, t) }];
  if (!transfers || t.type !== 'TRANSFER' || !inBalance(ds, t.accountId) || !inBalance(ds, t.toAccountId)) return [];
  const name = (id: string) => ds.accounts.get(id)?.name ?? '(unknown account)';
  return [
    { ...flowOn(ds, 'out', t.accountId, t.amount, rates, unconverted), flow: { id: `transfer-out:${t.accountId}`, name: `${name(t.accountId)} OUT` } },
    {
      ...flowOn(ds, 'in', t.toAccountId!, t.toAmount ?? t.amount, rates, unconverted),
      flow: { id: `transfer-in:${t.toAccountId}`, name: `${name(t.toAccountId!)} IN` },
    },
  ];
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
