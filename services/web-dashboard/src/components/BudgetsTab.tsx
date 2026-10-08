import { useId, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Customized, ResponsiveContainer, Tooltip, XAxis, YAxis, usePlotArea, useXAxisScale, useYAxisScale } from 'recharts';
import type { BudgetTimeseriesData, BudgetsData, Granularity } from '@ivy/contracts';
import { useReport } from '../api/hooks';
import { ErrorBox } from './ErrorBox';
import { SERIES, Unconverted, type DateRange } from './FlowReports';
import { fmtMoney, fmtPct } from '../format';

const AVG_BUCKET = 'Average';
const OTHER = '__other';
const MAX_NAMED = SERIES.length - 1; // the last palette slot is held back for "Other" when a budget has more categories

interface Series {
  key: string;
  label: string;
  color: string;
  total: number;
}

type Row = { bucket: string; threshold: number } & Record<string, string | number>;

/** Chart rows (one per period, then the dimmed average) and the legend series, from the API buckets. */
function shape(d: BudgetTimeseriesData): { series: Series[]; rows: Row[] } {
  const totals = new Map(d.budget.categories.map((c) => [c.id, 0]));
  for (const b of d.buckets) for (const [id, v] of Object.entries(b.spent)) totals.set(id, (totals.get(id) ?? 0) + v);

  // Biggest spender at the bottom of the stack. A budget with more categories than palette hues
  // keeps the biggest ones named and folds the rest into a muted "Other".
  const ranked = d.budget.categories.map((c) => ({ ...c, total: totals.get(c.id) ?? 0 })).sort((a, b) => b.total - a.total);
  const named = ranked.length > SERIES.length ? ranked.slice(0, MAX_NAMED) : ranked;
  const folded = new Set(ranked.slice(named.length).map((c) => c.id));
  const series: Series[] = named.map((c, i) => ({ key: c.id, label: c.name, color: SERIES[i]!, total: c.total }));
  if (folded.size)
    series.push({
      key: OTHER,
      label: `Other (${folded.size})`,
      color: 'var(--viz-muted)',
      total: ranked.slice(named.length).reduce((s, c) => s + c.total, 0),
    });

  const rows: Row[] = d.buckets.map((b) => {
    const row: Row = { bucket: b.bucket, threshold: b.threshold };
    for (const [id, v] of Object.entries(b.spent)) {
      const key = folded.has(id) ? OTHER : id;
      row[key] = Number(row[key] ?? 0) + v;
    }
    return row;
  });

  // Mean over the displayed periods (empty periods count as 0), like the Trends tab.
  const n = rows.length;
  if (n) {
    const avg: Row = { bucket: AVG_BUCKET, threshold: rows.reduce((s, r) => s + r.threshold, 0) / n };
    for (const s of series) avg[s.key] = rows.reduce((sum, r) => sum + Number(r[s.key] ?? 0), 0) / n;
    rows.push(avg);
  }
  return { series, rows };
}

const rowTotal = (row: Row, series: Series[]) => series.reduce((s, x) => s + Number(row[x.key] ?? 0), 0);

/**
 * Green below / red above each bar's own threshold, drawn behind the bars. Thresholds differ per
 * period (calendar-day scaling), so the zones are per-band rectangles rather than one horizontal line.
 */
function Zones({ rows, ceiling }: { rows: Row[]; ceiling: number }) {
  const uid = useId();
  const x = useXAxisScale();
  const y = useYAxisScale();
  const area = usePlotArea();
  if (!x || !y || !area) return null;
  const base = y(0);
  if (base == null) return null;
  const okId = `${uid}-ok`;
  const overId = `${uid}-over`;
  return (
    <g aria-hidden pointerEvents="none">
      <defs>
        {/* Green is strongest at the baseline, red strongest at the line, both fading away from it. */}
        <linearGradient id={okId} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="var(--zone-ok)" stopOpacity={0.05} />
          <stop offset="1" stopColor="var(--zone-ok)" stopOpacity={0.3} />
        </linearGradient>
        <linearGradient id={overId} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="var(--zone-over)" stopOpacity={0.3} />
          <stop offset="1" stopColor="var(--zone-over)" stopOpacity={0.04} />
        </linearGradient>
      </defs>
      {rows.map((r) => {
        const left = x(r.bucket, { position: 'start' });
        const right = x(r.bucket, { position: 'end' });
        const line = y(Math.min(r.threshold, ceiling));
        if (left == null || right == null || line == null) return null;
        const dim = r.bucket === AVG_BUCKET ? 0.6 : 1;
        return (
          <g key={r.bucket} opacity={dim}>
            <rect x={left} y={line} width={right - left} height={Math.max(base - line, 0)} fill={`url(#${okId})`} />
            <rect x={left} y={area.y} width={right - left} height={Math.max(line - area.y, 0)} fill={`url(#${overId})`} />
            <line x1={left} x2={right} y1={line} y2={line} stroke="var(--zone-over)" strokeWidth={1.5} strokeDasharray="4 3" />
          </g>
        );
      })}
    </g>
  );
}

function BudgetTooltip({ active, payload, series, base }: { active?: boolean; payload?: { payload: Row }[]; series: Series[]; base: string }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const total = rowTotal(row, series);
  const diff = row.threshold - total;
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--fg)', padding: '8px 12px', fontSize: 13 }}>
      <div style={{ fontWeight: 600 }}>{row.bucket}</div>
      <div>Spent {fmtMoney(total, base)} of {fmtMoney(row.threshold, base)}</div>
      <div style={{ color: diff < 0 ? 'var(--zone-over)' : 'var(--zone-ok)' }}>
        {diff < 0 ? `Over by ${fmtMoney(-diff, base)}` : `${fmtMoney(diff, base)} left`}
      </div>
      <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '6px 0' }} />
      {[...series]
        .filter((s) => Number(row[s.key] ?? 0) > 0)
        .sort((a, b) => Number(row[b.key]) - Number(row[a.key]))
        .map((s) => (
          <div key={s.key} style={{ display: 'flex', gap: 8 }}>
            <span style={{ width: 10, height: 10, marginTop: 5, borderRadius: 2, background: s.color }} aria-hidden />
            <span style={{ flex: 1 }}>{s.label}</span>
            <span>{fmtMoney(Number(row[s.key]), base)} ({fmtPct(Number(row[s.key]), total)})</span>
          </div>
        ))}
    </div>
  );
}

export function BudgetsTab({ fileId, range }: { fileId: string; range: DateRange }) {
  const [granularity, setGranularity] = useState<Granularity>('MONTH');
  const [picked, setPicked] = useState<string>();
  const list = useReport<BudgetsData>(fileId, 'budgets');
  const budgets = list.data?.data.budgets ?? [];
  // Fall back to the first budget until the user picks one (or when the picked one is gone).
  const budgetId = budgets.find((b) => b.id === picked)?.id ?? budgets[0]?.id;

  const r = useReport<BudgetTimeseriesData>(
    fileId,
    'budget-timeseries',
    { budgetId, from: range.from, to: range.to, granularity },
    !!budgetId,
  );
  const view = useMemo(() => (r.data && r.data.data.budget.id === budgetId ? shape(r.data.data) : null), [r.data, budgetId]);

  if (list.error) return <ErrorBox error={list.error} />;
  if (!list.data) return <p className="muted">Loading…</p>;
  if (!budgets.length) return <p className="muted">This backup has no budgets with categories. Budgets without categories are ignored.</p>;

  const base = list.data.baseCurrency;
  const periods = view ? view.rows.filter((x) => x.bucket !== AVG_BUCKET) : [];
  const ceiling = Math.max(0, ...(view?.rows ?? []).map((x) => Math.max(x.threshold, rowTotal(x, view!.series))));
  const grand = view ? view.series.reduce((s, x) => s + x.total, 0) : 0;
  const allowed = periods.reduce((s, x) => s + x.threshold, 0);

  return (
    <>
      <div className="controls">
        <label>
          Budget{' '}
          <select value={budgetId} onChange={(e) => setPicked(e.target.value)}>
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({fmtMoney(b.amount, base)} / month)</option>
            ))}
          </select>
        </label>
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
      {!view && !r.error && <p className="muted">Loading…</p>}
      {r.data && view && (
        <>
          <Unconverted list={r.data.data.unconverted} />
          <p className="budget-sum">
            Spent {fmtMoney(grand, base)} against {fmtMoney(allowed, base)} allotted over {periods.length} {granularity.toLowerCase()}
            {periods.length === 1 ? '' : 's'}
            {allowed > 0 && <> ({fmtPct(grand, allowed)})</>}.
          </p>
          <div className="chart" role="img" aria-label={`${r.data.data.budget.name} spending per ${granularity.toLowerCase()} against its budget`}>
            <ResponsiveContainer>
              <BarChart data={view.rows} barCategoryGap="20%">
                <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                <XAxis dataKey="bucket" tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" />
                <YAxis
                  tick={{ fill: 'var(--viz-muted)', fontSize: 12 }}
                  stroke="var(--viz-grid)"
                  width={72}
                  domain={[0, Math.ceil(ceiling * 1.1) || 1]}
                  allowDataOverflow
                />
                <Customized component={<Zones rows={view.rows} ceiling={Math.ceil(ceiling * 1.1) || 1} />} />
                <Tooltip cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }} content={<BudgetTooltip series={view.series} base={base} />} />
                {view.series.map((s, i) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    fill={s.color}
                    stackId="b"
                    stroke="var(--card)"
                    strokeWidth={2}
                    radius={i === view.series.length - 1 ? [4, 4, 0, 0] : 0}
                    isAnimationActive={false}
                  >
                    {/* The trailing average bar is dimmed so it reads as a summary, not a period. */}
                    {view.rows.map((row) => (
                      <Cell key={row.bucket} fillOpacity={row.bucket === AVG_BUCKET ? 0.55 : 1} />
                    ))}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <fieldset className="pick-legend">
            <legend>Budget categories</legend>
            <ul>
              {view.series.map((s) => (
                <li key={s.key}>
                  <span className="pick-item">
                    <span className="swatch solid" style={{ ['--c' as string]: s.color }} aria-hidden />
                    <span className="name">{s.label}</span>
                    <span className="num muted">{fmtMoney(s.total, base)}</span>
                    <span className="num pct">{fmtPct(s.total, grand)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </fieldset>
          <details>
            <summary>Show as table</summary>
            <div className="scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Period</th>
                    {view.series.map((s) => <th key={s.key} className="num">{s.label}</th>)}
                    <th className="num">Total</th>
                    <th className="num">Budget</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.bucket}>
                      <td>{row.bucket}</td>
                      {view.series.map((s) => <td key={s.key} className="num">{fmtMoney(Number(row[s.key] ?? 0), base)}</td>)}
                      <td className="num">{fmtMoney(rowTotal(row, view.series), base)}</td>
                      <td className="num">{fmtMoney(row.threshold, base)}</td>
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
