import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

// loadConfig env-flag coverage. Seeded for gascity-dashboard-hzy's
// useFixtures gate; new env-driven knobs land here to keep config
// behavior reviewable in one place.

describe('loadConfig', () => {
  test('useFixtures is true when SNAPSHOT_USE_FIXTURES=1', () => {
    const cfg = loadConfig({ SNAPSHOT_USE_FIXTURES: '1' });
    assert.equal(cfg.useFixtures, true);
  });

  test('useFixtures is false when SNAPSHOT_USE_FIXTURES is unset', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.useFixtures, false);
  });

  test('useFixtures is false for any value other than the exact string "1"', () => {
    // Strict equality with '1' prevents accidental opt-in via
    // SNAPSHOT_USE_FIXTURES=true, =yes, or =0.
    assert.equal(loadConfig({ SNAPSHOT_USE_FIXTURES: 'true' }).useFixtures, false);
    assert.equal(loadConfig({ SNAPSHOT_USE_FIXTURES: 'yes' }).useFixtures, false);
    assert.equal(loadConfig({ SNAPSHOT_USE_FIXTURES: '0' }).useFixtures, false);
    assert.equal(loadConfig({ SNAPSHOT_USE_FIXTURES: '' }).useFixtures, false);
  });
});
