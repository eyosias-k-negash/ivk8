import type { CustomReportData, CustomReportRule, CustomReportRuleGroup, Granularity, GroupBy } from '@ivy/contracts';

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
  /** Conditions on tags, words and amount, joined by and/or. */
  rules: GroupDraft;
}

// ---------- conditions, as edited ----------

export type TagsOp = 'any' | 'all' | 'none';
export type TextOp = 'contains' | 'excludes';
export type AmountOp = 'atLeast' | 'atMost' | 'between';
export type ConditionKind = 'tags' | 'text' | 'amount';

/**
 * A condition as the form holds it: typed text kept as typed, and an id for React and for edits. An amount keeps both
 * bounds whatever its op, so switching op doesn't lose what was typed.
 */
export type ConditionDraft =
  | { id: string; kind: 'tags'; op: TagsOp; tagIds: string[] }
  | { id: string; kind: 'text'; op: TextOp; text: string }
  | { id: string; kind: 'amount'; op: AmountOp; min: string; max: string };

export interface GroupDraft {
  id: string;
  kind: 'group';
  match: 'all' | 'any';
  rules: RuleDraft[];
}

export type RuleDraft = ConditionDraft | GroupDraft;

let seq = 0;
const newId = () => `r${++seq}`;

export const emptyRules = (): GroupDraft => ({ id: 'root', kind: 'group', match: 'all', rules: [] });

export function newCondition(kind: ConditionKind): ConditionDraft {
  if (kind === 'tags') return { id: newId(), kind: 'tags', op: 'any', tagIds: [] };
  if (kind === 'text') return { id: newId(), kind: 'text', op: 'contains', text: '' };
  return { id: newId(), kind: 'amount', op: 'atLeast', min: '', max: '' };
}

/** A group starts with the other connector than its parent's (the same one would add nothing) and one condition. */
export const newGroup = (parent: GroupDraft['match'], first: ConditionKind): GroupDraft => ({
  id: newId(),
  kind: 'group',
  match: parent === 'all' ? 'any' : 'all',
  rules: [newCondition(first)],
});

/** The tree with rule `id` replaced by `fn`'s result, or removed when it returns null. */
export function mapRule(root: GroupDraft, id: string, fn: (r: RuleDraft) => RuleDraft | null): GroupDraft {
  const walk = (r: RuleDraft): RuleDraft | null => {
    if (r.id === id) return fn(r);
    if (r.kind !== 'group') return r;
    return { ...r, rules: r.rules.map(walk).filter((x): x is RuleDraft => x !== null) };
  };
  return (walk(root) as GroupDraft | null) ?? emptyRules();
}

export const updateRule = (root: GroupDraft, id: string, patch: Partial<RuleDraft>) =>
  mapRule(root, id, (r) => ({ ...r, ...patch }) as RuleDraft);
export const removeRule = (root: GroupDraft, id: string) => mapRule(root, id, () => null);
export const addRule = (root: GroupDraft, groupId: string, rule: RuleDraft) =>
  mapRule(root, groupId, (g) => (g.kind === 'group' ? { ...g, rules: [...g.rules, rule] } : g));

export const words = (s: string) =>
  s
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);

/** A typed amount: undefined when blank, NaN when it isn't a number of 0 or more. */
export function parseAmount(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** The bounds an amount condition's op uses. */
export function amountBounds(c: Extract<ConditionDraft, { kind: 'amount' }>): { min?: number; max?: number } {
  return { min: c.op === 'atMost' ? undefined : parseAmount(c.min), max: c.op === 'atLeast' ? undefined : parseAmount(c.max) };
}

/** Whether a condition can run. Incomplete ones are left out until filled in; a problem blocks the report. */
export function checkCondition(c: ConditionDraft): 'ok' | 'incomplete' | { problem: string } {
  if (c.kind === 'tags') return c.tagIds.length ? 'ok' : 'incomplete';
  if (c.kind === 'text') return words(c.text).length ? 'ok' : 'incomplete';
  const { min, max } = amountBounds(c);
  if (Number.isNaN(min) || Number.isNaN(max)) return { problem: 'Amounts must be numbers of 0 or more.' };
  if (c.op === 'between' ? min === undefined || max === undefined : min === undefined && max === undefined) return 'incomplete';
  if (min !== undefined && max !== undefined && min > max) return { problem: 'A “between” amount must go from the smaller to the larger.' };
  return 'ok';
}

/**
 * The rules as the API takes them: incomplete conditions and the groups they leave empty are dropped, so nothing
 * half-typed filters anything. Undefined when no condition remains.
 */
export function compileRules(root: GroupDraft): { rules?: CustomReportRuleGroup } | { problem: string } {
  let problem: string | undefined;
  const walk = (r: RuleDraft): CustomReportRule | null => {
    if (r.kind === 'group') {
      const rules = r.rules.map(walk).filter((x): x is CustomReportRule => x !== null);
      return rules.length ? { kind: 'group', match: r.match, rules } : null;
    }
    const check = checkCondition(r);
    if (check !== 'ok') {
      if (typeof check === 'object') problem ??= check.problem;
      return null;
    }
    if (r.kind === 'tags') return { kind: 'tags', op: r.op, tagIds: r.tagIds };
    if (r.kind === 'text') return { kind: 'text', op: r.op, words: words(r.text) };
    return { kind: 'amount', ...amountBounds(r) };
  };
  const rules = walk(root) as CustomReportRuleGroup | null;
  if (problem) return { problem };
  return rules ? { rules } : {};
}

/** Conditions that apply (complete ones). */
export function countConditions(r: RuleDraft): number {
  if (r.kind === 'group') return r.rules.reduce((n, c) => n + countConditions(c), 0);
  return checkCondition(r) === 'ok' ? 1 : 0;
}

// ---------- the whole config ----------

export const DEFAULT_CONFIG: ReportConfig = {
  granularity: 'MONTH',
  groupBy: 'none',
  showNet: true,
  accounts: null,
  categories: null,
  rules: emptyRules(),
};

/** The config with every filter cleared and the display settings kept. */
export const clearFilters = (c: ReportConfig): ReportConfig => ({
  ...DEFAULT_CONFIG,
  granularity: c.granularity,
  groupBy: c.groupBy,
  showNet: c.showNet,
  rules: emptyRules(),
});

/** How many filters narrow the report: the account and category scope, and each condition that applies. */
export function activeFilters(c: ReportConfig): number {
  return Number(c.accounts !== null) + Number(c.categories !== null) + countConditions(c.rules);
}

/** Query params for /custom-report (range aside), or why the config can't run. */
export function reportQuery(c: ReportConfig): { params: Record<string, string | undefined> } | { problem: string } {
  if (c.accounts?.length === 0) return { problem: 'Choose at least one account.' };
  if (c.categories?.length === 0) return { problem: 'Choose at least one category.' };
  const compiled = compileRules(c.rules);
  if ('problem' in compiled) return compiled;
  const join = (items: string[] | null) => (items?.length ? items.join(',') : undefined);
  return {
    params: {
      granularity: c.granularity,
      groupBy: c.groupBy,
      accounts: join(c.accounts),
      categories: join(c.categories),
      rules: compiled.rules && JSON.stringify(compiled.rules),
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
 * on, largest nearest the zero line, and the unpicked groups fold into one "Other" per side, outermost
 * (or are left out altogether when `showOther` is off).
 */
export function shapeReport(d: CustomReportData, picked: ReadonlySet<string>, showOther = true): ReportView {
  const series: ReportSeries[] = [];
  if (d.groupBy === 'none') {
    series.push({ key: keyOf('income', ALL), side: 'income', group: ALL, label: 'Income', total: d.income });
    series.push({ key: keyOf('expense', ALL), side: 'expense', group: ALL, label: 'Expense', total: d.expense });
  } else {
    for (const side of SIDES) {
      const own = d.groups.filter((g) => picked.has(g.id) && g[side] > 0).sort((a, b) => b[side] - a[side]);
      for (const g of own) series.push({ key: keyOf(side, g.id), side, group: g.id, label: g.name, total: g[side] });
      const rest = d.groups.filter((g) => !picked.has(g.id) && g[side] > 0);
      if (showOther && rest.length)
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
      if (!showOther && !picked.has(id)) continue;
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
