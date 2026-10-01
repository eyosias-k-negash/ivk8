/** All config comes from env (12-factor). No secrets are needed by this service. */
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 8081),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Hard cap on an uploaded backup body. Keep in sync with drive-sync MAX_BACKUP_BYTES. */
  maxBackupBytes: num(process.env.MAX_BACKUP_BYTES, 50 * 1024 * 1024),
  /** How many parsed datasets to keep in memory (LRU). */
  datasetCacheSize: num(process.env.DATASET_CACHE_SIZE, 8),
  datasetTtlMs: num(process.env.DATASET_TTL_MS, 30 * 60_000),
  /** FX */
  ratesTtlMs: num(process.env.RATES_TTL_MS, 60 * 60_000),
  ecbUrl: process.env.ECB_URL ?? 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
  /** Optional fallback provider for currencies the ECB does not publish. Empty = disabled. */
  fallbackRatesUrl: process.env.FALLBACK_RATES_URL ?? '',
};
