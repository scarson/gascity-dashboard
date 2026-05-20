// Module-level in-memory cache for /api/* fetches. Pure dashboard
// session lifetime — no persistence, no TTL. The point is to make
// cross-route page swaps feel instant: when the operator navigates
// Agents → Beads → Agents, the second mount of Agents seeds from
// cache and renders immediately while a background refresh runs.
//
// Mutations call invalidate(prefix) so the next read fetches fresh.
// SSE-driven refreshes (useGcEventRefresh) and explicit user
// Refresh-button presses go through useCachedData.refresh(), which
// overwrites the cache slot in the same pass.

const cache = new Map<string, unknown>();

export function getCached<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

export function setCached<T>(key: string, value: T): void {
  cache.set(key, value);
}

/** Drop every cache entry whose key starts with the given prefix. */
export function invalidate(prefix: string): void {
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Drop a single cache entry by exact key. */
export function invalidateKey(key: string): void {
  cache.delete(key);
}
