import { createHash, randomBytes } from 'node:crypto';

/**
 * Google OAuth 2.0 authorization-code flow with PKCE, done with plain fetch
 * (no googleapis SDK: smaller image, smaller attack surface).
 *
 * Scope is drive.readonly: the app can never modify or delete anything in Drive.
 */
export const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly'];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export class ReauthRequired extends Error {
  constructor(message = 'Google access expired or was revoked') {
    super(message);
    this.name = 'ReauthRequired';
  }
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

export const newState = () => randomBytes(24).toString('base64url');
export const newVerifier = () => randomBytes(48).toString('base64url');
export const challengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export class GoogleOAuth {
  constructor(
    private readonly cfg: GoogleOAuthConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  authUrl(state: string, verifier: string): string {
    const p = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      state,
      code_challenge: challengeFor(verifier),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
    });
    return `${AUTH_URL}?${p}`;
  }

  private async token(params: Record<string, string>): Promise<TokenSet> {
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // invalid_grant = refresh token revoked/expired -> user must reconnect
      if (body.error === 'invalid_grant' || res.status === 400 || res.status === 401) throw new ReauthRequired();
      throw new Error(`Token endpoint HTTP ${res.status}`);
    }
    return {
      accessToken: String(body.access_token),
      expiresAt: this.now() + Number(body.expires_in ?? 3600) * 1000,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    };
  }

  exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    return this.token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: this.cfg.redirectUri });
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async userinfo(accessToken: string): Promise<{ sub: string; email?: string }> {
    const res = await this.fetchFn(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new ReauthRequired();
    return (await res.json()) as { sub: string; email?: string };
  }
}
