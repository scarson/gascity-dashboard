import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// Theme is one of three values:
//   'light'  — operator pinned light, overrides system.
//   'dark'   — operator pinned dark, overrides system.
//   'system' — follow prefers-color-scheme live.
//
// The pinned value is mirrored to <html data-theme="..."> so the CSS
// in styles/index.css can resolve tokens deterministically. When the
// operator picks 'system', the attribute is removed and the CSS falls
// back to the prefers-color-scheme media query.
//
// An inline script in index.html sets data-theme before paint to
// avoid a flash of the wrong theme on first load.

export type ThemePref = 'light' | 'dark' | 'system';
export type ThemeResolved = 'light' | 'dark';

interface ThemeContextValue {
  pref: ThemePref;
  resolved: ThemeResolved;
  set: (next: ThemePref) => void;
  toggle: () => void;
}

const STORAGE_KEY = 'gascity:theme';

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredPref(): ThemePref {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    /* storage may be blocked */
  }
  return 'system';
}

function readSystemResolved(): ThemeResolved {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyDocumentAttr(pref: ThemePref) {
  const el = document.documentElement;
  if (pref === 'system') {
    el.removeAttribute('data-theme');
  } else {
    el.setAttribute('data-theme', pref);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<ThemePref>(readStoredPref);
  const [system, setSystem] = useState<ThemeResolved>(readSystemResolved);

  // Track system theme live so 'system' mode follows it.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: ThemeResolved = pref === 'system' ? system : pref;

  const set = useCallback((next: ThemePref) => {
    setPref(next);
    try {
      if (next === 'system') {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      /* no-op */
    }
    applyDocumentAttr(next);
  }, []);

  // The header's toggle cycles between Light and Dark explicitly.
  // 'system' is reachable only via menu (not built yet) or by clearing
  // localStorage; that's the right shape because most operators want
  // to pin a choice once.
  const toggle = useCallback(() => {
    set(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, set]);

  const value = useMemo<ThemeContextValue>(
    () => ({ pref, resolved, set, toggle }),
    [pref, resolved, set, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}
