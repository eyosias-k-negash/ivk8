import type { CustomReportData, Granularity, GroupBy } from '@ivy/contracts';

export const AVG_BUCKET = 'Average';
/** Group of the unpicked groups, folded together on each side. */
export const OTHER = '__other';
/** Group of each side's single series when nothing splits the report. */
export const ALL = '__all';
/** Row keys of the net marker: the line through the periods, and the average's lone point beside them. */
export const NET = '__net';
export const NET_AVG = '__netAvg';

export type Side = 'income' | 'expense';

/** What the Reports tab is set to. Lists of ids go to the API as they are; typed text is kept as typed. */
export interface ReportConfig {
  granularity: Granularity;
  groupBy: GroupBy;
  showNet: boolean;
  /** null = every account (so the filter keeps up with the backup); otherwise only these. */
  accounts: string[] | null;
  /** null = every category; otherwise only these flow ids. */
  categories: string[] | null;
  /** Carries any of these (none = no filter). */
  tags: string[];
  /** Carries none of these. */
  excludeTags: string[];
  /** Comma-separated words. */
  keywords: string;
  excludeKeywords: string;
  /** Bounds on each transaction's amount in base currency, as typed. */
  minAmount: string;
  maxAmount: string;
}

export const DEFAULT_CONFIG: ReportConfig = {
  granularity: 'MONTH',
  groupBy: 'none',
  showNet: true,
  accounts: null,
  categories: null,
  tags: [],
  excludeTags: [],
  keywords: '',
  excludeKeywords: '',
  minAmount: '',
  maxAmount: '',
};

/** The config with every filter cleared and the display settings kept. */
export const clearFilters = (c: ReportConfig): ReportConfig => ({
  ...DEFAULT_CONFIG,
  granularity: c.granularity,
  groupBy: c.groupBy,
  showNet: c.showNet,
});

export const words = (s: string) =>
  s
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);

/** How many filters narrow the report. */
export function activeFilters(c: ReportConfig): number {
  return [
    c.accounts !== null,
    c.categories !== null,
    c.tags.length > 0,
    c.excludeTags.length > 0,
    words(c.keywords).length > 0,
    words(c.excludeKeywords).length > 0,
    c.minAmount.trim() !== '',
    c.maxAmount.trim() !== '',
  ].filter(Boolean).length;
}

/** A typed amount: undefined when blank, NaN when it isn't a number of 0 or more. */
export function parseAmount(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** Query params for /custom-report (range aside), or why the config can't run. */
export function reportQuery(c: ReportConfig): { params: Record<string, string | undefined> } | { problem: string } {
  if (c.accounts?.length === 0) return { problem: 'Choose at least one account.' };
  if (c.categories?.length === 0) return { problem: 'Choose at least one category.' };
  const min = parseAmount(c.minAmount);
  const max = parseAmount(c.maxAmount);
  if (Number.isNaN(min) || Number.isNaN(max)) return { problem: 'Amounts must be numbers of 0 or more.' };
  if (min !== undefined && max !== undefined && min > max) return { problem: 'The smallest amount is more than the largest.' };
  const join = (items: string[] | null) => (items?.length ? items.join(',') : undefined);
  return {
    params: {
      granularity: c.granularity,
      groupBy: c.groupBy,
      accounts: join(c.accounts),
      categories: join(c.categories),
      tags: join(c.tags),
      excludeTags: join(c.excludeTags),
      keywords: join(words(c.keywords)),
      excludeKeywords: join(words(c.excludeKeywords)),
      minAmount: min?.toString(),
      maxAmount: max?.toString(),
    },
  };
}

export interface ReportSeries {
  /** "<side>:<group>", unique across both sides. */
  key: string;
  side: Side;
  /** A group id, OTHER, or ALL. */
  group: string;
  label: string;
  /** Over the range, positive on both sides. */
  total: number;
}

/**
 * One chart row. Series values are signed: income above zero, expense below, so they stack apart. `income` and
 * `expense` hold the row's totals (positive), `count` its transactions (periods only), NET or NET_AVG the difference.
 */
export type ReportRow = { bucket: string; income: number; expense: number } & Record<string, string | number>;

export interface ReportView {
  /** Income series from the zero line up, then expense series from the zero line down. */
  series: ReportSeries[];
  /** One row per period, then the average row. */
  rows: ReportRow[];
  periods: number;
  /** Periods with any matching money. */
  active: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const keyOf = (side: Side, group: string) => `${side}:${group}`;
const SIDES: Side[] = ['income', 'expense'];

/**
 * Chart data. Unsplit, each side is one series. Split, each picked group gets a series on each side it has money
 * on, largest nearest the zero line, and the unpicked groups fold into one "Other" per side, outermost.
 */
export function shapeReport(d: CustomReportData, picked: ReadonlySet<string>): ReportView {
  const series: ReportSeries[] = [];
  if (d.groupBy === 'none') {
    series.push({ key: keyOf('income', ALL), side: 'income', group: ALL, label: 'Income', total: d.income });
    series.push({ key: keyOf('expense', ALL), side: 'expense', group: ALL, label: 'Expense', total: d.expense });
  } else {
    for (const side of SIDES) {
      const own = d.groups.filter((g) => picked.has(g.id) && g[side] > 0).sort((a, b) => b[side] - a[side]);
      for (const g of own) series.push({ key: keyOf(side, g.id), side, group: g.id, label: g.name, total: g[side] });
      const rest = d.groups.filter((g) => !picked.has(g.id) && g[side] > 0);
      if (rest.length)
        series.push({
          key: keyOf(side, OTHER),
          side,
          group: OTHER,
          label: `Other (${rest.length})`,
          total: cents(rest.reduce((sum, g) => sum + g[side], 0)),
        });
    }
  }

  const sign = (side: Side) => (side === 'income' ? 1 : -1);
  const add = (row: ReportRow, side: Side, amounts: Record<string, number>) => {
    for (const [id, v] of Object.entries(amounts)) {
      const key = keyOf(side, picked.has(id) ? id : OTHER);
      row[key] = cents(Number(row[key] ?? 0) + sign(side) * v);
    }
  };

  let active = 0;
  const rows: ReportRow[] = d.buckets.map((b) => {
    const row: ReportRow = { bucket: b.bucket, income: b.income, expense: b.expense, count: b.count, [NET]: cents(b.income - b.expense) };
    if (d.groupBy === 'none') {
      if (b.income) row[keyOf('income', ALL)] = b.income;
      if (b.expense) row[keyOf('expense', ALL)] = -b.expense;
    } else {
      add(row, 'income', b.incomeBy);
      add(row, 'expense', b.expenseBy);
    }
    if (b.count) active++;
    return row;
  });

  // Mean over the displayed periods (empty periods count as 0), like every other tab.
  const periods = rows.length;
  if (periods) {
    const avg: ReportRow = { bucket: AVG_BUCKET, income: d.income / periods, expense: d.expense / periods, [NET_AVG]: d.net / periods };
    for (const s of series) avg[s.key] = (sign(s.side) * s.total) / periods;
    rows.push(avg);
  }
  return { series, rows, periods, active };
}

/** The outermost segment on each side of a row's stack, which gets the rounded data-end. */
export function outerKeys(row: ReportRow, series: ReportSeries[]): { top?: string; bottom?: string } {
  let top: string | undefined;
  let bottom: string | undefined;
  for (const s of series) {
    const v = Number(row[s.key] ?? 0);
    if (s.side === 'income' && v > 0) top = s.key;
    if (s.side === 'expense' && v < 0) bottom = s.key;
  }
  return { top, bottom };
}
