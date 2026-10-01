import { DEFAULT_TZ, parseTzOffsetMs } from './engine/time';
import type { RateOverrides } from './engine/currency';

export class BadRequest extends Error {
  readonly statusCode = 400;
}

export interface CommonParams {
  tz: string;
  rateOverrides: RateOverrides;
}

/** tz + rateOverrides are request parameters, never stored state (plan section 2). */
export function parseCommon(q: Record<string, unknown>): CommonParams {
  const tz = typeof q.tz === 'string' && q.tz ? q.tz : DEFAULT_TZ;
  try {
    parseTzOffsetMs(tz);
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }

  let rateOverrides: RateOverrides = {};
  if (typeof q.rateOverrides === 'string' && q.rateOverrides) {
    try {
      const parsed = JSON.parse(q.rateOverrides) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      rateOverrides = parsed as RateOverrides;
    } catch {
      throw new BadRequest('rateOverrides must be a JSON object like {"USD":130.5}');
    }
    for (const [c, r] of Object.entries(rateOverrides)) {
      if (!/^[A-Z]{3}$/.test(c) || typeof r !== 'number' || !Number.isFinite(r) || r <= 0) {
        throw new BadRequest(`Invalid override for ${c}`);
      }
    }
  }
  return { tz, rateOverrides };
}

/** Epoch ms or ISO date. */
export function parseInstant(v: unknown, name: string, fallback?: number): number {
  if (v == null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new BadRequest(`${name} is required`);
  }
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Date.parse(String(v));
  if (!Number.isFinite(n)) throw new BadRequest(`${name} is not a valid date`);
  return n;
}
