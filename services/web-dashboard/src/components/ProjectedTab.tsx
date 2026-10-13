import { useMemo, useState, type ReactNode } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CursorValue } from './CursorValue';
import type { Granularity, PlannedData, ProjectionData } from '@ivy/contracts';
import { useReport } from '../api/hooks';
import { useParams } from '../state/params';
import { ErrorBox } from './ErrorBox';
import { SERIES, Unconverted, type DateRange } from './FlowReports';
import { fmtMoney, fmtPct, offsetMs } from '../format';

const OTHER = '__other';
const MAX_NAMED = SERIES.length - 1; // last palette slot is held back for "Other"
const NET_WORTH = 'netWorth';
const NW_ACTUAL = 'nwActual'; // solid line through history
const NW_AHEAD = 'nwAhead'; // dashed line from the last actual point on
/** Key prefix for the part of a bar that is the average carried forward; drawn dimmed on top of the actual part. */
const AHEAD = '~';
const DIM = 0.45;
const WINDOWS = [3, 4, 6, 12] as const;
const UNIT: Record<Granularity, string> = { DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

type Kind = 'income' | 'expense';
type Mode = 'planned' | 'average';

interface Series {
  key: string; // "income:<id>" / "expense:<id>", unique across both kinds
  kind: Kind;
  label: string;
  color: string;
  total: number;
}

/** Expenses are stored negative so they stack below the zero line. */
type Row = { bucket: string; [NET_WORTH]: number } & Record<string, string | number>;

interface View {
  income: Series[];
  expense: Series[];
  rows: Row[];
}

/** As in every tab: a transfer to or from an excluded account is income or expense; nothing else on those accounts is. */
const IN = 'Income';
const OUT = 'Expense';

/** Biggest category at the bottom of its stack; overflow past the palette folds into a muted "Other". */
function rankSeries(kind: Kind, totals: Map<string, number>, names: Map<string, string>): Series[] {
  const ranked = [...totals].map(([id, total]) => ({ id, total })).sort((a, b) => b.total - a.total);
  const named = ranked.length > SERIES.length ? ranked.slice(0, MAX_NAMED) : ranked;
  const out: Series[] = named.map((c, i) => ({ key: `${kind}:${c.id}`, kind, label: names.get(c.id) ?? c.id, color: SERIES[i]!, total: c.total }));
  const rest = ranked.slice(named.length);
  if (rest.length)
    out.push({ key: `${kind}:${OTHER}`, kind, label: `Other (${rest.length})`, color: 'var(--viz-muted)', total: rest.reduce((s, c) => s + c.total, 0) });
  return out;
}

/** Adds per-category amounts to `row` under their series keys, after `prefix`. */
function addAmounts(row: Row, kind: Kind, amounts: Record<string, number>, known: Set<string>, prefix = '') {
  for (const [id, v] of Object.entries(amounts)) {
    const key = prefix + (known.has(`${kind}:${id}`) ? `${kind}:${id}` : `${kind}:${OTHER}`);
    row[key] = Number(row[key] ?? 0) + (kind === 'expense' ? -v : v);
  }
}

function shapePlanned(d: PlannedData): View {
  const names = new Map(d.categories.map((c) => [c.id, c.name]));
  const totals = (kind: Kind) => {
    const m = new Map<string, number>();
    for (const b of d.buckets) for (const [id, v] of Object.entries(b[kind])) m.set(id, (m.get(id) ?? 0) + v);
    return m;
  };
  const income = rankSeries('income', totals('income'), names);
  const expense = rankSeries('expense', totals('expense'), names);
  const known = new Set([...income, ...expense].map((s) => s.key));

  const rows: Row[] = d.buckets.map((b) => {
    const row: Row = { bucket: b.bucket, [NET_WORTH]: b.netWorth };
    addAmounts(row, 'income', b.income, known);
    addAmounts(row, 'expense', b.expense, known);
    return row;
  });
  return { income, expense, rows };
}

/** Series are the flows (categories and transfers), ranked by (and totalling) the per-bucket average the projection runs on. */
function shapeAverage(d: ProjectionData): View {
  const names = new Map(d.categories.map((c) => [c.id, c.name]));
  const totals = (kind: Kind, average: Record<string, number>) => {
    const m = new Map(Object.entries(average));
    // A flow executed from today on but not in the average still needs a series.
    for (const b of d.buckets) for (const id of Object.keys(b[kind])) if (!m.has(id)) m.set(id, 0);
    return m;
  };
  const income = rankSeries('income', totals('income', d.averageIncome), names);
  const expense = rankSeries('expense', totals('expense', d.averageExpense), names);
  const known = new Set([...income, ...expense].map((s) => s.key));

  let lastActual = -1;
  d.buckets.forEach((b, i) => b.phase === 'actual' && (lastActual = i));
  const rows: Row[] = d.buckets.map((b, i) => {
    const row: Row = { bucket: b.bucket, phase: b.phase, [NET_WORTH]: b.netWorth };
    if (b.phase === 'actual') row[NW_ACTUAL] = b.netWorth;
    if (b.phase !== 'actual' || i === lastActual) row[NW_AHEAD] = b.netWorth; // dashed line picks up where history ends
    addAmounts(row, 'income', b.income, known);
    addAmounts(row, 'expense', b.expense, known);
    addAmounts(row, 'income', b.projectedIncome, known, AHEAD);
    addAmounts(row, 'expense', b.projectedExpense, known, AHEAD);
    return row;
  });
  return { income, expense, rows };
}

/** Smallest "nice" step (1, 2, 2.5 or 5 × 10^k) that is at least `raw`. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
}

const FLOW_INTERVALS = 6; // target grid intervals for the bars
const LINE_INTERVALS = 5; // most grid intervals the net worth band may use
const ROW_PX = 36; // height of one grid interval

/**
 * Stacked layout on one shared grid: the bars sit in the lower band, and the net worth line gets its own
 * band above the tallest income bar, so it always reads in the positive area of both axes. Each axis uses
 * its own nice step; the left axis only shows ticks inside the line's band.
 */
function chartLayout({ rows, income, expense }: View) {
  const up = Math.max(0, ...rows.map((r) => sideTotal(r, income)));
  const down = Math.max(0, ...rows.map((r) => sideTotal(r, expense)));
  const fs = niceStep((up + down) / FLOW_INTERVALS);
  const below = Math.ceil(down / fs);
  const above = Math.max(1, Math.ceil(up / fs));

  const values = rows.map((r) => r[NET_WORTH]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // Grow the step until the whole line fits in LINE_INTERVALS, starting from the finest that could.
  let ns = niceStep((hi - lo) / LINE_INTERVALS || Math.abs(hi) / 10 || 1);
  while (Math.ceil(hi / ns) - Math.floor(lo / ns) > LINE_INTERVALS) ns = niceStep(ns * 1.01);
  const nlo = Math.floor(lo / ns) * ns;
  const band = Math.max(2, Math.ceil(hi / ns) - Math.floor(lo / ns));

  const total = below + above + band;
  const range = (from: number, n: number, step: number) => Array.from({ length: n + 1 }, (_, i) => from + i * step);
  return {
    flow: { domain: [-below * fs, (above + band) * fs] as [number, number], ticks: range(-below * fs, below + above, fs) },
    grid: range(-below * fs, total, fs), // every grid line, in flow-axis values
    // Net worth's band starts at the grid line above the income bars.
    nw: { domain: [nlo - (below + above) * ns, nlo + band * ns] as [number, number], ticks: range(nlo, band, ns) },
    height: Math.max(280, total * ROW_PX),
  };
}

/** A series' bar in one row: the actual part plus the part carried forward from the average, as a positive amount. */
const amount = (row: Row, key: string) => Math.abs(Number(row[key] ?? 0)) + Math.abs(Number(row[AHEAD + key] ?? 0));
const sideTotal = (row: Row, series: Series[]) => series.reduce((s, x) => s + amount(row, x.key), 0);

function FlowTooltip({ active, payload, income, expense, base, head }: {
  active?: boolean;
  payload?: { payload: Row }[];
  income: Series[];
  expense: Series[];
  base: string;
  /** Lines under the period title; `net` is the row's income minus expense. */
  head: (row: Row, net: number) => ReactNode;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const inc = sideTotal(row, income);
  const exp = sideTotal(row, expense);
  const section = (title: string, series: Series[], total: number) => {
    const items = series.filter((s) => row[s.key] != null || row[AHEAD + s.key] != null).sort((a, b) => amount(row, b.key) - amount(row, a.key));
    if (!items.length) return null;
    return (
      <>
        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '6px 0' }} />
        <div style={{ fontWeight: 600 }}>{title} {fmtMoney(total, base)}</div>
        {items.map((s) => {
          const v = amount(row, s.key);
          return (
            <div key={s.key} style={{ display: 'flex', gap: 8 }}>
              <span style={{ width: 10, height: 10, marginTop: 5, borderRadius: 2, background: s.color }} aria-hidden />
              <span style={{ flex: 1 }}>{s.label}</span>
              <span>{fmtMoney(v, base)} ({fmtPct(v, total)})</span>
            </div>
          );
        })}
      </>
    );
  };
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--fg)', padding: '8px 12px', fontSize: 13, minWidth: 220 }}>
      <div style={{ fontWeight: 600 }}>{row.bucket}</div>
      {head(row, inc - exp)}
      {section(IN, income, inc)}
      {section(OUT, expense, exp)}
    </div>
  );
}

/** Income stacked above zero and expenses below (right axis), with net worth in its own band on top (left axis). */
function FlowChart({ view, base, label, head, lines, today }: {
  view: View;
  base: string;
  label: string;
  head: (row: Row, net: number) => ReactNode;
  lines: ReactNode[];
  /** Bucket holding today; marks it and draws the dimmed average-carried-forward parts of the bars. */
  today?: string;
}) {
  const layout = useMemo(() => chartLayout(view), [view]);
  const series = [...view.income, ...view.expense];
  const bar = (s: Series, key: string, opacity = 1) => (
    <Bar
      key={key}
      yAxisId="flow"
      dataKey={key}
      name={s.label}
      fill={s.color}
      fillOpacity={opacity}
      stackId={s.kind}
      stroke="var(--card)"
      strokeWidth={2}
      isAnimationActive={false}
    />
  );
  return (
    <div className="chart" style={{ height: layout.height }} role="img" aria-label={label}>
      <ResponsiveContainer>
        <ComposedChart data={view.rows} stackOffset="sign" barCategoryGap="20%" margin={{ left: 0, right: 0, top: today ? 18 : 5 }}>
          <CartesianGrid vertical={false} stroke="var(--viz-grid)" yAxisId="flow" horizontalValues={layout.grid} />
          <XAxis dataKey="bucket" tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" />
          {/* Left: net worth, in its own band above the bars. Right: flows, expenses below zero. */}
          <YAxis yAxisId="nw" orientation="left" width={72} tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" domain={layout.nw.domain} ticks={layout.nw.ticks} allowDataOverflow />
          <YAxis yAxisId="flow" orientation="right" width={72} tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" domain={layout.flow.domain} ticks={layout.flow.ticks} allowDataOverflow />
          <ReferenceLine yAxisId="flow" y={0} stroke="var(--viz-muted)" />
          {today && (
            <ReferenceLine yAxisId="flow" x={today} stroke="var(--viz-muted)" strokeDasharray="2 3" label={{ value: 'Today', position: 'top', fill: 'var(--viz-muted)', fontSize: 11 }} />
          )}
          <Tooltip cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }} content={<FlowTooltip income={view.income} expense={view.expense} base={base} head={head} />} />
          {series.map((s) => bar(s, s.key))}
          {/* After every actual part, so the dimmed parts sit at the outer end of each stack. */}
          {today && series.map((s) => bar(s, AHEAD + s.key, DIM))}
          {lines}
          <CursorValue base={base} yAxisId="nw" side="left" />
          <CursorValue base={base} yAxisId="flow" side="right" line={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function FlowTable({ view, base, basis }: { view: View; base: string; basis?: (row: Row) => string }) {
  return (
    <details>
      <summary>Show as table</summary>
      <div className="scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>Period</th>
              {basis && <th>Basis</th>}
              <th className="num">{IN}</th>
              <th className="num">{OUT}</th>
              <th className="num">Net worth</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.bucket}>
                <td>{row.bucket}</td>
                {basis && <td>{basis(row)}</td>}
                <td className="num">{fmtMoney(sideTotal(row, view.income), base)}</td>
                <td className="num">{fmtMoney(sideTotal(row, view.expense), base)}</td>
                <td className="num">{fmtMoney(row[NET_WORTH], base)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Projections lie ahead, so the default window is today through the next 12 months (not the past-looking shared range). */
function useFutureRange() {
  const { tz } = useParams();
  const [range, setRange] = useState<DateRange | null>(null);
  const today = new Date(Date.now() + offsetMs(tz));
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const ahead = (months: number): DateRange => {
    const end = new Date(t);
    end.setUTCMonth(end.getUTCMonth() + months);
    end.setUTCDate(end.getUTCDate() - 1);
    return { from: iso(t), to: iso(end.getTime()) };
  };
  return { range: range ?? ahead(12), setRange, ahead, today: iso(t) };
}

export function ProjectedTab({ fileId }: { fileId: string }) {
  const [mode, setMode] = useState<Mode>('planned');
  const [granularity, setGranularity] = useState<Granularity>('MONTH');
  const [lookback, setLookback] = useState<number>(4);
  const { range, setRange, ahead, today } = useFutureRange();

  return (
    <>
      <div className="controls">
        <label>
          Based on{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="planned">Planned items</option>
            <option value="average">Moving average</option>
          </select>
        </label>
        {/* The moving average always starts from today's balance. */}
        {mode === 'planned' && (
          <label>
            From <input type="date" value={range.from} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
          </label>
        )}
        <label>
          To <input type="date" value={range.to} min={mode === 'average' ? today : undefined} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
        </label>
        {([3, 6, 12, 24] as const).map((m) => (
          <button key={m} className="link" onClick={() => setRange(ahead(m))}>Next {m} months</button>
        ))}
        <label>
          Interval{' '}
          <select value={granularity} onChange={(e) => setGranularity(e.target.value as Granularity)}>
            <option value="DAY">Day</option>
            <option value="WEEK">Week (Mon)</option>
            <option value="MONTH">Month</option>
            <option value="YEAR">Year</option>
          </select>
        </label>
        {mode === 'average' && (
          <label>
            Average over{' '}
            <select value={lookback} onChange={(e) => setLookback(Number(e.target.value))}>
              {WINDOWS.map((n) => (
                <option key={n} value={n}>last {plural(n, UNIT[granularity])}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {mode === 'planned' ? (
        <PlannedProjection fileId={fileId} range={range} granularity={granularity} />
      ) : (
        <AverageProjection fileId={fileId} to={range.to} granularity={granularity} lookback={lookback} />
      )}
    </>
  );
}

function PlannedProjection({ fileId, range, granularity }: { fileId: string; range: DateRange; granularity: Granularity }) {
  const r = useReport<PlannedData>(fileId, 'planned', { from: range.from, to: range.to, granularity });
  const view = useMemo(() => (r.data ? shapePlanned(r.data.data) : null), [r.data]);

  if (r.error) return <ErrorBox error={r.error} />;
  const last = r.data?.data.buckets.at(-1);
  if (!r.data || !view || !last) return <p className="muted">Loading…</p>;
  const base = r.data.baseCurrency;
  const incomeTotal = view.income.reduce((s, x) => s + x.total, 0);
  const expenseTotal = view.expense.reduce((s, x) => s + x.total, 0);

  return (
    <>
      <Unconverted list={r.data.data.unconverted} />
      <p className="budget-sum">
        Planned income {fmtMoney(incomeTotal, base)} and expense {fmtMoney(expenseTotal, base)}: net worth goes from{' '}
        {fmtMoney(r.data.data.startingNetWorth, base)} to {fmtMoney(last.netWorth, base)}. Overdue planned items are assumed to happen on their due date.
      </p>
      {!view.income.length && !view.expense.length && <p className="muted">No planned income or expenses fall in this range.</p>}
      <p className="muted" style={{ margin: '0 0 4px', fontSize: 12 }}>
        Line: projected net worth (left axis, top band). Bars: planned income above zero, expenses below (right axis). As in every tab,
        income and expense on accounts excluded from the balance are left out, a transfer to or from one counts under its category (or
        its two accounts if it has none), and transfers between included accounts never count.
      </p>
      <FlowChart
        view={view}
        base={base}
        label={`Planned income and expenses per ${UNIT[granularity]} with projected net worth`}
        head={(row, net) => (
          <>
            <div>Projected net worth {fmtMoney(row[NET_WORTH], base)}</div>
            <div className="muted">Planned net {fmtMoney(net, base)}</div>
          </>
        )}
        lines={[
          <Line key="nw" yAxisId="nw" dataKey={NET_WORTH} name="Projected net worth" type="natural" stroke="var(--fg)" strokeWidth={2} dot={{ r: 3, fill: 'var(--fg)' }} isAnimationActive={false} />,
        ]}
      />
      <CategoryLegend title="Planned income" series={view.income} total={incomeTotal} base={base} />
      <CategoryLegend title="Planned expenses" series={view.expense} total={expenseTotal} base={base} />
      <FlowTable view={view} base={base} />
    </>
  );
}

/** Executed transactions can sit in any bucket from today on, dated ahead; the average only tops them up. */
const hasExecuted = (row: Row, view: View) => [...view.income, ...view.expense].some((s) => row[s.key] != null);
const basisOf = (row: Row, view: View) =>
  row.phase === 'actual' ? 'Actual' : hasExecuted(row, view) ? 'Executed, topped up to the average' : 'Average';

function AverageProjection({ fileId, to, granularity, lookback }: { fileId: string; to: string; granularity: Granularity; lookback: number }) {
  const r = useReport<ProjectionData>(fileId, 'projection', { to, granularity, window: String(lookback) });
  const view = useMemo(() => (r.data ? shapeAverage(r.data.data) : null), [r.data]);

  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data || !view) return <p className="muted">Loading…</p>;
  const base = r.data.baseCurrency;
  const d = r.data.data;
  const unit = UNIT[granularity];
  const used = d.buckets.filter((b) => b.phase === 'actual');
  const current = d.buckets.find((b) => b.phase === 'current');
  const last = d.buckets.at(-1);
  const incomeAvg = view.income.reduce((s, x) => s + x.total, 0);
  const expenseAvg = view.expense.reduce((s, x) => s + x.total, 0);

  return (
    <>
      <Unconverted list={d.unconverted} />
      <p className="budget-sum">
        {d.windowUsed ? (
          <>
            Averaging the last {plural(d.windowUsed, `complete ${unit}`)} ({used[0]!.bucket}
            {used.length > 1 && ` to ${used.at(-1)!.bucket}`}): income {fmtMoney(incomeAvg, base)}, expense {fmtMoney(expenseAvg, base)}, net{' '}
            {fmtMoney(incomeAvg - expenseAvg, base)} per {unit}. From today's net worth of {fmtMoney(d.currentNetWorth, base)}, the projection reaches{' '}
            {fmtMoney(last?.netWorth ?? d.currentNetWorth, base)} by {to}.
            {d.windowUsed < d.window && ` Only ${plural(d.windowUsed, `complete ${unit}`)} of history exist, so the average uses those.`}
          </>
        ) : (
          <>
            There is no complete {unit} of history before today to average, so only executed transactions move the projection from
            today's net worth of {fmtMoney(d.currentNetWorth, base)}.
          </>
        )}
      </p>
      <p className="muted" style={{ margin: '0 0 4px', fontSize: 12 }}>
        Line: net worth, solid where actual and dashed where projected (left axis, top band). Bars: income above zero, expenses below
        (right axis). Solid parts are executed transactions, including any dated after today, whatever their planned date. Dimmed parts
        top each category up to its average, never below what is already executed. As in every tab, income and expense on accounts
        excluded from the balance are left out, a transfer to or from one counts under its category (or its two accounts if it has
        none), and transfers between included accounts never count. Planned items are not added, since recurring ones are already in the
        history.
      </p>
      <FlowChart
        view={view}
        base={base}
        label={`Net worth projected from the average income and expense of the last ${plural(d.windowUsed, unit)}`}
        today={current?.bucket}
        head={(row, net) =>
          row.phase === 'actual' ? (
            <>
              <div>Net worth {fmtMoney(row[NET_WORTH], base)}</div>
              <div className="muted">Net {fmtMoney(net, base)}</div>
            </>
          ) : (
            <>
              <div>Projected net worth {fmtMoney(row[NET_WORTH], base)}</div>
              {row.phase === 'current' && <div className="muted">Today {fmtMoney(d.currentNetWorth, base)}</div>}
              <div className="muted">{hasExecuted(row, view) ? 'Executed + rest of average' : 'Average'} net {fmtMoney(net, base)}</div>
            </>
          )
        }
        lines={[
          <Line
            key="ahead"
            yAxisId="nw"
            dataKey={NW_AHEAD}
            name="Projected net worth"
            type="linear"
            stroke="var(--fg)"
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={{ r: 3, fill: 'var(--card)', stroke: 'var(--fg)', strokeWidth: 1.5 }}
            isAnimationActive={false}
          />,
          <Line key="actual" yAxisId="nw" dataKey={NW_ACTUAL} name="Net worth" type="natural" stroke="var(--fg)" strokeWidth={2} dot={{ r: 3, fill: 'var(--fg)' }} isAnimationActive={false} />,
        ]}
      />
      <CategoryLegend title={`Average income per ${unit}`} series={view.income} total={incomeAvg} base={base} />
      <CategoryLegend title={`Average expenses per ${unit}`} series={view.expense} total={expenseAvg} base={base} />
      <FlowTable view={view} base={base} basis={(row) => basisOf(row, view)} />
    </>
  );
}

function CategoryLegend({ title, series, total, base }: { title: string; series: Series[]; total: number; base: string }) {
  if (!series.length) return null;
  return (
    <fieldset className="pick-legend">
      <legend>{title} · {fmtMoney(total, base)}</legend>
      <ul>
        {series.map((s) => (
          <li key={s.key}>
            <span className="pick-item">
              <span className="swatch solid" style={{ ['--c' as string]: s.color }} aria-hidden />
              <span className="name" title={s.label}>{s.label}</span>
              <span className="num muted">{fmtMoney(s.total, base)}</span>
              <span className="num pct">{fmtPct(s.total, total)}</span>
            </span>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
