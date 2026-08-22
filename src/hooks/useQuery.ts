import { useCallback, useEffect, useRef, useState } from 'react';

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  /** True only on the first load; refreshes keep the previous data visible. */
  loading: boolean;
  refreshing: boolean;
  refetch: () => void;
}

/**
 * Minimal async read hook. Deliberately not a cache: every screen states its
 * own dependencies, and stale data is never shown without a refreshing flag.
 * Results from superseded requests are dropped rather than rendered.
 */
export function useQuery<T>(fetcher: () => Promise<T>, deps: readonly unknown[]): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Guards against a slow first request overwriting a newer one.
  const requestId = useRef(0);
  const hasLoaded = useRef(false);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const current = ++requestId.current;
    let active = true;

    if (hasLoaded.current) setRefreshing(true);
    else setLoading(true);

    fetcher()
      .then((result) => {
        if (!active || current !== requestId.current) return;
        setData(result);
        setError(null);
        hasLoaded.current = true;
      })
      .catch((cause: unknown) => {
        if (!active || current !== requestId.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!active || current !== requestId.current) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, refreshing, refetch };
}
