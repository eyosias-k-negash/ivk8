import { zipSync } from 'fflate';
import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../src/server';
import { SESSION_COOKIE, SessionCodec, type Session } from '../src/auth/session';
import type { Config } from '../src/config';
import type { DriveClient } from '../src/drive/driveClient';
import type { AnalyticsClient } from '../src/analytics/analyticsClient';

const config: Config = {
  port: 0, host: '127.0.0.1', logLevel: 'silent', publicBaseUrl: 'http://localhost:8080',
  googleClientId: 'id', googleClientSecret: 'secret', sessionSecret: 's'.repeat(32),
  analyticsUrl: 'http://analytics', maxBackupBytes: 1000,
};
const codec = new SessionCodec(config.sessionSecret);
const cookieFor = (s: Session) => ({ [SESSION_COOKIE]: codec.seal(s) });
const signedIn: Session = { sub: 'u1', email: 'a@b.c', accessToken: 'at', accessExpiresAt: Date.now() + 3600_000, refreshToken: 'rt', folderId: 'folder1' };

function setup() {
  const drive = {
    listFolders: vi.fn(async () => [{ id: 'folder1', name: 'Ivy' }]),
    listBackups: vi.fn(async () => []),
    meta: vi.fn(async (id: string) => ({ id, name: 'b.zip', mimeType: 'application/zip', size: 2, md5Checksum: 'm', modifiedTime: '', parents: ['folder1'] })),
    download: vi.fn(async () => Buffer.from(zipSync({ 'backup.json': Buffer.from('{}') }))),
    folderName: vi.fn(async () => 'Ivy'),
  } as unknown as DriveClient;
  const analytics = {
    report: vi.fn().mockResolvedValueOnce({ status: 404, body: {} }).mockResolvedValue({ status: 200, body: { data: 'ok' } }),
    ingest: vi.fn(async () => ({ status: 201, body: {} })),
  } as unknown as AnalyticsClient;
  const app = buildApp({ config, logger: false, drive: () => drive, analytics });
  return { app, drive, analytics };
}

describe('drive-sync API', () => {
  it('reports signed-out state', async () => {
    const res = await setup().app.inject('/api/me');
    expect(res.json()).toEqual({ signedIn: false });
  });

  it('login redirects to Google with PKCE and read-only Drive scope', async () => {
    const res = await setup().app.inject('/api/auth/login');
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.hostname).toBe('accounts.google.com');
    expect(loc.searchParams.get('scope')).toContain('drive.readonly');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(res.headers['set-cookie']).toContain('HttpOnly');
  });

  it('rejects a callback with a mismatched state', async () => {
    const res = await setup().app.inject({ url: '/api/auth/callback?code=c&state=wrong', cookies: cookieFor({ oauth: { state: 's', verifier: 'v', createdAt: Date.now() } }) });
    expect(res.headers.location).toContain('authError=invalid_state');
  });

  it('requires sign-in for Drive routes', async () => {
    expect((await setup().app.inject('/api/backups')).statusCode).toBe(401);
  });

  it('blocks state-changing requests without the CSRF header', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'PUT', url: '/api/drive/folder', cookies: cookieFor(signedIn), payload: { folderId: 'folder1xxxxxx' } });
    expect(res.statusCode).toBe(403);
    const ok = await app.inject({ method: 'PUT', url: '/api/drive/folder', cookies: cookieFor(signedIn), headers: { 'x-ivy-csrf': '1' }, payload: { folderId: 'folder1xxxxxx' } });
    expect(ok.statusCode).toBe(200);
  });

  it('re-ingests on analytics 404, then returns the report', async () => {
    const { app, analytics, drive } = setup();
    const res = await app.inject({ url: '/api/backups/file1/balances?tz=%2B03:00', cookies: cookieFor(signedIn) });
    expect(res.statusCode).toBe(200);
    expect(drive.download).toHaveBeenCalledOnce();
    expect(analytics.ingest).toHaveBeenCalledOnce();
    const [key, report, q] = (analytics.report as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(report).toBe('balances');
    expect((q as URLSearchParams).get('tz')).toBe('+03:00');
  });

  it('refuses files outside the chosen folder', async () => {
    const { app, drive } = setup();
    (drive.meta as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'x', parents: ['other'], size: 1, modifiedTime: '' });
    const res = await app.inject({ url: '/api/backups/x/balances', cookies: cookieFor(signedIn) });
    expect(res.statusCode).toBe(404);
  });
});
