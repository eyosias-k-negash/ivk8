import { useEffect, useMemo, useRef, useState, type ComponentProps, type Dispatch, type SetStateAction } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, Rectangle, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type BarShapeProps } from 'recharts';
import type { CustomReportData, CustomReportGroup, CustomReportOption, Granularity, GroupBy, TransactionRow } from '@ivy/contracts';
import { useReport } from '../api/hooks';
import { CursorValue } from './CursorValue';
import { PrintButton, rangeText } from '../print';
import { ErrorBox } from './ErrorBox';
import { AverageControl, Kpi, SERIES, Unconverted, averageText, periodsText, type DateRange } from './FlowReports';
import { TransactionsTable } from './TransactionsTable';
import { fmtMoney, fmtPct } from '../format';
import { signature, toConfigPatch, useSavedFilters } from '../state/savedFilters';
import {
  ALL, AVG_BUCKET, NET, NET_AVG, OTHER, activeFilters, addRule, amountBounds, checkCondition, clearFilters, mapRule, newCondition,
  newGroup, outerKeys, removeRule, reportQuery, shapeReport, updateRule,
  type ConditionDraft, type ConditionKind, type GroupDraft, type ReportConfig, type ReportRow, type ReportSeries, type ReportView,
  type RuleDraft, type Side,
} from '../reports';

const DEFAULT_PICKS = 5; // as in Breakdowns: leaves a few colors free for the user's own picks
const FOLDED_COLOR = 'var(--viz-muted)';
/** Unsplit, each side keeps one fixed hue: a cool/warm pair, so the two read as opposites. */
const SIDE_COLOR: Record<Side, string> = { income: SERIES[0]!, expense: SERIES[1]! };
const TYPING_MS = 400;
const UNIT: Record<Granularity, string> = { DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const signed = (n: number, base: string) => `${n > 0 ? '+' : ''}${fmtMoney(n, base)}`;

/**
 * Picked group id -> palette slot (+ name, for a pick with nothing under the current filters).
 * Slots stick to the group, so toggling others or changing filters never repaints it.
 */
type Picks = Map<string, { slot: number; name: string }>;
type Colored = ReportSeries & { color: string };
type Options = CustomReportData['options'];

type Update = Dispatch<SetStateAction<ReportConfig>>;

/**
 * A text input that hands its value on once typing pauses (or on leaving it), so each keystroke doesn't refetch.
 * It follows `value` when that changes from outside, such as Clear all.
 */
function SettledInput({ value, onSettle, ...rest }: { value: string; onSettle: (v: string) => void } & Omit<ComponentProps<'input'>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value);
  const handed = useRef(value);
  const settle = useRef(onSettle);
  settle.current = onSettle;
  useEffect(() => {
    if (value !== handed.current) {
      handed.current = value;
      setText(value);
    }
  }, [value]);
  const flush = (v: string) => {
    if (v === handed.current) return;
    handed.current = v;
    settle.current(v);
  };
  useEffect(() => {
    const id = setTimeout(() => flush(text), TYPING_MS);
    return () => clearTimeout(id);
  }, [text]);
  return <input {...rest} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => flush(text)} />;
}

/** The configurable report: income above zero and expense below for the transactions passing the filters. */
export function ReportsTab({ fileId, range, config, onChange }: {
  fileId: string;
  range: DateRange;
  config: ReportConfig;
  /** Takes updater functions too: typed text lands a moment after typing, and must not undo a click made meanwhile. */
  onChange: Update;
}) {
  const set = (patch: Partial<ReportConfig>) => onChange((c) => ({ ...c, ...patch }));
  const query = reportQuery(config);
  const problem = 'problem' in query ? query.problem : null;
  const r = useReport<CustomReportData>(
    fileId,
    'custom-report',
    { from: range.from, to: range.to, ...('params' in query ? query.params : {}) },
    !problem,
  );
  // The filter lists come with each answer; keep the last ones while a config that can't run is being fixed.
  const options = useRef<Options | null>(null);
  if (r.data) options.current = r.data.data.options;
  const data = problem ? undefined : r.data?.data;
  const base = r.data?.baseCurrency ?? '';

  // As in Breakdowns, picks belong to the split they were made for; a new split (or Reset) starts from the top groups.
  const [custom, setCustom] = useState<{ groupBy: GroupBy; picks: Picks } | null>(null);
  const groups = useMemo(() => data?.groups ?? [], [data]);
  const split = data?.groupBy ?? 'none';
  const picks = useMemo<Picks>(
    () =>
      custom?.groupBy === split ? custom.picks : new Map(groups.slice(0, DEFAULT_PICKS).map((g, i) => [g.id, { slot: i, name: g.name }])),
    [custom, split, groups],
  );
  // Unchecking "Other" leaves the unpicked groups out of the chart instead of folding them into it.
  const [showOther, setShowOther] = useState(true);
  const toggle = (g: CustomReportOption) => {
    const next = new Map(picks);
    if (next.has(g.id)) next.delete(g.id);
    else {
      const used = new Set([...next.values()].map((p) => p.slot));
      const slot = SERIES.findIndex((_, i) => !used.has(i));
      if (slot < 0) return;
      next.set(g.id, { slot, name: g.name });
    }
    setCustom({ groupBy: split, picks: next });
  };

  const view = useMemo(
    () => (data ? shapeReport(data, new Set(picks.keys()), showOther, config.average) : null),
    [data, picks, showOther, config.average],
  );
  const series = useMemo<Colored[]>(
    () =>
      (view?.series ?? []).map((s) => ({
        ...s,
        color: s.group === ALL ? SIDE_COLOR[s.side] : s.group === OTHER ? FOLDED_COLOR : SERIES[picks.get(s.group)!.slot]!,
      })),
    [view, picks],
  );
  const unit = UNIT[config.granularity];
  const divisor = view ? (config.average === 'active' ? view.active : view.periods) : 0;

  return (
    <>
      <div className="controls">
        <label>
          Interval{' '}
          <select value={config.granularity} onChange={(e) => set({ granularity: e.target.value as Granularity })}>
            <option value="DAY">Day</option>
            <option value="WEEK">Week (Mon)</option>
            <option value="MONTH">Month</option>
            <option value="YEAR">Year</option>
          </select>
        </label>
        <label>
          Break down by{' '}
          <select value={config.groupBy} onChange={(e) => set({ groupBy: e.target.value as GroupBy })}>
            <option value="none">Nothing (income vs expense)</option>
            <option value="category">Category</option>
            <option value="account">Account</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={config.showNet} onChange={(e) => set({ showNet: e.target.checked })} /> Net line
        </label>
        <AverageControl value={config.average} onChange={(average) => set({ average })} unit={unit} />
        <PrintButton
          tab="Reports"
          title="Custom report"
          meta={[rangeText(range), `Per ${unit}`, split === 'none' ? '' : `Split by ${split}`, averageText(config.average, unit)]}
        />
      </div>
      <ReportFilters config={config} options={options.current} base={base} onChange={onChange} />
      {problem && <div className="callout warn">{problem}</div>}
      {r.error && <ErrorBox error={r.error} />}
      {!problem && !r.data && !r.error && <p className="muted">Loading…</p>}
      {data && view && (
        // While new filters load, the last answer stays up, dimmed, instead of flashing empty.
        <div className={r.isFetching && r.isPlaceholderData ? 'refreshing' : undefined}>
          <Unconverted list={data.unconverted} />
          <div className="kpis">
            <Kpi label="Income" value={fmtMoney(data.income, base)} />
            <Kpi label="Expense" value={fmtMoney(data.expense, base)} />
            <Kpi label="Net" value={signed(data.net, base)} />
            <Kpi
              label={`Average net per ${unit}`}
              value={signed(divisor ? data.net / divisor : 0, base)}
              note={
                divisor
                  ? `${fmtMoney(data.income / divisor, base)} in, ${fmtMoney(data.expense / divisor, base)} out over ${periodsText(divisor, unit, config.average)}`
                  : undefined
              }
            />
            <Kpi label="Transactions" value={String(data.count)} />
          </div>
          {data.count === 0 ? (
            <p className="muted">No transactions match these filters in this range.</p>
          ) : (
            <>
              <ReportChart view={view} series={series} base={base} unit={unit} showNet={config.showNet} />
              <ChartKey series={series} showNet={config.showNet} split={split !== 'none'} />
              {split !== 'none' && (
                <GroupLegend
                  groups={groups}
                  picks={picks}
                  base={base}
                  noun={split}
                  showOther={showOther}
                  onToggleOther={() => setShowOther((v) => !v)}
                  onToggle={toggle}
                  onReset={() => {
                    setCustom(null);
                    setShowOther(true);
                  }}
                />
              )}
              <ReportTable view={view} series={series} base={base} split={split !== 'none'} />
            </>
          )}
          <MatchingTransactions fileId={fileId} ids={data.transactionIds} />
        </div>
      )}
      <p className="muted" style={{ fontSize: 12 }}>
        Executed only; planned payments are not counted. As in every tab, income and expense on accounts excluded from the balance are
        left out, a transfer to or from one counts as income or expense on the included account, under its category (or its two accounts
        if it has none), and transfers between included accounts never count. A transaction counts when its included side is one of the
        accounts, its category one of the categories, and it meets the conditions. Words match its title or description in any case;
        amounts are each transaction’s own, in {base || 'base currency'}, bounds included. A condition still being filled in is left out.
      </p>
    </>
  );
}

// ---------- filters ----------

function ReportFilters({ config, options, base, onChange }: {
  config: ReportConfig;
  options: Options | null;
  base: string;
  onChange: Update;
}) {
  const set = (patch: Partial<ReportConfig>) => onChange((c) => ({ ...c, ...patch }));
  const n = activeFilters(config);
  const edit = (fn: (root: GroupDraft) => GroupDraft) => onChange((c) => ({ ...c, rules: fn(c.rules) }));
  const saved = useSavedFilters();
  const [name, setName] = useState('');
  const here = signature(config);
  const trimmed = name.trim();
  const doSave = () => {
    if (!trimmed) return;
    saved.save(trimmed, config);
    setName('');
  };
  return (
    <fieldset className="report-filters">
      <legend>
        Filters{n > 0 && <> · {n} on <button className="link" onClick={() => onChange(clearFilters)}>Clear all</button></>}
      </legend>
      <OnlyPicker label="Accounts" noun="accounts" options={options?.accounts} value={config.accounts} onChange={(accounts) => set({ accounts })} />
      <OnlyPicker label="Categories" noun="categories" options={options?.categories} value={config.categories} onChange={(categories) => set({ categories })} />
      <div className="rules">
        <span className="field-label">Conditions on tags, words and amount</span>
        <RuleGroup group={config.rules} depth={0} tags={options?.tags} base={base} edit={edit} />
      </div>
      <div className="saved-filters">
        <span className="field-label">Saved filters</span>
        <ul>
          {saved.list.map((f) => (
            <li key={f.name} className={signature(f) === here ? 'on' : undefined}>
              <button type="button" className="saved-apply" aria-pressed={signature(f) === here} onClick={() => onChange((c) => ({ ...c, ...toConfigPatch(f) }))}>
                {f.name}
              </button>
              <button type="button" className="saved-remove" aria-label={`Delete saved filter ${f.name}`} onClick={() => saved.remove(f.name)}>×</button>
            </li>
          ))}
          {!saved.list.length && <li className="muted">None yet</li>}
        </ul>
        <form
          className="saved-new"
          onSubmit={(e) => {
            e.preventDefault();
            doSave();
          }}
        >
          <input value={name} maxLength={40} placeholder="Name this filter" aria-label="Name for the saved filter" onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={!trimmed}>{saved.list.some((f) => f.name === trimmed) ? 'Replace' : 'Save'}</button>
        </form>
      </div>
    </fieldset>
  );
}

/**
 * Conditions joined by one connector, as in a spreadsheet filter: "Where … and … and …". The connector is picked on
 * the second row and holds for the whole group; to mix "and" with "or", put some conditions in a group of their own.
 * Only the top level adds groups (two levels read clearly; the API allows three).
 */
function RuleGroup({ group, depth, tags, base, edit }: {
  group: GroupDraft;
  depth: number;
  tags: CustomReportOption[] | undefined;
  base: string;
  edit: (fn: (root: GroupDraft) => GroupDraft) => void;
}) {
  const word = group.match === 'all' ? 'and' : 'or';
  const firstKind: ConditionKind = tags?.length ? 'tags' : 'text';
  const joint = (i: number) =>
    i === 0 ? (
      'Where'
    ) : i === 1 ? (
      <select
        aria-label={depth ? 'Join the conditions in this group with' : 'Join conditions with'}
        value={group.match}
        onChange={(e) => edit((root) => updateRule(root, group.id, { match: e.target.value as GroupDraft['match'] }))}
      >
        <option value="all">and</option>
        <option value="any">or</option>
      </select>
    ) : (
      word
    );
  return (
    <div className={depth ? 'rule-group nested' : 'rule-group'} role="group" aria-label={depth ? `Group joined by ${word}` : 'Conditions'}>
      {!group.rules.length && (
        <p className="muted rule-empty">
          {depth ? 'This group is empty, so it filters nothing.' : 'No conditions: everything in the accounts and categories above counts.'}
        </p>
      )}
      {group.rules.map((r, i) => (
        <div className="rule-row" key={r.id}>
          <span className="rule-joint">{joint(i)}</span>
          {r.kind === 'group' ? (
            <RuleGroup group={r} depth={depth + 1} tags={tags} base={base} edit={edit} />
          ) : (
            <Condition c={r} tags={tags} base={base} edit={edit} />
          )}
        </div>
      ))}
      <div className="rule-actions">
        <button type="button" className="link" onClick={() => edit((root) => addRule(root, group.id, newCondition(firstKind)))}>
          + Add condition
        </button>
        {depth === 0 && (
          <button type="button" className="link" onClick={() => edit((root) => addRule(root, group.id, newGroup(group.match, firstKind)))}>
            + Add group
          </button>
        )}
        {depth > 0 && (
          <button type="button" className="link" onClick={() => edit((root) => removeRule(root, group.id))}>
            Remove group
          </button>
        )}
      </div>
    </div>
  );
}

const OPS: { [K in ConditionKind]: [Extract<ConditionDraft, { kind: K }>['op'], string][] } = {
  tags: [['any', 'include any of'], ['all', 'include all of'], ['none', 'include none of']],
  text: [['contains', 'contains any of'], ['excludes', 'contains none of']],
  amount: [['atLeast', 'is at least'], ['atMost', 'is at most'], ['between', 'is between']],
};

function Condition({ c, tags, base, edit }: {
  c: ConditionDraft;
  tags: CustomReportOption[] | undefined;
  base: string;
  edit: (fn: (root: GroupDraft) => GroupDraft) => void;
}) {
  const set = (patch: Partial<RuleDraft>) => edit((root) => updateRule(root, c.id, patch));
  const check = checkCondition(c);
  return (
    <div className="rule-cond">
      <select
        aria-label="Condition on"
        value={c.kind}
        // Another field starts a fresh condition in the same place.
        onChange={(e) => edit((root) => mapRule(root, c.id, () => ({ ...newCondition(e.target.value as ConditionKind), id: c.id })))}
      >
        <option value="tags">Tags</option>
        <option value="text">Title or description</option>
        <option value="amount">Amount</option>
      </select>
      <select aria-label="Test" value={c.op} onChange={(e) => set({ op: e.target.value } as Partial<RuleDraft>)}>
        {OPS[c.kind].map(([op, label]) => <option key={op} value={op}>{label}</option>)}
      </select>
      {c.kind === 'tags' && (
        <MultiSelect
          label="Tags"
          summary={c.tagIds.length ? names(c.tagIds, tags) : 'Choose tags'}
          options={tags}
          checked={new Set(c.tagIds)}
          onChange={(s) => set({ tagIds: [...s] })}
        />
      )}
      {c.kind === 'text' && (
        <SettledInput
          className="rule-words"
          aria-label="Words, separated by commas"
          placeholder="e.g. coffee, taxi"
          value={c.text}
          onSettle={(text) => set({ text })}
        />
      )}
      {c.kind === 'amount' && <AmountInputs c={c} base={base} set={set} />}
      {check === 'incomplete' && <span className="rule-hint">not applied yet</span>}
      <button type="button" className="rule-remove" aria-label="Remove condition" title="Remove condition" onClick={() => edit((root) => removeRule(root, c.id))}>
        ×
      </button>
    </div>
  );
}

function AmountInputs({ c, base, set }: {
  c: Extract<ConditionDraft, { kind: 'amount' }>;
  base: string;
  set: (patch: Partial<RuleDraft>) => void;
}) {
  const { min, max } = amountBounds(c);
  const crossed = min !== undefined && max !== undefined && min > max;
  const invalid = (v: number | undefined) => Number.isNaN(v) || crossed || undefined;
  const input = (which: 'min' | 'max', label: string) => (
    <SettledInput
      aria-label={label}
      inputMode="decimal"
      placeholder="0.00"
      value={c[which]}
      aria-invalid={invalid(which === 'min' ? min : max)}
      onSettle={(v) => set({ [which]: v })}
    />
  );
  return (
    <span className="range-inputs">
      {c.op !== 'atMost' && input('min', c.op === 'between' ? 'Smallest amount' : 'Amount')}
      {c.op === 'between' && <span className="muted">and</span>}
      {c.op !== 'atLeast' && input('max', c.op === 'between' ? 'Largest amount' : 'Amount')}
      {base && <span className="muted">{base}</span>}
    </span>
  );
}

/** "Trip, Work" or "Trip, Work +3"; ids the backup doesn't know are skipped. */
function names(ids: string[], options: CustomReportOption[] | undefined, shown = 2): string {
  const byId = new Map(options?.map((o) => [o.id, o.name]));
  const known = ids.map((id) => byId.get(id)).filter((n): n is string => !!n);
  if (!known.length) return `${plural(ids.length, 'item')} selected`;
  return known.slice(0, shown).join(', ') + (known.length > shown ? ` +${known.length - shown}` : '');
}

/** A list where everything is in until narrowed: null = all, so items the backup gains later are in too. */
function OnlyPicker({ label, noun, options, value, onChange }: {
  label: string;
  noun: string;
  options: CustomReportOption[] | undefined;
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const all = options?.map((o) => o.id) ?? [];
  const summary =
    value === null ? `All ${noun}` : !value.length ? `No ${noun}` : value.length <= 2 ? names(value, options) : `${value.length} of ${all.length} ${noun}`;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <MultiSelect
        label={label}
        summary={summary}
        options={options}
        checked={new Set(value ?? all)}
        onChange={(s) => onChange(all.length && all.every((id) => s.has(id)) ? null : [...s])}
      />
    </div>
  );
}

/** A dropdown of checkboxes. Closes on Escape or a click outside; long lists get a search box. */
function MultiSelect({ label, summary, options, checked, onChange }: {
  label: string;
  summary: string;
  options: CustomReportOption[] | undefined;
  checked: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!open) return;
    const close = () => ref.current && (ref.current.open = false);
    const click = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      ref.current?.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', click);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', click);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const needle = q.trim().toLowerCase();
  const shown = options?.filter((o) => o.name.toLowerCase().includes(needle)) ?? [];
  // All / None act on what the search shows.
  const setShown = (on: boolean) => {
    const next = new Set(checked);
    for (const o of shown) if (on) next.add(o.id);
    else next.delete(o.id);
    onChange(next);
  };
  const toggle = (id: string) => {
    const next = new Set(checked);
    if (!next.delete(id)) next.add(id);
    onChange(next);
  };
  return (
    <details ref={ref} className="multi" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary aria-label={`${label}: ${summary}`}>
        <span className="name">{summary}</span>
      </summary>
      <div className="multi-pop">
        {!options ? (
          <p className="muted">Loading…</p>
        ) : !options.length ? (
          <p className="muted">None in this backup.</p>
        ) : (
          <>
            {options.length > 8 && <input className="filter" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />}
            <div className="multi-actions">
              <button type="button" className="link" onClick={() => setShown(true)}>All</button>
              <button type="button" className="link" onClick={() => setShown(false)}>None</button>
            </div>
            <ul>
              {shown.map((o) => (
                <li key={o.id}>
                  <label title={o.name}>
                    <input type="checkbox" checked={checked.has(o.id)} onChange={() => toggle(o.id)} />
                    <span className="name">{o.name}</span>
                  </label>
                </li>
              ))}
              {!shown.length && <li className="muted">No match.</li>}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}

// ---------- chart ----------

function ReportChart({ view, series, base, unit, showNet }: { view: ReportView; series: Colored[]; base: string; unit: string; showNet: boolean }) {
  return (
    <div className="chart report-chart" role="img" aria-label={`Income above zero and expense below, per ${unit}${showNet ? ', with net' : ''}`}>
      <ResponsiveContainer>
        <ComposedChart data={view.rows} stackOffset="sign" barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
          <XAxis dataKey="bucket" tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" />
          <YAxis tick={{ fill: 'var(--viz-muted)', fontSize: 12 }} stroke="var(--viz-grid)" width={72} tickFormatter={(v: number) => v.toLocaleString()} />
          <ReferenceLine y={0} stroke="var(--viz-muted)" />
          <Tooltip cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }} content={<ReportTooltip series={series} base={base} unit={unit} showNet={showNet} />} />
          {series.map((s) => (
            // The outermost segment on each side of a stack gets the rounded data end; the rest stay square.
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={s.color}
              stackId="flow"
              stroke="var(--card)"
              strokeWidth={2}
              maxBarSize={48}
              isAnimationActive={false}
              shape={(p: BarShapeProps) => {
                const row = p.payload as ReportRow;
                const { top, bottom } = outerKeys(row, series);
                return (
                  <Rectangle
                    {...p}
                    // The trailing average bar is dimmed so it reads as a summary, not a period.
                    fillOpacity={row.bucket === AVG_BUCKET ? 0.55 : 1}
                    // Rounds the data end, below zero too (recharts draws those from their tip).
                    radius={s.key === top || s.key === bottom ? [4, 4, 0, 0] : 0}
                  />
                );
              }}
            />
          ))}
          {showNet && (
            <Line
              dataKey={NET}
              name="Net"
              stroke="var(--fg)"
              strokeWidth={2}
              dot={{ r: 4, fill: 'var(--fg)', stroke: 'var(--card)', strokeWidth: 2 }}
              activeDot={{ r: 5, fill: 'var(--fg)', stroke: 'var(--card)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          )}
          {/* The average's net stands alone: a line into it would read as one more period. */}
          {showNet && (
            <Line
              dataKey={NET_AVG}
              name="Average net"
              stroke="none"
              dot={{ r: 4, fill: 'var(--fg)', fillOpacity: 0.55, stroke: 'var(--card)', strokeWidth: 2 }}
              activeDot={false}
              isAnimationActive={false}
            />
          )}
          <CursorValue base={base} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function ReportTooltip({ active, payload, series, base, unit, showNet }: {
  active?: boolean;
  payload?: { payload: ReportRow }[];
  series: Colored[];
  base: string;
  unit: string;
  showNet: boolean;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const avg = row.bucket === AVG_BUCKET;
  const section = (side: Side, title: string, total: number) => {
    if (!total) return null;
    const items = series
      .filter((s) => s.side === side && row[s.key] != null)
      .sort((a, b) => Math.abs(Number(row[b.key])) - Math.abs(Number(row[a.key])));
    return (
      <>
        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '6px 0' }} />
        <div style={{ display: 'flex', gap: 8, fontWeight: 600 }}>
          <span style={{ flex: 1 }}>{title}</span>
          <span>{fmtMoney(total, base)}</span>
        </div>
        {/* Unsplit, the side is its only series: the heading says it all. */}
        {items.some((s) => s.group !== ALL) &&
          items.map((s) => {
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
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--fg)', padding: '8px 12px', fontSize: 13, minWidth: 240 }}>
      <div style={{ fontWeight: 600 }}>{avg ? `Average per ${unit}` : row.bucket}</div>
      {(showNet || !avg) && (
        <div className="muted">
          Net {signed(row.income - row.expense, base)}
          {!avg && ` · ${plural(Number(row.count), 'transaction')}`}
        </div>
      )}
      {section('income', 'Income', row.income)}
      {section('expense', 'Expense', row.expense)}
    </div>
  );
}

/** What the marks mean. Split, the group legend below carries the colors; this names the sides and the line. */
function ChartKey({ series, showNet, split }: { series: Colored[]; showNet: boolean; split: boolean }) {
  return (
    <ul className="chart-key">
      {split ? (
        <li className="muted">Bars: income above zero, expense below, colored by group</li>
      ) : (
        series.map((s) => (
          <li key={s.key}>
            <span className="key-box" style={{ ['--c' as string]: s.color }} aria-hidden />
            {s.label} {s.side === 'income' ? '(above zero)' : '(below zero)'}
          </li>
        ))
      )}
      {showNet && (
        <li>
          <span className="key-line" aria-hidden />
          Net (income − expense)
        </li>
      )}
    </ul>
  );
}

/**
 * Checkbox legend for a split report: checked groups get their own color on both sides, unchecked ones fold into
 * "Other", which can be unchecked to leave them out. Each row shows the group's money in and out under the current filters.
 */
function GroupLegend({ groups, picks, base, noun, showOther, onToggleOther, onToggle, onReset }: {
  groups: CustomReportGroup[];
  picks: Picks;
  base: string;
  noun: GroupBy;
  showOther: boolean;
  onToggleOther: () => void;
  onToggle: (g: CustomReportOption) => void;
  onReset: () => void;
}) {
  // Picks survive filter changes, so a picked group may have nothing now; keep it listed (at zero) so it can
  // still be unchecked and its color freed.
  const live = new Set(groups.map((g) => g.id));
  const idle = [...picks].filter(([id]) => !live.has(id)).map(([id, p]) => ({ id, name: p.name, income: 0, expense: 0 }));
  const items = [...groups, ...idle];
  const rest = groups.filter((g) => !picks.has(g.id));
  const full = picks.size >= SERIES.length;
  const amounts = (g: { income: number; expense: number }) => (
    <>
      <span className="num muted">{g.income ? `+${fmtMoney(g.income, base)}` : ''}</span>
      <span className="num muted">{g.expense ? `−${fmtMoney(g.expense, base)}` : ''}</span>
    </>
  );
  return (
    <fieldset className="pick-legend">
      <legend>
        {noun === 'account' ? 'Accounts' : 'Categories'} shown in chart ({picks.size}/{SERIES.length}){' '}
        <button className="link" onClick={onReset}>Reset</button>
      </legend>
      {full && <p className="muted">All {SERIES.length} colors are in use. Uncheck one to add another.</p>}
      <ul className="flows">
        {items.map((g) => {
          const slot = picks.get(g.id)?.slot;
          return (
            <li key={g.id}>
              <label title={g.name}>
                <input
                  type="checkbox"
                  checked={slot !== undefined}
                  disabled={slot === undefined && full}
                  onChange={() => onToggle(g)}
                  style={slot !== undefined ? { accentColor: SERIES[slot] } : undefined}
                />
                <span className="name">{g.name}</span>
                {amounts(g)}
              </label>
            </li>
          );
        })}
        {rest.length > 0 && (
          <li>
            <label>
              <input type="checkbox" checked={showOther} onChange={onToggleOther} style={{ accentColor: FOLDED_COLOR }} />
              <span className="name">Other ({rest.length})</span>
              {amounts({ income: rest.reduce((s, g) => s + g.income, 0), expense: rest.reduce((s, g) => s + g.expense, 0) })}
            </label>
          </li>
        )}
      </ul>
    </fieldset>
  );
}

/** Table view: the accessible and precise counterpart of the chart. */
function ReportTable({ view, series, base, split }: { view: ReportView; series: Colored[]; base: string; split: boolean }) {
  return (
    <details>
      <summary>Show as table</summary>
      <div className="scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>Period</th>
              <th className="num">Income</th>
              <th className="num">Expense</th>
              <th className="num">Net</th>
              <th className="num">Transactions</th>
              {split && series.map((s) => <th key={s.key} className="num">{s.label} ({s.side === 'income' ? 'in' : 'out'})</th>)}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.bucket}>
                <td>{row.bucket}</td>
                <td className="num">{fmtMoney(row.income, base)}</td>
                <td className="num">{fmtMoney(row.expense, base)}</td>
                <td className="num">{signed(row.income - row.expense, base)}</td>
                <td className="num">{row.bucket === AVG_BUCKET ? '' : row.count}</td>
                {split && series.map((s) => <td key={s.key} className="num">{fmtMoney(Math.abs(Number(row[s.key] ?? 0)), base)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** The transactions behind the chart, so a filter can be checked. Loaded on first open (shares the Transactions tab's cache). */
function MatchingTransactions({ fileId, ids }: { fileId: string; ids: string[] }) {
  const [open, setOpen] = useState(false);
  const r = useReport<TransactionRow[]>(fileId, 'transactions', {}, open);
  const rows = useMemo(() => {
    const wanted = new Set(ids);
    return r.data?.data.filter((t) => wanted.has(t.id)) ?? [];
  }, [r.data, ids]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Matching transactions ({ids.length})</summary>
      {open && (r.error ? <ErrorBox error={r.error} /> : !r.data ? <p className="muted">Loading…</p> : <TransactionsTable rows={rows} base={r.data.baseCurrency} tz={r.data.tz} />)}
    </details>
  );
}
