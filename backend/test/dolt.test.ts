import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  createDoltNomsSampler,
  type DoltNomsRuntime,
  type DoltNomsTimer,
  sampleDoltNomsSize,
} from '../src/routes/dolt.js';

describe('dolt-noms sampler', () => {
  test('returns the recursive byte size of a city .dolt/noms directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gcd-dolt-'));
    await fs.mkdir(path.join(root, '.dolt', 'noms', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, '.dolt', 'noms', 'chunk-1'), 'abcd');
    await fs.writeFile(path.join(root, '.dolt', 'noms', 'nested', 'chunk-2'), 'abcdef');

    const sample = await sampleDoltNomsSize(root);

    assert.deepEqual(sample, {
      kind: 'available',
      sample: {
        bytes: 10,
        source: path.join(root, '.dolt', 'noms'),
      },
    });
  });

  test('returns an explicit unavailable reason when no city path or noms directory is available', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gcd-no-dolt-'));

    assert.deepEqual(await sampleDoltNomsSize(''), {
      kind: 'unavailable',
      reason: 'city_path_missing',
    });
    assert.deepEqual(await sampleDoltNomsSize(root), {
      kind: 'unavailable',
      reason: 'noms_directory_missing',
      source: path.join(root, '.dolt', 'noms'),
    });
  });

  test('keeps sample history per sampler instance', async () => {
    const first = createDoltNomsSampler({
      cityPath: '/city-one',
      sample: async () => ({
        kind: 'available',
        sample: { bytes: 42, source: '/city-one/.dolt/noms' },
      }),
    });
    const second = createDoltNomsSampler({
      cityPath: '/city-two',
      sample: async () => ({
        kind: 'available',
        sample: { bytes: 99, source: '/city-two/.dolt/noms' },
      }),
    });

    await first.sampleOnce();

    assert.deepEqual(first.trend(), {
      available: true,
      samples: [{ ts: first.trend().samples[0]?.ts ?? '', bytes: 42 }],
      source: '/city-one/.dolt/noms',
    });
    assert.deepEqual(second.trend(), {
      available: false,
      samples: [],
      reason: 'city_path_missing',
    });
  });

  test('starts idempotently and clears its sampling interval on stop', () => {
    const runtime = new FakeDoltNomsRuntime();
    const sampler = createDoltNomsSampler({
      cityPath: '/city',
      runtime,
      sample: async () => ({
        kind: 'available',
        sample: { bytes: 1, source: '/city/.dolt/noms' },
      }),
    });

    assert.equal(sampler.running, false);
    sampler.start();
    assert.equal(sampler.running, true);
    assert.equal(runtime.activeIntervalCount(), 1);

    sampler.start();
    assert.equal(runtime.activeIntervalCount(), 1);

    sampler.stop();
    assert.equal(sampler.running, false);
    assert.equal(runtime.activeIntervalCount(), 0);
  });
});

class FakeDoltNomsRuntime implements DoltNomsRuntime {
  setInterval(callback: () => void, delayMs: number): DoltNomsTimer {
    const timer = new FakeDoltNomsTimer(callback, delayMs);
    this.intervals.push(timer);
    return timer;
  }

  clearInterval(timer: DoltNomsTimer): void {
    (timer as FakeDoltNomsTimer).cleared = true;
  }

  activeIntervalCount(): number {
    return this.intervals.filter((timer) => !timer.cleared).length;
  }

  private readonly intervals: FakeDoltNomsTimer[] = [];
}

class FakeDoltNomsTimer implements DoltNomsTimer {
  cleared = false;
  constructor(
    readonly callback: () => void,
    readonly delayMs: number,
  ) {}

  unref(): void {}
}
