import type { WorkflowLane } from 'gas-city-dashboard-shared';

// gascity-dashboard-kb3 PRD §4 — "Concern region". Items needing a
// decision materialize beneath the sentence on the same page via
// opacity (reserved space, never animate height; respects
// prefers-reduced-motion). Each row is the same deep link + an inline
// sling action.
//
// R10 withholding (Phase 1 architect C2): healthy in-flight lanes are
// NEVER enumerated here. The caller is responsible for applying the
// concern predicate; this component just renders the result.

export interface ConcernRow {
  lane: WorkflowLane;
  /**
   * Why the row is in the concern region. Drives the per-row copy and
   * (downstream) the inline action affordance set.
   */
  reason: 'needsOperator' | 'stalled';
}

export interface ConcernRegionProps {
  rows: readonly ConcernRow[];
}

function laneToken(lane: WorkflowLane): string {
  if (lane.external.status === 'available') return lane.external.label;
  return lane.title;
}

function rowHref(lane: WorkflowLane): string {
  const id = encodeURIComponent(lane.id);
  const scope = lane.scope.status === 'available' ? lane.scope : null;
  if (lane.health.status === 'available' && lane.health.data.stuckNode.status === 'available') {
    const qs = new URLSearchParams();
    qs.set('node', encodeURIComponent(lane.health.data.stuckNode.id));
    if (scope) {
      qs.set('scope_kind', scope.kind);
      qs.set('scope_ref', scope.ref);
    }
    return `/workflows/${id}?${qs.toString()}`;
  }
  if (scope) {
    const qs = new URLSearchParams();
    qs.set('scope_kind', scope.kind);
    qs.set('scope_ref', scope.ref);
    return `/workflows/${id}?${qs.toString()}`;
  }
  return `/workflows/${id}`;
}

function reasonLabel(reason: ConcernRow['reason']): string {
  switch (reason) {
    case 'needsOperator':
      return 'needs you';
    case 'stalled':
      return 'stalled';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function ConcernRegion({ rows }: ConcernRegionProps) {
  // R10: when there are no rows, render an empty list (NOT a "all calm"
  // affordance). Absence is the calm signal (R6). The reserved height
  // comes from the list element itself, not a placeholder row, so the
  // page layout stays stable across cycles without animating.
  return (
    <ul
      className="mt-2 transition-opacity duration-150 ease-out-quart motion-reduce:transition-none"
      style={{ opacity: rows.length === 0 ? 0 : 1 }}
      aria-live="polite"
      data-testid="concern-region"
    >
      {rows.map(({ lane, reason }) => (
        <li key={lane.id} className="text-body text-fg flex items-baseline gap-3">
          <a
            href={rowHref(lane)}
            className="font-medium hover:text-fg focus-mark"
            data-testid={`concern-row-${lane.id}`}
          >
            {laneToken(lane)}
          </a>
          <span className="text-label uppercase tracking-wider text-fg-muted">
            {reasonLabel(reason)}
          </span>
        </li>
      ))}
    </ul>
  );
}
