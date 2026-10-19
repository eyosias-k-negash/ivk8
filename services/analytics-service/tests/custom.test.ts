import { describe, it, expect } from 'vitest';
import { ingest } from '../src/engine/loader';
import type { RateTable } from '../src/engine/currency';
import { BadRequest, parseRange } from '../src/params';
import type { CustomReportRule, CustomReportRuleGroup } from '@ivy/contracts';
import { MAX_DEPTH, MAX_RULES, customReport, parseCustomFilters, type CustomFilters } from '../src/reports/custom';
import { summaryReport } from '../src/reports/flows';
import { ID, makeBackup, tx, utc } from './engine/fixtures';

const rates: RateTable = new Map([['USD', { currency: 'USD', rateToBase: 100, source: 'manual' }]]);
const none: RateTable = new Map([['USD', { currency: 'USD', rateToBase: null, source: 'unavailable' }]]);

const TRIP = '00000000-0000-4000-8000-0000000000a1';
const WORK = '00000000-0000-4000-8000-0000000000a2';
const TO_HIDDEN = `transfer:${ID.cash}>${ID.excluded}`;

const salary = tx({ accountId: ID.cash, type: 'INCOME', amount: 1000, title: 'September salary', dateTime: utc('2026-09-01T09:00:00Z') });
const coffee = tx({ accountId: ID.cash, type: 'EXPENSE', amount: 50, categoryId: ID.food, title: 'Coffee at the corner', dateTime: utc('2026-09-02T09:00:00Z') });
// 3 USD = 300 in base
const lunch = tx({
  accountId: ID.usd,
  type: 'EXPENSE',
  amount: 3,
  categoryId: ID.food,
  title: 'Lunch',
  description: 'With the team, COFFEE after',
  dateTime: utc('2026-09-10T09:00:00Z'),
});
const movie = tx({ accountId: ID.cash, type: 'EXPENSE', amount: 200, categoryId: ID.fun, title: 'Cinema', dateTime: utc('2026-09-15T09:00:00Z') });
// 22:30 UTC on Sep 30 = 01:30 Oct 1 at +03:00 -> October
const late = tx({ accountId: ID.cash, type: 'EXPENSE', amount: 70, categoryId: ID.food, title: 'Late coffee', dateTime: utc('2026-09-30T22:30:00Z') });
// transfers to and from an excluded account are money out and in, on the included side
const toHidden = tx({ accountId: ID.cash, type: 'TRANSFER', amount: 400, toAccountId: ID.excluded, title: 'Savings', dateTime: utc('2026-10-01T09:00:00Z') });
const fromHidden = tx({ accountId: ID.excluded, type: 'TRANSFER', amount: 150, toAccountId: ID.cash, categoryId: ID.fun, dateTime: utc('2026-10-02T09:00:00Z') });
// never counted, whatever the filters
const between = tx({ accountId: ID.cash, type: 'TRANSFER', amount: 999, toAccountId: ID.usd, toAmount: 9, title: 'coffee fund', dateTime: utc('2026-10-04T09:00:00Z') });
const onHidden = tx({ accountId: ID.excluded, type: 'EXPENSE', amount: 999, title: 'coffee', dateTime: utc('2026-10-05T09:00:00Z') });
const planned = tx({ accountId: ID.cash, type: 'EXPENSE', amount: 999, title: 'coffee', dueDate: utc('2026-10-06T09:00:00Z') });

const tag = (tagId: string, ...txs: { id: string }[]) => txs.map((t) => ({ tagId, associatedId: t.id }));

const ds = ingest(
  makeBackup({
    transactions: [salary, coffee, lunch, movie, late, toHidden, fromHidden, between, onHidden, planned],
    tags: [
      { id: WORK, name: 'Work' },
      { id: TRIP, name: 'Trip' },
    ],
    tagAssociations: [...tag(TRIP, lunch, movie, toHidden, between), ...tag(WORK, lunch)],
  }),
);

const range = parseRange({ from: '2026-09-01', to: '2026-10-31' }, '+03:00');
const run = (filters: CustomFilters = {}, groupBy: 'none' | 'category' | 'account' = 'none', r: RateTable = rates) =>
  customReport(ds, range.from, range.to, 'MONTH', groupBy, filters, '+03:00', r);
const totals = (o: ReturnType<typeof run>) => ({ income: o.income, expense: o.expense, count: o.count });
const filters = (q: Record<string, string>) => parseCustomFilters(q);
const all = (...rules: CustomReportRule[]): CustomReportRuleGroup => ({ kind: 'group', match: 'all', rules });
const any = (...rules: CustomReportRule[]): CustomReportRuleGroup => ({ kind: 'group', match: 'any', rules });
const tags = (op: 'any' | 'all' | 'none', ...tagIds: string[]): CustomReportRule => ({ kind: 'tags', op, tagIds });
const text = (op: 'contains' | 'excludes', ...words: string[]): CustomReportRule => ({ kind: 'text', op, words });
const amount = (min?: number, max?: number): CustomReportRule => ({ kind: 'amount', min, max });
/** Filters as the API receives them: the rules go through the JSON parser. */
const where = (rules: CustomReportRuleGroup, scope: Record<string, string> = {}) => filters({ ...scope, rules: JSON.stringify(rules) });

describe('customReport', () => {
  it('without filters counts exactly what the income and expense summary counts', () => {
    const o = run();
    const s = summaryReport(ds, range.from, range.to, rates);
    expect(totals(o)).toEqual({ income: s.income, expense: s.expense, count: s.count });
    expect(totals(o)).toEqual({ income: 1000 + 150, expense: 50 + 300 + 200 + 70 + 400, count: 7 });
    expect(o.net).toBe(1150 - 1020);
    expect(o.transactionIds.sort()).toEqual([salary, coffee, lunch, movie, late, toHidden, fromHidden].map((t) => t.id).sort());
  });

  it('buckets in the request timezone and keeps empty buckets', () => {
    expect(run().buckets).toEqual([
      { bucket: '2026-09', income: 1000, expense: 550, incomeBy: {}, expenseBy: {}, count: 4 },
      { bucket: '2026-10', income: 150, expense: 470, incomeBy: {}, expenseBy: {}, count: 3 },
    ]);
    const r = parseRange({ from: '2026-08-01', to: '2026-09-30' }, '+03:00');
    const o = customReport(ds, r.from, r.to, 'MONTH', 'none', {}, '+03:00', rates);
    expect(o.buckets[0]).toEqual({ bucket: '2026-08', income: 0, expense: 0, incomeBy: {}, expenseBy: {}, count: 0 });
  });

  it('splits by category the way the category breakdown files money, largest group first', () => {
    const o = run({}, 'category');
    expect(o.buckets.map((b) => [b.incomeBy, b.expenseBy])).toEqual([
      [{ uncategorized: 1000 }, { [ID.food]: 350, [ID.fun]: 200 }],
      [{ [ID.fun]: 150 }, { [TO_HIDDEN]: 400, [ID.food]: 70 }],
    ]);
    expect(o.groups).toEqual([
      { id: 'uncategorized', name: 'Uncategorized', income: 1000, expense: 0 },
      { id: ID.food, name: 'Food', income: 0, expense: 420 },
      { id: TO_HIDDEN, name: 'Transfer Cash → Hidden', income: 0, expense: 400 },
      { id: ID.fun, name: 'Fun', income: 150, expense: 200 },
    ]);
  });

  it('splits by account under the side included in the balance', () => {
    const o = run({}, 'account');
    expect(o.buckets.map((b) => [b.incomeBy, b.expenseBy])).toEqual([
      [{ [ID.cash]: 1000 }, { [ID.cash]: 250, [ID.usd]: 300 }],
      [{ [ID.cash]: 150 }, { [ID.cash]: 470 }],
    ]);
    expect(o.groups.map((g) => [g.name, g.income, g.expense])).toEqual([
      ['Cash', 1150, 720],
      ['USD Wallet', 0, 300],
    ]);
  });

  it('filters by the included side’s account', () => {
    expect(totals(run(filters({ accounts: ID.usd })))).toEqual({ income: 0, expense: 300, count: 1 });
    // the transfers to and from Hidden are filed under Cash, so Hidden itself never matches
    expect(totals(run(filters({ accounts: ID.excluded })))).toEqual({ income: 0, expense: 0, count: 0 });
    expect(run(filters({ accounts: `${ID.cash},${ID.usd}` })).count).toBe(7);
  });

  it('filters by flow id: categories, uncategorized, and uncategorized transfers each on their own', () => {
    expect(totals(run(filters({ categories: ID.food })))).toEqual({ income: 0, expense: 420, count: 3 });
    expect(totals(run(filters({ categories: 'uncategorized' })))).toEqual({ income: 1000, expense: 0, count: 1 });
    expect(totals(run(filters({ categories: TO_HIDDEN })))).toEqual({ income: 0, expense: 400, count: 1 });
  });

  it('tests tags: any of, all of, none of', () => {
    expect(totals(run(where(all(tags('any', TRIP)))))).toEqual({ income: 0, expense: 300 + 200 + 400, count: 3 });
    expect(run(where(all(tags('all', TRIP, WORK)))).transactionIds).toEqual([lunch.id]);
    expect(totals(run(where(all(tags('none', TRIP)))))).toEqual({ income: 1150, expense: 120, count: 4 });
  });

  it('tests words in the title or description, ignoring case', () => {
    expect(totals(run(where(all(text('contains', 'Coffee')))))).toEqual({ income: 0, expense: 50 + 300 + 70, count: 3 });
    expect(totals(run(where(all(text('contains', 'coffee', 'cinema')))))).toEqual({ income: 0, expense: 620, count: 4 });
    expect(run(where(all(text('excludes', 'coffee')))).count).toBe(4); // one with no title or description contains no word, so it stays
  });

  it('bounds the base amount, inclusively, for income and expense alike', () => {
    expect(totals(run(where(all(amount(200)))))).toEqual({ income: 1000, expense: 300 + 200 + 400, count: 4 });
    expect(totals(run(where(all(amount(undefined, 200)))))).toEqual({ income: 150, expense: 50 + 200 + 70, count: 4 });
    // 3 USD is 300 in base: the bound is on the base amount, not the account's own
    expect(run(where(all(amount(300, 300)))).transactionIds).toEqual([lunch.id]);
  });

  it('joins conditions with and, or or', () => {
    // coffee, lunch, late contain "coffee"; only late is "late"
    expect(run(where(all(text('contains', 'coffee'), text('excludes', 'late')))).transactionIds).toEqual([coffee.id, lunch.id]);
    // Trip (lunch, movie, savings) or coffee (coffee, lunch, late): lunch once
    expect(totals(run(where(any(tags('any', TRIP), text('contains', 'coffee')))))).toEqual({ income: 0, expense: 300 + 200 + 400 + 50 + 70, count: 5 });
  });

  it('nests groups', () => {
    // (Trip or coffee) and at most 250
    const o = run(where(all(any(tags('any', TRIP), text('contains', 'coffee')), amount(undefined, 250))));
    expect(o.transactionIds).toEqual([coffee.id, movie.id, late.id]);
    // (Trip and at least 300) or salary
    expect(totals(run(where(any(all(tags('any', TRIP), amount(300)), text('contains', 'salary')))))).toEqual({ income: 1000, expense: 700, count: 3 });
  });

  it('lets an empty group match everything, whatever its connector', () => {
    expect(run(where(all())).count).toBe(7);
    expect(run(where(any())).count).toBe(7);
    expect(run(where(all(any(), tags('any', WORK)))).transactionIds).toEqual([lunch.id]);
  });

  it('combines the account and category scope with the rules', () => {
    const o = run(where(all(text('contains', 'coffee', 'cinema'), amount(undefined, 100)), { accounts: ID.cash, categories: `${ID.food},${ID.fun}` }));
    expect(o.transactionIds).toEqual([coffee.id, late.id]);
  });

  it('lists the options whatever the range and filters', () => {
    const r = parseRange({ from: '2026-09-01', to: '2026-09-02' }, '+03:00');
    const o = customReport(ds, r.from, r.to, 'DAY', 'none', where(all(tags('any', TRIP))), '+03:00', rates);
    expect(o.options).toEqual({
      accounts: [
        { id: ID.cash, name: 'Cash', currency: 'ETB' },
        { id: ID.usd, name: 'USD Wallet', currency: 'USD' },
      ],
      categories: [
        { id: ID.food, name: 'Food' },
        { id: ID.fun, name: 'Fun' },
        { id: 'uncategorized', name: 'Uncategorized' },
        // the transfer between two included accounts is no money flow, so it is no option either
        { id: TO_HIDDEN, name: 'Transfer Cash → Hidden' },
      ],
      tags: [
        { id: TRIP, name: 'Trip' },
        { id: WORK, name: 'Work' },
      ],
    });
  });

  it('reports a currency with no rate when its transactions match, or might if their amount were known', () => {
    const o = run({}, 'none', none);
    expect(o.unconverted).toEqual(['USD']);
    expect(totals(o)).toEqual({ income: 1150, expense: 720, count: 6 });
    expect(run(where(all(), { accounts: ID.cash }), 'none', none).unconverted).toEqual([]);
    // the lunch's amount is unknown, so "at least 1000" can't rule it out
    const big = run(where(all(amount(1000))), 'none', none);
    expect([big.transactionIds, big.unconverted]).toEqual([[salary.id], ['USD']]);
    // it carries Work, so the "or" holds whatever its amount
    expect(run(where(any(amount(1000), tags('any', WORK))), 'none', none).unconverted).toEqual(['USD']);
    // it carries Work, so the "and" fails whatever its amount
    expect(run(where(all(tags('none', WORK), amount(0))), 'none', none).unconverted).toEqual([]);
  });
});

describe('parseCustomFilters', () => {
  it('treats absent and blank filters as no filter', () => {
    expect(filters({ accounts: '', categories: ' , ', rules: '' })).toEqual({});
  });

  it('splits scope lists and trims items', () => {
    expect(filters({ accounts: ' a, b,,' }).accounts).toEqual(new Set(['a', 'b']));
  });

  it('normalizes the rules: trimmed entries, lower-cased words', () => {
    const f = where(any(text('contains', ' Coffee ', 'TAXI'), tags('none', ' t1 '), amount(5)));
    expect(f.rules).toEqual(any(text('contains', 'coffee', 'taxi'), tags('none', 't1'), { kind: 'amount', min: 5 }));
  });

  it('rejects malformed rules', () => {
    const bad = (rules: unknown) => () => filters({ rules: typeof rules === 'string' ? rules : JSON.stringify(rules) });
    expect(bad('{')).toThrow(/JSON/);
    expect(bad(tags('any', 'a'))).toThrow(/must be a group/);
    expect(bad({ kind: 'group', match: 'some', rules: [] })).toThrow(BadRequest);
    expect(bad({ kind: 'group', match: 'all', rules: [{ kind: 'payee' }] })).toThrow(/group, tags, text or amount/);
    expect(bad(all(tags('any')))).toThrow(/at least one/);
    expect(bad(all(text('contains', ' ')))).toThrow(/at least one/);
    expect(bad(all({ kind: 'amount' }))).toThrow(/min or a max/);
    expect(bad(all(amount(-1)))).toThrow(BadRequest);
    expect(bad(all(amount(10, 5)))).toThrow(/not be more than/);
  });

  it('caps nesting and size', () => {
    expect(() => where(all(any(all(tags('any', 'a')))))).not.toThrow(); // three levels
    expect(() => where(all(any(all(any()))))).toThrow(new RegExp(`${MAX_DEPTH} levels`));
    const many = (n: number) => all(...Array.from({ length: n }, () => tags('any', 'a')));
    expect(() => where(many(MAX_RULES - 1))).not.toThrow(); // plus the root
    expect(() => where(many(MAX_RULES))).toThrow(new RegExp(`at most ${MAX_RULES}`));
  });
});
