import { describe, it, expect } from 'vitest';
import type { TagsData } from '@ivy/contracts';
import { AVG_BUCKET, OTHER_COMBOS, comboSlots, rowTotal, shapeTags } from './tags';

// September: Trip 1030 and Work 530 in all, sharing a 100 dinner tagged both and a 30 taxi that also carries Car.
// October has nothing.
const data: TagsData = {
  from: 0,
  to: 1,
  granularity: 'MONTH',
  tags: [
    { id: 'trip', name: 'Trip', income: 40, expense: 1030 },
    { id: 'work', name: 'Work', income: 0, expense: 530 },
    { id: 'car', name: 'Car', income: 0, expense: 100 },
  ],
  buckets: [
    {
      bucket: '2026-09',
      income: [{ tagIds: ['trip'], amount: 40, count: 1 }],
      expense: [
        { tagIds: ['car'], amount: 70, count: 1 },
        { tagIds: ['car', 'trip', 'work'], amount: 30, count: 1 },
        { tagIds: ['trip'], amount: 900, count: 4 },
        { tagIds: ['trip', 'work'], amount: 100, count: 1 },
        { tagIds: ['work'], amount: 400, count: 2 },
      ],
    },
    { bucket: '2026-10', income: [], expense: [] },
  ],
  unconverted: [],
};

describe('shapeTags', () => {
  it('gives each combination of picked tags its own series, counting its transactions once', () => {
    const v = shapeTags(data, 'expense', new Set(['trip', 'work']));
    expect(v.series).toEqual([
      { key: 'trip', tagIds: ['trip'], label: 'Trip', total: 900 },
      { key: 'work', tagIds: ['work'], label: 'Work', total: 400 },
      // the taxi carries car too, but only the picked tags decide where it stacks
      { key: 'combo:trip,work', tagIds: ['trip', 'work'], label: 'Trip + Work', total: 130 },
    ]);
    expect(v.total).toBe(1430); // not 1560: shared transactions count once
    expect(v.count).toBe(8);
    expect(v.shared).toEqual(new Map([['trip', 130], ['work', 130]]));
    expect(rowTotal(v.rows[0]!, v.series)).toBe(1430);
  });

  it('keeps different combinations apart, largest first, members in tag-list order', () => {
    const v = shapeTags(data, 'expense', new Set(['car', 'trip', 'work']));
    expect(v.series.map((s) => [s.label, s.total])).toEqual([
      ['Trip', 900],
      ['Work', 400],
      ['Car', 70],
      ['Trip + Work', 100],
      ['Trip + Work + Car', 30],
    ]);
    expect(v.total).toBe(1500);
  });

  it('folds the smallest combinations once the palette runs out', () => {
    const v = shapeTags(data, 'expense', new Set(['car', 'trip', 'work']), 1);
    expect(v.series.slice(3).map((s) => [s.key, s.label, s.total])).toEqual([
      ['combo:trip,work', 'Trip + Work', 100],
      [OTHER_COMBOS, 'Other combinations (1)', 30],
    ]);
    expect(v.rows[0]![OTHER_COMBOS]).toBe(30);
    expect(v.total).toBe(1500);
  });

  it('gives a single picked tag its whole total, shared transactions included', () => {
    const v = shapeTags(data, 'expense', new Set(['work']));
    expect(v.series).toEqual([{ key: 'work', tagIds: ['work'], label: 'Work', total: 530 }]);
    expect(v.shared.size).toBe(0);
  });

  it('leaves unpicked tags out entirely', () => {
    const v = shapeTags(data, 'expense', new Set(['car']));
    expect(v.total).toBe(100);
    expect(v.rows[0]).toEqual({ bucket: '2026-09', car: 100 });
  });

  it('appends the per-period average, empty periods counting as 0', () => {
    const v = shapeTags(data, 'expense', new Set(['car']));
    expect(v.periods).toBe(2);
    expect(v.active).toBe(1);
    expect(v.rows.at(-1)).toEqual({ bucket: AVG_BUCKET, car: 50 });
  });

  it('can average over the active periods only', () => {
    const v = shapeTags(data, 'expense', new Set(['car']), Infinity, 'active');
    expect(v.rows.at(-1)).toEqual({ bucket: AVG_BUCKET, car: 100 });
    expect(shapeTags(data, 'income', new Set(['work']), Infinity, 'active').rows.map((r) => r.bucket)).toEqual(['2026-09', '2026-10']);
  });

  it('reads the chosen metric', () => {
    const v = shapeTags(data, 'income', new Set(['trip', 'work']));
    expect(v.total).toBe(40);
    expect(v.series.map((s) => s.key)).toEqual(['trip']);
  });
});

describe('comboSlots', () => {
  it('starts combinations from the top of the palette, away from the tags', () => {
    expect(comboSlots(new Map(), ['a+b', 'b+c'], new Set([0, 1, 2]), 8)).toEqual(new Map([['a+b', 7], ['b+c', 6]]));
  });

  it('keeps a combination on its slot while it stays on screen', () => {
    const prev = new Map([['b+c', 6]]);
    // a+b is new and larger, but b+c keeps its color
    expect(comboSlots(prev, ['a+b', 'b+c'], new Set([0, 1, 2]), 8)).toEqual(new Map([['b+c', 6], ['a+b', 7]]));
  });

  it('moves a combination only when a tag takes its slot', () => {
    expect(comboSlots(new Map([['a+b', 7]]), ['a+b'], new Set([0, 7]), 8)).toEqual(new Map([['a+b', 6]]));
  });
});
