import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CursorValue } from './CursorValue';
import type { Granularity, GroupBy, SummaryData, TimeseriesData } from '@ivy/contracts';
import { useReport } from '../api/hooks';
import { useParams } from '../state/params';
import { PrintButton, rangeText } from '../print';
import { ErrorBox } from './ErrorBox';
import { fmtMoney, fmtPct, offsetMs } from '../format';

// ---------- shared date range (flow 4: "for the selected backup and date range") ----------

export interface DateRange {
  from: string; // YYYY-MM-DD (local) or 'all'
  to: string; // YYYY-MM-DD (local, inclusive)
}

/** "Today" in the selected fixed offset, not the browser's zone. */
function localToday(tz: string): Date {
  const d = new Date(Date.now() + offsetMs(tz));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function presetRange(preset: 'thisMonth' | 'lastMonth' | 'thisYear' | 'all', tz: string): DateRange {
  const t = localToday(tz);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  switch (preset) {
    case 'thisMonth':
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(t) };
    case 'lastMonth':
      return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    case 'thisYear':
      return { from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(t) };
    case 'all':
      return { from: 'all', to: iso(t) };
  }
}

export type RangeUnit = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
const UNIT_LABEL: Record<RangeUnit, string> = { DAY: 'days', WEEK: 'weeks', MONTH: 'months', YEAR: 'years' };

/** Shifts a date by n units (negative = back); months and years keep the day-of-month, clamped to the month's end. */
function shift(d: Date, n: number, unit: RangeUnit): Date {
  const out = new Date(d);
  if (unit === 'DAY' || unit === 'WEEK') {
    out.setUTCDate(out.getUTCDate() + n * (unit === 'WEEK' ? 7 : 1));
    return out;
  }
  const months = unit === 'YEAR' ? n * 12 : n;
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(d.getUTCDate(), last));
  return out;
}

/** The n units ending today ("last 3 months" = the 3 months back from today, today included). */
export function lastRange(n: number, unit: RangeUnit, tz: string): DateRange {
  const t = localToday(tz);
  return { from: iso(shift(shift(t, -n, unit), 1, 'DAY')), to: iso(t) };
}

/** The n units starting today, for projections. */
export function nextRange(n: number, unit: RangeUnit, tz: string): DateRange {
  const t = localToday(tz);
  return { from: iso(t), to: iso(shift(shift(t, n, unit), -1, 'DAY')) };
}

/** "Last/Next [x] [interval]": a whole number and any interval, applied as soon as both are valid. */
export function RelativeRange({ mode, onPick }: { mode: 'last' | 'next'; onPick: (r: DateRange) => void }) {
  const { tz } = useParams();
  const [text, setText] = useState('3');
  const [unit, setUnit] = useState<RangeUnit>('MONTH');
  const apply = (t: string, u: RangeUnit) => {
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= 1000) onPick((mode === 'last' ? lastRange : nextRange)(n, u, tz));
  };
  const n = Number(text);
  const bad = !(Number.isInteger(n) && n >= 1 && n <= 1000);
  return (
    <span className="range-inputs">
      {mode === 'last' ? 'Last' : 'Next'}
      <input
        type="number"
        min={1}
        max={1000}
        step={1}
        value={text}
        aria-label={`${mode} how many`}
        aria-invalid={bad}
        style={{ width: '4.5em' }}
        onChange={(e) => {
          setText(e.target.value);
          apply(e.target.value, unit);
        }}
      />
      <select
        value={unit}
        aria-label="interval"
        onChange={(e) => {
          setUnit(e.target.value as RangeUnit);
          apply(text, e.target.value as RangeUnit);
        }}
      >
        {(Object.keys(UNIT_LABEL) as RangeUnit[]).map((u) => (
          <option key={u} value={u}>{UNIT_LABEL[u]}</option>
        ))}
      </select>
      <button className="link" disabled={bad} onClick={() => apply(text, unit)}>Apply</button>
    </span>
  );
}

export function RangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const { tz } = useParams();
  return (
    <div className="controls">
      <label>
        From{' '}
        <input type="date" value={value.from === 'all' ? '' : value.from} onChange={(e) => onChange({ ...value, from: e.target.value || 'all' })} />
      </label>
      <label>
        To <input type="date" value={value.to} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
      </label>
      {(['thisMonth', 'lastMonth', 'thisYear', 'all'] as const).map((p) => (
        <button key={p} className="link" onClick={() => onChange(presetRange(p, tz))}>
          {{ thisMonth: 'This month', lastMonth: 'Last month', thisYear: 'This year', all: 'All time' }[p]}
        </button>
      ))}
      <RelativeRange mode="last" onPick={onChange} />
    </div>
  );
}

export function Unconverted({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <div className="callout warn">
      Left out of totals (no exchange rate): {list.join(', ')}. Add an override under “Rates & timezone”.
    </div>
  );
}

// ---------- Income & expense (summary) ----------

export function SummaryTab({ fileId, range }: { fileId: string; range: DateRange }) {
  const r = useReport<SummaryData>(fileId, 'summary', { from: range.from, to: range.to });
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <p className="muted">Loading…</p>;
  const { data: s, baseCurrency: base } = r.data;
  return (
    <>
      <div className="kpis">
        <Kpi label="Income" value={fmtMoney(s.income, base)} />
        <Kpi label="Expense" value={fmtMoney(s.expense, base)} />
        <Kpi label="Net" value={fmtMoney(s.net, base)} />
        <Kpi label="Transactions" value={String(s.count)} />
      </div>
      <Unconverted list={s.unconverted} />
      <IncomeExpenseChart fileId={fileId} range={range} />
      <p className="muted">
        Executed only; planned payments are not counted. Income and expense on accounts excluded from the balance are left out. A
        transfer to or from an excluded account counts as expense or income under its category; transfers between included accounts never
        count.
      </p>

      <details open>
        <summary><h3 style={{ display: 'inline' }}>By category</h3></summary>
      <table className="grid">
        <thead><tr><th>Category</th><th className="num">Income</th><th className="num">Expense</th><th className="num">Net</th></tr></thead>
        <tbody>
          {s.byCategory.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td className="num">{fmtMoney(c.income, base)}</td>
              <td className="num">{fmtMoney(c.expense, base)}</td>
              <td className="num">{fmtMoney(c.net, base)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </details>

      <details open>
        <summary><h3 style={{ display: 'inline' }}>By account</h3></summary>
      <table className="grid">
        <thead>
          <tr><th>Account</th><th className="num">Income</th><th className="num">Expense</th><th className="num">Net ({base})</th></tr>
        </thead>
        <tbody>
          {s.byAccount.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td className="num">
                {fmtMoney(a.incomeNative, a.currency)}
                {a.currency !== base && <div className="muted">{fmtMoney(a.income, base)}</div>}
              </td>
              <td className="num">
                {fmtMoney(a.expenseNative, a.currency)}
                {a.currency !== base && <div className="muted">{fmtMoney(a.expense, base)}</div>}
              </td>
              <td className="num">{fmtMoney(a.net, base)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </details>
    </>
  );
}

/** Income vs expense per interval, with a trailing average bar. No breakdowns; see Breakdowns for those. */
function IncomeExpenseChart({ fileId, range }: { fileId: string; range: DateRange }) {
  const [granularity, setGranularity] = useState<Granularity>('MONTH');
  const r = useReport<TimeseriesData>(fileId, 'timeseries', { from: range.from, to: range.to, granularity, groupBy: 'none' });
  const view = useMemo(() => {
    if (!r.data) return null;
    const v = shape(r.data.data, 'expense', [], new Map(), true);
    return { ...v, rows: withAverage(v) };
  }, [r.data]);
  const base = r.data?.baseCurrency ?? '';

  return (
    <>
      <div className="controls">
        <label>
          Interval{' '}
          <select value={granularity} onChange={(e) => setGranularity(e.target.value as Granularity)}>
            <option value="DAY">Day</option>
            <option value="WEEK">Week (Mon)</option>
            <option value="MONTH">Month</option>
            <option value="YEAR">Year</option>
          </select>
        </label>
        <PrintButton tab="Income & expense" title="Income and expense" meta={[rangeText(range), `Per ${granularity.toLowerCase()}`]} />
      </div>
      {r.error && <ErrorBox error={r.error} />}
      {!r.data && !r.error && <p className="muted">Loading…</p>}
      {r.data && view && (
        <>
          <div className="chart" role="img" aria-label={`Income and expense per ${granularity.toLowerCase()}`}>
            <ResponsiveContainer>
              <BarChart data={view.rows} barGap={2} barCategoryGap="20%">
                <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                <XAxis dataKey="bucket" tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" />
                <YAxis tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" width={72} />
                <Tooltip
                  cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }}
                  contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--fg)' }}
                  itemStyle={{ color: 'var(--fg)' }}
                  labelStyle={{ color: 'var(--fg)', fontWeight: 600 }}
                  formatter={(v) => fmtMoney(Number(v), base)}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span style={{ color: 'var(--fg)' }}>{v}</span>} />
                {view.series.map((s) => (
                  <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                    {/* The trailing average bar is dimmed so it reads as a summary, not a period. */}
                    {view.rows.map((row) => (
                      <Cell key={row.bucket as string} fillOpacity={row.bucket === AVG_BUCKET ? 0.55 : 1} />
                    ))}
                  </Bar>
                ))}
                <CursorValue base={base} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <details>
            <summary>Show as table</summary>
            <div className="scroll">
              <table className="grid">
                <thead><tr><th>Period</th>{view.series.map((s) => <th key={s.key} className="num">{s.label}</th>)}</tr></thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.bucket as string}>
                      <td>{row.bucket}</td>
                      {view.series.map((s) => <td key={s.key} className="num">{fmtMoney(Number(row[s.key] ?? 0), base)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </>
  );
}

export function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

// ---------- Breakdowns (timeseries) ----------

/**
 * Whole-range figures for the Breakdowns tab; independent of which groups are picked for the chart, but `data` comes
 * without the excluded ones (named under the total).
 */
function BreakdownKpis({ data, base, metric, unit, excluded }: { data: TimeseriesData; base: string; metric: Metric; unit: string; excluded: Excluded }) {
  const perBucket = new Map<string, { income: number; expense: number }>();
  for (const p of data.points) {
    const b = perBucket.get(p.bucket) ?? { income: 0, expense: 0 };
    b.income += p.income;
    b.expense += p.expense;
    perBucket.set(p.bucket, b);
  }
  const n = perBucket.size;
  const income = [...perBucket.values()].reduce((s, b) => s + b.income, 0);
  const expense = [...perBucket.values()].reduce((s, b) => s + b.expense, 0);
  const avg = (v: number) => fmtMoney(n ? v / n : 0, base);
  const periods = `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (data.groupBy === 'none') {
    return (
      <div className="kpis">
        <Kpi label="Income" value={fmtMoney(income, base)} note={`${avg(income)} per ${unit} over ${periods}`} />
        <Kpi label="Expense" value={fmtMoney(expense, base)} note={`${avg(expense)} per ${unit} over ${periods}`} />
        <Kpi label="Net" value={fmtMoney(income - expense, base)} note={`${avg(income - expense)} per ${unit}`} />
      </div>
    );
  }
  const total = metric === 'expense' ? expense : income;
  let peak: { bucket: string; value: number } | null = null;
  for (const [bucket, b] of perBucket) if (!peak || b[metric] > peak.value) peak = { bucket, value: b[metric] };
  return (
    <div className="kpis">
      <Kpi label={`Total ${metric}`} value={fmtMoney(total, base)} note={excludingNote(excluded)} />
      <Kpi label={`Average per ${unit}`} value={avg(total)} note={`over ${periods}`} />
      {peak && peak.value > 0 && <Kpi label={`Highest ${unit}`} value={fmtMoney(peak.value, base)} note={peak.bucket} />}
    </div>
  );
}

// The validated palette has 8 hues; a 9th distinct series would need a generated hue, so the
// cap on picked groups is the palette size and everything unpicked folds into "Other" (muted).
export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
const DEFAULT_PICKS = 5; // leaves a few colors free for the user's own picks

export type Metric = 'expense' | 'income';
/**
 * Picked group id -> palette slot (+ name, for picks with no activity in the current range).
 * Slots stick to the group, so toggling others never repaints it.
 */
type Picks = Map<string, { slot: number; name: string }>;
/** Excluded group id -> name. Their money is left out of the chart and KPIs altogether, not folded into "Other". */
type Excluded = ReadonlyMap<string, string>;
const NONE: Excluded = new Map();

/**
 * Which groups a split chart shows in their own color, which it leaves out, and whether the rest show as "Other".
 * The user's choices belong to the split they were made for: changing "Split by" (or Reset) falls back to the
 * defaults (top groups by total, nothing excluded). Anything else (range, metric, interval) keeps them.
 */
export function usePicks(groups: Group[], groupBy: GroupBy) {
  const [custom, setCustom] = useState<{ groupBy: GroupBy; picks: Picks; excluded: Excluded } | null>(null);
  // Unchecking "Other" leaves the unpicked groups out of the chart instead of folding them into it.
  const [showOther, setShowOther] = useState(true);
  const mine = custom?.groupBy === groupBy ? custom : null;
  const picks = useMemo<Picks>(
    () => mine?.picks ?? new Map(groups.slice(0, DEFAULT_PICKS).map((g, i) => [g.id, { slot: i, name: g.name }])),
    [mine, groups],
  );
  const excluded = mine?.excluded ?? NONE;
  const included = useMemo(() => groups.filter((g) => !excluded.has(g.id)), [groups, excluded]);
  // Each click moves a group on: own color -> folded into "Other" -> excluded -> own color. With every color
  // in use, an excluded group goes back to "Other" instead.
  const toggle = (g: Group) => {
    const nextPicks = new Map(picks);
    const nextExcluded = new Map(excluded);
    if (nextPicks.has(g.id)) nextPicks.delete(g.id);
    else if (!nextExcluded.has(g.id)) nextExcluded.set(g.id, g.name);
    else {
      nextExcluded.delete(g.id);
      const used = new Set([...nextPicks.values()].map((p) => p.slot));
      const slot = SERIES.findIndex((_, i) => !used.has(i));
      if (slot >= 0) nextPicks.set(g.id, { slot, name: g.name });
    }
    setCustom({ groupBy, picks: nextPicks, excluded: nextExcluded });
  };
  return {
    picks,
    excluded,
    /** `groups` without the excluded ones. */
    included,
    showOther,
    toggle,
    toggleOther: () => setShowOther((v) => !v),
    reset: () => {
      setCustom(null);
      setShowOther(true);
    },
  };
}

export function BreakdownsTab({ fileId, range }: { fileId: string; range: DateRange }) {
  const [granularity, setGranularity] = useState<Granularity>('MONTH');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [metric, setMetric] = useState<Metric>('expense');
  const r = useReport<TimeseriesData>(fileId, 'timeseries', { from: range.from, to: range.to, granularity, groupBy });

  const groups = useMemo(() => (r.data ? groupTotals(r.data.data, metric) : []), [r.data, metric]);
  const { picks, excluded, included, showOther, toggle, toggleOther, reset } = usePicks(groups, groupBy);
  const kept = useMemo(() => (r.data ? without(r.data.data, excluded) : null), [r.data, excluded]);

  const view = useMemo(() => {
    if (!kept) return null;
    const v = shape(kept, metric, included, picks, showOther);
    return { ...v, rows: withAverage(v) };
  }, [kept, metric, included, picks, showOther]);

  return (
    <>
      <div className="controls">
        <label>
          Interval{' '}
          <select value={granularity} onChange={(e) => setGranularity(e.target.value as Granularity)}>
            <option value="DAY">Day</option>
            <option value="WEEK">Week (Mon)</option>
            <option value="MONTH">Month</option>
            <option value="YEAR">Year</option>
          </select>
        </label>
        <SplitControls groupBy={groupBy} onGroupBy={setGroupBy} metric={metric} onMetric={setMetric} />
        <PrintButton
          tab="Breakdowns"
          title={view?.title ?? 'Breakdowns'}
          meta={[rangeText(range), `Per ${granularity.toLowerCase()}`, groupBy === 'none' ? '' : `Split by ${groupBy} (${metric})`, excludingText(excluded)]}
        />
      </div>
      {r.error && <ErrorBox error={r.error} />}
      {!r.data && !r.error && <p className="muted">Loading…</p>}
      {r.data && kept && view && (
        <>
          <Unconverted list={r.data.data.unconverted} />
          <BreakdownKpis data={kept} base={r.data.baseCurrency} metric={metric} unit={granularity.toLowerCase()} excluded={excluded} />
          <FlowChart view={view} base={r.data.baseCurrency} label={`${view.title} per ${granularity.toLowerCase()}`} />
          {view.stacked && (
            <PickLegend
              groups={groups}
              picks={picks}
              excluded={excluded}
              base={r.data.baseCurrency}
              showOther={showOther}
              onToggleOther={toggleOther}
              onToggle={toggle}
              onReset={reset}
            />
          )}
          <FlowTable view={view} base={r.data.baseCurrency} />
        </>
      )}
    </>
  );
}

/** "Split by" and, for a split, which side of the money to show. */
export function SplitControls({ groupBy, onGroupBy, metric, onMetric }: {
  groupBy: GroupBy;
  onGroupBy: (g: GroupBy) => void;
  metric: Metric;
  onMetric: (m: Metric) => void;
}) {
  return (
    <>
      <label>
        Split by{' '}
        <select value={groupBy} onChange={(e) => onGroupBy(e.target.value as GroupBy)}>
          <option value="none">Nothing (income vs expense)</option>
          <option value="category">Category</option>
          <option value="account">Account</option>
        </select>
      </label>
      {groupBy !== 'none' && (
        <label>
          Show{' '}
          <select value={metric} onChange={(e) => onMetric(e.target.value as Metric)}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
        </label>
      )}
    </>
  );
}

/** Bars per period from shape() + withAverage(): income vs expense side by side, or one stack per period for a split. */
export function FlowChart({ view, base, label }: { view: View; base: string; label: string }) {
  // Card-colored seams between stacked segments; past ~60 bars each bar is a few pixels wide and the seams would hide it.
  const seams = view.stacked && view.rows.length <= 60;
  return (
    <div className="chart" role="img" aria-label={label}>
      <ResponsiveContainer>
        <BarChart data={view.rows} barGap={2} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
          <XAxis dataKey="bucket" tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" />
          <YAxis tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" width={72} />
          <Tooltip
            cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }}
            contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--fg)' }}
            itemStyle={{ color: 'var(--fg)' }}
            labelStyle={{ color: 'var(--fg)', fontWeight: 600 }}
            itemSorter={(item) => -Number(item.value ?? 0)}
            // Stacked bars: each item's share of that period's bar, with the bar total in the header.
            labelFormatter={(label, payload) =>
              view.stacked && payload?.[0] ? `${label} · ${fmtMoney(rowTotal(payload[0].payload, view), base)}` : label
            }
            formatter={(v, _name, item) =>
              view.stacked ? `${fmtMoney(Number(v), base)} (${fmtPct(Number(v), rowTotal(item.payload, view))})` : fmtMoney(Number(v), base)
            }
          />
          {/* Text wears text tokens; the swatch beside it carries identity. */}
          {!view.stacked && <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span style={{ color: 'var(--fg)' }}>{v}</span>} />}
          {view.series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={s.color}
              stackId={view.stacked ? 'g' : undefined}
              stroke={seams ? 'var(--card)' : undefined}
              strokeWidth={seams ? 2 : 0}
              radius={!view.stacked || i === view.series.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
            >
              {/* The trailing average bar is dimmed so it reads as a summary, not a period. */}
              {view.rows.map((row) => (
                <Cell key={row.bucket as string} fillOpacity={row.bucket === AVG_BUCKET ? 0.55 : 1} />
              ))}
            </Bar>
          ))}
          <CursorValue base={base} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Table view: the accessible/precise counterpart of FlowChart. */
export function FlowTable({ view, base, head = 'Period' }: { view: View; base: string; head?: string }) {
  return (
    <details>
      <summary>Show as table</summary>
      <div className="scroll">
        <table className="grid">
          <thead>
            <tr><th>{head}</th>{view.series.map((s) => <th key={s.key} className="num">{s.label}</th>)}</tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.bucket as string}>
                <td>{row.bucket}</td>
                {view.series.map((s) => <td key={s.key} className="num">{fmtMoney(Number(row[s.key] ?? 0), base)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

interface View {
  title: string;
  stacked: boolean;
  series: { key: string; label: string; color: string }[];
  rows: Record<string, string | number>[];
}

interface Group {
  id: string;
  name: string;
  total: number;
}

/** Per-group totals over the whole range, largest first. Groups with nothing to show are dropped. */
export function groupTotals(d: TimeseriesData, metric: Metric): Group[] {
  if (d.groupBy === 'none') return [];
  const totals = new Map<string, Group>();
  for (const p of d.points) {
    const id = p.groupId ?? '?';
    const g = totals.get(id) ?? { id, name: p.groupName ?? id, total: 0 };
    g.total += p[metric];
    totals.set(id, g);
  }
  return [...totals.values()].filter((g) => g.total > 0).sort((a, b) => b.total - a.total);
}

/** The data without the excluded groups' points, so the chart and KPIs alike behave as if they never moved money. */
export function without(d: TimeseriesData, excluded: Excluded): TimeseriesData {
  return excluded.size ? { ...d, points: d.points.filter((p) => !excluded.has(p.groupId ?? '?')) } : d;
}

/** "Excluding Rent, Travel": the print header line, empty when nothing is excluded. */
export const excludingText = (excluded: Excluded) => (excluded.size ? `Excluding ${[...excluded.values()].join(', ')}` : '');

/** The same for a KPI note, which only has room for a few names. */
export function excludingNote(excluded: Excluded): string | undefined {
  const names = [...excluded.values()];
  if (!names.length) return undefined;
  return `excluding ${names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', ')}`;
}

/**
 * Pivot API points into chart rows. Grouped views show the picked groups and fold the rest into "Other".
 * Given `buckets`, a grouped view has a row for each of them, in that order, even an empty one; otherwise
 * only buckets with money get a row, sorted by key.
 */
export function shape(d: TimeseriesData, metric: Metric, groups: Group[], picks: Picks, showOther: boolean, buckets?: string[]): View {
  if (d.groupBy === 'none') {
    return {
      title: 'Income and expense',
      stacked: false,
      series: [
        { key: 'income', label: 'Income', color: SERIES[0]! },
        { key: 'expense', label: 'Expense', color: SERIES[1]! },
      ],
      rows: d.points.map((p) => ({ bucket: p.bucket, income: p.income, expense: p.expense })),
    };
  }

  const rowsByBucket = new Map<string, Record<string, string | number>>((buckets ?? []).map((b) => [b, { bucket: b }]));
  for (const p of d.points) {
    const row = rowsByBucket.get(p.bucket) ?? { bucket: p.bucket };
    const id = p.groupId ?? '?';
    const key = picks.has(id) ? id : '__other';
    if (key === '__other' && !showOther) continue;
    row[key] = Number(row[key] ?? 0) + p[metric];
    rowsByBucket.set(p.bucket, row);
  }

  // Largest picked group sits at the bottom of the stack; "Other" caps it.
  const series = groups
    .filter((g) => picks.has(g.id))
    .map((g) => ({ key: g.id, label: g.name, color: SERIES[picks.get(g.id)!.slot]! }));
  if (showOther && groups.some((g) => !picks.has(g.id))) series.push({ key: '__other', label: 'Other', color: 'var(--viz-muted)' });

  return {
    title: metric === 'expense' ? 'Expense' : 'Income',
    stacked: true,
    series,
    rows: buckets ? [...rowsByBucket.values()] : [...rowsByBucket.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket))),
  };
}

const AVG_BUCKET = 'Average';

/** Appends one row holding each shown series' mean over the displayed periods (empty periods count as 0). */
export function withAverage(view: View): View['rows'] {
  const n = view.rows.length;
  if (!n) return view.rows;
  // "Other" is not an enabled legend entry, so it gets no average bar.
  const avg: Record<string, string | number> = { bucket: AVG_BUCKET };
  for (const s of view.series) {
    if (view.stacked && s.key === '__other') continue;
    avg[s.key] = view.rows.reduce((sum, r) => sum + Number(r[s.key] ?? 0), 0) / n;
  }
  return [...view.rows, avg];
}

/** Sum of all shown series in one chart row, i.e. the full height of that period's stacked bar. */
function rowTotal(row: Record<string, string | number> | undefined, view: View): number {
  return row ? view.series.reduce((sum, s) => sum + Number(row[s.key] ?? 0), 0) : 0;
}

/** What a click on a legend box does next, per state. */
const NEXT = {
  picked: 'Click to fold it into Other.',
  folded: 'Click to exclude it from the chart and figures.',
  excluded: 'Excluded from the chart and figures. Click to show it again.',
};

/**
 * Checkbox legend for grouped views. Each box cycles through three states: checked groups get their own color,
 * unchecked ones fold into "Other" (itself optional), and crossed-out ones are excluded altogether.
 */
export function PickLegend({ groups, picks, excluded, base, showOther, onToggleOther, onToggle, onReset }: {
  groups: Group[];
  picks: Picks;
  excluded: Excluded;
  base: string;
  showOther: boolean;
  onToggleOther: () => void;
  onToggle: (g: Group) => void;
  onReset: () => void;
}) {
  // Picks and exclusions survive range changes, so such a group may have nothing in this range; keep it listed
  // (at zero) so it can still be cycled on, freeing its color slot or bringing it back.
  const active = new Set(groups.map((g) => g.id));
  const idle = [...[...picks].map(([id, p]) => [id, p.name] as const), ...excluded]
    .filter(([id]) => !active.has(id))
    .map(([id, name]) => ({ id, name, total: 0 }));
  const items = [...groups, ...idle];
  if (!items.length) return null;
  const full = picks.size >= SERIES.length;
  const kept = groups.filter((g) => !excluded.has(g.id));
  const other = kept.filter((g) => !picks.has(g.id)).reduce((sum, g) => sum + g.total, 0);
  const whole = kept.reduce((sum, g) => sum + g.total, 0);
  return (
    <fieldset className="pick-legend">
      <legend>
        Shown in chart ({picks.size}/{SERIES.length}) <button className="link" onClick={onReset}>Reset</button>
      </legend>
      {full && <p className="muted">All {SERIES.length} colors are in use. Uncheck one to add another.</p>}
      <ul>
        {items.map((g) => {
          const slot = picks.get(g.id)?.slot;
          const out = excluded.has(g.id);
          const state = slot !== undefined ? 'picked' : out ? 'excluded' : 'folded';
          return (
            <li key={g.id}>
              <label className={out ? 'excluded' : undefined} title={`${g.name}. ${NEXT[state]}`}>
                {/* A native checkbox has two states; the third is drawn over an unchecked one (see .excluded). */}
                <input
                  type="checkbox"
                  checked={slot !== undefined}
                  onChange={() => onToggle(g)}
                  className={out ? 'excluded' : undefined}
                  aria-label={out ? `${g.name} (excluded)` : undefined}
                  style={slot !== undefined ? { accentColor: SERIES[slot] } : undefined}
                />
                <span className="name">{g.name}</span>
                <span className="num muted">{fmtMoney(g.total, base)}</span>
                <span className="num pct">{out ? '' : fmtPct(g.total, whole)}</span>
              </label>
            </li>
          );
        })}
        {other > 0 && (
          <li>
            <label>
              <input type="checkbox" checked={showOther} onChange={onToggleOther} style={{ accentColor: 'var(--viz-muted)' }} />
              <span className="name">Other</span>
              <span className="num muted">{fmtMoney(other, base)}</span>
              <span className="num pct">{fmtPct(other, whole)}</span>
            </label>
          </li>
        )}
      </ul>
    </fieldset>
  );
}
