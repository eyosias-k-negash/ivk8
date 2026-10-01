import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * Timezone + exchange-rate overrides. Held in memory only (business rule: nothing is stored).
 * Every analytics request carries them, so a change simply re-queries.
 */
export interface Params {
  tz: string;
  rateOverrides: Record<string, number>;
}

interface Ctx extends Params {
  setTz: (tz: string) => void;
  setOverride: (currency: string, rate: number | null) => void;
}

export const DEFAULT_TZ = '+03:00';

const ParamsContext = createContext<Ctx | null>(null);

export function ParamsProvider({ children }: { children: ReactNode }) {
  const [tz, setTz] = useState(DEFAULT_TZ);
  const [rateOverrides, setOverrides] = useState<Record<string, number>>({});
  const setOverride = (currency: string, rate: number | null) =>
    setOverrides((prev) => {
      const next = { ...prev };
      if (rate == null) delete next[currency];
      else next[currency] = rate;
      return next;
    });
  return <ParamsContext.Provider value={{ tz, rateOverrides, setTz, setOverride }}>{children}</ParamsContext.Provider>;
}

export function useParams(): Ctx {
  const ctx = useContext(ParamsContext);
  if (!ctx) throw new Error('useParams outside ParamsProvider');
  return ctx;
}
