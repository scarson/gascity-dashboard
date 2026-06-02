import type {
  FormulaRunDetail,
  RunScopeKind,
} from 'gas-city-dashboard-shared';
import { errorMessage } from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { reportClientError } from '../lib/clientErrorReporting';
import { useCachedData } from './useCachedData';

interface FormulaRunDetailState {
  kind: 'idle' | 'loading' | 'ready' | 'failed';
  refresh: () => Promise<void>;
}

type FormulaRunRefreshState =
  | { kind: 'idle' }
  | { kind: 'refreshing' }
  | { kind: 'failed'; error: string };

type FormulaRunDetailPayload =
  | { kind: 'unrequested' }
  | {
      kind: 'loaded';
      detail: FormulaRunDetail;
    };

export type FormulaRunDetailLoadState =
  | (FormulaRunDetailState & { kind: 'idle' })
  | (FormulaRunDetailState & { kind: 'loading' })
  | (FormulaRunDetailState & {
      kind: 'ready';
      detail: FormulaRunDetail;
      refreshState: FormulaRunRefreshState;
    })
  | (FormulaRunDetailState & { kind: 'failed'; error: string });

export function useFormulaRunDetail(
  runId: string | undefined,
  scopeKind?: RunScopeKind,
  scopeRef?: string,
): FormulaRunDetailLoadState {
  const key = formulaRunDetailCacheKey(runId, scopeKind, scopeRef);
  const { data, loading, error, refresh } = useCachedData(
    key,
    () => loadFormulaRunDetail(runId, scopeKind, scopeRef),
    {
      // Explicit refresh (manual button + SSE bead events) forces the backend
      // run-detail cache to re-fetch from the supervisor rather than serving a
      // cached assemble (gascity-dashboard-wqsk).
      refreshFetcher: () => loadFormulaRunDetail(runId, scopeKind, scopeRef, true),
      onError: (err) => {
        if (runId !== undefined) reportRunDetailError('load detail', runId, err);
      },
    },
  );

  if (runId === undefined) return { kind: 'idle', refresh: noopRefresh };
  if (data?.kind === 'loaded') {
    return {
      kind: 'ready',
      detail: data.detail,
      refresh,
      refreshState: refreshState(loading, error),
    };
  }
  if (error !== null) return { kind: 'failed', error, refresh };
  return { kind: 'loading', refresh };
}

async function loadFormulaRunDetail(
  runId: string | undefined,
  scopeKind?: RunScopeKind,
  scopeRef?: string,
  refresh?: boolean,
): Promise<FormulaRunDetailPayload> {
  if (!runId) return { kind: 'unrequested' };
  const params: { scopeKind?: RunScopeKind; scopeRef?: string; refresh?: boolean } = {};
  if (scopeKind !== undefined) params.scopeKind = scopeKind;
  if (scopeRef !== undefined) params.scopeRef = scopeRef;
  if (refresh) params.refresh = true;
  const detail = await api.formulaRun(runId, params);
  return { kind: 'loaded', detail };
}

async function noopRefresh(): Promise<void> {}

function refreshState(
  loading: boolean,
  error: string | null,
): FormulaRunRefreshState {
  if (error !== null) return { kind: 'failed', error };
  return loading ? { kind: 'refreshing' } : { kind: 'idle' };
}

function reportRunDetailError(
  operation: string,
  runId: string,
  err: unknown,
): void {
  void reportClientError({
    component: 'formula-run-detail',
    operation,
    message: `${runId}: ${errorMessage(err)}`,
  });
}

function formulaRunDetailCacheKey(
  runId: string | undefined,
  scopeKind?: RunScopeKind,
  scopeRef?: string,
): string {
  const parts = [
    'formula-run',
    runId ?? 'missing',
    scopeKind ?? 'default',
    scopeRef ?? 'default',
  ];
  return parts.join(':');
}
