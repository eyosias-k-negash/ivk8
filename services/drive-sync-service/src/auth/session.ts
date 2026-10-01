import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Stateless session: the whole session (incl. the Google refresh token) lives in an
 * AES-256-GCM encrypted, httpOnly cookie. No database, no Redis, any replica can serve
 * any request. Rotating SESSION_SECRET signs everyone out (by design).
 */
export interface Session {
  sub?: string;
  email?: string;
  refreshToken?: string;
  accessToken?: string;
  /** epoch ms */
  accessExpiresAt?: number;
  folderId?: string;
  folderName?: string;
  /** In-flight OAuth handshake (state + PKCE verifier). Cleared after callback. */
  oauth?: { state: string; verifier: string; createdAt: number };
}

export const SESSION_COOKIE = 'ivy_session';
/** Absolute session lifetime. Google refresh tokens may live longer; we re-auth anyway. */
export const SESSION_MAX_AGE_S = 7 * 24 * 3600;

export class SessionCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'ivy-wallet-plus', 'session-cookie-v1', 32));
  }

  seal(s: Session): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(s), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  /** Returns an empty session for missing, tampered or undecryptable cookies. */
  open(token: string | undefined): Session {
    if (!token) return {};
    try {
      const raw = Buffer.from(token, 'base64url');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const body = raw.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      return JSON.parse(json) as Session;
    } catch {
      return {};
    }
  }
}
