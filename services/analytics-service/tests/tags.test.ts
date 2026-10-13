import { describe, it, expect } from 'vitest';
import { ingest } from '../src/engine/loader';
import type { RateTable } from '../src/engine/currency';
import { parseRange } from '../src/params';
import { tagsReport } from '../src/reports/tags';
import { ID, makeBackup, tx, utc } from './engine/fixtures';

const rates: RateTable = new Map([['USD', { currency: 'USD', rateToBase: 100, source: 'manual' }]]);
const none: RateTable = new Map([['USD', { currency: 'USD', rateToBase: null, source: 'unavailable' }]]);

const TRIP = '00000000-0000-4000-8000-0000000000a1';
const WORK = '00000000-0000-4000-8000-0000000000a2';
const IDLE = '00000000-0000-4000-8000-0000000000a3';
const GONE = '00000000-0000-4000-8000-0000000000a4';

const hotel = tx({ accountId: ID.cash, type: 'EXPENSE', amount: 500, categoryId: ID.fun, dateTime: utc('2026-09-05T09:00:00Z') });
const meal = tx({ accountId: ID.usd, type: 'EXPENSE', amount: 2, categoryId: ID.food, dateTime: utc('2026-09-06T09:00:00Z') });
const dinner = tx({ accountId: ID.cash, type: 'EXPENSE', amount: 120, categoryId: ID.food, dateTime: utc('2026-09-07T09:00:00Z') });
const refund = tx({ accountId: ID.cash, type: 'INCOME', amount: 50, dateTime: utc('2026-09-08T09:00:00Z') });
// 22:30 UTC on Sep 30 = 01:30 Oct 1 at +03:00 -> October
const taxi = tx({ accountId: ID.cash, type: 'EXPENSE', amount: 30, dateTime: utc('2026-09-30T22:30:00Z') });
// a transfer out to an excluded account is money out; one between included accounts is not
const toHidden = tx({ accountId: ID.cash, type: 'TRANSFER', amount: 80, toAccountId: ID.excluded, dateTime: utc('2026-10-03T09:00:00Z') });
const between = tx({ accountId: ID.cash, type: 'TRANSFER', amount: 999, toAccountId: ID.usd, toAmount: 9, dateTime: utc('2026-10-04T09:00:00Z') });
const onHidden = tx({ accountId: ID.excluded, type: 'EXPENSE', amount: 999, dateTime: utc('2026-10-05T09:00:00Z') });
const planned = tx({ accountId: ID.cash, type: 'EXPENSE', amount: 999, dueDate: utc('2026-10-06T09:00:00Z') });
const untagged = tx({ accountId: ID.cash, type: 'EXPENSE', amount: 999, dateTime: utc('2026-10-07T09:00:00Z') });
const oldTagOnly = tx({ accountId: ID.cash, type: 'EXPENSE', amount: 999, dateTime: utc('2026-10-08T09:00:00Z') });

const tag = (tagId: string, ...txs: { id: string }[]) => txs.map((t) => ({ tagId, associatedId: t.id }));

const ds = ingest(
  makeBackup({
    transactions: [hotel, meal, dinner, refund, taxi, toHidden, between, onHidden, planned, untagged, oldTagOnly],
    tags: [
      { id: TRIP, name: 'Trip' },
      { id: WORK, name: 'Work' },
      { id: IDLE, name: 'Idle' },
      { id: GONE, name: 'Gone', isDeleted: true },
    ],
    tagAssociations: [
      ...tag(TRIP, hotel, meal, dinner, refund, taxi, toHidden, between, onHidden, planned),
      ...tag(WORK, dinner, taxi),
      ...tag(GONE, oldTagOnly, hotel),
    ],
  }),
);

const range = parseRange({ from: '2026-09-01', to: '2026-10-31' }, '+03:00');
const out = tagsReport(ds, range.from, range.to, 'MONTH', '+03:00', rates);
const [sep, oct] = out.buckets;

describe('tagsReport', () => {
  it('lists every live tag, largest first, counting a multi-tagged transaction under each tag', () => {
    expect(out.tags).toEqual([
      { id: TRIP, name: 'Trip', income: 50, expense: 500 + 200 + 120 + 30 + 80 },
      { id: WORK, name: 'Work', income: 0, expense: 120 + 30 },
      { id: IDLE, name: 'Idle', income: 0, expense: 0 },
    ]);
  });

  it('groups each bucket by exact tag set, so a transaction appears once', () => {
    expect(out.buckets.map((b) => b.bucket)).toEqual(['2026-09', '2026-10']);
    expect(sep!.expense).toEqual([
      { tagIds: [TRIP], amount: 500 + 200, count: 2 }, // hotel (its deleted tag ignored) + meal converted from USD
      { tagIds: [TRIP, WORK], amount: 120, count: 1 },
    ]);
    expect(sep!.income).toEqual([{ tagIds: [TRIP], amount: 50, count: 1 }]);
  });

  it('follows the money-flow rules and the request timezone', () => {
    // taxi lands in October locally; the transfer to the excluded account counts; nothing else does
    expect(oct!.expense).toEqual([
      { tagIds: [TRIP], amount: 80, count: 1 },
      { tagIds: [TRIP, WORK], amount: 30, count: 1 },
    ]);
    expect(oct!.income).toEqual([]);
  });

  it('keeps empty buckets', () => {
    const r = parseRange({ from: '2026-08-01', to: '2026-09-30' }, '+03:00');
    const o = tagsReport(ds, r.from, r.to, 'MONTH', '+03:00', rates);
    expect(o.buckets[0]).toEqual({ bucket: '2026-08', income: [], expense: [] });
  });

  it('reports unconvertible currencies instead of dropping them silently', () => {
    const o = tagsReport(ds, range.from, range.to, 'MONTH', '+03:00', none);
    expect(o.unconverted).toEqual(['USD']);
    expect(o.tags[0]!.expense).toBe(500 + 120 + 30 + 80);
  });
});
