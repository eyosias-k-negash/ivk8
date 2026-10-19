import { createContext, useContext, useRef } from 'react';
import { useBackups, useMe } from './api/hooks';

/** What a printed chart page needs besides the chart itself. */
export interface PrintSpec {
  title: string;
  /** Context lines under the title: the range, interval, filters. */
  meta?: string[];
  /** Where the data came from: the login and the backup file. */
  source?: { email?: string; file?: string };
}

/** The opened backup's file id, provided by BackupView so every tab's print button can name it. */
export const BackupIdContext = createContext<string | null>(null);

// Paper is always white, so the print sheet carries the light tokens instead of inheriting a dark theme.
const SHEET_CSS = `
:root { --viz-muted:#6b6963; --viz-grid:#d9dce5; --card:#fff; --fg:#1d2330; --muted:#5b6275; --border:#d5d9e3; --accent:#4f6bed;
  --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a; --series-4:#eda100; --series-5:#e87ba4; --series-6:#008300; --series-7:#4a3aa7; --series-8:#e34948;
  --zone-ok:#1baf7a; --zone-over:#e34948; }
@page { size: letter landscape; margin: 0.5in; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: var(--fg); font: 11pt/1.4 system-ui, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
/* One sheet: the page is the content box (letter landscape 11in x 8.5in minus margins). */
.sheet { height: 7.5in; display: flex; flex-direction: column; overflow: hidden; page-break-after: avoid; break-inside: avoid; }
.letterhead { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 8pt; border-bottom: 2pt solid var(--accent); }
.brand { font-size: 20pt; font-weight: 700; letter-spacing: -0.01em; }
.brand small { display: block; font-size: 9pt; font-weight: 400; color: var(--muted); letter-spacing: 0; }
.stamp { font-size: 9pt; color: var(--muted); text-align: right; }
h1 { margin: 10pt 0 2pt; font-size: 15pt; }
h1 + .source { margin: 0 0 2pt; font-size: 10.5pt; }
.source b { font-weight: 600; }
.source span + span::before { content: ' · '; color: var(--muted); }
.meta { margin: 0 0 6pt; font-size: 9.5pt; color: var(--muted); }
.meta span + span::before { content: ' · '; }
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6pt; }
.figure { flex: 1; min-height: 0; display: flex; }
.figure > .chart { flex: 1; min-height: 0; width: 100%; height: auto; margin: 0; }
.figure .recharts-wrapper { width: 100% !important; height: 100% !important; }
.figure svg { width: 100%; height: 100%; }
.budget-sum { margin: 0; font-size: 10pt; color: var(--muted); }
.chart-key, .pick-legend ul { list-style: none; display: flex; flex-wrap: wrap; gap: 2pt 14pt; padding: 0; margin: 0; font-size: 9pt; }
.pick-legend { border: 0; padding: 0; margin: 0; min-width: 0; }
.pick-legend legend { padding: 0; font-size: 9pt; color: var(--muted); }
.pick-legend li, .chart-key li { display: flex; align-items: center; gap: 5pt; }
.pick-legend label, .pick-legend .pick-item { display: flex; align-items: center; gap: 5pt; }
.pick-legend .num { margin-left: 4pt; font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.kpis { display: flex; gap: 8pt; }
.kpi { border: 0.5pt solid var(--border); border-radius: 4pt; padding: 3pt 8pt; }
.kpi .label { font-size: 8pt; color: var(--muted); } .kpi .value { font-size: 12pt; font-weight: 600; } .kpi .note { font-size: 7.5pt; color: var(--muted); }
.swatch, .key-box { display: inline-block; width: 9pt; height: 9pt; border-radius: 2pt; background: var(--c, var(--viz-muted)); flex: none; }
.key-line { display: inline-block; width: 14pt; height: 2pt; background: var(--fg); }
.recharts-legend-wrapper { position: static !important; }
footer { margin-top: 6pt; padding-top: 4pt; border-top: 0.5pt solid var(--border); font-size: 8pt; color: var(--muted); display: flex; justify-content: space-between; }
`;

// What a chart page keeps from the tab, in document order: the headline sentence, the plot, and every legend.
const KEEP = '.budget-sum, .kpis, .chart, .chart-key, .pick-legend';

/** "2026-01-01 – 2026-03-31", or "All time". */
export const rangeText = (r: { from: string; to: string }) => (r.from === 'all' ? 'All time' : `${r.from} – ${r.to}`);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Builds the printable copy of the chart inside `scope`. Live nodes are read for state a clone loses:
 * checkbox state and the size of each svg.
 */
function collect(scope: Element): string {
  const parts: string[] = [];
  for (const live of scope.querySelectorAll(KEEP)) {
    if (live.closest('details')) continue;
    const copy = live.cloneNode(true) as HTMLElement;

    if (live.classList.contains('chart')) {
      // Drop hover-only overlays and the tooltip, then let the svg scale to the sheet via its viewBox.
      copy.querySelectorAll('.recharts-tooltip-wrapper, [aria-hidden="true"] text').forEach((n) => n.remove());
      const liveSvg = live.querySelector('svg.recharts-surface');
      const svg = copy.querySelector('svg.recharts-surface');
      if (liveSvg && svg) {
        const { width, height } = liveSvg.getBoundingClientRect();
        if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${Math.round(width)} ${Math.round(height)}`);
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      }
      copy.removeAttribute('style');
      parts.push(`<div class="figure">${copy.outerHTML}</div>`);
      continue;
    }

    // Legend checkboxes become swatches in the checkbox's own color; unchecked rows are not in the chart.
    const liveBoxes = [...live.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    copy.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((box, i) => {
      const li = box.closest('li');
      if (!liveBoxes[i]?.checked) return void li?.remove();
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.setProperty('--c', box.style.accentColor || 'var(--viz-muted)');
      box.replaceWith(swatch);
    });
    copy.querySelectorAll('button, .link, p.muted').forEach((n) => n.remove());
    parts.push(copy.outerHTML);
  }
  return parts.join('\n');
}

/** Prints one landscape Letter page: project letterhead, the chart and its legends. */
export function printChart(scope: Element, spec: PrintSpec): void {
  const body = collect(scope);
  const source = [spec.source?.file && `Backup: <b>${esc(spec.source.file)}</b>`, spec.source?.email && `Account: <b>${esc(spec.source.email)}</b>`]
    .filter(Boolean)
    .map((s) => `<span>${s}</span>`)
    .join('');
  const now = new Date().toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
  const meta = (spec.meta ?? []).filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('');
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(spec.title)} · Ivy Wallet Plus</title><style>${SHEET_CSS}</style></head><body>
<div class="sheet">
  <header class="letterhead">
    <div class="brand">Ivy Wallet Plus<small>Personal finance dashboard for Ivy Wallet backups</small></div>
    <div class="stamp">Report printed<br>${esc(now)}</div>
  </header>
  <h1>${esc(spec.title)}</h1>
  <p class="source">${source}</p>
  <p class="meta">${meta}</p>
  <div class="body">${body}</div>
  <footer><span>Ivy Wallet Plus · ${esc(spec.title)}</span><span>Executed transactions only unless noted. Amounts in the backup's base currency.</span></footer>
</div></body></html>`;

  // A hidden iframe keeps the app page untouched and gives the print dialog only the sheet.
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  frame.srcdoc = doc;
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) return frame.remove();
    win.addEventListener('afterprint', () => frame.remove());
    win.focus();
    win.print();
  };
  document.body.appendChild(frame);
}

/**
 * Print button for a tab with a chart. Prints the chart, its headline and legends found in the nearest card,
 * so place it inside the tab and call it with whatever describes the current view.
 */
export function PrintButton({ title, meta }: PrintSpec) {
  const ref = useRef<HTMLButtonElement>(null);
  const fileId = useContext(BackupIdContext);
  const email = useMe().data?.email;
  const file = useBackups().data?.find((b) => b.fileId === fileId)?.name;
  return (
    <button
      ref={ref}
      type="button"
      className="link print-btn"
      title="Print this chart on one landscape page"
      onClick={() => {
        const scope = ref.current?.closest('.card');
        if (scope) printChart(scope, { title, meta, source: { email, file } });
      }}
    >
      🖨 Print chart
    </button>
  );
}
