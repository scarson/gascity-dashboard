import type { WorkflowLane } from 'gas-city-dashboard-shared';

// gascity-dashboard-kb3 PRD §4 line 2 — "the lean-in read".
// Body scale, ≤70ch, prose assembled from structured facts:
//   "adopt-pr-271 has waited on a review verdict for 22 min"
//
// One Mark Rule (DESIGN.md): the maroon (.text-accent) class appears
// AT MOST once per viewport. It lands on the single most-severe
// run-id token only, and only when the lane is phaseConfidence='known'
// AND its stuckNode is available (so the deep-link target exists).
//
// R6 (PRD §12, Phase 1 architect M3): NO negative-reassurance clauses.
// Absence of a concern clause IS the calm signal. When there's no
// failing lane to report, the sentence collapses to empty — no
// "nothing is blocked" fallback prose. Per PRODUCT.md the calm state
// has no Line 2; the census already carried the trust anchor.

export interface StatusSentenceProps {
  /**
   * The single most-severe lane this sentence should highlight. The
   * caller has already applied R2 + One Mark ranking (oldest stall
   * wins) and OMITS this prop entirely when the city is calm — the
   * sentence has no calm rendering (R6 negative-clause floor).
   */
  topConcern: { lane: WorkflowLane; ageMs: number };
}

function formatAge(ageMs: number): string {
  const totalMin = Math.floor(ageMs / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function deepLinkHref(lane: WorkflowLane): string | null {
  // R2: only render the maroon deep-link when the engine actually
  // resolved which node stalled. An 'unavailable' stuckNode means we
  // would deep-link with no ?node= and the L2 page would have no
  // selection — break the One Mark Rule for a dead-end click.
  if (lane.health.status !== 'available') return null;
  const stuck = lane.health.data.stuckNode;
  if (stuck.status !== 'available') return null;
  // Security (per the 3ax close note): encodeURIComponent the supervisor-
  // supplied node id so a future renamed gc.step_id with reserved chars
  // cannot inject into the URL.
  const node = encodeURIComponent(stuck.id);
  const id = encodeURIComponent(lane.id);
  // Preserve the existing scope deep-link contract from LaneCard.
  const scope = lane.scope.status === 'available' ? lane.scope : null;
  const qs = new URLSearchParams();
  qs.set('node', node);
  if (scope) {
    qs.set('scope_kind', scope.kind);
    qs.set('scope_ref', scope.ref);
  }
  return `/workflows/${id}?${qs.toString()}`;
}

function laneToken(lane: WorkflowLane): string {
  // Prefer external reference (PR/issue label, e.g. "adopt-pr-271")
  // when available — that's what the operator recognises.
  if (lane.external.status === 'available') return lane.external.label;
  return lane.title;
}

function pickConcernPhrasing(lane: WorkflowLane): string {
  if (lane.health.status === 'available' && lane.health.data.needsOperator) {
    return 'is waiting on your decision';
  }
  return 'has waited on a review verdict for';
}

export function StatusSentence({ topConcern }: StatusSentenceProps) {
  const { lane, ageMs } = topConcern;
  const token = laneToken(lane);
  const href = deepLinkHref(lane);
  const phrase = pickConcernPhrasing(lane);
  const ageLabel = formatAge(ageMs);

  return (
    <p
      className="text-body text-fg max-w-[70ch] leading-relaxed"
      data-testid="status-sentence"
    >
      {href === null ? (
        // Engine could not resolve which node stalled. Render the token
        // as plain text — no maroon class (R2 floor), no deep link.
        <span data-testid="status-sentence-token">{token}</span>
      ) : (
        <a
          href={href}
          className="text-accent font-semibold focus-mark"
          data-testid="status-sentence-token"
        >
          {token}
        </a>
      )}{' '}
      {phrase} {ageLabel}.
    </p>
  );
}
