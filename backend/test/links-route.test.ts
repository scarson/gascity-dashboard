import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { GcBead, GcBeadList, GcSessionList, EntityLinkView } from 'gas-city-dashboard-shared';
import { GcClient } from '../src/gc-client.js';
import { linksRouter } from '../src/routes/links.js';

// R3 integration tests for GET /api/links/:ref.
//
// A GcClient subclass stubs the two upstream reads (listBeads,
// listSessions) so the route runs end-to-end without a live supervisor.

function bead(id: string, metadata: Record<string, string> = {}): GcBead {
  return {
    id,
    title: `bead ${id}`,
    status: 'open',
    issue_type: 'task',
    priority: 2,
    created_at: '2026-05-20T00:00:00Z',
    metadata,
  };
}

class StubGcClient extends GcClient {
  constructor(
    private readonly stubBeads: GcBead[],
    private readonly sessionsThrow = false,
    /** Override the reported supervisor total (defaults to items.length). */
    private readonly reportedTotal?: number,
  ) {
    super({ baseUrl: 'http://127.0.0.1:1', cityName: 'ds-research' });
  }
  override async listBeads(): Promise<GcBeadList> {
    return {
      items: this.stubBeads,
      total: this.reportedTotal ?? this.stubBeads.length,
    };
  }
  override async listSessions(): Promise<GcSessionList> {
    if (this.sessionsThrow) throw new Error('sessions down');
    return { items: [], total: 0 };
  }
}

interface AppHandle {
  url: string;
  close: () => Promise<void>;
}

async function buildApp(
  beads: GcBead[],
  sessionsThrow = false,
  reportedTotal?: number,
): Promise<AppHandle> {
  const app = express();
  app.use(express.json());
  app.use('/api/links', linksRouter(new StubGcClient(beads, sessionsThrow, reportedTotal)));
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

async function getJson(url: string): Promise<{ status: number; body: EntityLinkView & Record<string, unknown> }> {
  const res = await fetch(url);
  const body = (await res.json()) as EntityLinkView & Record<string, unknown>;
  return { status: res.status, body };
}

describe('GET /api/links/:ref (R3)', () => {
  let h: AppHandle | undefined;
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
  });

  test('a known bead returns 200 with parent/molecule/PR edges', async () => {
    h = await buildApp([
      bead('focus', {
        'gc.parent_bead_id': 'root',
        molecule_id: 'mol-1',
        'pr_review.pr_number': '123',
      }),
      bead('root'),
      bead('peer', { molecule_id: 'mol-1' }),
    ]);
    const { status, body } = await getJson(`${h.url}/api/links/focus`);
    assert.equal(status, 200);
    assert.equal(body.focus.ref, 'focus');
    const relations = new Set(body.edges.map((e) => e.relation));
    assert.ok(relations.has('parent'), 'has parent edge');
    assert.ok(relations.has('molecule'), 'has molecule edge');
    assert.ok(relations.has('pr'), 'has pr edge');
  });

  test('an unresolvable ref returns 200 with focus-only nodes + partial', async () => {
    h = await buildApp([bead('other')]);
    const { status, body } = await getJson(`${h.url}/api/links/no-such-bead`);
    assert.equal(status, 200);
    assert.equal(body.partial, true);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.edges.length, 0);
  });

  test('a malformed ref returns 400', async () => {
    h = await buildApp([]);
    const res = await fetch(`${h.url}/api/links/${encodeURIComponent('bad id !!')}`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { kind?: string };
    assert.equal(body.kind, 'validation');
  });

  test('a failed sessions fetch degrades to partial, not 5xx', async () => {
    h = await buildApp([bead('focus', { session_id: 's1' })], true);
    const { status, body } = await getJson(`${h.url}/api/links/focus`);
    assert.equal(status, 200);
    assert.equal(body.partial, true);
  });

  test('a truncated bead set (supervisor total > fetched) degrades to partial', async () => {
    // Supervisor reports more beads than were returned in the fetch window
    // → relations may be missing edges to beads beyond the limit, so the
    // view must be flagged partial (truncation is never silent).
    h = await buildApp([bead('focus')], false, 9999);
    const { status, body } = await getJson(`${h.url}/api/links/focus`);
    assert.equal(status, 200);
    assert.equal(body.partial, true, 'truncated bead set must mark the view partial');
  });

  test('a fully-fetched bead set (total === fetched) is not partial', async () => {
    h = await buildApp([bead('focus', { 'gc.parent_bead_id': 'root' }), bead('root')]);
    const { status, body } = await getJson(`${h.url}/api/links/focus`);
    assert.equal(status, 200);
    assert.equal(body.partial, false);
  });

  test('_stats returns the resolution rollup', async () => {
    h = await buildApp([bead('focus', { 'gc.parent_bead_id': 'root' }), bead('root')]);
    await getJson(`${h.url}/api/links/focus`);
    const res = await fetch(`${h.url}/api/links/_stats`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { stats: Array<{ relation: string; resolved: number }> };
    const parent = body.stats.find((s) => s.relation === 'parent');
    assert.equal(parent?.resolved, 1);
  });
});
