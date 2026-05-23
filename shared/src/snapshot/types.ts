// Read-side telemetry envelope shared across the snapshot series
// (gascity-dashboard-37u). Ported from demo-dash src/shared/types.ts.
//
// The SourceName union enumerates every source the dashboard may surface;
// individual collectors are wired in later beads. Listing all six names
// here even though only city/workflows/resources have collectors today
// keeps DashboardSources (bead-3) and the fixture (bead-2) able to
// `satisfies` a fully-keyed object without churn when the remaining
// collectors land.

export type SourceName =
  | 'aimux'
  | 'city'
  | 'resources'
  | 'workflows'
  | 'github'
  | 'tokens';

export type SourceStatus = 'fresh' | 'stale' | 'error' | 'fixture';

export interface SourceState<T> {
  source: SourceName;
  status: SourceStatus;
  fetchedAt: string | null;
  staleAt: string | null;
  error: string | null;
  data: T | null;
}

// ── Aggregate snapshot ────────────────────────────────────────────────────

export interface DashboardSnapshot {
  generatedAt: string;
  config: DashboardRuntimeConfig;
  headline: DashboardHeadline;
  sources: DashboardSources;
}

export interface DashboardRuntimeConfig {
  cityRoot: string;
  githubRepo: string;
  useFixtures: boolean;
}

export interface DashboardHeadline {
  activeAgents: number | null;
  maxAgents: number | null;
  activeSessions: number | null;
  activeWorkflows: number | null;
  githubOpenReviews: number | null;
}

export interface DashboardSources {
  aimux: SourceState<AimuxQuotaSummary>;
  city: SourceState<CityStatusSummary>;
  resources: SourceState<ResourceSummary>;
  workflows: SourceState<WorkflowSummary>;
  github: SourceState<GitHubSummary>;
  tokens: SourceState<TokenUsageSummary>;
}

/**
 * Per-source data shape map. Derived from DashboardSources so the two
 * cannot drift; used by fixtureSourceLoader<K> in the snapshot fixtures
 * module to return a precisely-typed data accessor per source name.
 *
 * NonNullable wraps T inside the conditional so the intent ("strip the
 * null that data: T | null carries") is explicit, even though every
 * current T is already non-nullable. The form-vs-coincidence distinction
 * matters if a future source ever types its T as `Foo | null` directly.
 */
export type SourceDataMap = {
  [K in SourceName]: DashboardSources[K] extends SourceState<infer T>
    ? NonNullable<T>
    : never;
};

// ── aimux ─────────────────────────────────────────────────────────────────

export interface AimuxQuotaSummary {
  vendors: AimuxVendorQuota[];
  warnings: string[];
}

export interface AimuxVendorQuota {
  vendor: string;
  accounts: AimuxAccountQuota[];
}

export interface AimuxAccountQuota {
  account: string;
  status: 'available' | 'limited' | 'blocked' | 'unknown';
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
  resetAt: string | null;
  warning: string | null;
  error: string | null;
}

export interface QuotaWindow {
  used: number | null;
  available: number | null;
  limit: number | null;
  utilization: number | null;
  resetAt: string | null;
}

// ── city ──────────────────────────────────────────────────────────────────

export interface CityStatusSummary {
  activeAgents: number | null;
  totalAgents: number | null;
  activeSessions: number | null;
  suspendedSessions: number | null;
  maxSessions: number | null;
  sessionsByProvider: CitySessionProvider[];
  rigs: CityRig[];
}

export interface CitySessionProvider {
  provider: string;
  active: number;
  total: number;
}

export interface CityRig {
  name: string;
  path: string;
}

// ── resources ─────────────────────────────────────────────────────────────

export interface ResourceSummary {
  vcpuCount: number;
  loadAverage: [number, number, number];
  loadPerVcpu: number;
  memory: MemorySummary;
  uptimeSeconds: number;
  samples: ResourceSample[];
}

export interface MemorySummary {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  utilization: number;
}

export interface ResourceSample {
  sampledAt: string;
  vcpuCount: number;
  loadAverage: [number, number, number];
  loadPerVcpu: number;
  memoryUsedBytes: number;
  memoryAvailableBytes: number;
  memoryUtilization: number;
}

// ── workflows ─────────────────────────────────────────────────────────────

export interface WorkflowSummary {
  totalActive: number;
  runCounts: WorkflowRunCounts;
  lanes: WorkflowLane[];
  recentChanges: WorkflowChange[];
}

export interface WorkflowRunCounts {
  total: number;
  visible: number;
  prReview: number;
  designReview: number;
  bugfix: number;
  blocked: number;
  other: number;
}

export interface WorkflowLane {
  id: string;
  title: string;
  formula: string | null;
  externalUrl: string | null;
  externalLabel: string | null;
  phase: WorkflowPhase;
  phaseLabel: string;
  statusCounts: Record<string, number>;
  activeAssignees: string[];
  updatedAt: string | null;
  stages: WorkflowStage[];
}

export type WorkflowPhase =
  | 'intake'
  | 'implementation'
  | 'review'
  | 'approval'
  | 'finalization'
  | 'blocked'
  | 'complete'
  | 'active';

export interface WorkflowStage {
  key: string;
  label: string;
  status: 'pending' | 'active' | 'complete' | 'blocked';
}

export interface WorkflowChange {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

// ── github ────────────────────────────────────────────────────────────────

export interface GitHubSummary {
  repo: string;
  openPullRequests: number | null;
  openReviewDemand: number | null;
  reviewActivity: WindowedCounts;
  mergedPullRequests: WindowedCounts;
  commitsToMain: WindowedCounts;
  newContributors: WindowedCounts;
  recentActivity: GitHubActivity[];
  rateLimit: GitHubRateLimit | null;
}

export interface WindowedCounts {
  oneDay: number | null;
  sevenDays: number | null;
  thirtyDays: number | null;
}

export interface GitHubActivity {
  kind: 'pull_request' | 'commit' | 'review' | 'release';
  title: string;
  url: string | null;
  actor: string | null;
  occurredAt: string;
}

export interface GitHubRateLimit {
  remaining: number;
  limit: number;
  resetAt: string | null;
}

// ── tokens ────────────────────────────────────────────────────────────────

export interface TokenUsageSummary {
  windows: WindowedCounts;
  clients: string[];
  activeDays: number;
}
