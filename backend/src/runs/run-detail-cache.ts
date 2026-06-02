// Per-key TTL + single-flight + stale-while-revalidate cache for run-detail
// reads (gascity-dashboard-wqsk).
//
// The gc supervisor's single-run endpoint (GET /v0/city/{name}/workflow/{id})
// scans every store in the city to assemble one run — 2–4s for a tiny run,
// worse under load. The run-detail route paid that on every navigation. This
// cache keys assembled detail by runId+scope and serves repeat reads from
// memory, collapsing the supervisor scan to at most one per TTL per run.
//
// Why a bespoke cache and not SourceCache: SourceCache (snapshot/cache.ts) is
// single-entry and bound to the fixed SourceName enum + SourceState wire shape.
// Run detail is keyed by an unbounded (runId, scope) space, so it needs a Map.
// The stale-while-revalidate + single-flight semantics mirror SourceCache.get()
// deliberately so the two caches behave the same way under load.

export interface KeyedSwrCacheOptions {
  /** Entries older than this are stale and trigger a background revalidate. */
  ttlMs: number;
  /** Injectable clock for tests. Defaults to wall-clock epoch millis. */
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  fetchedAtMs: number;
}

export class KeyedSwrCache<T> {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry<T>>();
  // Single-flight per key: concurrent loads (or a stale read's background
  // revalidate racing a forced read) share one in-flight promise so the
  // supervisor is hit once, not once per caller.
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(options: KeyedSwrCacheOptions) {
    if (options.ttlMs <= 0 || !Number.isFinite(options.ttlMs)) {
      throw new Error('KeyedSwrCache ttlMs must be a positive finite number.');
    }
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Resolve `key`, loading via `load` only when necessary:
   *   - fresh entry (within TTL)  → return it, no load
   *   - stale entry               → return it immediately, revalidate in background
   *   - cold (no entry) or force  → await a fresh load
   *
   * `load` failures are never cached: a cold failure rejects to the caller; a
   * background-revalidation failure is swallowed so the last good value keeps
   * being served (the route surfaces upstream errors on the cold path).
   */
  async get(key: string, load: () => Promise<T>, options: { force?: boolean } = {}): Promise<T> {
    const entry = this.entries.get(key);

    if (!options.force && entry !== undefined) {
      const fresh = this.now() - entry.fetchedAtMs < this.ttlMs;
      if (fresh) return entry.value;
      // Stale: serve the prior value now, refresh out of band.
      void this.revalidate(key, load).catch(() => {
        // Swallow — the stale entry remains valid to serve and the next
        // stale read retries. Mirrors SourceCache's background-refresh guard.
      });
      return entry.value;
    }

    return await this.revalidate(key, load);
  }

  private revalidate(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;

    const promise = (async () => {
      const value = await load();
      this.entries.set(key, { value, fetchedAtMs: this.now() });
      return value;
    })().finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return promise;
  }
}
