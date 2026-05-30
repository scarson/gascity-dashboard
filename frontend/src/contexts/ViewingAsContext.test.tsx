import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { useEffect } from 'react';
import { api } from '../api/client';
import { ViewingAsProvider, useViewingAs, getSessionsRetryDelay } from './ViewingAsContext';

// gascity-dashboard-5gg: bounded retry for /api/sessions in the alias
// prefetch. Tests cover:
//
//   1. Initial fetch failure flips sessionsUnavailable=true.
//   2. Three retries are scheduled at 30s, 90s, 270s after each prior
//      failure; no retry fires earlier.
//   3. A successful retry flips sessionsUnavailable back to false.
//   4. After the third failed retry, no further attempts are made
//      (sticky failure matches current behaviour).
//   5. Unmounting between retries cancels the pending timer (no late
//      state updates, no leaked timeouts).
//
// We mock `../api/client` so listSessions/listMail return shaped
// promises under our control. listMail is not retried — only sessions
// has the bounded retry.

vi.mock('../api/client', () => ({
  api: {
    listSessions: vi.fn(),
    listMail: vi.fn(),
  },
  ApiClientError: class extends Error {},
}));

const mockListSessions = api.listSessions as Mock;
const mockListMail = api.listMail as Mock;

interface Probe {
  sessionsUnavailable: boolean;
  aliasesLoading: boolean;
}

function Harness({ onState }: { onState: (p: Probe) => void }) {
  const { sessionsUnavailable, aliasesLoading, loadAliases } = useViewingAs();
  useEffect(() => {
    loadAliases();
  }, [loadAliases]);
  useEffect(() => {
    onState({ sessionsUnavailable, aliasesLoading });
  }, [sessionsUnavailable, aliasesLoading, onState]);
  return null;
}

async function flushPromises() {
  // Vitest fake timers don't drain microtasks; wrap a real-clock yield
  // so awaited `.then()` callbacks on resolved promises run.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockListSessions.mockReset();
  mockListMail.mockReset();
  // Mail fetch is uninteresting for these tests; resolve to empty.
  mockListMail.mockResolvedValue({ items: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ViewingAsProvider — bounded sessions retry', () => {
  it('flips sessionsUnavailable=true on initial /api/sessions failure', async () => {
    mockListSessions.mockRejectedValue(new Error('upstream 504'));
    const states: Probe[] = [];
    render(
      <ViewingAsProvider>
        <Harness onState={(p) => states.push(p)} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(states.at(-1)?.sessionsUnavailable).toBe(true);
  });

  it('does not retry before the 30s mark', async () => {
    mockListSessions.mockRejectedValue(new Error('upstream 504'));
    render(
      <ViewingAsProvider>
        <Harness onState={() => {}} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);
    // Advance just under the first retry window.
    await act(async () => {
      vi.advanceTimersByTime(29_999);
    });
    expect(mockListSessions).toHaveBeenCalledTimes(1);
  });

  it('retries at 30s, 90s, and 270s after successive failures', async () => {
    mockListSessions.mockRejectedValue(new Error('upstream 504'));
    render(
      <ViewingAsProvider>
        <Harness onState={() => {}} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);

    // First retry at 30s.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(2);

    // Second retry at 30s + 90s.
    await act(async () => {
      vi.advanceTimersByTime(90_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(3);

    // Third retry at 30s + 90s + 270s.
    await act(async () => {
      vi.advanceTimersByTime(270_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(4);
  });

  it('flips sessionsUnavailable=false when a retry succeeds', async () => {
    mockListSessions
      .mockRejectedValueOnce(new Error('upstream 504'))
      .mockResolvedValueOnce({ items: [{ alias: 'mechanic' }] });

    const states: Probe[] = [];
    render(
      <ViewingAsProvider>
        <Harness onState={(p) => states.push(p)} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(states.at(-1)?.sessionsUnavailable).toBe(true);

    // First retry at 30s — succeeds this time.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flushPromises();
    expect(states.at(-1)?.sessionsUnavailable).toBe(false);
  });

  it('stops retrying after the third failed attempt (sticky failure)', async () => {
    mockListSessions.mockRejectedValue(new Error('upstream 504'));
    render(
      <ViewingAsProvider>
        <Harness onState={() => {}} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);

    // Exhaust all three retries.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(90_000);
    });
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(270_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(4); // initial + 3 retries

    // No further calls even after a long quiet period.
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(4);
  });

  it('cancels pending retry on unmount (no late /api/sessions call)', async () => {
    mockListSessions.mockRejectedValue(new Error('upstream 504'));
    const { unmount } = render(
      <ViewingAsProvider>
        <Harness onState={() => {}} />
      </ViewingAsProvider>,
    );
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);

    // Unmount before the 30s retry window elapses.
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);
  });
});

// gascity-dashboard-7s7: explicit coverage of the two acceptance criteria
// the bead enumerates but the retry-focused suite above does not test
// directly — first-shot sessions success leaves the flag false, and mail
// failure is independent of the sessions-side flag.
describe('ViewingAsProvider — loadAliases initial flag transitions', () => {
  it('leaves sessionsUnavailable=false when initial /api/sessions succeeds', async () => {
    mockListSessions.mockResolvedValue({ items: [{ alias: 'mechanic' }] });
    const states: Probe[] = [];
    render(
      <ViewingAsProvider>
        <Harness onState={(p) => states.push(p)} />
      </ViewingAsProvider>,
    );
    await flushPromises();

    // Flag stays false; success path never sets it.
    expect(states.at(-1)?.sessionsUnavailable).toBe(false);

    // No retry scheduled on success: advancing well past the first retry
    // delay must not trigger a second call.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);
  });

  it('leaves sessionsUnavailable=false when mail fetch fails but sessions succeeds', async () => {
    // Mail-side failure must NOT flip the sessions-side flag — the two
    // sources settle independently, and the flag is sessions-scoped.
    mockListSessions.mockResolvedValue({ items: [{ alias: 'mechanic' }] });
    mockListMail.mockRejectedValue(new Error('mail corpus 500'));

    const states: Probe[] = [];
    render(
      <ViewingAsProvider>
        <Harness onState={(p) => states.push(p)} />
      </ViewingAsProvider>,
    );
    await flushPromises();

    expect(states.at(-1)?.sessionsUnavailable).toBe(false);
    // Mail failure must not schedule a sessions retry either.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);
  });
});

// gascity-dashboard-7ky: the sessions retry table is read by index, and
// under `noUncheckedIndexedAccess` the read is typed `number | undefined`.
// If the caller's bounds check ever weakens, `setTimeout(fn, undefined)`
// would fire at 0 ms — a busy-loop retry storm. `getSessionsRetryDelay`
// is the safe accessor that returns `null` for any out-of-bounds index
// instead of leaking `undefined` to a timer.
describe('getSessionsRetryDelay — out-of-bounds guard', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns the scheduled delay for in-range indices', () => {
    expect(getSessionsRetryDelay(0)).toBe(30_000);
    expect(getSessionsRetryDelay(1)).toBe(90_000);
    expect(getSessionsRetryDelay(2)).toBe(270_000);
  });

  it('returns null (never undefined, never a fallback number) for an index just past the end', () => {
    const result = getSessionsRetryDelay(3);
    expect(result).toBeNull();
    // Critically: not undefined and not a number. A `setTimeout` call
    // with this value would no-op via the caller's `null` check rather
    // than fire at 0 ms.
    expect(result).not.toBe(undefined);
    expect(typeof result).not.toBe('number');
  });

  it('returns null for a large out-of-bounds index', () => {
    expect(getSessionsRetryDelay(99)).toBeNull();
  });

  it('returns null and warns for a negative index', () => {
    expect(getSessionsRetryDelay(-1)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/invalid index -1/);
  });

  it('returns null and warns for a non-integer index', () => {
    expect(getSessionsRetryDelay(1.5)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/invalid index 1.5/);
  });

  it('returns null and warns for NaN', () => {
    expect(getSessionsRetryDelay(Number.NaN)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
