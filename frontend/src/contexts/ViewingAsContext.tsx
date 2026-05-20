import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ViewingAs } from 'gas-city-dashboard-shared';

// Identity-switching for mail:
//
//   Frontend: visible "Reading as <agent>" strip with accent color when
//   ≠ the operator. The compose-from field is disabled while
//   impersonating. THE CONSTRAINT IS VISIBLE.
//
//   No client-side caching of mail under as-identity: Cache-Control:
//   no-store + no localStorage retention.
//
// We use sessionStorage so the chosen identity survives accidental page
// refresh in the same tab but does NOT persist beyond tab close — the
// "no retention" rule applies to cached mail bodies, not the user's
// chosen viewing context, but tab-scoped is friendlier here than fully
// transient.

const STORAGE_KEY = 'gascity.dashboard.viewingAs';
const OPERATOR = 'stephanie';

interface ViewingAsContextValue {
  viewingAs: ViewingAs;
  setAlias: (alias: string) => void;
  resetToOperator: () => void;
}

const Context = createContext<ViewingAsContextValue | null>(null);

function readStored(): string {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 64) return raw;
  } catch {
    /* sessionStorage may be unavailable */
  }
  return OPERATOR;
}

function writeStored(alias: string): void {
  try {
    if (alias === OPERATOR) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, alias);
    }
  } catch {
    /* no-op */
  }
}

export function ViewingAsProvider({ children }: { children: ReactNode }) {
  const [alias, setAliasState] = useState<string>(() => readStored());

  const setAlias = useCallback((next: string) => {
    setAliasState(next);
    writeStored(next);
  }, []);

  const resetToOperator = useCallback(() => {
    setAliasState(OPERATOR);
    writeStored(OPERATOR);
  }, []);

  const value = useMemo<ViewingAsContextValue>(() => ({
    viewingAs: { alias, isOperator: alias === OPERATOR },
    setAlias,
    resetToOperator,
  }), [alias, setAlias, resetToOperator]);

  // Strict: when the tab is hidden (parent walked away), revert to the
  // operator. Stops a forgotten "reading as X" state from being live the
  // next time someone glances at the laptop.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && alias !== OPERATOR) {
        setAliasState(OPERATOR);
        writeStored(OPERATOR);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [alias]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useViewingAs(): ViewingAsContextValue {
  const value = useContext(Context);
  if (value === null) {
    throw new Error('useViewingAs must be inside <ViewingAsProvider>');
  }
  return value;
}

export const OPERATOR_ALIAS = OPERATOR;
