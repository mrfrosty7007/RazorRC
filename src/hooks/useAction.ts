import { useCallback, useState } from 'react';

export interface ActionState {
  /** Identifier of the item currently being written, if any. */
  pendingId: string | null;
  error: string | null;
  clearError: () => void;
}

/**
 * Wraps a single write. Tracks which row is in flight so a table can disable
 * just that row's controls instead of blocking the whole screen.
 */
export function useAction<Args extends unknown[]>(
  perform: (...args: Args) => Promise<unknown>,
  onDone?: () => void,
): [(id: string, ...args: Args) => Promise<void>, ActionState] {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (id: string, ...args: Args) => {
      setPendingId(id);
      setError(null);
      try {
        await perform(...args);
        onDone?.();
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPendingId(null);
      }
    },
    [perform, onDone],
  );

  return [run, { pendingId, error, clearError: () => setError(null) }];
}
