import { createHash } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ApiError, Me } from '@ivy/contracts';
import { AnalyticsClient } from './analytics/analyticsClient';
import { GoogleOAuth, ReauthRequired, newState, newVerifier } from './auth/google';
import { SESSION_COOKIE, SESSION_MAX_AGE_S, SessionCodec, type Session } from './auth/session';
import type { Config } from './config';
import { InvalidBackupZip, extractBackupJson } from './drive/backupZip';
import { BackupTooLarge, DriveClient, DriveNotFound, DriveRateLimited, DriveUnavailable } from './drive/driveClient';

export interface AppDeps {
  config: Config;
  oauth?: GoogleOAuth;
  analytics?: AnalyticsClient;
  /** Factory so tests can inject a fake Drive. */
  drive?: (accessToken: () => Promise<string>) => DriveClient;
  logger?: boolean;
}

/** Reports the dashboard may request; mirrors analytics-service routes. */
const REPORTS = new Set(['transactions', 'balances', 'summary', 'timeseries', 'budgets', 'planned', 'tags', 'payees', 'rates']);
const OAUTH_TTL_MS = 10 * 60_000;

declare module 'fastify' {
  interface FastifyRequest {
    session: Session;
    sessionDirty: boolean;
  }
}

function fail(reply: FastifyReply, status: number, code: ApiError['error']['code'], message: string, details?: string[]) {
  const body: ApiError = { error: { code, message, ...(details ? { details } : {}) } };
  return reply.code(status).send(body);
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config } = deps;
  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          },
    trustProxy: true,
  });

  const codec = new SessionCodec(config.sessionSecret);
  const oauth =
    deps.oauth ??
    new GoogleOAuth({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      redirectUri: `${config.publicBaseUrl}/api/auth/callback`,
    });
  const analytics = deps.analytics ?? new AnalyticsClient(config.analyticsUrl);
  const makeDrive = deps.drive ?? ((tok) => new DriveClient(tok));
  const secureCookie = config.publicBaseUrl.startsWith('https://');

  app.register(cookie);

  // ---- session plumbing (encrypted cookie, written back only when changed) ----
  app.decorateRequest('session', null as unknown as Session);
  app.decorateRequest('sessionDirty', false);
  app.addHook('onRequest', async (req) => {
    req.session = codec.open(req.cookies[SESSION_COOKIE]);
    req.sessionDirty = false;
  });
  app.addHook('onSend', async (req, reply) => {
    if (!req.sessionDirty) return;
    if (Object.keys(req.session).length === 0) {
      reply.clearCookie(SESSION_COOKIE, { path: '/api' });
    } else {
      reply.setCookie(SESSION_COOKIE, codec.seal(req.session), {
        path: '/api',
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'lax',
        maxAge: SESSION_MAX_AGE_S,
      });
    }
  });
  const save = (req: FastifyRequest, s: Session) => {
    req.session = s;
    req.sessionDirty = true;
  };

  // CSRF: cookies are SameSite=Lax; state-changing calls must also carry a custom header,
  // which a cross-site form post cannot set.
  app.addHook('preHandler', async (req, reply) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && req.headers['x-ivy-csrf'] !== '1') {
      return fail(reply, 403, 'BAD_REQUEST', 'Missing CSRF header');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ReauthRequired) {
      save(req, {}); // drop dead tokens
      return fail(reply, 401, 'REAUTH_REQUIRED', 'Google Drive access expired or was revoked. Please reconnect.');
    }
    if (err instanceof DriveRateLimited) {
      reply.header('retry-after', '10');
      return fail(reply, 503, 'DRIVE_RATE_LIMITED', 'Google Drive is rate limiting requests; try again shortly');
    }
    if (err instanceof DriveUnavailable) return fail(reply, 503, 'DRIVE_UNAVAILABLE', 'Google Drive is unavailable; try again shortly');
    if (err instanceof DriveNotFound) return fail(reply, 404, 'NOT_FOUND', err.message);
    if (err instanceof BackupTooLarge) return fail(reply, 413, 'BACKUP_TOO_LARGE', err.message);
    if (err instanceof InvalidBackupZip) return fail(reply, 422, 'INVALID_BACKUP_ZIP', err.message);
    const e = err as Error;
    app.log.error({ err: { message: e.message, stack: e.stack } }, 'unhandled');
    return fail(reply, 500, 'INTERNAL', 'Internal error');
  });

  /** Valid access token for this session, refreshing (and re-saving the cookie) when needed. */
  const accessTokenFor = (req: FastifyRequest) => async () => {
    const s = req.session;
    if (s.accessToken && s.accessExpiresAt && s.accessExpiresAt - 60_000 > Date.now()) return s.accessToken;
    if (!s.refreshToken) throw new ReauthRequired();
    const t = await oauth.refresh(s.refreshToken);
    save(req, { ...s, accessToken: t.accessToken, accessExpiresAt: t.expiresAt, refreshToken: t.refreshToken ?? s.refreshToken });
    return t.accessToken;
  };

  const requireUser = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!req.session.sub) {
      fail(reply, 401, 'UNAUTHENTICATED', 'Sign in with Google first');
      return false;
    }
    return true;
  };

  // ---- health ----
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => ({ ok: true }));

  // ---- auth ----
  app.get('/api/auth/login', async (req, reply) => {
    const state = newState();
    const verifier = newVerifier();
    save(req, { ...req.session, oauth: { state, verifier, createdAt: Date.now() } });
    return reply.redirect(oauth.authUrl(state, verifier));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/callback', async (req, reply) => {
    const pending = req.session.oauth;
    const back = (err?: string) => reply.redirect(`${config.publicBaseUrl}/${err ? `?authError=${encodeURIComponent(err)}` : ''}`);
    if (req.query.error) return back(req.query.error);
    if (!pending || !req.query.code || req.query.state !== pending.state || Date.now() - pending.createdAt > OAUTH_TTL_MS) {
      save(req, {});
      return back('invalid_state');
    }
    const tokens = await oauth.exchangeCode(req.query.code, pending.verifier);
    const user = await oauth.userinfo(tokens.accessToken);
    save(req, {
      sub: user.sub,
      ...(user.email ? { email: user.email } : {}),
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.expiresAt,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    });
    return back();
  });

  app.post('/api/auth/logout', async (req) => {
    save(req, {});
    return { ok: true };
  });

  app.get('/api/me', async (req): Promise<Me> => {
    const s = req.session;
    return {
      signedIn: Boolean(s.sub),
      ...(s.email ? { email: s.email } : {}),
      ...(s.folderId ? { folderId: s.folderId } : {}),
      ...(s.folderName ? { folderName: s.folderName } : {}),
    };
  });

  // ---- drive ----
  app.get<{ Querystring: { q?: string } }>('/api/drive/folders', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return makeDrive(accessTokenFor(req)).listFolders(req.query.q ?? '');
  });

  app.put<{ Body: { folderId?: string } }>('/api/drive/folder', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const folderId = req.body?.folderId;
    if (!folderId || !/^[\w-]{10,}$/.test(folderId)) return fail(reply, 400, 'BAD_REQUEST', 'folderId is required');
    const folderName = await makeDrive(accessTokenFor(req)).folderName(folderId);
    save(req, { ...req.session, folderId, folderName });
    return { folderId, folderName };
  });

  app.get('/api/backups', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    if (!req.session.folderId) return fail(reply, 409, 'FOLDER_NOT_SET', 'Choose your Ivy Wallet backup folder first');
    return makeDrive(accessTokenFor(req)).listBackups(req.session.folderId);
  });

  /**
   * Reports for one backup. drive-sync owns "which bytes"; analytics owns "what they mean".
   * Dataset key = sha256(user sub, fileId, Drive md5) so users never share a cache entry and a
   * changed file gets a fresh key. On analytics 404 (evicted / pod restarted) we re-upload once.
   */
  app.get<{ Params: { fileId: string; report: string }; Querystring: Record<string, string> }>(
    '/api/backups/:fileId/:report',
    async (req, reply) => {
      if (!requireUser(req, reply)) return;
      const { fileId, report } = req.params;
      if (!REPORTS.has(report)) return fail(reply, 404, 'NOT_FOUND', 'Unknown report');
      const folderId = req.session.folderId;
      if (!folderId) return fail(reply, 409, 'FOLDER_NOT_SET', 'Choose your Ivy Wallet backup folder first');

      const drive = makeDrive(accessTokenFor(req));
      const meta = await drive.meta(fileId);
      if (!meta.parents.includes(folderId)) return fail(reply, 404, 'NOT_FOUND', 'Backup not found in your folder');

      const key = createHash('sha256')
        .update(`${req.session.sub}\0${meta.id}\0${meta.md5Checksum ?? meta.modifiedTime}`)
        .digest('hex');
      const query = new URLSearchParams(req.query);

      let res = await analytics.report(key, report, query);
      if (res.status === 404) {
        const zipBytes = await drive.download(meta, config.maxBackupBytes);
        const json = extractBackupJson(zipBytes, meta.name);
        const ingested = await analytics.ingest(key, json);
        if (ingested.status >= 400) return reply.code(ingested.status).send(ingested.body);
        res = await analytics.report(key, report, query);
      }
      return reply.code(res.status).send(res.body);
    },
  );

  return app;
}
