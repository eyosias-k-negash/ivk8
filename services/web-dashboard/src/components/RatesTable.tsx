import { useState } from 'react';
import type { RateUsed } from '@ivy/contracts';
import { useParams } from '../state/params';

/** Editable rates table: shows each rate's source; editing creates a manual override (remembered per signed-in user in this browser). */
export function RatesTable({ base, rates }: { base: string; rates: RateUsed[] }) {
  const { rateOverrides, setOverride } = useParams();
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (!rates.length) return <p className="muted">All accounts use {base}; no conversion needed.</p>;
  return (
    <table className="grid">
      <thead>
        <tr><th>Currency</th><th>1 unit = ? {base}</th><th>Source</th><th /></tr>
      </thead>
      <tbody>
        {rates.map((r) => (
          <tr key={r.currency}>
            <td>{r.currency}</td>
            <td>
              <input
                inputMode="decimal"
                placeholder={r.rateToBase == null ? 'unavailable' : ''}
                value={draft[r.currency] ?? (r.rateToBase != null ? String(+r.rateToBase.toFixed(6)) : '')}
                onChange={(e) => setDraft({ ...draft, [r.currency]: e.target.value })}
                onBlur={() => {
                  const v = Number(draft[r.currency]);
                  if (draft[r.currency] !== undefined && Number.isFinite(v) && v > 0) setOverride(r.currency, v);
                }}
              />
            </td>
            <td>
              <span className={`badge ${r.source}`}>{r.source}</span>
              {r.stale ? <span className="badge stale">stale</span> : null}
            </td>
            <td>
              {rateOverrides[r.currency] != null && (
                <button className="link" onClick={() => { setOverride(r.currency, null); setDraft({ ...draft, [r.currency]: undefined as unknown as string }); }}>
                  reset
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
