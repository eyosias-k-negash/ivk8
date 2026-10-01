# 0005. FX rates: ECB daily reference rates with an optional fallback

- Status: accepted (2026-10-01)

## Context
The plan requires the latest official daily rates, manual overrides, stale handling and an explicit "unavailable" state. The ECB publishes about 30 currencies, keyless and free. It does **not** include ETB, which is likely to be the base currency here.

## Decision
- Primary source: `eurofxref-daily.xml`, cached in memory for 1 hour. Cross rates via EUR. A failed refresh serves the last snapshot with `stale: true`.
- Optional `FALLBACK_RATES_URL`: any EUR-quoted `{ rates: {...} }` JSON. It is used only for currencies the ECB lacks, and those rates are marked `fallback`.
- Manual overrides always win (`source: manual`). Anything still missing is `unavailable`, excluded from totals and reported as `UNCONVERTIBLE_CURRENCY`.

## Consequences
- Until a fallback provider is chosen and its terms are checked, ETB-based users must enter overrides.
- Picking that provider is a Day-2 action item in the plan's sanity-check step.
