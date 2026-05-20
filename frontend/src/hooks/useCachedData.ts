import { useCallback, useEffect, useRef, useState } from 'react';
import { getCached, setCached } from '../api/cache';

interface UseCachedDataResult<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Stale-while-revalidate fetch hook. On mount:
 *   - If the cache has the key: seed state with cached data and
 *     render synchronously, then kick off a background refresh.
 *   - Otherwise: render loading=true and fetch.
 *
 * `key` changes (e.g. params shift) reseed from cache for the new
 * key and refetch. `fetcher` is captured in a ref so callers don't
 * need to memoize it to avoid refetch loops — refetches only fire
 * on key change or explicit refresh().
 */
export function useCachedData<T>(
  key: string,
  fetcher: () => Promise<T>,
): UseCachedDataResult<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [data, setData] = useState<T | undefined>(() => getCached<T>(key));
  const [loading, setLoading] = useState<boolean>(() => getCached<T>(key) === undefined);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fresh = await fetcherRef.current();
      setCached(key, fresh);
      setData(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    const cached = getCached<T>(key);
    setData(cached);
    setLoading(cached === undefined);
    void refresh();
  }, [key, refresh]);

  return { data, loading, error, refresh };
}
