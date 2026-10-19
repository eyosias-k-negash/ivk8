import { describe, it, expect } from 'vitest';
import type { CustomReportData } from '@ivy/contracts';
import { ALL, AVG_BUCKET, DEFAULT_CONFIG, NET, NET_AVG, OTHER, activeFilters, clearFilters, outerKeys, reportQuery, shapeReport } from './reports';

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

describe('reportQuery', () => {
  it('sends nothing for the filters left alone', () => {
    expect(reportQuery(DEFAULT_CONFIG)).toEqual({
      params: {
        granularity: 'MONTH',
        groupBy: 'none',
        accounts: undefined,
        categories: undefined,
        tags: undefined,
        excludeTags: undefined,
        keywords: undefined,
        excludeKeywords: undefined,
        minAmount: undefined,
        maxAmount: undefined,
      },
    });
  });

  it('joins lists and cleans up typed words and amounts', () => {
    const q = reportQuery({
      ...DEFAULT_CONFIG,
      accounts: ['a', 'b'],
      tags: ['t'],
      keywords: ' coffee, , taxi ',
      excludeKeywords: ',',
      minAmount: ' 10 ',
      maxAmount: '250.5',
    });
    expect(q).toMatchObject({
      params: { accounts: 'a,b', tags: 't', keywords: 'coffee,taxi', excludeKeywords: undefined, minAmount: '10', maxAmount: '250.5' },
    });
  });

  it('explains a config that cannot run instead of sending it', () => {
    expect(reportQuery({ ...DEFAULT_CONFIG, accounts: [] })).toEqual({ problem: 'Choose at least one account.' });
    expect(reportQuery({ ...DEFAULT_CONFIG, categories: [] })).toEqual({ problem: 'Choose at least one category.' });
    expect(reportQuery({ ...DEFAULT_CONFIG, minAmount: '-1' })).toHaveProperty('problem');
    expect(reportQuery({ ...DEFAULT_CONFIG, maxAmount: 'ten' })).toHaveProperty('problem');
    expect(reportQuery({ ...DEFAULT_CONFIG, minAmount: '20', maxAmount: '10' })).toHaveProperty('problem');
  });
});

describe('activeFilters / clearFilters', () => {
  it('counts what narrows the report, not how it is drawn', () => {
    expect(activeFilters({ ...DEFAULT_CONFIG, granularity: 'DAY', groupBy: 'account', showNet: false })).toBe(0);
    const busy = { ...DEFAULT_CONFIG, groupBy: 'account' as const, accounts: ['a'], excludeTags: ['t'], keywords: ' , ', maxAmount: '5' };
    expect(activeFilters(busy)).toBe(3); // blank words don't count
    expect(clearFilters(busy)).toEqual({ ...DEFAULT_CONFIG, groupBy: 'account' });
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
