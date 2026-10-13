import type { TagsData } from '@ivy/contracts';

export const AVG_BUCKET = 'Average';
/** Series key prefix for transactions carrying two or more of the picked tags; their sorted ids follow. */
const COMBO = 'combo:';
/** Series key for the smallest combinations, folded together once the palette runs out. */
export const OTHER_COMBOS = '__combos';

export type Metric = 'expense' | 'income';

export interface TagSeries {
  key: string;
  /** The picked tags this series' transactions carry: one for a tag, two or more for a combination, none for OTHER_COMBOS. */
  tagIds: string[];
  label: string;
  total: number;
}

export const isCombo = (s: TagSeries) => s.tagIds.length > 1;

export type TagRow = { bucket: string } & Record<string, string | number>;

export interface TagView {
  /**
   * Picked tags with money of their own, largest first (bottom of the stack); then each combination of picked tags
   * that transactions carry together, largest first; then OTHER_COMBOS if some combinations were folded.
   */
  series: TagSeries[];
  /** One row per period (a series is absent where it has nothing), then the average row. */
  rows: TagRow[];
  /** What the picked tags moved over the range, each transaction once: the sum of the series totals. */
  total: number;
  /** Transactions behind `total`. */
  count: number;
  /** Periods in the range, and how many of them have any picked money. */
  periods: number;
  active: number;
  /** Per picked tag, the part of its own total that sits in combinations. Only tags with such a part. */
  shared: Map<string, number>;
}

/**
 * Chart data for the picked tags. A transaction carrying exactly one picked tag stacks under that tag; one carrying
 * several stacks once, under the combination of picked tags it carries, so every bar adds up to the money the picked
 * tags actually moved and the overlaps stay visible. Past `maxCombos`, the smallest combinations fold into one series.
 */
export function shapeTags(d: TagsData, metric: Metric, picked: ReadonlySet<string>, maxCombos = Infinity): TagView {
  const rank = new Map(d.tags.map((t, i) => [t.id, i]));
  const names = new Map(d.tags.map((t) => [t.id, t.name]));
  const totals = new Map<string, TagSeries>();
  const shared = new Map<string, number>();
  let count = 0;

  // Money per period per exact set of picked tags.
  const cells = d.buckets.map((b) => {
    const m = new Map<string, number>();
    for (const set of b[metric]) {
      const hits = set.tagIds.filter((id) => picked.has(id)).sort();
      if (!hits.length) continue;
      const key = hits.length === 1 ? hits[0]! : COMBO + hits.join(',');
      if (hits.length > 1) for (const id of hits) shared.set(id, (shared.get(id) ?? 0) + set.amount);
      m.set(key, (m.get(key) ?? 0) + set.amount);
      const s = totals.get(key) ?? { key, tagIds: hits, label: label(hits, rank, names), total: 0 };
      s.total += set.amount;
      totals.set(key, s);
      count += set.count;
    }
    return m;
  });

  const bySize = (a: TagSeries, b: TagSeries) => b.total - a.total;
  const all = [...totals.values()];
  const combos = all.filter(isCombo).sort(bySize);
  const kept = combos.slice(0, Math.max(0, maxCombos));
  const folded = new Set(combos.slice(kept.length).map((s) => s.key));
  const series = [...all.filter((s) => !isCombo(s)).sort(bySize), ...kept];
  if (folded.size)
    series.push({
      key: OTHER_COMBOS,
      tagIds: [],
      label: `Other combinations (${folded.size})`,
      total: combos.slice(kept.length).reduce((sum, s) => sum + s.total, 0),
    });

  let active = 0;
  const rows: TagRow[] = d.buckets.map((b, i) => {
    const row: TagRow = { bucket: b.bucket };
    for (const [key, v] of cells[i]!) {
      const k = folded.has(key) ? OTHER_COMBOS : key;
      row[k] = Number(row[k] ?? 0) + v;
    }
    if (cells[i]!.size) active++;
    return row;
  });

  // Mean over the displayed periods (empty periods count as 0), like the Trends tab.
  const periods = rows.length;
  if (periods) {
    const avg: TagRow = { bucket: AVG_BUCKET };
    for (const s of series) avg[s.key] = s.total / periods;
    rows.push(avg);
  }

  return { series, rows, total: series.reduce((sum, s) => sum + s.total, 0), count, periods, active, shared };
}

/** "Trip + Work", members in the tag list's order (largest first). */
function label(ids: string[], rank: Map<string, number>, names: Map<string, string>): string {
  return [...ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)).map((id) => names.get(id) ?? id).join(' + ');
}

/**
 * Palette slots for the combinations on screen. A combination keeps the slot it had (unless a tag now holds it), so
 * toggling other tags never repaints it; a new one takes the highest free slot, away from where tags start.
 * `combos` must fit in the slots the tags leave free (see `maxCombos`).
 */
export function comboSlots(prev: ReadonlyMap<string, number>, combos: string[], tagSlots: ReadonlySet<number>, size: number): Map<string, number> {
  const next = new Map<string, number>();
  const used = new Set(tagSlots);
  for (const key of combos) {
    const slot = prev.get(key);
    if (slot !== undefined && !used.has(slot)) {
      next.set(key, slot);
      used.add(slot);
    }
  }
  for (const key of combos) {
    if (next.has(key)) continue;
    for (let slot = size - 1; slot >= 0; slot--) {
      if (used.has(slot)) continue;
      next.set(key, slot);
      used.add(slot);
      break;
    }
  }
  return next;
}

/** Sum of all series in one chart row, i.e. the full height of that period's stacked bar. */
export const rowTotal = (row: TagRow, series: TagSeries[]) => series.reduce((sum, s) => sum + Number(row[s.key] ?? 0), 0);
