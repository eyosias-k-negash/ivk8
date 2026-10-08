import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Granularity, GroupBy, SummaryData, TimeseriesData } from '@ivy/contracts';
import { useReport } from '../api/hooks';
import { useParams } from '../state/params';
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
      <p className="muted">Executed income and expense only. Transfers and planned payments are not counted.</p>

      <h3>By category</h3>
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

      <h3>By account</h3>
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
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

// ---------- Trends (timeseries) ----------

// The validated palette has 8 hues; a 9th distinct series would need a generated hue, so the
// cap on picked groups is the palette size and everything unpicked folds into "Other" (muted).
export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
const DEFAULT_PICKS = 5; // leaves a few colors free for the user's own picks

type Metric = 'expense' | 'income';
/**
 * Picked group id -> palette slot (+ name, for picks with no activity in the current range).
 * Slots stick to the group, so toggling others never repaints it.
 */
type Picks = Map<string, { slot: number; name: string }>;

export function TrendsTab({ fileId, range }: { fileId: string; range: DateRange }) {
  const [granularity, setGranularity] = useState<Granularity>('MONTH');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [metric, setMetric] = useState<Metric>('expense');
  const r = useReport<TimeseriesData>(fileId, 'timeseries', { from: range.from, to: range.to, granularity, groupBy });

  // The user's picks belong to the split they were made for: changing "Split by" (or Reset) falls
  // back to the defaults (top groups by total). Range, metric and interval changes keep them.
  const [custom, setCustom] = useState<{ groupBy: GroupBy; picks: Picks } | null>(null);
  const groups = useMemo(() => (r.data ? groupTotals(r.data.data, metric) : []), [r.data, metric]);
  const picks = useMemo<Picks>(
    () =>
      custom?.groupBy === groupBy
        ? custom.picks
        : new Map(groups.slice(0, DEFAULT_PICKS).map((g, i) => [g.id, { slot: i, name: g.name }])),
    [custom, groupBy, groups],
  );
  const toggle = (g: Group) => {
    const next = new Map(picks);
    if (next.has(g.id)) next.delete(g.id);
    else {
      const used = new Set([...next.values()].map((p) => p.slot));
      const slot = SERIES.findIndex((_, i) => !used.has(i));
      if (slot < 0) return;
      next.set(g.id, { slot, name: g.name });
    }
    setCustom({ groupBy, picks: next });
  };

  const view = useMemo(() => {
    if (!r.data) return null;
    const v = shape(r.data.data, metric, groups, picks);
    return { ...v, rows: withAverage(v) };
  }, [r.data, metric, groups, picks]);

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
        <label>
          Split by{' '}
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="none">Nothing (income vs expense)</option>
            <option value="category">Category</option>
            <option value="account">Account</option>
          </select>
        </label>
        {groupBy !== 'none' && (
          <label>
            Show{' '}
            <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </label>
        )}
      </div>
      {r.error && <ErrorBox error={r.error} />}
      {!r.data && !r.error && <p className="muted">Loading…</p>}
      {r.data && view && (
        <>
          <Unconverted list={r.data.data.unconverted} />
          <div className="chart" role="img" aria-label={`${view.title} per ${granularity.toLowerCase()}`}>
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
                    view.stacked && payload?.[0]
                      ? `${label} · ${fmtMoney(rowTotal(payload[0].payload, view), r.data!.baseCurrency)}`
                      : label
                  }
                  formatter={(v, _name, item) =>
                    view.stacked
                      ? `${fmtMoney(Number(v), r.data!.baseCurrency)} (${fmtPct(Number(v), rowTotal(item.payload, view))})`
                      : fmtMoney(Number(v), r.data!.baseCurrency)
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
                    stroke={view.stacked ? 'var(--card)' : undefined}
                    strokeWidth={view.stacked ? 2 : 0}
                    radius={!view.stacked || i === view.series.length - 1 ? [4, 4, 0, 0] : 0}
                    isAnimationActive={false}
                  >
                    {/* The trailing average bar is dimmed so it reads as a summary, not a period. */}
                    {view.rows.map((row) => (
                      <Cell key={row.bucket as string} fillOpacity={row.bucket === AVG_BUCKET ? 0.55 : 1} />
                    ))}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          {view.stacked && (
            <PickLegend groups={groups} picks={picks} base={r.data.baseCurrency} onToggle={toggle} onReset={() => setCustom(null)} />
          )}
          {/* Table view: the accessible/precise counterpart of the chart. */}
          <details>
            <summary>Show as table</summary>
            <div className="scroll">
              <table className="grid">
                <thead>
                  <tr><th>Period</th>{view.series.map((s) => <th key={s.key} className="num">{s.label}</th>)}</tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.bucket as string}>
                      <td>{row.bucket}</td>
                      {view.series.map((s) => <td key={s.key} className="num">{fmtMoney(Number(row[s.key] ?? 0), r.data!.baseCurrency)}</td>)}
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
function groupTotals(d: TimeseriesData, metric: Metric): Group[] {
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

/** Pivot API points into chart rows. Grouped views show the picked groups and fold the rest into "Other". */
function shape(d: TimeseriesData, metric: Metric, groups: Group[], picks: Picks): View {
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

  const rowsByBucket = new Map<string, Record<string, string | number>>();
  for (const p of d.points) {
    const row = rowsByBucket.get(p.bucket) ?? { bucket: p.bucket };
    const id = p.groupId ?? '?';
    const key = picks.has(id) ? id : '__other';
    row[key] = Number(row[key] ?? 0) + p[metric];
    rowsByBucket.set(p.bucket, row);
  }

  // Largest picked group sits at the bottom of the stack; "Other" caps it.
  const series = groups
    .filter((g) => picks.has(g.id))
    .map((g) => ({ key: g.id, label: g.name, color: SERIES[picks.get(g.id)!.slot]! }));
  if (groups.some((g) => !picks.has(g.id))) series.push({ key: '__other', label: 'Other', color: 'var(--viz-muted)' });

  return {
    title: metric === 'expense' ? 'Expense' : 'Income',
    stacked: true,
    series,
    rows: [...rowsByBucket.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket))),
  };
}

const AVG_BUCKET = 'Average';

/** Appends one row holding each shown series' mean over the displayed periods (empty periods count as 0). */
function withAverage(view: View): View['rows'] {
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

/** Checkbox legend for grouped views: checked groups get their own color, unchecked ones fold into "Other". */
function PickLegend({ groups, picks, base, onToggle, onReset }: {
  groups: Group[];
  picks: Picks;
  base: string;
  onToggle: (g: Group) => void;
  onReset: () => void;
}) {
  // Picks survive range changes, so a picked group may have nothing in this range; keep it listed
  // (at zero) so it can still be unchecked and its color slot freed.
  const active = new Set(groups.map((g) => g.id));
  const idle = [...picks].filter(([id]) => !active.has(id)).map(([id, p]) => ({ id, name: p.name, total: 0 }));
  const items = [...groups, ...idle];
  if (!items.length) return null;
  const full = picks.size >= SERIES.length;
  const other = groups.filter((g) => !picks.has(g.id)).reduce((sum, g) => sum + g.total, 0);
  const whole = groups.reduce((sum, g) => sum + g.total, 0);
  return (
    <fieldset className="pick-legend">
      <legend>
        Shown in chart ({picks.size}/{SERIES.length}) <button className="link" onClick={onReset}>Reset</button>
      </legend>
      {full && <p className="muted">All {SERIES.length} colors are in use. Uncheck one to add another.</p>}
      <ul>
        {items.map((g) => {
          const slot = picks.get(g.id)?.slot;
          return (
            <li key={g.id}>
              <label>
                <input
                  type="checkbox"
                  checked={slot !== undefined}
                  disabled={slot === undefined && full}
                  onChange={() => onToggle(g)}
                  style={slot !== undefined ? { accentColor: SERIES[slot] } : undefined}
                />
                <span className="name">{g.name}</span>
                <span className="num muted">{fmtMoney(g.total, base)}</span>
                <span className="num pct">{fmtPct(g.total, whole)}</span>
              </label>
            </li>
          );
        })}
        {other > 0 && (
          <li>
            <label>
              <span className="swatch" aria-hidden />
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
