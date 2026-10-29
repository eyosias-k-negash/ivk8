import { useMemo, useState } from 'react';
import type { GroupBy, TimeseriesData } from '@ivy/contracts';
import { useReport } from '../api/hooks';
import { useParams } from '../state/params';
import { PrintButton, rangeText } from '../print';
import { ErrorBox } from './ErrorBox';
import { FlowChart, FlowTable, Kpi, PickLegend, SplitControls, Unconverted, groupTotals, shape, usePicks, withAverage, type DateRange, type Metric } from './FlowReports';
import { fmtMoney } from '../format';
import { PATTERNS, foldTrend, type Aggregate, type Pattern, type Trend } from '../trends';

/** What one bar is, in words, per pattern. */
const HINTS: Record<Pattern, string> = {
  monthOfYear: 'Jan is every January in the range together, and so on.',
  weekOfYear: "W1 is every ISO week 1 in the range together. Weeks start on Monday, and a few late-December days belong to the next year's W1.",
  dayOfYear: 'Jan 1 is every January 1st in the range together. Feb 29 only occurs in leap years.',
  weekOfMonth: 'Weeks here are fixed spans of days: 1st is days 1–7 of every month in the range together. The 5th is only 1 to 3 days long.',
  dayOfMonth: '1st is the first day of every month in the range together. The 29th to 31st are missing from some months.',
  dayOfWeek: 'Mon is every Monday in the range together, and so on.',
};

const AGGREGATE_LABEL: Record<Aggregate, string> = { total: 'Totals', average: 'Average per occurrence' };

export function TrendsTab({ fileId, range }: { fileId: string; range: DateRange }) {
  const { tz } = useParams();
  const [pattern, setPattern] = useState<Pattern>('monthOfYear');
  const [aggregate, setAggregate] = useState<Aggregate>('total');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [metric, setMetric] = useState<Metric>('expense');
  const spec = PATTERNS[pattern];
  const r = useReport<TimeseriesData>(fileId, 'timeseries', { from: range.from, to: range.to, granularity: spec.granularity, groupBy });

  // While another pattern loads, the previous answer is at the old granularity; folding it would mislabel months as days.
  const trend = useMemo(
    () => (r.data && r.data.data.granularity === spec.granularity ? foldTrend(r.data.data, pattern, tz, aggregate) : null),
    [r.data, spec.granularity, pattern, tz, aggregate],
  );
  // Legend figures are what each group moved over the range, whatever the bars aggregate.
  const groups = useMemo(() => (r.data ? groupTotals(r.data.data, metric) : []), [r.data, metric]);
  const { picks, showOther, toggle, toggleOther, reset } = usePicks(groups, groupBy);

  const view = useMemo(() => {
    if (!trend) return null;
    const v = shape(trend.data, metric, groups, picks, showOther, trend.slots);
    return { ...v, rows: withAverage(v) };
  }, [trend, metric, groups, picks, showOther]);

  const unit = spec.unit;
  return (
    <>
      <div className="controls">
        <label>
          Period{' '}
          <select value={pattern} onChange={(e) => setPattern(e.target.value as Pattern)}>
            {(Object.keys(PATTERNS) as Pattern[]).map((p) => (
              <option key={p} value={p}>{PATTERNS[p].label}</option>
            ))}
          </select>
        </label>
        <label>
          Bars show{' '}
          <select value={aggregate} onChange={(e) => setAggregate(e.target.value as Aggregate)}>
            {(Object.keys(AGGREGATE_LABEL) as Aggregate[]).map((a) => (
              <option key={a} value={a}>{AGGREGATE_LABEL[a]}</option>
            ))}
          </select>
        </label>
        <SplitControls groupBy={groupBy} onGroupBy={setGroupBy} metric={metric} onMetric={setMetric} />
        <PrintButton
          tab="Trends"
          title={`${view?.title ?? 'Trends'}: ${spec.label.toLowerCase()}`}
          meta={[rangeText(range), AGGREGATE_LABEL[aggregate], groupBy === 'none' ? '' : `Split by ${groupBy} (${metric})`]}
        />
      </div>
      {r.error && <ErrorBox error={r.error} />}
      {!view && !r.error && <p className="muted">Loading…</p>}
      {r.data && trend && view && (
        <>
          <Unconverted list={r.data.data.unconverted} />
          <TrendKpis trend={trend} base={r.data.baseCurrency} metric={groupBy === 'none' ? null : metric} unit={unit} aggregate={aggregate} />
          <FlowChart view={view} base={r.data.baseCurrency} label={`${view.title}, ${spec.label.toLowerCase()}`} />
          {view.stacked && (
            <PickLegend
              groups={groups}
              picks={picks}
              base={r.data.baseCurrency}
              showOther={showOther}
              onToggleOther={toggleOther}
              onToggle={toggle}
              onReset={reset}
            />
          )}
          <p className="muted">
            {HINTS[pattern]}{' '}
            {aggregate === 'total'
              ? 'Bars are totals, so one that occurs more often in the range has a head start; “Average per occurrence” evens that out.'
              : 'Each bar is its total divided by how many times it occurs in the range; a partly covered month or week counts once.'}{' '}
            Parts of the calendar the range never reaches are left out.
          </p>
          <FlowTable view={view} base={r.data.baseCurrency} head={unit[0]!.toUpperCase() + unit.slice(1)} />
        </>
      )}
    </>
  );
}

/**
 * The extremes of the chart, all groups together (picks do not matter). With no split (`metric` null), the range's
 * income, expense and net, then the costliest slot.
 */
function TrendKpis({ trend, base, metric, unit, aggregate }: { trend: Trend; base: string; metric: Metric | null; unit: string; aggregate: Aggregate }) {
  const perSlot = new Map(trend.slots.map((s) => [s, { income: 0, expense: 0 }]));
  for (const p of trend.data.points) {
    const b = perSlot.get(p.bucket);
    if (!b) continue;
    b.income += p.income;
    b.expense += p.expense;
  }
  const slots = [...perSlot];
  const n = slots.length;
  const pick = (m: Metric, better: (a: number, b: number) => boolean) =>
    slots.reduce<{ slot: string; value: number } | null>((best, [slot, b]) => (!best || better(b[m], best.value) ? { slot, value: b[m] } : best), null);
  const money = (v: number) => `${fmtMoney(v, base)}${aggregate === 'average' ? ' on average' : ''}`;

  if (!metric) {
    const peak = pick('expense', (a, b) => a > b);
    return (
      <div className="kpis">
        <Kpi label="Income" value={fmtMoney(trend.income, base)} />
        <Kpi label="Expense" value={fmtMoney(trend.expense, base)} />
        <Kpi label="Net" value={fmtMoney(trend.income - trend.expense, base)} />
        {peak && peak.value > 0 && <Kpi label={`Costliest ${unit}`} value={peak.slot} note={money(peak.value)} />}
      </div>
    );
  }
  const high = pick(metric, (a, b) => a > b);
  const low = pick(metric, (a, b) => a < b);
  const mean = n ? slots.reduce((s, [, b]) => s + b[metric], 0) / n : 0;
  return (
    <div className="kpis">
      <Kpi label={`Total ${metric}`} value={fmtMoney(metric === 'expense' ? trend.expense : trend.income, base)} />
      {high && high.value > 0 && <Kpi label={`Highest ${unit}`} value={high.slot} note={money(high.value)} />}
      {low && n > 1 && <Kpi label={`Lowest ${unit}`} value={low.slot} note={money(low.value)} />}
      <Kpi label={`Average ${unit}`} value={fmtMoney(mean, base)} note={`mean of the ${n} bar${n === 1 ? '' : 's'}`} />
    </div>
  );
}
