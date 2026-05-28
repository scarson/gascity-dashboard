import { act, cleanup, renderHook } from '@testing-library/react';
import type { TranscriptResult } from 'gas-city-dashboard-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { useSessionStream } from './useSessionStream';

vi.mock('../api/client', () => ({
  api: {
    peekSession: vi.fn(),
    sessionStreamUrl: vi.fn((sessionId: string) => `/api/sessions/${sessionId}/stream`),
  },
}));

const eventSources: FakeEventSource[] = [];

const transcript: TranscriptResult = {
  session_id: 'gc-session-1',
  turns: [{ role: 'assistant', text: 'initial' }],
  total_chars: 7,
  captured_at: '2026-05-27T10:00:00Z',
  truncated: false,
  format: 'conversation',
};

describe('useSessionStream', () => {
  beforeEach(() => {
    eventSources.length = 0;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(api.peekSession).mockReset();
    vi.mocked(api.sessionStreamUrl).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('returns explicit idle state when no session is selected', () => {
    const { result } = renderHook(() => useSessionStream(null, true));

    expect(result.current).toEqual({
      status: 'idle',
      stream: { status: 'idle' },
    });
  });

  it('loads the snapshot, opens the stream, and appends turn frames', async () => {
    vi.mocked(api.peekSession).mockResolvedValue(transcript);

    const { result } = renderHook(() => useSessionStream('gc-session-1', true));

    expect(result.current).toEqual({
      status: 'loading',
      stream: { status: 'connecting' },
    });

    await flush();
    expect(result.current).toMatchObject({
      status: 'ready',
      result: transcript,
      stream: { status: 'connecting' },
    });

    act(() => eventSources[0]?.open());
    expect(result.current).toMatchObject({
      status: 'ready',
      stream: { status: 'open' },
    });

    act(() => eventSources[0]?.emit('message', JSON.stringify({
      role: 'assistant',
      text: 'streamed',
    })));
    expect(result.current.status).toBe('ready');
    if (result.current.status !== 'ready') return;
    expect(result.current.result.turns).toHaveLength(2);
    expect(result.current.result.turns.at(-1)).toEqual({
      role: 'assistant',
      text: 'streamed',
    });
    expect(result.current.result.total_chars).toBe(15);
  });

  it('keeps the transcript visible while surfacing malformed stream frames', async () => {
    vi.mocked(api.peekSession).mockResolvedValue(transcript);

    const { result } = renderHook(() => useSessionStream('gc-session-1', true));
    await flush();
    act(() => eventSources[0]?.open());
    act(() => eventSources[0]?.emit('message', 'not json'));

    expect(result.current.status).toBe('ready');
    if (result.current.status !== 'ready') return;
    expect(result.current.result).toEqual(transcript);
    expect(result.current.stream).toEqual({
      status: 'degraded',
      error: 'Malformed session stream event.',
    });
  });

  it('reports initial transcript load failure without nullable result fields', async () => {
    vi.mocked(api.peekSession).mockRejectedValue(new Error('peek failed'));

    const { result } = renderHook(() => useSessionStream('gc-session-1', true));
    await flush();

    expect(result.current).toEqual({
      status: 'failed',
      error: 'peek failed',
      stream: { status: 'idle' },
    });
  });
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeEventSource.CONNECTING;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(readonly url: string | URL) {
    eventSources.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  emit(type: string, data: string): void {
    const event = new MessageEvent<string>(type, { data });
    this.listeners.get(type)?.forEach((listener) => listener(event));
    if (type === 'message') this.onmessage?.(event);
  }
}
