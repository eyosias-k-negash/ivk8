import type { DataWarning } from '@ivy/contracts';

/** Flow 7: data-quality warnings are shown, never fatal. */
export function Warnings({ warnings }: { warnings: DataWarning[] }) {
  if (!warnings.length) return null;
  return (
    <details className="callout warn">
      <summary>{warnings.length} data-quality warning{warnings.length > 1 ? 's' : ''}</summary>
      <ul>
        {warnings.map((w) => (
          <li key={w.code}>
            <code>{w.code}</code> {w.message}
            {w.count != null ? ` (${w.count})` : ''}
            {w.examples?.length ? <span className="muted"> e.g. {w.examples.join(', ')}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
