import { describe, it, expect } from 'vitest';
import type { CustomReportData } from '@ivy/contracts';
import {
  ALL, AVG_BUCKET, DEFAULT_CONFIG, NET, NET_AVG, OTHER, activeFilters, addRule, checkCondition, clearFilters, compileRules, emptyRules,
  mapRule, newCondition, newGroup, outerKeys, removeRule, reportQuery, shapeReport, updateRule,
  type ConditionDraft, type ConditionKind, type GroupDraft, type ReportConfig, type RuleDraft,
} from './reports';

const options = { accounts: [], categories: [], tags: [] };

// September: salary 1000 into Cash; food 350 and fun 200 out. October: fun 150 in; savings 400 and food 70 out.
const split: CustomReportData = {
  from: 0,
  to: 1,
  granularity: 'MONTH',
  groupBy: 'category',
  options,
  income: 1150,
  expense: 1020,
  net: 130,
  count: 7,
  groups: [
    { id: 'none', name: 'Uncategorized', income: 1000, expense: 0 },
    { id: 'food', name: 'Food', income: 0, expense: 420 },
    { id: 'save', name: 'Savings', income: 0, expense: 400 },
    { id: 'fun', name: 'Fun', income: 150, expense: 200 },
  ],
  buckets: [
    { bucket: '2026-09', income: 1000, expense: 550, incomeBy: { none: 1000 }, expenseBy: { food: 350, fun: 200 }, count: 4 },
    { bucket: '2026-10', income: 150, expense: 470, incomeBy: { fun: 150 }, expenseBy: { save: 400, food: 70 }, count: 3 },
    { bucket: '2026-11', income: 0, expense: 0, incomeBy: {}, expenseBy: {}, count: 0 },
  ],
  transactionIds: [],
  unconverted: [],
};

const unsplit: CustomReportData = {
  ...split,
  groupBy: 'none',
  groups: [],
  buckets: split.buckets.map((b) => ({ ...b, incomeBy: {}, expenseBy: {} })),
};

// Drafts as the form holds them.
let n = 0;
const cond = (kind: ConditionKind, patch: Record<string, unknown> = {}) => ({ ...newCondition(kind), ...patch }) as ConditionDraft;
const group = (match: 'all' | 'any', ...rules: RuleDraft[]): GroupDraft => ({ id: `g${++n}`, kind: 'group', match, rules });
const root = (match: 'all' | 'any', ...rules: RuleDraft[]): GroupDraft => ({ ...group(match, ...rules), id: 'root' });

describe('compileRules', () => {
  it('sends no rules while there is no complete condition', () => {
    expect(compileRules(emptyRules())).toEqual({});
    expect(compileRules(root('all', cond('tags'), group('any', cond('text'))))).toEqual({});
  });

  it('drops incomplete conditions and the groups they leave empty, and tidies typed words', () => {
    const r = root(
      'all',
      cond('tags', { tagIds: ['t'] }),
      cond('text', { text: ' coffee, , taxi ' }),
      cond('amount'),
      group('any', cond('tags'), cond('text', { op: 'excludes', text: ' , ' })),
      group('any', cond('amount', { op: 'atMost', max: '50' }), cond('tags', { op: 'none', tagIds: ['w'] })),
    );
    expect(compileRules(r)).toEqual({
      rules: {
        kind: 'group',
        match: 'all',
        rules: [
          { kind: 'tags', op: 'any', tagIds: ['t'] },
          { kind: 'text', op: 'contains', words: ['coffee', 'taxi'] },
          { kind: 'group', match: 'any', rules: [{ kind: 'amount', max: 50 }, { kind: 'tags', op: 'none', tagIds: ['w'] }] },
        ],
      },
    });
  });

  it('reads only the bounds an amount condition’s test uses', () => {
    const one = (patch: Record<string, unknown>) => compileRules(root('all', cond('amount', patch)));
    expect(one({ op: 'atLeast', min: ' 10 ', max: 'junk' })).toEqual({ rules: { kind: 'group', match: 'all', rules: [{ kind: 'amount', min: 10 }] } });
    expect(one({ op: 'atMost', min: '99', max: '5' })).toMatchObject({ rules: { rules: [{ kind: 'amount', max: 5 }] } });
    expect(one({ op: 'between', min: '1', max: '2.5' })).toMatchObject({ rules: { rules: [{ kind: 'amount', min: 1, max: 2.5 }] } });
    expect(one({ op: 'between', min: '1', max: '' })).toEqual({}); // half a range isn't applied yet
  });

  it('turns an amount that can’t be read into a problem instead of a silent filter', () => {
    expect(compileRules(root('any', cond('amount', { min: 'ten' })))).toEqual({ problem: 'Amounts must be numbers of 0 or more.' });
    expect(compileRules(root('any', cond('amount', { op: 'atMost', max: '-3' })))).toHaveProperty('problem');
    expect(compileRules(root('any', group('all', cond('amount', { op: 'between', min: '20', max: '10' }))))).toHaveProperty('problem');
  });
});

describe('checkCondition', () => {
  it('tells complete, incomplete and broken conditions apart', () => {
    expect(checkCondition(cond('tags'))).toBe('incomplete');
    expect(checkCondition(cond('text', { text: 'a' }))).toBe('ok');
    expect(checkCondition(cond('amount', { op: 'between', max: '5' }))).toBe('incomplete');
    expect(checkCondition(cond('amount', { op: 'atMost', max: 'x' }))).toEqual({ problem: expect.any(String) });
  });
});

describe('rule tree edits', () => {
  const inner = cond('text', { text: 'coffee' });
  const g = group('any', inner);
  const start = root('all', cond('tags', { tagIds: ['t'] }), g);

  it('adds, updates and removes by id at any depth, leaving the original alone', () => {
    const added = addRule(start, g.id, cond('amount'));
    expect((added.rules[1] as GroupDraft).rules.map((r) => r.kind)).toEqual(['text', 'amount']);
    const updated = updateRule(added, inner.id, { op: 'excludes' } as Partial<RuleDraft>);
    expect((updated.rules[1] as GroupDraft).rules[0]).toEqual({ ...inner, op: 'excludes' });
    expect(removeRule(updated, g.id).rules).toHaveLength(1);
    expect((start.rules[1] as GroupDraft).rules).toEqual([inner]);
  });

  it('swaps a condition for a fresh one of another kind in the same place', () => {
    const swapped = mapRule(start, inner.id, () => ({ ...newCondition('amount'), id: inner.id }));
    expect((swapped.rules[1] as GroupDraft).rules[0]).toMatchObject({ id: inner.id, kind: 'amount', op: 'atLeast' });
  });

  it('starts a group with the other connector than its parent', () => {
    expect(newGroup('all', 'tags')).toMatchObject({ match: 'any', rules: [{ kind: 'tags' }] });
    expect(newGroup('any', 'text').match).toBe('all');
  });
});

describe('reportQuery', () => {
  it('sends nothing for the filters left alone', () => {
    expect(reportQuery(DEFAULT_CONFIG)).toEqual({
      params: { granularity: 'MONTH', groupBy: 'none', accounts: undefined, categories: undefined, rules: undefined },
    });
  });

  it('joins scope lists and sends the rules as JSON', () => {
    const q = reportQuery({ ...DEFAULT_CONFIG, accounts: ['a', 'b'], rules: root('any', cond('tags', { tagIds: ['t'] }), cond('text', { text: 'Coffee' })) });
    expect('params' in q && q.params.accounts).toBe('a,b');
    expect('params' in q && JSON.parse(q.params.rules!)).toEqual({
      kind: 'group',
      match: 'any',
      rules: [{ kind: 'tags', op: 'any', tagIds: ['t'] }, { kind: 'text', op: 'contains', words: ['Coffee'] }],
    });
  });

  it('explains a config that cannot run instead of sending it', () => {
    expect(reportQuery({ ...DEFAULT_CONFIG, accounts: [] })).toEqual({ problem: 'Choose at least one account.' });
    expect(reportQuery({ ...DEFAULT_CONFIG, categories: [] })).toEqual({ problem: 'Choose at least one category.' });
    expect(reportQuery({ ...DEFAULT_CONFIG, rules: root('all', cond('amount', { min: 'lots' })) })).toHaveProperty('problem');
  });
});

describe('activeFilters / clearFilters', () => {
  it('counts the scope and each condition that applies, not how the chart is drawn', () => {
    expect(activeFilters({ ...DEFAULT_CONFIG, granularity: 'DAY', groupBy: 'account', showNet: false })).toBe(0);
    const busy: ReportConfig = {
      ...DEFAULT_CONFIG,
      groupBy: 'account',
      accounts: ['a'],
      rules: root('all', cond('tags', { tagIds: ['t'] }), cond('text', { text: ' , ' }), group('any', cond('amount', { op: 'atMost', max: '5' }))),
    };
    expect(activeFilters(busy)).toBe(3); // the blank words don't count
    expect(clearFilters(busy)).toEqual({ ...DEFAULT_CONFIG, groupBy: 'account', rules: emptyRules() });
  });
});

describe('shapeReport', () => {
  it('unsplit: income above zero, expense below, net per period and an average row', () => {
    const v = shapeReport(unsplit, new Set());
    expect(v.series.map((s) => [s.key, s.total])).toEqual([
      [`income:${ALL}`, 1150],
      [`expense:${ALL}`, 1020],
    ]);
    expect(v.rows[0]).toEqual({ bucket: '2026-09', income: 1000, expense: 550, count: 4, [NET]: 450, [`income:${ALL}`]: 1000, [`expense:${ALL}`]: -550 });
    expect(v.rows[2]).toEqual({ bucket: '2026-11', income: 0, expense: 0, count: 0, [NET]: 0 }); // empty periods stay
    expect(v.rows[3]).toEqual({
      bucket: AVG_BUCKET,
      income: 1150 / 3,
      expense: 340,
      [NET_AVG]: 130 / 3,
      [`income:${ALL}`]: 1150 / 3,
      [`expense:${ALL}`]: -340,
    });
    expect([v.periods, v.active]).toEqual([3, 2]);
  });

  it('can average over the periods with transactions only', () => {
    const v = shapeReport(unsplit, new Set(), true, 'active');
    expect(v.rows[3]).toEqual({
      bucket: AVG_BUCKET,
      income: 575,
      expense: 510,
      [NET_AVG]: 65,
      [`income:${ALL}`]: 575,
      [`expense:${ALL}`]: -510,
    });
  });

  it('split: picked groups on each side they have money on, largest nearest zero, the rest folded into Other', () => {
    const v = shapeReport(split, new Set(['food', 'fun']));
    expect(v.series.map((s) => [s.key, s.label, s.total])).toEqual([
      ['income:fun', 'Fun', 150],
      [`income:${OTHER}`, 'Other (1)', 1000],
      ['expense:food', 'Food', 420],
      ['expense:fun', 'Fun', 200],
      [`expense:${OTHER}`, 'Other (1)', 400],
    ]);
    expect(v.rows[0]).toMatchObject({ [`income:${OTHER}`]: 1000, 'expense:food': -350, 'expense:fun': -200 });
    expect(v.rows[1]).toMatchObject({ 'income:fun': 150, [`expense:${OTHER}`]: -400, 'expense:food': -70 });
    expect(v.rows[3]).toMatchObject({ 'income:fun': 50, 'expense:food': -140, [`expense:${OTHER}`]: -400 / 3 });
  });

  it('split with nothing picked folds every group into Other', () => {
    const v = shapeReport(split, new Set());
    expect(v.series.map((s) => s.key)).toEqual([`income:${OTHER}`, `expense:${OTHER}`]);
    expect(v.rows[1]).toMatchObject({ [`income:${OTHER}`]: 150, [`expense:${OTHER}`]: -470 });
  });
});

describe('outerKeys', () => {
  it('finds the segment at the outer end of each side, skipping series absent from the row', () => {
    const v = shapeReport(split, new Set(['food', 'fun']));
    expect(outerKeys(v.rows[0]!, v.series)).toEqual({ top: `income:${OTHER}`, bottom: 'expense:fun' });
    expect(outerKeys(v.rows[1]!, v.series)).toEqual({ top: 'income:fun', bottom: `expense:${OTHER}` });
    expect(outerKeys(v.rows[2]!, v.series)).toEqual({ top: undefined, bottom: undefined });
  });
});
