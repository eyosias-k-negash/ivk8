import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Granularity, GroupBy, SummaryData, TimeseriesData } from '@ivy/contracts';
import { useReport } from '../api/hooks';
import { useParams } from '../state/params';
import { ErrorBox } from './ErrorBox';
import { fmtMoney, offsetMs } from '../format';

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

function Unconverted({ list }: { list: string[] }) {
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

const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
const MAX_GROUPS = 7; // 7 hues + "Other" (muted) keeps the stack inside the validated 8-slot palette

export function TrendsTab({ fileId, range }: { fileId: string; range: DateRange }) {
  const [granularity, setGranularity] = useState<Granularity>('MONTH');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [metric, setMetric] = useState<'expense' | 'income'>('expense');
  const r = useReport<TimeseriesData>(fileId, 'timeseries', { from: range.from, to: range.to, granularity, groupBy });

  const view = useMemo(() => (r.data ? shape(r.data.data, metric) : null), [r.data, metric]);

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
            <select value={metric} onChange={(e) => setMetric(e.target.value as 'expense' | 'income')}>
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
                  formatter={(v) => fmtMoney(Number(v), r.data!.baseCurrency)}
                />
                {/* Text wears text tokens; the swatch beside it carries identity. */}
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span style={{ color: 'var(--fg)' }}>{v}</span>} />
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
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
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

/** Pivot API points into chart rows. Grouped views keep the top groups and fold the rest into "Other". */
function shape(d: TimeseriesData, metric: 'expense' | 'income'): View {
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

  const totals = new Map<string, { name: string; total: number }>();
  for (const p of d.points) {
    const id = p.groupId ?? '?';
    const t = totals.get(id) ?? { name: p.groupName ?? id, total: 0 };
    t.total += p[metric];
    totals.set(id, t);
  }
  const top = [...totals.entries()].filter(([, t]) => t.total > 0).sort((a, b) => b[1].total - a[1].total).slice(0, MAX_GROUPS);
  // Color follows the entity, not its rank: slots are assigned by stable id order among the shown groups.
  const shown = top.map(([id]) => id).sort();
  const hasOther = [...totals.entries()].some(([id, t]) => !shown.includes(id) && t.total > 0);

  const rowsByBucket = new Map<string, Record<string, string | number>>();
  for (const p of d.points) {
    const row = rowsByBucket.get(p.bucket) ?? { bucket: p.bucket };
    const key = p.groupId && shown.includes(p.groupId) ? p.groupId : '__other';
    row[key] = Number(row[key] ?? 0) + p[metric];
    rowsByBucket.set(p.bucket, row);
  }

  const series = shown.map((id, i) => ({ key: id, label: totals.get(id)!.name, color: SERIES[i]! }));
  if (hasOther) series.push({ key: '__other', label: 'Other', color: 'var(--viz-muted)' });

  return {
    title: metric === 'expense' ? 'Expense' : 'Income',
    stacked: true,
    series,
    rows: [...rowsByBucket.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket))),
  };
}
