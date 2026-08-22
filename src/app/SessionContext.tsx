import { createContext, useContext, type ReactNode } from 'react';
import type { EngineStatus, Merchant } from '@/domain';
import { data } from '@/data';
import { useQuery } from '@/hooks/useQuery';

interface SessionValue {
  merchant: Merchant | null;
  engine: EngineStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Merchant identity and engine health, fetched once for the whole shell. The
 * sidebar and topbar both need them, and neither should trigger its own load.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const merchant = useQuery(() => data.system.getMerchant(), []);
  const engine = useQuery(() => data.system.getEngineStatus(), []);

  const value: SessionValue = {
    merchant: merchant.data,
    engine: engine.data,
    loading: merchant.loading || engine.loading,
    error: merchant.error ?? engine.error,
    refresh: () => {
      merchant.refetch();
      engine.refetch();
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
