import type { DashboardSnapshot } from 'gas-city-dashboard-shared';

// Committed sample data for SNAPSHOT_USE_FIXTURES=1 runtime mode. This is
// what the dashboard serves when the supervisor / upstream sources are
// unreachable. NOT test fixtures — tests use injected mocks. Adapted from
// demo-dash src/fixtures/snapshot.json with operator-specific names and
// paths replaced by generic placeholders.
//
// Only city / workflows / resources carry realistic data; aimux / github /
// tokens are intentionally null until their collectors are wired (deferred
// pending bead dkb's architecture decisions). The placeholder envelopes
// keep DashboardSources fully populated so callers can index every source
// without optional-chaining churn.

export const fixtureSnapshot = {
  generatedAt: '2026-05-22T22:00:00.000Z',
  config: {
    cityRoot: '/tmp/example-city',
    githubRepo: 'example-org/example-repo',
    useFixtures: true,
  },
  headline: {
    activeAgents: 12,
    maxAgents: 100,
    activeSessions: 28,
    activeWorkflows: 6,
    githubOpenReviews: 14,
  },
  sources: {
    aimux: {
      source: 'aimux',
      status: 'fixture',
      fetchedAt: null,
      staleAt: null,
      error: null,
      data: null,
    },
    city: {
      source: 'city',
      status: 'fixture',
      fetchedAt: '2026-05-22T22:00:00.000Z',
      staleAt: '2026-05-22T22:00:45.000Z',
      error: null,
      data: {
        activeAgents: 12,
        totalAgents: 17,
        activeSessions: 28,
        suspendedSessions: 0,
        maxSessions: 100,
        sessionsByProvider: [
          { provider: 'codex', active: 18, total: 22 },
          { provider: 'claude', active: 7, total: 8 },
          { provider: 'gemini', active: 3, total: 3 },
        ],
        rigs: [
          {
            name: 'rig-1',
            path: '/tmp/example-rig',
          },
        ],
      },
    },
    resources: {
      source: 'resources',
      status: 'fixture',
      fetchedAt: '2026-05-22T22:00:00.000Z',
      staleAt: '2026-05-22T22:00:30.000Z',
      error: null,
      data: {
        vcpuCount: 32,
        loadAverage: [8.4, 7.9, 7.1],
        loadPerVcpu: 0.26,
        memory: {
          totalBytes: 137438953472,
          usedBytes: 60129542144,
          availableBytes: 77309411328,
          utilization: 0.44,
        },
        uptimeSeconds: 86400,
        samples: [
          {
            sampledAt: '2026-05-22T22:00:00.000Z',
            vcpuCount: 32,
            loadAverage: [8.4, 7.9, 7.1],
            loadPerVcpu: 0.26,
            memoryUsedBytes: 60129542144,
            memoryAvailableBytes: 77309411328,
            memoryUtilization: 0.44,
          },
        ],
      },
    },
    workflows: {
      source: 'workflows',
      status: 'fixture',
      fetchedAt: '2026-05-22T22:00:00.000Z',
      staleAt: '2026-05-22T22:01:00.000Z',
      error: null,
      data: {
        totalActive: 6,
        runCounts: {
          total: 6,
          visible: 1,
          prReview: 4,
          designReview: 1,
          bugfix: 1,
          blocked: 1,
          other: 0,
        },
        lanes: [
          {
            id: 'lane-1',
            title: 'Example workflow',
            formula: 'mol-example-v1',
            externalUrl: 'https://github.com/example-org/example-repo/pull/1',
            externalLabel: 'PR #1',
            phase: 'review',
            phaseLabel: 'review round 2',
            statusCounts: {
              open: 3,
              in_progress: 2,
              closed: 8,
            },
            activeAssignees: ['agent-1', 'agent-2'],
            updatedAt: '2026-05-22T21:58:00.000Z',
            stages: [
              { key: 'intake', label: 'Intake', status: 'complete' },
              { key: 'implementation', label: 'Implementation', status: 'complete' },
              { key: 'review', label: 'Review', status: 'active' },
            ],
          },
        ],
        recentChanges: [
          {
            id: 'lane-1.7',
            title: 'Example review',
            status: 'in_progress',
            updatedAt: '2026-05-22T21:58:00.000Z',
          },
        ],
      },
    },
    github: {
      source: 'github',
      status: 'fixture',
      fetchedAt: null,
      staleAt: null,
      error: null,
      data: null,
    },
    tokens: {
      source: 'tokens',
      status: 'fixture',
      fetchedAt: null,
      staleAt: null,
      error: null,
      data: null,
    },
  },
} satisfies DashboardSnapshot;
