import type { LinkResolutionStat } from 'gas-city-dashboard-shared';

// R11 — resolution instrumentation (RK4).
//
// Every link-view build records per-edge-type resolution outcomes into a
// process-level rollup, exposed by the GET /api/links/_stats endpoint, so
// deferred link directions (rich GitHub→bead, more surfaces) can be
// promoted on measured hit-rate, not speculation. No frontend surface
// consumes this endpoint in this PR — it is an out-of-band / future-use
// endpoint (curl-able, or for a later Activity/Health register tile). A
// nonzero n-candidates rate on an AUTHORITATIVE direction (parent/molecule)
// is a correctness alarm — it means the namespaced key failed to keep
// distinct-scope beads apart.
//
// Promote / kill thresholds (reviewed quarterly by the dashboard owner):
//   - Promote rich GitHub→bead join when bead→PR resolution to a PRESENT
//     entity exceeds 40% over a 30-day window (PG2 threshold).
//   - Sunset condition: if the RelatedEntities section sees fewer
//     interactions than the three pre-existing inline links over 30 days,
//     remove it (tracked outside this counter, by the owner).
//
// This is deterministic arithmetic aggregation only — ZFC-clean.

export type ResolutionOutcome = 'resolved' | 'unresolved' | 'n-candidates';

export type ResolutionRecorder = (
  relation: string,
  outcome: ResolutionOutcome,
) => void;

interface MutableStat {
  resolved: number;
  unresolved: number;
  nCandidates: number;
}

/**
 * A bounded rollup of resolution outcomes across builds. Process-scoped;
 * reset on restart (the per-snapshot rebuild posture means there is no
 * persistence to invalidate).
 */
export class ResolutionRollup {
  private readonly byRelation = new Map<string, MutableStat>();

  record(relation: string, outcome: ResolutionOutcome): void {
    const stat =
      this.byRelation.get(relation) ??
      this.byRelation.set(relation, { resolved: 0, unresolved: 0, nCandidates: 0 }).get(
        relation,
      )!;
    if (outcome === 'resolved') stat.resolved += 1;
    else if (outcome === 'unresolved') stat.unresolved += 1;
    else stat.nCandidates += 1;
  }

  /** A bound recorder for passing into buildLinkView. */
  recorder(): ResolutionRecorder {
    return (relation, outcome) => this.record(relation, outcome);
  }

  /** The current rollup, sorted by relation. Consumed by GET /api/links/_stats. */
  snapshot(): LinkResolutionStat[] {
    return [...this.byRelation.entries()]
      .map(([relation, s]) => ({
        relation,
        resolved: s.resolved,
        unresolved: s.unresolved,
        nCandidates: s.nCandidates,
      }))
      .sort((a, b) => a.relation.localeCompare(b.relation));
  }
}

/** Helper used by the view builder; no-ops on an absent recorder. */
export function recordResolution(
  recorder: ResolutionRecorder | undefined,
  relation: string,
  outcome: ResolutionOutcome,
): void {
  recorder?.(relation, outcome);
}
