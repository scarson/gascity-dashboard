import { useMemo } from 'react';
import type {
  DashboardSnapshot,
  WorkflowLane,
  WorkflowSummary,
} from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { PageHeader } from '../components/PageHeader';
import { ConcernRegion, type ConcernRow } from '../components/ambient/ConcernRegion';
import { PhaseCensus } from '../components/ambient/PhaseCensus';
import { StatusSentence } from '../components/ambient/StatusSentence';
import { useCachedData } from '../hooks/useCachedData';
import { useFaviconSignal } from '../hooks/useFaviconSignal';
import { useStaleness, type StalenessResult } from '../hooks/useStaleness';

// gascity-dashboard-kb3 — the L0 ambient home at `/`. PRD §4 + §5.
//
// Composes:
//   • PhaseCensus           — Line 1, the trust anchor pattern-match target.
//   • StatusSentence        — Line 2 with the single .text-accent run-id token.
//   • ConcernRegion         — opacity-materialized rows for items needing a decision.
//   • useFaviconSignal      — R8 hysteresis on the failing count.
//
// R10 (PRD §4 withholding contract): / NEVER lists a healthy in-flight
// run. The concern predicate is the gate; the sentence and the region
// both consume it.

function pickTopConcern(
  lanes: readonly WorkflowLane[],
  staleness: StalenessResult,
): { lane: WorkflowLane; ageMs: number } | undefined {
  // Rank-broken by oldest stall (PRD §4). Server's thrashing-detected
  // lanes outrank time-stalled because thrashing is the freshness-
  // independent server signal — but both already gated to known per R2.
  const candidates: { lane: WorkflowLane; ageMs: number; priority: number }[] = [];
  for (const lane of lanes) {
    if (lane.health.status !== 'available') continue;
    const known = lane.health.data.phaseConfidence === 'known';
    if (!known) continue;
    const ageMs = staleness.byLane.get(lane.id)?.ageMs ?? 0;
    if (lane.health.data.thrashingDetected) {
      candidates.push({ lane, ageMs, priority: 2 });
    } else if (staleness.byLane.get(lane.id)?.isStalled) {
      candidates.push({ lane, ageMs, priority: 1 });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.priority - a.priority || b.ageMs - a.ageMs);
  const top = candidates[0]!;
  return { lane: top.lane, ageMs: top.ageMs };
}

function buildConcernRows(
  lanes: readonly WorkflowLane[],
  staleness: StalenessResult,
  topConcernId: string | undefined,
): ConcernRow[] {
  // R10 predicate: needsOperator OR (known AND (thrashing OR client-stalled)).
  // The top-concern lane is already represented by the StatusSentence
  // maroon token, so it is omitted from the rows below to avoid
  // double-surfacing.
  const rows: ConcernRow[] = [];
  for (const lane of lanes) {
    if (lane.id === topConcernId) continue;
    if (lane.health.status !== 'available') continue;
    const health = lane.health.data;
    if (health.needsOperator) {
      rows.push({ lane, reason: 'needsOperator' });
      continue;
    }
    if (health.phaseConfidence !== 'known') continue;
    if (health.thrashingDetected || staleness.byLane.get(lane.id)?.isStalled) {
      rows.push({ lane, reason: 'stalled' });
    }
  }
  return rows;
}

function countWaiting(lanes: readonly WorkflowLane[]): number {
  // "waiting" census-vocab (Phase 1 architect M4) — operator-decision-pending.
  let count = 0;
  for (const lane of lanes) {
    if (lane.health.status === 'available' && lane.health.data.needsOperator) count += 1;
  }
  return count;
}

interface FreshSnapshot {
  snapshot: DashboardSnapshot;
  summary: WorkflowSummary;
}

function readFresh(data: DashboardSnapshot | undefined): FreshSnapshot | null {
  if (data === undefined) return null;
  const wf = data.sources.workflows;
  if (wf.status === 'error') return null;
  return { snapshot: data, summary: wf.data };
}

interface BodyProps {
  fresh: FreshSnapshot;
  cycleKey: string;
}

function AmbientBody({ fresh, cycleKey }: BodyProps) {
  const { summary, snapshot } = fresh;
  const staleness = useStaleness(summary.lanes);
  const top = useMemo(() => pickTopConcern(summary.lanes, staleness), [summary.lanes, staleness]);
  const rows = useMemo(
    () => buildConcernRows(summary.lanes, staleness, top?.lane.id),
    [summary.lanes, staleness, top],
  );

  // The server's `thrashing` count already excludes inferred lanes;
  // clientStalledLaneIds.length is gated to known via useStaleness.
  // Both contribute to the headline failing count.
  const failing = (() => {
    if (summary.census.status !== 'available') return 0;
    return summary.census.data.thrashing + staleness.clientStalledLaneIds.length;
  })();

  useFaviconSignal({ failing, cycleKey });

  const synopsis =
    snapshot.config !== undefined
      ? `${snapshot.config.cityName}, ${summary.totalActive} active`
      : null;

  if (summary.census.status !== 'available') {
    return (
      <section>
        <PageHeader title="Home" synopsis={synopsis} />
        <p
          className="mt-6 text-body text-fg-muted max-w-[70ch]"
          role="alert"
          data-testid="census-unavailable"
        >
          Census unavailable: {summary.census.error}.
        </p>
      </section>
    );
  }

  return (
    <section>
      <PageHeader title="Home" synopsis={synopsis} />
      <div className="mt-6 space-y-4">
        <PhaseCensus
          census={summary.census.data}
          waitingCount={countWaiting(summary.lanes)}
          failingCount={failing}
        />
        {top !== undefined && <StatusSentence topConcern={top} />}
        <ConcernRegion rows={rows} />
      </div>
    </section>
  );
}

export function AmbientHomePage() {
  const { data, loading, error } = useCachedData('snapshot', () => api.snapshot());

  const fresh = readFresh(data);
  // cycleKey advances per snapshot (drives R8 hysteresis); now-ticks
  // re-render the body but share the same generatedAt and so do not
  // advance the favicon hysteresis. Use a sentinel for the loading
  // path so the cycleKey type stays narrow.
  const cycleKey = fresh?.snapshot.generatedAt ?? '';

  if (data === undefined && loading) {
    return (
      <section>
        <PageHeader title="Home" synopsis={null} />
        <p className="mt-6 text-body text-fg-muted">Loading…</p>
      </section>
    );
  }
  if (data === undefined && error !== null) {
    return (
      <section>
        <PageHeader title="Home" synopsis={null} />
        <p className="mt-6 text-body text-accent" role="alert" data-testid="snapshot-error">
          {error}
        </p>
      </section>
    );
  }
  if (fresh === null) {
    // workflows source itself is in error state — the rest of the
    // snapshot may be fine but we have no facts to assemble the home.
    return (
      <section>
        <PageHeader title="Home" synopsis={null} />
        <p
          className="mt-6 text-body text-accent"
          role="alert"
          data-testid="workflows-source-error"
        >
          Workflow data is unavailable.
        </p>
      </section>
    );
  }
  return <AmbientBody fresh={fresh} cycleKey={cycleKey} />;
}
