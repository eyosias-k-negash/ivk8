import { useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CursorValue } from './CursorValue';
import type { Granularity, PlannedData } from '@ivy/contracts';
import { useReport } from '../api/hooks';
import { useParams } from '../state/params';
import { ErrorBox } from './ErrorBox';
import { SERIES, Unconverted, type DateRange } from './FlowReports';
import { fmtMoney, fmtPct, offsetMs } from '../format';

const OTHER = '__other';
const MAX_NAMED = SERIES.length - 1; // last palette slot is held back for "Other"
const NET_WORTH = 'netWorth';

type Kind = 'income' | 'expense';

interface Series {
  key: string; // "income:<id>" / "expense:<id>", unique across both kinds
  kind: Kind;
  label: string;
  color: string;
  total: number;
}

/** Expenses are stored negative so they stack below the zero line. */
type Row = { bucket: string; [NET_WORTH]: number } & Record<string, string | number>;

function shape(d: PlannedData): { income: Series[]; expense: Series[]; rows: Row[] } {
  const names = new Map(d.categories.map((c) => [c.id, c.name]));

  const build = (kind: Kind): Series[] => {
    const totals = new Map<string, number>();
    for (const b of d.buckets) for (const [id, v] of Object.entries(b[kind])) totals.set(id, (totals.get(id) ?? 0) + v);
    // Biggest category at the bottom of its stack; overflow past the palette folds into a muted "Other".
    const ranked = [...totals].map(([id, total]) => ({ id, total })).sort((a, b) => b.total - a.total);
    const named = ranked.length > SERIES.length ? ranked.slice(0, MAX_NAMED) : ranked;
    const out: Series[] = named.map((c, i) => ({ key: `${kind}:${c.id}`, kind, label: names.get(c.id) ?? c.id, color: SERIES[i]!, total: c.total }));
    const rest = ranked.slice(named.length);
    if (rest.length)
      out.push({ key: `${kind}:${OTHER}`, kind, label: `Other (${rest.length})`, color: 'var(--viz-muted)', total: rest.reduce((s, c) => s + c.total, 0) });
    return out;
  };
  const income = build('income');
  const expense = build('expense');
  const known = new Set([...income, ...expense].map((s) => s.key));

  const rows: Row[] = d.buckets.map((b) => {
    const row: Row = { bucket: b.bucket, [NET_WORTH]: b.netWorth };
    for (const kind of ['income', 'expense'] as const)
      for (const [id, v] of Object.entries(b[kind])) {
        const key = known.has(`${kind}:${id}`) ? `${kind}:${id}` : `${kind}:${OTHER}`;
        row[key] = Number(row[key] ?? 0) + (kind === 'expense' ? -v : v);
      }
    return row;
  });
  return { income, expense, rows };
}

const sideTotal = (row: Row, series: Series[]) => series.reduce((s, x) => s + Math.abs(Number(row[x.key] ?? 0)), 0);

function PlannedTooltip({ active, payload, income, expense, base }: {
  active?: boolean;
  payload?: { payload: Row }[];
  income: Series[];
  expense: Series[];
  base: string;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const inc = sideTotal(row, income);
  const exp = sideTotal(row, expense);
  const section = (title: string, series: Series[], total: number) => {
    const items = series.filter((s) => row[s.key] != null).sort((a, b) => Math.abs(Number(row[b.key])) - Math.abs(Number(row[a.key])));
    if (!items.length) return null;
    return (
      <>
        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '6px 0' }} />
        <div style={{ fontWeight: 600 }}>{title} {fmtMoney(total, base)}</div>
        {items.map((s) => {
          const v = Math.abs(Number(row[s.key]));
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
      <div>Projected net worth {fmtMoney(row[NET_WORTH], base)}</div>
      <div className="muted">Planned net {fmtMoney(inc - exp, base)}</div>
      {section('Income', income, inc)}
      {section('Expense', expense, exp)}
    </div>
  );
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Planned items lie ahead, so the default window is today through the next 12 months (not the past-looking shared range). */
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
  return { range: range ?? ahead(12), setRange, ahead };
}

export function PlannedTab({ fileId }: { fileId: string }) {
  const [granularity, setGranularity] = useState<Granularity>('MONTH');
  const { range, setRange, ahead } = useFutureRange();
  const r = useReport<PlannedData>(fileId, 'planned', { from: range.from, to: range.to, granularity });
  const view = useMemo(() => (r.data ? shape(r.data.data) : null), [r.data]);

  const base = r.data?.baseCurrency ?? '';
  const incomeTotal = view ? view.income.reduce((s, x) => s + x.total, 0) : 0;
  const expenseTotal = view ? view.expense.reduce((s, x) => s + x.total, 0) : 0;
  const last = r.data?.data.buckets.at(-1);

  return (
    <>
      <div className="controls">
        <label>
          From <input type="date" value={range.from} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
        </label>
        <label>
          To <input type="date" value={range.to} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
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
      </div>
      {r.error && <ErrorBox error={r.error} />}
      {!r.data && !r.error && <p className="muted">Loading…</p>}
      {r.data && view && last && (
        <>
          <Unconverted list={r.data.data.unconverted} />
          <p className="budget-sum">
            Planned income {fmtMoney(incomeTotal, base)} and expense {fmtMoney(expenseTotal, base)}: net worth goes from{' '}
            {fmtMoney(r.data.data.startingNetWorth, base)} to {fmtMoney(last.netWorth, base)}. Overdue planned items are assumed to happen on their due date.
          </p>
          {!view.income.length && !view.expense.length && <p className="muted">No planned income or expenses fall in this range.</p>}
          <p className="muted" style={{ margin: '0 0 4px', fontSize: 12 }}>
            Line: projected net worth (left axis). Bars: planned income above zero, expenses below (right axis).
          </p>
          <div className="chart" role="img" aria-label={`Planned income and expenses per ${granularity.toLowerCase()} with projected net worth`}>
            <ResponsiveContainer>
              <ComposedChart data={view.rows} stackOffset="sign" barCategoryGap="20%" margin={{ left: 0, right: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                <XAxis dataKey="bucket" tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" />
                {/* Left: projected net worth. Right: planned flows, expenses below zero. Each has its own scale. */}
                <YAxis yAxisId="nw" orientation="left" width={72} tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" domain={['auto', 'auto']} />
                <YAxis yAxisId="flow" orientation="right" width={72} tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" />
                <ReferenceLine yAxisId="flow" y={0} stroke="var(--viz-muted)" />
                <Tooltip cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }} content={<PlannedTooltip income={view.income} expense={view.expense} base={base} />} />
                <CursorValue base={base} yAxisId="nw" side="left" />
                <CursorValue base={base} yAxisId="flow" side="right" line={false} />
                {[...view.income, ...view.expense].map((s) => (
                  <Bar
                    key={s.key}
                    yAxisId="flow"
                    dataKey={s.key}
                    name={s.label}
                    fill={s.color}
                    stackId={s.kind}
                    stroke="var(--card)"
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                ))}
                <Line yAxisId="nw" dataKey={NET_WORTH} name="Projected net worth" type="monotone" stroke="var(--fg)" strokeWidth={2} dot={{ r: 3, fill: 'var(--fg)' }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <PlannedLegend title="Planned income" series={view.income} total={incomeTotal} base={base} />
          <PlannedLegend title="Planned expenses" series={view.expense} total={expenseTotal} base={base} />
          <details>
            <summary>Show as table</summary>
            <div className="scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th className="num">Income</th>
                    <th className="num">Expense</th>
                    <th className="num">Net worth</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.bucket}>
                      <td>{row.bucket}</td>
                      <td className="num">{fmtMoney(sideTotal(row, view.income), base)}</td>
                      <td className="num">{fmtMoney(sideTotal(row, view.expense), base)}</td>
                      <td className="num">{fmtMoney(row[NET_WORTH], base)}</td>
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

function PlannedLegend({ title, series, total, base }: { title: string; series: Series[]; total: number; base: string }) {
  if (!series.length) return null;
  return (
    <fieldset className="pick-legend">
      <legend>{title} · {fmtMoney(total, base)}</legend>
      <ul>
        {series.map((s) => (
          <li key={s.key}>
            <span className="pick-item">
              <span className="swatch solid" style={{ ['--c' as string]: s.color }} aria-hidden />
              <span className="name">{s.label}</span>
              <span className="num muted">{fmtMoney(s.total, base)}</span>
              <span className="num pct">{fmtPct(s.total, total)}</span>
            </span>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
