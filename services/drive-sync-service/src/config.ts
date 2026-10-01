/**
 * Config from env. Secrets (GOOGLE_CLIENT_SECRET, SESSION_SECRET) arrive via a k8s Secret
 * and are never logged. Missing secrets fail fast at startup.
 */
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  publicBaseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  sessionSecret: string;
  analyticsUrl: string;
  maxBackupBytes: number;
}

export function loadConfig(): Config {
  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return {
    port: num(process.env.PORT, 8080),
    host: process.env.HOST ?? '0.0.0.0',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
    googleClientId: required('GOOGLE_CLIENT_ID'),
    googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
    sessionSecret,
    analyticsUrl: (process.env.ANALYTICS_URL ?? 'http://analytics-service:8081').replace(/\/$/, ''),
    maxBackupBytes: num(process.env.MAX_BACKUP_BYTES, 50 * 1024 * 1024),
  };
}
