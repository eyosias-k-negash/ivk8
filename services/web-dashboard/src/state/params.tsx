import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Me } from '@ivy/contracts';
import { api } from '../api/client';

/**
 * Timezone + exchange-rate overrides. Timezone is in memory only. Rate overrides are remembered in this
 * browser per signed-in user (localStorage, nothing server-side), so they apply to every backup and visit.
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

const rateKey = (email: string) => `ivy.rateOverrides.${email}`;

function loadOverrides(email: string): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(rateKey(email)) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'number' && v > 0)) as Record<string, number>;
  } catch {
    return {};
  }
}

const ParamsContext = createContext<Ctx | null>(null);

export function ParamsProvider({ children }: { children: ReactNode }) {
  const [tz, setTz] = useState(DEFAULT_TZ);
  const [rateOverrides, setOverrides] = useState<Record<string, number>>({});
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const email = me?.signedIn ? me.email : undefined;

  // Load the signed-in user's saved rates; clear them when signed out.
  useEffect(() => {
    setOverrides(email ? loadOverrides(email) : {});
  }, [email]);

  const setOverride = (currency: string, rate: number | null) => {
    const next = { ...rateOverrides };
    if (rate == null) delete next[currency];
    else next[currency] = rate;
    setOverrides(next);
    if (email) {
      try {
        localStorage.setItem(rateKey(email), JSON.stringify(next));
      } catch {
        /* storage unavailable: override still applies for this session */
      }
    }
  };
  return <ParamsContext.Provider value={{ tz, rateOverrides, setTz, setOverride }}>{children}</ParamsContext.Provider>;
}

export function useParams(): Ctx {
  const ctx = useContext(ParamsContext);
  if (!ctx) throw new Error('useParams outside ParamsProvider');
  return ctx;
}
