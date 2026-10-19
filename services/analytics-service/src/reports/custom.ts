/**
 * The configurable report behind the Reports tab: income and expense over time for the transactions that pass the
 * filters, optionally split by category or account.
 *
 * Rules applied here:
 * - Money counts exactly as in every income and expense view (see `moneyFlow`, `flowOf`): executed only; income and
 *   expense on accounts included in the balance, and transfers to or from an excluded account, filed under the
 *   included side and under their category (or their two accounts when they have none). Income and expense on an
 *   excluded account, and transfers between two included accounts, never count, whatever the filters.
 * - Scope: the included side is one of `accounts`, and the flow id the category breakdown files it under is one of
 *   `categories`. Unknown ids match nothing rather than failing, so a filter made against another backup still runs.
 * - Rules: a tree of conditions on tags, words in the title or description (any case) and the base amount (to the
 *   cent, bounds inclusive), joined by all/any per group (see CustomReportRule). An empty group matches everything.
 * - Range is [from, to) on dateTime, bucketed in the request timezone. Amounts are in base at the current rate. A
 *   currency with no rate can't be totalled, nor tested against an amount condition, so its transactions are left
 *   out; the currency is listed in `unconverted` when one of them matches, or might if its amount were known.
 */
import type {
  CustomReportBucket, CustomReportData, CustomReportGroup, CustomReportOption, CustomReportRule, CustomReportRuleGroup,
  Granularity, GroupBy,
} from '@ivy/contracts';
import type { RateTable } from '../engine/currency';
import type { Dataset } from '../engine/loader';
import { classify } from '../engine/rules';
import { bucketKey } from '../engine/time';
import type { Transaction } from '../engine/types';
import { BadRequest } from '../params';
import { flowOf, moneyFlow } from './index';
import { bucketKeys } from './flows';

/** Conditions plus groups, root included; keeps a request from asking for unbounded work. */
export const MAX_RULES = 50;
/** The root group is level 1. */
export const MAX_DEPTH = 3;

export interface CustomFilters {
  accounts?: ReadonlySet<string>;
  categories?: ReadonlySet<string>;
  /** Text conditions' words are lower-cased. */
  rules?: CustomReportRuleGroup;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Comma-separated, trimmed, blanks dropped; nothing left = no filter. */
function list(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined;
  const items = String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

const strings = (v: unknown, what: string): string[] => {
  const items = Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean) : [];
  if (!items.length) throw new BadRequest(`a ${what} rule needs at least one entry`);
  return items;
};

const bound = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new BadRequest(`an amount rule's ${name} must be a number of 0 or more`);
  return v;
};

/** Validates the JSON rule tree and normalizes it: trimmed entries, lower-cased words. */
export function parseRules(v: unknown): CustomReportRuleGroup | undefined {
  if (v == null || v === '') return undefined;
  let json: unknown;
  try {
    json = JSON.parse(String(v));
  } catch {
    throw new BadRequest('rules must be JSON');
  }
  let count = 0;
  const rule = (r: unknown, depth: number): CustomReportRule => {
    if (++count > MAX_RULES) throw new BadRequest(`rules may hold at most ${MAX_RULES} conditions and groups`);
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new BadRequest('each rule must be an object');
    const o = r as Record<string, unknown>;
    switch (o.kind) {
      case 'group':
        if (depth > MAX_DEPTH) throw new BadRequest(`groups nest at most ${MAX_DEPTH} levels deep`);
        if (o.match !== 'all' && o.match !== 'any') throw new BadRequest("a group's match must be all or any");
        if (!Array.isArray(o.rules)) throw new BadRequest('a group needs a rules list');
        return { kind: 'group', match: o.match, rules: o.rules.map((c) => rule(c, depth + 1)) };
      case 'tags':
        if (o.op !== 'any' && o.op !== 'all' && o.op !== 'none') throw new BadRequest("a tags rule's op must be any, all or none");
        return { kind: 'tags', op: o.op, tagIds: strings(o.tagIds, 'tags') };
      case 'text':
        if (o.op !== 'contains' && o.op !== 'excludes') throw new BadRequest("a text rule's op must be contains or excludes");
        return { kind: 'text', op: o.op, words: strings(o.words, 'text').map((w) => w.toLowerCase()) };
      case 'amount': {
        const min = bound(o.min, 'min');
        const max = bound(o.max, 'max');
        if (min === undefined && max === undefined) throw new BadRequest('an amount rule needs a min or a max');
        if (min !== undefined && max !== undefined && min > max) throw new BadRequest("an amount rule's min must not be more than its max");
        return { kind: 'amount', ...(min !== undefined && { min }), ...(max !== undefined && { max }) };
      }
      default:
        throw new BadRequest('a rule must be a group, tags, text or amount');
    }
  };
  const root = rule(json, 1);
  if (root.kind !== 'group') throw new BadRequest('rules must be a group');
  return root;
}

export function parseCustomFilters(q: Record<string, unknown>): CustomFilters {
  const set = (v: unknown) => {
    const items = list(v);
    return items && new Set(items);
  };
  return { accounts: set(q.accounts), categories: set(q.categories), rules: parseRules(q.rules) };
}

/** What the rules look at. `amount` is null when the currency has no rate. */
interface Subject {
  tagIds: string[];
  text: string;
  amount: number | null;
}

/**
 * true or false; null when the answer hangs on an amount nobody can know (no rate), by three-valued logic: within
 * "all" a false decides, within "any" a true does, and otherwise an unknown leaves the group unknown.
 */
export function test(rule: CustomReportRule, s: Subject): boolean | null {
  switch (rule.kind) {
    case 'tags': {
      const has = (id: string) => s.tagIds.includes(id);
      if (rule.op === 'any') return rule.tagIds.some(has);
      if (rule.op === 'all') return rule.tagIds.every(has);
      return !rule.tagIds.some(has);
    }
    case 'text': {
      const hit = rule.words.some((w) => s.text.includes(w));
      return rule.op === 'contains' ? hit : !hit;
    }
    case 'amount':
      if (s.amount === null) return null;
      return (rule.min === undefined || s.amount >= rule.min) && (rule.max === undefined || s.amount <= rule.max);
    case 'group': {
      const decisive = rule.match === 'any';
      let unknown = false;
      for (const r of rule.rules) {
        const v = test(r, s);
        if (v === null) unknown = true;
        else if (v === decisive) return v;
      }
      return unknown ? null : !decisive || !rule.rules.length;
    }
  }
}

const inScope = (accountId: string, flowId: string, f: CustomFilters) =>
  (!f.accounts || f.accounts.has(accountId)) && (!f.categories || f.categories.has(flowId));

const subject = (ds: Dataset, t: Transaction, amount: number | null): Subject => ({
  tagIds: ds.tagsByTransaction.get(t.id) ?? [],
  text: [t.title, t.description].filter(Boolean).join('\n').toLowerCase(),
  amount,
});

const roundAll = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round(v)]));

export function customReport(
  ds: Dataset,
  from: number,
  to: number,
  granularity: Granularity,
  groupBy: GroupBy,
  filters: CustomFilters,
  tz: string,
  rates: RateTable,
): CustomReportData {
  const unconverted = new Set<string>();
  const ignored = new Set<string>(); // moneyFlow's own list; only matching transactions are reported
  // Flow ids money has been filed under that are not live categories (uncategorized transfer pairs, deleted
  // categories), from the whole history, so the category options don't change with the range.
  const otherFlows = new Map<string, string>();
  const buckets = new Map<string, CustomReportBucket>();
  for (const k of bucketKeys(from, to, granularity, tz))
    buckets.set(k, { bucket: k, income: 0, expense: 0, incomeBy: {}, expenseBy: {}, count: 0 });
  const groups = new Map<string, CustomReportGroup>();
  const transactionIds: string[] = [];
  let income = 0;
  let expense = 0;

  for (const t of ds.transactions) {
    if (classify(t, ds.rules) !== 'EXECUTED') continue;
    const money = moneyFlow(ds, t, rates, ignored);
    if (!money) continue;
    const flow = flowOf(ds, t);
    if (!ds.categories.has(flow.id) && flow.id !== 'uncategorized') otherFlows.set(flow.id, flow.name);

    const at = t.dateTime as number;
    if (at < from || at >= to) continue;
    if (!inScope(money.accountId, flow.id, filters)) continue;
    const verdict = filters.rules ? test(filters.rules, subject(ds, t, money.base == null ? null : round(Math.abs(money.base)))) : true;
    if (verdict === false) continue;
    if (money.base == null) {
      unconverted.add(money.currency);
      continue;
    }

    const side = money.direction === 'in' ? 'income' : 'expense';
    const b = buckets.get(bucketKey(at, granularity, tz))!;
    b[side] += money.base;
    b.count++;
    if (groupBy !== 'none') {
      const g =
        groupBy === 'category'
          ? flow
          : { id: money.accountId, name: ds.accounts.get(money.accountId)?.name ?? '(unknown account)' };
      const by = side === 'income' ? b.incomeBy : b.expenseBy;
      by[g.id] = (by[g.id] ?? 0) + money.base;
      const group = groups.get(g.id) ?? { id: g.id, name: g.name, income: 0, expense: 0 };
      group[side] += money.base;
      groups.set(g.id, group);
    }
    if (side === 'income') income += money.base;
    else expense += money.base;
    transactionIds.push(t.id);
  }

  const byName = (a: CustomReportOption, b: CustomReportOption) => a.name.localeCompare(b.name);
  const option = ({ id, name }: CustomReportOption) => ({ id, name });

  return {
    from,
    to,
    granularity,
    groupBy,
    options: {
      accounts: [...ds.accounts.values()]
        .filter((a) => a.includeInBalance !== false)
        .map((a) => ({ id: a.id, name: a.name, currency: a.currency || ds.baseCurrency }))
        .sort(byName),
      categories: [
        ...[...ds.categories.values()].map(option).sort(byName),
        { id: 'uncategorized', name: 'Uncategorized' },
        ...[...otherFlows].map(([id, name]) => ({ id, name })).sort(byName),
      ],
      tags: [...ds.tags.values()].map(option).sort(byName),
    },
    income: round(income),
    expense: round(expense),
    net: round(income - expense),
    count: transactionIds.length,
    groups: [...groups.values()]
      .map((g) => ({ ...g, income: round(g.income), expense: round(g.expense) }))
      .sort((a, b) => b.income + b.expense - (a.income + a.expense) || a.name.localeCompare(b.name)),
    buckets: [...buckets.values()].map((b) => ({
      ...b,
      income: round(b.income),
      expense: round(b.expense),
      incomeBy: roundAll(b.incomeBy),
      expenseBy: roundAll(b.expenseBy),
    })),
    transactionIds,
    unconverted: [...unconverted].sort(),
  };
}
