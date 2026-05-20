import { describe, expect, it } from 'vitest';
import type { GcSession } from 'gas-city-dashboard-shared';
import { SESSION_CHIPS, buildSynopsis, stateTone } from './Agents';

// Every named value in GcSessionState (shared/src/index.ts) must match
// at least one chip. Otherwise, sessions in that state vanish silently
// when any chip is active — the bug from gascity-dashboard-9yb. Listed
// literally rather than via Exclude<GcSessionState, string> because the
// union widens to string for forward-compat, which would yield never.
const NAMED_STATES = [
  'creating',
  'active',
  'asleep',
  'detached',
  'failed',
  'closed',
] as const;

function mkSession(state: string): GcSession {
  return {
    id: `s-${state}`,
    template: 'claude-code',
    state,
    created_at: '2026-01-01T00:00:00Z',
    attached: false,
  };
}

describe('SESSION_CHIPS', () => {
  it('every named GcSessionState matches at least one chip', () => {
    for (const state of NAMED_STATES) {
      const session = mkSession(state);
      const matched = SESSION_CHIPS.some((chip) => chip.match(session));
      expect(
        matched,
        `state "${state}" must match at least one chip, otherwise it disappears when any chip is active`,
      ).toBe(true);
    }
  });

  it('exposes a "detached" chip so detached sessions stay visible under chip filters', () => {
    const detached = mkSession('detached');
    const detachedChip = SESSION_CHIPS.find((chip) => chip.id === 'detached');
    expect(detachedChip, 'detached chip should exist').toBeDefined();
    expect(detachedChip?.match(detached)).toBe(true);
  });

  it('detached sessions match only the detached chip when not running', () => {
    const detached = mkSession('detached');
    const matchingIds = SESSION_CHIPS.filter((chip) => chip.match(detached)).map(
      (chip) => chip.id,
    );
    expect(matchingIds).toEqual(['detached']);
  });
});

describe('stateTone', () => {
  it('classifies detached sessions explicitly (not via default fallthrough)', () => {
    // Detached is paused-alive — same neutral palette as idle/asleep, but the
    // case is explicit so a reviewer sees the intent rather than a silent
    // default. See gascity-dashboard-x4k for context.
    expect(stateTone('detached')).toBe('neutral');
  });
});

describe('buildSynopsis', () => {
  it('reports detached sessions as a distinct count, not bucketed under idle', () => {
    const rows: GcSession[] = [
      mkSession('active'),
      mkSession('asleep'),
      mkSession('asleep'),
      mkSession('detached'),
    ];
    const synopsis = buildSynopsis(rows);
    expect(synopsis).toContain('1 active');
    expect(synopsis).toContain('2 idle');
    expect(synopsis).toContain('1 detached');
  });

  it('omits detached from the synopsis when there are no detached sessions', () => {
    const rows: GcSession[] = [mkSession('active'), mkSession('asleep')];
    expect(buildSynopsis(rows)).not.toContain('detached');
  });

  it('returns the empty-state sentence when no rows', () => {
    expect(buildSynopsis([])).toBe('No sessions running.');
  });
});
