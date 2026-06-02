import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { KeyedSwrCache } from '../src/runs/run-detail-cache.js';

// A controllable clock + a loader that counts calls and returns a
// monotonically increasing value, so tests can assert exactly when the
// upstream load fires and which entry version a get() served.
function harness(initialMs = 0) {
  let nowMs = initialMs;
  let calls = 0;
  const load = async (): Promise<string> => {
    calls += 1;
    return `v${calls}`;
  };
  return {
    cache: <T>(ttlMs: number) => new KeyedSwrCache<T>({ ttlMs, now: () => nowMs }),
    advance: (ms: number) => {
      nowMs += ms;
    },
    load,
    callCount: () => calls,
  };
}

// Yield to the microtask queue so a fire-and-forget background revalidation
// (which is intentionally not awaited by get()) has a chance to settle before
// the test inspects the result of the next get().
const flush = () => new Promise((r) => setImmediate(r));

describe('KeyedSwrCache', () => {
  test('cold get awaits the loader and caches the value', async () => {
    const h = harness();
    const cache = h.cache<string>(1000);
    const value = await cache.get('k', h.load);
    assert.equal(value, 'v1');
    assert.equal(h.callCount(), 1);
  });

  test('fresh get within TTL serves cached value without reloading', async () => {
    const h = harness();
    const cache = h.cache<string>(1000);
    await cache.get('k', h.load);
    h.advance(999);
    const value = await cache.get('k', h.load);
    assert.equal(value, 'v1');
    assert.equal(h.callCount(), 1);
  });

  test('stale get serves stale value immediately and revalidates in the background', async () => {
    const h = harness();
    const cache = h.cache<string>(1000);
    await cache.get('k', h.load);
    h.advance(1001);
    // Stale: the caller is NOT blocked on the upstream scan — it gets the
    // prior value instantly while a background refresh runs.
    const stale = await cache.get('k', h.load);
    assert.equal(stale, 'v1');
    await flush();
    assert.equal(h.callCount(), 2, 'background revalidation should have fired');
    // The refreshed entry is served on the next get without another load.
    const fresh = await cache.get('k', h.load);
    assert.equal(fresh, 'v2');
    assert.equal(h.callCount(), 2);
  });

  test('force bypasses a fresh entry and reloads synchronously', async () => {
    const h = harness();
    const cache = h.cache<string>(1000);
    await cache.get('k', h.load);
    const forced = await cache.get('k', h.load, { force: true });
    assert.equal(forced, 'v2');
    assert.equal(h.callCount(), 2);
  });

  test('concurrent cold gets for one key coalesce into a single load', async () => {
    const h = harness();
    const cache = h.cache<string>(1000);
    const [a, b] = await Promise.all([cache.get('k', h.load), cache.get('k', h.load)]);
    assert.equal(a, 'v1');
    assert.equal(b, 'v1');
    assert.equal(h.callCount(), 1);
  });

  test('distinct keys are isolated', async () => {
    const h = harness();
    const cache = h.cache<string>(1000);
    const a = await cache.get('a', h.load);
    const b = await cache.get('b', h.load);
    assert.equal(a, 'v1');
    assert.equal(b, 'v2');
    assert.equal(h.callCount(), 2);
  });

  test('a failed cold load rejects and is not cached', async () => {
    const nowMs = 0;
    let calls = 0;
    const cache = new KeyedSwrCache<string>({ ttlMs: 1000, now: () => nowMs });
    const failing = async (): Promise<string> => {
      calls += 1;
      throw new Error('boom');
    };
    await assert.rejects(() => cache.get('k', failing), /boom/);
    // No entry was cached, so the next get retries the loader.
    const ok = async (): Promise<string> => `recovered-${calls}`;
    const value = await cache.get('k', ok);
    assert.equal(value, 'recovered-1');
  });

  test('a failed background revalidation keeps serving the last good value', async () => {
    let nowMs = 0;
    const cache = new KeyedSwrCache<string>({ ttlMs: 1000, now: () => nowMs });
    await cache.get('k', async () => 'good');
    nowMs += 1001;
    // Stale → serves 'good', kicks a background refresh that throws.
    const stale = await cache.get('k', async () => {
      throw new Error('upstream down');
    });
    assert.equal(stale, 'good');
    await flush();
    // The stale entry survives the failed refresh; still served, no throw.
    nowMs += 1001;
    const again = await cache.get('k', async () => {
      throw new Error('still down');
    });
    assert.equal(again, 'good');
  });
});
