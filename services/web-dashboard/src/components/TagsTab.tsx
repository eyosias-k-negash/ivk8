import { useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CursorValue } from './CursorValue';
import type { Granularity, TagTotal, TagsData } from '@ivy/contracts';
import { useReport } from '../api/hooks';
import { PrintButton, rangeText } from '../print';
import { ErrorBox } from './ErrorBox';
import {
  AverageControl, Kpi, SERIES, Unconverted, averageText, fade, highlighted, hoverList, hoverRow, periodsText, type DateRange,
} from './FlowReports';
import { fmtMoney, fmtPct } from '../format';
import type { AverageOver } from '../average';
import { AVG_BUCKET, OTHER_COMBOS, comboSlots, isCombo, rowTotal, shapeTags, type Metric, type TagRow, type TagSeries, type TagView } from '../tags';

const DEFAULT_PICKS = 5; // as in Breakdowns: leaves a few colors free for the user's own picks
const FOLDED_COLOR = 'var(--viz-muted)';

/**
 * Picked tag id -> palette slot (+ name, for a pick with nothing in the current range).
 * Slots stick to the tag, so toggling others never repaints it.
 */
type Picks = Map<string, { slot: number; name: string }>;
type Colored = TagSeries & { color: string };

export function TagsTab({ fileId, range }: { fileId: string; range: DateRange }) {
  const [granularity, setGranularity] = useState<Granularity>('MONTH');
  const [metric, setMetric] = useState<Metric>('expense');
  const [over, setOver] = useState<AverageOver>('all');
  const [hover, setHover] = useState<string | null>(null);
  const r = useReport<TagsData>(fileId, 'tags', { from: range.from, to: range.to, granularity });

  // Tags with money in the range for the shown metric, largest first.
  const ranked = useMemo(
    () => (r.data ? r.data.data.tags.filter((t) => t[metric] > 0).sort((a, b) => b[metric] - a[metric]) : []),
    [r.data, metric],
  );
  // Until the user picks, the top tags are shown. Picks then survive range, metric and interval changes.
  const [custom, setCustom] = useState<Picks | null>(null);
  const picks = useMemo<Picks>(
    () => custom ?? new Map(ranked.slice(0, DEFAULT_PICKS).map((t, i) => [t.id, { slot: i, name: t.name }])),
    [custom, ranked],
  );
  // Combination -> palette slot, kept between renders so a combination keeps its color while it stays on screen.
  const combos = useRef(new Map<string, number>());
  const toggle = (t: { id: string; name: string }) => {
    const next = new Map(picks);
    if (next.has(t.id)) next.delete(t.id);
    else {
      // Prefer a slot no combination holds, so adding a tag repaints nothing.
      const tags = new Set([...next.values()].map((p) => p.slot));
      const held = new Set(combos.current.values());
      let slot = SERIES.findIndex((_, i) => !tags.has(i) && !held.has(i));
      if (slot < 0) slot = SERIES.findIndex((_, i) => !tags.has(i));
      if (slot < 0) return;
      next.set(t.id, { slot, name: t.name });
    }
    setCustom(next);
  };

  // Combinations get the colors the picked tags leave free; any beyond that fold into one muted series.
  const view = useMemo(
    () => (r.data ? shapeTags(r.data.data, metric, new Set(picks.keys()), SERIES.length - picks.size, over) : null),
    [r.data, metric, picks, over],
  );
  const series = useMemo<Colored[]>(() => {
    if (!view) return [];
    const tagSlots = new Set([...picks.values()].map((p) => p.slot));
    const slots = comboSlots(combos.current, view.series.filter(isCombo).map((s) => s.key), tagSlots, SERIES.length);
    combos.current = slots;
    return view.series.map((s) => ({
      ...s,
      color: s.key === OTHER_COMBOS ? FOLDED_COLOR : SERIES[isCombo(s) ? slots.get(s.key)! : picks.get(s.key)!.slot]!,
    }));
  }, [view, picks]);

  const unit = granularity.toLowerCase();
  const divisor = view ? (over === 'active' ? view.active : view.periods) : 0;

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
          Show{' '}
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
        </label>
        <AverageControl value={over} onChange={setOver} unit={unit} />
        <PrintButton
          tab="Tags"
          title={`Tags: ${metric === 'expense' ? 'expense' : 'income'}`}
          meta={[rangeText(range), `Per ${unit}`, averageText(over, unit)]}
        />
      </div>
      {r.error && <ErrorBox error={r.error} />}
      {!r.data && !r.error && <p className="muted">Loading…</p>}
      {r.data && view && !r.data.data.tags.length && <p className="muted">This backup has no tags.</p>}
      {r.data && view && r.data.data.tags.length > 0 && (
        <>
          <Unconverted list={r.data.data.unconverted} />
          {!ranked.length && !picks.size && <p className="muted">No tagged {metric} in this range.</p>}
          {!picks.size && ranked.length > 0 && <p className="muted">Check one or more tags below to chart them together.</p>}
          {picks.size > 0 && (
            <>
              <div className="kpis">
                <Kpi label={`Total ${metric}`} value={fmtMoney(view.total, r.data.baseCurrency)} />
                <Kpi
                  label={`Average per ${unit}`}
                  value={fmtMoney(divisor ? view.total / divisor : 0, r.data.baseCurrency)}
                  note={`over ${periodsText(divisor, unit, over)}`}
                />
                <Kpi label="Transactions" value={String(view.count)} />
              </div>
              <TagChart view={view} series={series} base={r.data.baseCurrency} unit={unit} metric={metric} hover={hover} />
            </>
          )}
          <TagLegend
            tags={ranked}
            metric={metric}
            picks={picks}
            view={view}
            series={series}
            base={r.data.baseCurrency}
            onToggle={toggle}
            onReset={() => setCustom(null)}
            onClear={() => setCustom(new Map())}
            onHover={setHover}
          />
          <p className="muted" style={{ fontSize: 12 }}>
            Executed only; planned payments are not counted. A transaction carrying several of the checked tags counts once, in the
            segment for that combination (such as “A + B”), so overlaps stay visible and each bar adds up to what the checked tags actually{' '}
            {metric === 'expense' ? 'cost' : 'brought in'}. Amounts beside unchecked tags are each tag’s own total. As in every tab, income and expense on accounts excluded from the balance are
            left out, a transfer to or from one counts, and transfers between included accounts never count.
          </p>
          {picks.size > 0 && (
            <details>
              <summary>Show as table</summary>
              <div className="scroll">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Period</th>
                      {series.map((s) => <th key={s.key} className="num">{s.label}</th>)}
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.rows.map((row) => (
                      <tr key={row.bucket}>
                        <td>{row.bucket}</td>
                        {series.map((s) => <td key={s.key} className="num">{fmtMoney(Number(row[s.key] ?? 0), r.data!.baseCurrency)}</td>)}
                        <td className="num">{fmtMoney(rowTotal(row, series), r.data!.baseCurrency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </>
  );
}

function TagChart({ view, series, base, unit, metric, hover }: {
  view: TagView;
  series: Colored[];
  base: string;
  unit: string;
  metric: Metric;
  hover: string | null;
}) {
  // A hovered tag lights up its own segment and every combination carrying it: all of that tag's money.
  const lit = highlighted(series, hover, (s, id) => s.key === id || s.tagIds.includes(id));
  return (
    <div className="chart" role="img" aria-label={`${metric === 'expense' ? 'Expense' : 'Income'} of the checked tags per ${unit}`}>
      <ResponsiveContainer>
        <BarChart data={view.rows} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
          <XAxis dataKey="bucket" tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" />
          <YAxis tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" width={72} />
          <Tooltip cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }} content={<TagTooltip series={series} base={base} unit={unit} />} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={s.color}
              stackId="t"
              stroke="var(--card)"
              strokeWidth={2}
              radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
            >
              {/* The trailing average bar is dimmed so it reads as a summary, not a period. */}
              {view.rows.map((row) => (
                <Cell key={row.bucket} fillOpacity={(row.bucket === AVG_BUCKET ? 0.55 : 1) * fade(lit, s.key)} />
              ))}
            </Bar>
          ))}
          <CursorValue base={base} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TagTooltip({ active, payload, series, base, unit }: {
  active?: boolean;
  payload?: { payload: TagRow }[];
  series: Colored[];
  base: string;
  unit: string;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const total = rowTotal(row, series);
  const items = series.filter((s) => Number(row[s.key] ?? 0) > 0).sort((a, b) => Number(row[b.key]) - Number(row[a.key]));
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--fg)', padding: '8px 12px', fontSize: 13, minWidth: 220 }}>
      <div style={{ fontWeight: 600 }}>
        {row.bucket === AVG_BUCKET ? `Average per ${unit}` : row.bucket} · {fmtMoney(total, base)}
      </div>
      {items.length > 0 && <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '6px 0' }} />}
      {items.map((s) => (
        <div key={s.key} style={{ display: 'flex', gap: 8 }}>
          <span style={{ width: 10, height: 10, marginTop: 5, borderRadius: 2, background: s.color }} aria-hidden />
          <span style={{ flex: 1 }}>{s.label}</span>
          <span>{fmtMoney(Number(row[s.key]), base)} ({fmtPct(Number(row[s.key]), total)})</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Checkbox legend: checked tags show their own part of the chart and its share; unchecked ones show their own total.
 * Unlike Breakdowns, unchecked tags are left out rather than folded into "Other": the chart is the checked collection.
 * Below them, each combination of checked tags that transactions carry together, as in the chart. Hovering a checked
 * tag or a combination highlights its part of the stacks.
 */
function TagLegend({ tags, metric, picks, view, series, base, onToggle, onReset, onClear, onHover }: {
  tags: TagTotal[];
  metric: Metric;
  picks: Picks;
  view: TagView;
  series: Colored[];
  base: string;
  onToggle: (t: { id: string; name: string }) => void;
  onReset: () => void;
  onClear: () => void;
  onHover: (id: string | null) => void;
}) {
  // Picks survive range changes, so a picked tag may have nothing in this range; keep it listed
  // (at zero) so it can still be unchecked and its color slot freed.
  const active = new Set(tags.map((t) => t.id));
  const idle = [...picks].filter(([id]) => !active.has(id)).map(([id, p]) => ({ id, name: p.name, total: 0 }));
  const items = [...tags.map((t) => ({ id: t.id, name: t.name, total: t[metric] })), ...idle];
  if (!items.length) return null;
  const inChart = new Map(view.series.map((s) => [s.key, s.total]));
  const overlaps = series.filter((s) => isCombo(s) || s.key === OTHER_COMBOS);
  const full = picks.size >= SERIES.length;
  return (
    <fieldset className="pick-legend">
      <legend>
        Tags in chart ({picks.size}/{SERIES.length}) <button className="link" onClick={onReset}>Reset</button>
        <button className="link" onClick={onClear}>Clear</button>
      </legend>
      {full && <p className="muted">All {SERIES.length} colors are in use. Uncheck one to add another.</p>}
      <ul {...hoverList(onHover)}>
        {items.map((t) => {
          const slot = picks.get(t.id)?.slot;
          const picked = slot !== undefined;
          const amount = picked ? (inChart.get(t.id) ?? 0) : t.total;
          const shared = view.shared.get(t.id);
          return (
            <li key={t.id} {...hoverRow(onHover, t.id)}>
              <label
                title={
                  picked && shared
                    ? `${t.name}: ${fmtMoney(t.total, base)} in all, of which ${fmtMoney(shared, base)} also carries other checked tags (in the combinations below)`
                    : t.name
                }
              >
                <input
                  type="checkbox"
                  checked={picked}
                  disabled={!picked && full}
                  onChange={() => onToggle(t)}
                  style={picked ? { accentColor: SERIES[slot] } : undefined}
                />
                <span className="name">{t.name}</span>
                <span className="num muted">{fmtMoney(amount, base)}</span>
                <span className="num pct">{picked ? fmtPct(amount, view.total) : ''}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {overlaps.length > 0 && (
        <>
          <p className="muted overlaps">Carrying several checked tags (each transaction counted once)</p>
          <ul className="combos" {...hoverList(onHover)}>
            {overlaps.map((s) => (
              <li key={s.key} {...hoverRow(onHover, s.key)}>
                <span className="pick-item" title={s.label}>
                  <span className="swatch solid" style={{ ['--c' as string]: s.color }} aria-hidden />
                  <span className="name">{s.label}</span>
                  <span className="num muted">{fmtMoney(s.total, base)}</span>
                  <span className="num pct">{fmtPct(s.total, view.total)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </fieldset>
  );
}
