import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ExecResult } from '../src/exec.js';
import { agentsRouter } from '../src/routes/agents.js';
import { setAuditLogPath } from '../src/audit.js';

// Tests for GET /api/agents/:alias/prime non-zero-exit redaction
// (gascity-dashboard-i53).
//
// Threat model: gc prime --strict stderr can be up to 1024 bytes of
// implementation-defined content (today: "agent X not found in city
// config" for 404 arm; arbitrary content for 502 arm). Pinning the wire
// contract so a future gc release that adds host paths or env detail to
// stderr cannot regress this redaction silently.
//
// Mirrors the DI harness shape used in maintainer-sling.test.ts /
// mail-send.test.ts.

type PrimeStub = (alias: string, cityPath?: string) => Promise<ExecResult>;

interface AppHandle {
  url: string;
  close: () => Promise<void>;
  auditPath: string;
}

interface BuildOpts {
  prime?: PrimeStub;
}

async function buildApp(opts: BuildOpts = {}): Promise<AppHandle> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-prime-test-'));
  const auditPath = path.join(tmpDir, 'events.jsonl');
  setAuditLogPath(auditPath);

  const defaultStub: PrimeStub = async () => ({
    exitCode: 0,
    stdout: 'composed prompt body\n',
    stderr: '',
    truncated: false,
    durationMs: 7,
  });

  const app = express();
  app.use('/api/agents', agentsRouter({ execAgentPrime: opts.prime ?? defaultStub }));

  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        auditPath,
        close: () =>
          new Promise<void>((r) =>
            srv.close(async () => {
              await fs.rm(tmpDir, { recursive: true, force: true });
              r();
            }),
          ),
      });
    });
  });
}

async function getJson(
  url: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url);
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: data };
}

describe('GET /api/agents/:alias/prime — non-zero-exit redaction', { concurrency: false }, () => {
  let h: AppHandle | undefined;

  afterEach(async () => {
    if (h) {
      await h.close();
      h = undefined;
    }
  });

  test('200 success returns prompt body and no stderr leakage', async () => {
    h = await buildApp({
      prime: async () => ({
        exitCode: 0,
        stdout: 'AGENT PROMPT BODY',
        stderr: '',
        truncated: false,
        durationMs: 12,
      }),
    });
    const res = await getJson(`${h.url}/api/agents/mayor/prime`);
    assert.equal(res.status, 200);
    assert.equal(res.body.agent, 'mayor');
    assert.equal(res.body.prompt, 'AGENT PROMPT BODY');
    assert.equal(res.body.bytes, 'AGENT PROMPT BODY'.length);
  });

  test('404 not_found redacts stderr from wire (gascity-dashboard-i53)', async () => {
    h = await buildApp({
      prime: async () => ({
        exitCode: 1,
        stdout: '',
        // Today's gc stderr for unknown alias, plus a forward-looking
        // sensitive-path payload to demonstrate the contract: whatever
        // gc puts here must NOT reach the client.
        stderr:
          'agent unknownagent not found in city config (loaded from /home/ds/secret-city/.gc/config.yaml)',
        truncated: false,
        durationMs: 5,
      }),
    });
    const res = await getJson(`${h.url}/api/agents/unknownagent/prime`);
    assert.equal(res.status, 404);
    assert.equal(res.body.kind, 'not_found');
    assert.equal(res.body.error, 'agent not configured');
    // The acceptance criterion: stderr / path detail MUST NOT appear on
    // the wire. Both shapes (string field, nested details.stderr).
    assert.equal('stderr' in res.body, false, 'top-level stderr must not be present');
    const details = res.body.details as Record<string, unknown> | undefined;
    if (details !== undefined) {
      assert.equal('stderr' in details, false, 'details.stderr must not be present');
    }
    // Belt-and-suspenders: serialised body contains no path fragment from stderr.
    const serialised = JSON.stringify(res.body);
    assert.equal(serialised.includes('/home/ds/secret-city'), false);
    assert.equal(serialised.includes('city config'), false);
  });

  test('502 upstream redacts stderr from wire (gascity-dashboard-i53)', async () => {
    h = await buildApp({
      prime: async () => ({
        exitCode: 2,
        stdout: '',
        stderr:
          'panic: runtime error: index out of range [3] with length 2\n\tgoroutine 1 [running]:\n\tmain.compose(/home/ds/gascity/internal/prime/compose.go:142)',
        truncated: false,
        durationMs: 8,
      }),
    });
    const res = await getJson(`${h.url}/api/agents/mayor/prime`);
    assert.equal(res.status, 502);
    assert.equal(res.body.kind, 'upstream');
    // Discriminator preserved; raw stderr stripped.
    assert.equal('stderr' in res.body, false, 'top-level stderr must not be present');
    // The 502 wire shape promises a present `details` object with a
    // descriptive `name` and NO stderr. Pin it directly so a future
    // change that drops `details` (or revives `details.stderr`) fails
    // loudly instead of slipping through a loose conditional.
    const details = res.body.details as Record<string, unknown> | undefined;
    assert.ok(details !== undefined, 'details must be present on 502 upstream');
    assert.equal(details.name, 'NonZeroExit');
    assert.equal('stderr' in details, false, 'details.stderr must not be present');
    const serialised = JSON.stringify(res.body);
    assert.equal(serialised.includes('/home/ds/gascity'), false);
    assert.equal(serialised.includes('goroutine'), false);
    assert.equal(serialised.includes('panic'), false);
  });

  test('502 upstream preserves enough discriminator for frontend routing', async () => {
    // The frontend reads `kind` and `error` (status code already routes
    // 404 vs 502). This pins that contract so a future "just drop the
    // whole error body" simplification doesn't strip the discriminators
    // the UI needs.
    h = await buildApp({
      prime: async () => ({
        exitCode: 2,
        stdout: '',
        stderr: 'some failure',
        truncated: false,
        durationMs: 8,
      }),
    });
    const res = await getJson(`${h.url}/api/agents/mayor/prime`);
    assert.equal(res.status, 502);
    assert.equal(typeof res.body.kind, 'string');
    assert.equal(typeof res.body.error, 'string');
    assert.equal((res.body.details as { name?: string } | undefined)?.name, 'NonZeroExit');
  });
});
