/** Formatting helpers. Dates are rendered in the user's chosen fixed offset, not the browser's zone. */
export function fmtMoney(n: number, currency: string): string {
  return `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function offsetMs(tz: string): number {
  const m = /^(?:gmt|utc)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(tz.trim());
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000;
}

export function fmtDate(ms: number | null | undefined, tz: string): string {
  if (ms == null) return '—';
  return new Date(ms + offsetMs(tz)).toISOString().slice(0, 16).replace('T', ' ');
}
