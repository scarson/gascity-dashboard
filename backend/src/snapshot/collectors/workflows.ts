import type { WorkflowSummary } from 'gas-city-dashboard-shared';
import { SourceCache } from '../cache.js';

// STUB workflows collector — gascity-dashboard-8nj wires this so the
// SnapshotService composes a fully-keyed DashboardSources. The real
// collector logic (lane composition from beads, phase mapping, run counts)
// lands in gascity-dashboard-0t6 (WorkflowMap port). Until then we return
// a zeroed WorkflowSummary so the route serves a valid envelope and the
// frontend's empty-state rendering is exercised.

export const WORKFLOWS_CACHE_TTL_MS = 60 * 1000;

export interface CreateWorkflowsSourceCacheOptions {
  now?: () => Date;
  loadFixture?: () => Promise<WorkflowSummary> | WorkflowSummary;
  useFixture?: boolean;
  /** Test seam: override the loader (real impl lands in 0t6). */
  load?: () => Promise<WorkflowSummary> | WorkflowSummary;
}

export function emptyWorkflowSummary(): WorkflowSummary {
  return {
    totalActive: 0,
    runCounts: {
      total: 0,
      visible: 0,
      prReview: 0,
      designReview: 0,
      bugfix: 0,
      blocked: 0,
      other: 0,
    },
    lanes: [],
    recentChanges: [],
  };
}

export function createWorkflowsSourceCache(
  options: CreateWorkflowsSourceCacheOptions = {},
): SourceCache<WorkflowSummary> {
  return new SourceCache<WorkflowSummary>({
    source: 'workflows',
    ttlMs: WORKFLOWS_CACHE_TTL_MS,
    now: options.now,
    load: options.load ?? (() => emptyWorkflowSummary()),
    loadFixture: options.loadFixture,
    useFixture: options.useFixture,
  });
}
