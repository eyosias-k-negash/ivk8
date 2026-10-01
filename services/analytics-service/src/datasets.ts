import type { Dataset } from './engine/loader';

/**
 * In-memory LRU of parsed datasets, keyed by an opaque key chosen by drive-sync
 * (sha256 of user + fileId + Drive md5). No persistence: a pod restart or eviction
 * just means drive-sync re-uploads the backup on the next 404.
 */
export class DatasetCache {
  private readonly map = new Map<string, { ds: Dataset; expires: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): Dataset | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency + TTL
    this.map.delete(key);
    this.map.set(key, { ds: hit.ds, expires: this.now() + this.ttlMs });
    return hit.ds;
  }

  set(key: string, ds: Dataset): void {
    this.map.delete(key);
    this.map.set(key, { ds, expires: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
