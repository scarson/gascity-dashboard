import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { GcSession, GcSessionList } from 'gas-city-dashboard-shared';

import {
  aggregateSessionsByProvider,
  collectCityStatus,
} from '../src/snapshot/collectors/cityStatus.js';

// cityStatus collector coverage for gascity-dashboard-8nj.
//
// Per gascity-dashboard-dkb Q4 resolution (and upstream issue
// gastownhall/gascity#2508): the dashboard does NOT title-parse to infer
// provider. sessionsByProvider aggregates only over sessions where
// GcSession.provider is populated. Sessions without provider are TOLERATED
// (treated as 'unknown provider') and EXCLUDED from the breakdown.
// Demo-dash's inferProviderFromTitle is intentionally NOT ported.

function sess(partial: Partial<GcSession>): GcSession {
  return {
    id: 't-1',
    template: 'codex',
    state: 'active',
    created_at: '2026-05-22T00:00:00.000Z',
    attached: false,
    ...partial,
  };
}

describe('aggregateSessionsByProvider', () => {
  test('aggregates active+total counts when every session has provider populated', () => {
    const sessions: GcSession[] = [
      sess({ id: 't-1', provider: 'codex', state: 'active' }),
      sess({ id: 't-2', provider: 'codex', state: 'asleep' }),
      sess({ id: 't-3', provider: 'codex', state: 'active' }),
      sess({ id: 't-4', provider: 'claude', state: 'active' }),
      sess({ id: 't-5', provider: 'claude', state: 'closed' }),
      sess({ id: 't-6', provider: 'gemini', state: 'active' }),
    ];

    const breakdown = aggregateSessionsByProvider(sessions);

    // Sorted by active desc, then provider asc.
    assert.deepEqual(breakdown, [
      { provider: 'codex', active: 2, total: 3 },
      { provider: 'claude', active: 1, total: 2 },
      { provider: 'gemini', active: 1, total: 1 },
    ]);
  });

  test('excludes sessions without provider (no title-parsing fallback)', () => {
    // Mix: some with provider, some without. Sessions without provider
    // are silently dropped from the aggregation — they are NOT inferred
    // from title even when title text contains 'codex'/'claude'/'gemini'.
    const sessions: GcSession[] = [
      sess({ id: 't-1', provider: 'codex', state: 'active' }),
      sess({ id: 't-2', title: 'codex/research', state: 'active' }), // no provider
      sess({ id: 't-3', title: 'claude/triage', state: 'active' }), // no provider
      sess({ id: 't-4', provider: 'claude', state: 'asleep' }),
    ];

    const breakdown = aggregateSessionsByProvider(sessions);

    assert.deepEqual(breakdown, [
      { provider: 'codex', active: 1, total: 1 },
      { provider: 'claude', active: 0, total: 1 },
    ]);
  });

  test('returns empty array when no session has provider', () => {
    const sessions: GcSession[] = [
      sess({ id: 't-1', title: 'codex/x' }),
      sess({ id: 't-2', title: 'claude/y' }),
    ];

    assert.deepEqual(aggregateSessionsByProvider(sessions), []);
  });

  test('returns empty array on empty input', () => {
    assert.deepEqual(aggregateSessionsByProvider([]), []);
  });
});

describe('collectCityStatus', () => {
  test('builds CityStatusSummary from sessions + null city.toml when cityPath unset', async () => {
    const sessionList: GcSessionList = {
      items: [
        sess({ id: 't-1', provider: 'codex', state: 'active' }),
        sess({ id: 't-2', provider: 'codex', state: 'asleep' }),
        sess({ id: 't-3', provider: 'claude', state: 'active' }),
      ],
    };

    const summary = await collectCityStatus({
      listSessions: async () => sessionList,
      cityPath: '',
    });

    assert.equal(summary.activeAgents, 2);
    assert.equal(summary.totalAgents, 3);
    assert.equal(summary.activeSessions, 2);
    assert.equal(summary.suspendedSessions, 1);
    assert.equal(summary.maxSessions, null);
    assert.deepEqual(summary.rigs, []);
    // Sort: active desc, then provider asc. codex and claude both have
    // active=1, so alpha tiebreak puts claude first.
    assert.deepEqual(summary.sessionsByProvider, [
      { provider: 'claude', active: 1, total: 1 },
      { provider: 'codex', active: 1, total: 2 },
    ]);
  });

  test('parses max_active_sessions and rigs from city.toml when reader returns one', async () => {
    const sessionList: GcSessionList = {
      items: [sess({ id: 't-1', provider: 'codex', state: 'active' })],
    };

    const summary = await collectCityStatus({
      listSessions: async () => sessionList,
      cityPath: '/fake/city',
      readCityToml: async () => ({
        maxSessions: 100,
        rigs: [{ name: 'rig-a', path: '/data/rig-a' }],
      }),
    });

    assert.equal(summary.maxSessions, 100);
    assert.deepEqual(summary.rigs, [{ name: 'rig-a', path: '/data/rig-a' }]);
  });

  test('tolerates missing city.toml: maxSessions=null, rigs=[]', async () => {
    const sessionList: GcSessionList = { items: [] };

    const summary = await collectCityStatus({
      listSessions: async () => sessionList,
      cityPath: '/fake/city',
      readCityToml: async () => null,
    });

    assert.equal(summary.maxSessions, null);
    assert.deepEqual(summary.rigs, []);
  });
});
