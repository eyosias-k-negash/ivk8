import type { BackupFile, DriveFolder } from '@ivy/contracts';
import { ReauthRequired } from '../auth/google';

/**
 * Minimal Drive v3 client (read-only). Handles:
 * - rate limits / outages: retry 429, 5xx and 403 rate-limit reasons with exponential backoff + jitter
 * - size limit: refuses files whose metadata size exceeds the cap, and aborts streaming past it
 * - auth: 401 -> ReauthRequired (the UI asks the user to reconnect)
 */
const API = 'https://www.googleapis.com/drive/v3';

export class DriveRateLimited extends Error {}
export class DriveUnavailable extends Error {}
export class DriveNotFound extends Error {}
export class BackupTooLarge extends Error {}

export interface FileMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  md5Checksum?: string;
  modifiedTime: string;
  parents: string[];
}

export interface DriveClientOptions {
  fetchFn?: typeof fetch;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export class DriveClient {
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly accessToken: () => Promise<string>,
    opts: DriveClientOptions = {},
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 300;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request(path: string, params: Record<string, string> = {}): Promise<Response> {
    const url = `${API}${path}?${new URLSearchParams(params)}`;
    let lastErr: Error = new DriveUnavailable('Drive unavailable');
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random()));
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: { authorization: `Bearer ${await this.accessToken()}` },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        lastErr = new DriveUnavailable('Drive request failed');
        continue;
      }
      if (res.ok) return res;
      if (res.status === 401) throw new ReauthRequired();
      if (res.status === 404) throw new DriveNotFound('File not found');

      let reason = '';
      if (res.status === 403) {
        const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[] } };
        reason = body.error?.errors?.[0]?.reason ?? '';
        if (!RATE_LIMIT_REASONS.has(reason)) throw new ReauthRequired('Drive access denied; reconnect Google Drive');
      }
      if (res.status === 429 || RATE_LIMIT_REASONS.has(reason)) lastErr = new DriveRateLimited('Drive rate limit hit');
      else if (res.status >= 500) lastErr = new DriveUnavailable(`Drive HTTP ${res.status}`);
      else throw new Error(`Drive HTTP ${res.status}`);
    }
    throw lastErr;
  }

  async listFolders(nameContains = ''): Promise<DriveFolder[]> {
    const filter = ["mimeType='application/vnd.google-apps.folder'", 'trashed=false'];
    if (nameContains) filter.push(`name contains '${q(nameContains)}'`);
    const res = await this.request('/files', {
      q: filter.join(' and '),
      fields: 'files(id,name)',
      pageSize: '50',
      orderBy: 'name',
    });
    const body = (await res.json()) as { files: DriveFolder[] };
    return body.files;
  }

  async folderName(folderId: string): Promise<string> {
    const res = await this.request(`/files/${encodeURIComponent(folderId)}`, { fields: 'id,name,mimeType' });
    const body = (await res.json()) as { name: string; mimeType: string };
    if (body.mimeType !== 'application/vnd.google-apps.folder') throw new DriveNotFound('Not a folder');
    return body.name;
  }

  /** Every backup version in the folder, newest first. */
  async listBackups(folderId: string): Promise<BackupFile[]> {
    const out: BackupFile[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.request('/files', {
        q: `'${q(folderId)}' in parents and trashed=false and (mimeType='application/json' or name contains '.json')`,
        fields: 'nextPageToken,files(id,name,modifiedTime,size)',
        orderBy: 'modifiedTime desc',
        pageSize: '100',
        ...(pageToken ? { pageToken } : {}),
      });
      const body = (await res.json()) as {
        nextPageToken?: string;
        files: { id: string; name: string; modifiedTime: string; size?: string }[];
      };
      for (const f of body.files)
        out.push({ fileId: f.id, name: f.name, modifiedTime: f.modifiedTime, sizeBytes: Number(f.size ?? 0) });
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  async meta(fileId: string): Promise<FileMeta> {
    const res = await this.request(`/files/${encodeURIComponent(fileId)}`, {
      fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,parents',
    });
    const b = (await res.json()) as Omit<FileMeta, 'size' | 'parents'> & { size?: string; parents?: string[] };
    return { ...b, size: Number(b.size ?? 0), parents: b.parents ?? [] };
  }

  /** Download file bytes, enforcing maxBytes both up front and while streaming. */
  async download(meta: FileMeta, maxBytes: number): Promise<Buffer> {
    if (meta.size > maxBytes) throw new BackupTooLarge(`Backup is ${meta.size} bytes; limit is ${maxBytes}`);
    const res = await this.request(`/files/${encodeURIComponent(meta.id)}`, { alt: 'media' });
    if (!res.body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new BackupTooLarge(`Backup exceeds limit of ${maxBytes} bytes`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
