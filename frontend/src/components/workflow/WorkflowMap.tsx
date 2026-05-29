import type { SourceState, WorkflowSummary } from 'gas-city-dashboard-shared';
import { LaneCard } from './LaneCard';

// Workflow phase-lane map (gascity-dashboard-0t6). Renders the snapshot's
// workflows source as a typographic block list — count summary up top,
// hairline-separated lanes below. No card chrome anywhere; hierarchy is
// carried by space, weight, and tracked-uppercase column heads, matching
// the Flat Page Rule and Greyscale Test in DESIGN.md.
//
// gascity-dashboard-yh5i: the active/historical split is rendered as two
// optional sections. Active lanes always show; historical lanes show only
// when `showHistory` is true (controlled by ?history=1 in the URL,
// threaded down from /workflows). The historical section is labeled and
// hairlined to keep the typographic register continuous with active.

interface WorkflowMapProps {
  source: SourceState<WorkflowSummary>;
  now: number;
  showHistory: boolean;
}

const COUNT_LABELS: Array<[keyof WorkflowSummary['runCounts'], string]> = [
  ['prReview', 'PR'],
  ['designReview', 'Design'],
  ['bugfix', 'Bugfix'],
  ['other', 'Other'],
];

const HISTORICAL_SECTION_ID = 'workflows-historical-section';

export function WorkflowMap({ source, now, showHistory }: WorkflowMapProps) {
  if (source.status === 'error') {
    return (
      <section>
        <CountsHeader summary={null} />
        <p className="mt-8 text-body text-fg-muted italic">
          {`Workflow data unavailable: ${source.error}.`}
        </p>
      </section>
    );
  }

  const summary = source.data;

  return (
    <section>
      <CountsHeader summary={summary} />
      <ActiveSection summary={summary} now={now} />
      {showHistory && (
        <HistoricalSection summary={summary} now={now} />
      )}
    </section>
  );
}

function ActiveSection({ summary, now }: { summary: WorkflowSummary; now: number }) {
  if (summary.lanes.length === 0) {
    // Distinguish "nothing at all" from "nothing active but N completed".
    const trailer =
      summary.totalHistorical > 0
        ? ` (${summary.totalHistorical} completed.)`
        : '';
    return (
      <p className="mt-8 text-body text-fg-muted italic">
        {`No active workflow runs.${trailer}`}
      </p>
    );
  }
  return (
    <>
      <ol className="mt-6 divide-y divide-rule">
        {summary.lanes.map((lane) => (
          <LaneCard key={lane.id} lane={lane} now={now} />
        ))}
      </ol>
      {summary.totalActive > summary.lanes.length && (
        <p className="mt-3 text-label uppercase tracking-wider text-fg-faint tnum">
          {summary.totalActive - summary.lanes.length} more not shown
        </p>
      )}
    </>
  );
}

function HistoricalSection({ summary, now }: { summary: WorkflowSummary; now: number }) {
  return (
    <section
      id={HISTORICAL_SECTION_ID}
      aria-label="Historical workflow runs"
      className="mt-12"
    >
      <h2 className="text-label uppercase tracking-wider text-fg-faint">
        Historical
      </h2>
      {summary.historicalLanes.length === 0 ? (
        <p className="mt-3 text-body text-fg-muted italic">
          No completed runs in the current window.
        </p>
      ) : (
        <>
          <ol className="mt-3 divide-y divide-rule">
            {summary.historicalLanes.map((lane) => (
              <LaneCard key={lane.id} lane={lane} now={now} />
            ))}
          </ol>
          {summary.totalHistorical > summary.historicalLanes.length && (
            <p className="mt-3 text-label uppercase tracking-wider text-fg-faint tnum">
              {summary.totalHistorical - summary.historicalLanes.length} more not shown
            </p>
          )}
        </>
      )}
    </section>
  );
}

function CountsHeader({ summary }: { summary: WorkflowSummary | null }) {
  // yh5i: tile labeled "Active" (was "Runs") so the denominator is
  // self-describing — runCounts.total counts only active lanes after the
  // split. Sub-tiles (PR / Design / Bugfix / Other) break down the active
  // set by formula kind, matching the headline metric. Historical counts
  // surface via the toggle button in the page header, not here.
  const total = summary?.runCounts.total ?? 0;
  const blocked = summary?.runCounts.blocked ?? 0;
  return (
    <header className="space-y-2">
      <div className="flex items-baseline gap-x-6 gap-y-2 flex-wrap">
        <CountTile label="Active" value={total} tone="strong" />
        {COUNT_LABELS.map(([key, label]) => (
          <CountTile
            key={key}
            label={label}
            value={summary?.runCounts[key] ?? 0}
            tone="muted"
          />
        ))}
        {blocked > 0 && (
          <CountTile label="Blocked" value={blocked} tone="accent" />
        )}
      </div>
    </header>
  );
}

function CountTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'strong' | 'muted' | 'accent';
}) {
  // tnum + tracked-uppercase label per the column-head register elsewhere on
  // the page; value sits below in body weight. No box around either.
  const valueTone =
    tone === 'strong'
      ? 'text-fg'
      : tone === 'accent'
        ? 'text-accent'
        : 'text-fg-muted';
  return (
    <div className="flex flex-col">
      <span className="text-label uppercase tracking-wider text-fg-faint">
        {label}
      </span>
      <span className={`text-title tnum ${valueTone}`}>
        {value}
      </span>
    </div>
  );
}

export const WORKFLOWS_HISTORICAL_SECTION_ID = HISTORICAL_SECTION_ID;
