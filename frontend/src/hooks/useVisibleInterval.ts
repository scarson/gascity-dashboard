import { useEffect, useRef } from 'react';

export function useVisibleInterval(
  callback: () => void,
  intervalMs: number,
  enabled = true,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (!document.hidden) callbackRef.current();
    };
    const interval = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(interval);
  }, [enabled, intervalMs]);
}
