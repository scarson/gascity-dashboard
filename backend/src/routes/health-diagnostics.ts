import type {
  BeadsUsage,
  ConfigComparisonRow,
  DiagnosticValue,
  DoltUsage,
  GcStatus,
  HealthDiagnostics,
} from 'gas-city-dashboard-shared';

// gascity-dashboard-1cob: pure translation of supervisor status + local
// version probes into the Health page's diagnostics bundle. No IO lives here —
// the route injects the probes and the (already-fetched) supervisor status, so
// every branch is unit-testable. Per the data-sourcing rule, a datum the
// backend cannot obtain is surfaced as `unavailable` with a reason, never
// fabricated.

const DOLT_VERSION_SOURCE = 'local probe: dolt version';
const BEADS_VERSION_SOURCE = 'local probe: bd version';
const STATUS_SOURCE = 'supervisor status.store_health';
const WORK_SOURCE = 'supervisor status.work';
const COMPARISON_SOURCE = 'supervisor status.store_health (threshold vs actual)';

const STATUS_UNAVAILABLE_REASON =
  'supervisor did not report store_health';
const WORK_UNAVAILABLE_REASON = 'supervisor did not report work counts';
const NO_THRESHOLD_REASON =
  'supervisor reports no recommended baseline to compare against';

/** Result of a single local CLI version probe. */
export type VersionProbeResult =
  | { kind: 'ok'; version: string }
  | { kind: 'error'; reason: string };

export type VersionProbe = () => Promise<VersionProbeResult>;

export interface BuildDiagnosticsInput {
  /** Supervisor city status, or null when the supervisor is unreachable. */
  status: GcStatus | null;
  doltProbe: VersionProbe;
  beadsProbe: VersionProbe;
}

const SEMVER_RE = /(\d+\.\d+\.\d+)/;

/**
 * Pulls the first dotted version token out of a CLI's version output. Both
 * `dolt version` ("dolt version 2.0.7") and `bd version` ("bd version 1.0.4
 * (sha…)") put the semver first, so one parser covers both.
 */
export function parseVersion(stdout: string): string | null {
  return SEMVER_RE.exec(stdout)?.[1] ?? null;
}

function fromProbe(
  result: VersionProbeResult,
  source: string,
): DiagnosticValue<string> {
  return result.kind === 'ok'
    ? { status: 'available', value: result.version, source }
    : { status: 'unavailable', reason: result.reason };
}

function doltUsageOf(status: GcStatus | null): DiagnosticValue<DoltUsage> {
  const sh = status?.store_health;
  if (sh === undefined) {
    return { status: 'unavailable', reason: STATUS_UNAVAILABLE_REASON };
  }
  return { status: 'available', value: { ...sh }, source: STATUS_SOURCE };
}

function beadsUsageOf(status: GcStatus | null): DiagnosticValue<BeadsUsage> {
  const work = status?.work;
  if (work === undefined) {
    return { status: 'unavailable', reason: WORK_UNAVAILABLE_REASON };
  }
  const value: BeadsUsage = {
    open: work.open,
    ready: work.ready,
    in_progress: work.in_progress,
  };
  return { status: 'available', value, source: WORK_SOURCE };
}

function configComparisonOf(
  status: GcStatus | null,
): DiagnosticValue<ConfigComparisonRow[]> {
  const sh = status?.store_health;
  // The only recommended-vs-actual signal the supervisor exposes today is the
  // Dolt maintenance ratio threshold. Without both the threshold (recommended)
  // and the actual ratio there is no baseline to diff — surface unavailable
  // rather than inventing a recommended value (see gascity-dashboard-1cob.2).
  if (
    sh === undefined ||
    sh.threshold_mb_per_row === undefined ||
    sh.ratio_mb_per_row === undefined
  ) {
    return { status: 'unavailable', reason: NO_THRESHOLD_REASON };
  }
  const row: ConfigComparisonRow = {
    label: 'Dolt MB-per-row ratio',
    recommended: `≤ ${sh.threshold_mb_per_row}`,
    loaded: String(sh.ratio_mb_per_row),
    // The supervisor owns the verdict: prefer its `warning` flag when present,
    // otherwise compare against the threshold it reported.
    withinRecommendation:
      sh.warning !== undefined
        ? !sh.warning
        : sh.ratio_mb_per_row <= sh.threshold_mb_per_row,
  };
  return { status: 'available', value: [row], source: COMPARISON_SOURCE };
}

export async function buildDiagnostics(
  input: BuildDiagnosticsInput,
): Promise<HealthDiagnostics> {
  const [doltVersion, beadsVersion] = await Promise.all([
    input.doltProbe(),
    input.beadsProbe(),
  ]);
  return {
    doltVersion: fromProbe(doltVersion, DOLT_VERSION_SOURCE),
    beadsVersion: fromProbe(beadsVersion, BEADS_VERSION_SOURCE),
    doltUsage: doltUsageOf(input.status),
    beadsUsage: beadsUsageOf(input.status),
    configComparison: configComparisonOf(input.status),
  };
}
