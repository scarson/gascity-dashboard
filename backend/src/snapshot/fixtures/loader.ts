import type {
  DashboardSnapshot,
  SourceDataMap,
  SourceName,
} from 'gas-city-dashboard-shared';
import { fixtureSnapshot } from './snapshot.js';

// Fixture loader for SNAPSHOT_USE_FIXTURES=1 runtime mode
// (gascity-dashboard-hzy). Bead-3's cache wiring binds these into each
// SourceCache as loadFixture so a live-source failure falls back to the
// committed sample data instead of leaving a panel empty.
//
// Demo-dash exposes markSnapshotAsFixture / markSourceAsFixture helpers
// for wrapping arbitrary input snapshots. We don't port them: the
// committed fixtureSnapshot already has status='fixture' on every source
// and SourceCache stamps its own envelope on the way out anyway.

export async function loadFixtureSnapshot(): Promise<DashboardSnapshot> {
  return fixtureSnapshot;
}

/**
 * Returns a loader function suitable for SourceCacheOptions.loadFixture.
 * The returned function rejects when the requested source's fixture data
 * is null (the placeholder shape used for collectors that aren't wired
 * yet — aimux, github, tokens at v0). Callers MUST only bind this for
 * sources with populated fixture data; binding for a null-data source
 * makes both the live load AND the fixture fallback throw, leaving the
 * cache in the synthetic-error state. Coverage at
 * backend/test/snapshot-fixtures.test.ts asserts the null-source guard.
 */
export function fixtureSourceLoader<K extends SourceName>(
  source: K,
): () => Promise<SourceDataMap[K]> {
  return async () => {
    const data = fixtureSnapshot.sources[source].data;
    if (data === null) {
      throw new Error(`fixture data for source '${source}' is null`);
    }
    // Cast is unavoidable: tsc cannot narrow a generic index access
    // (sources[source].data) back to SourceDataMap[K] after a null
    // guard. Soundness rests on the fixtureSnapshot annotation — if
    // its shape drifts, the typed-const compile gate catches it first.
    return data as SourceDataMap[K];
  };
}
