import fs from 'node:fs/promises';
import path from 'node:path';
import type { MaintainerTriage } from 'gas-city-dashboard-shared';

// Atomic JSON cache for the maintainer triage view.
// Reads are best-effort: missing file or parse error returns null so the
// route can fall back to a freshly-fetched empty envelope without ever
// 500ing on a corrupted file. Writes go through a sibling tmp file +
// rename so a crashed write never leaves a half-written cache that the
// next process would choke on.
//
// SQLite is deliberately not used here (gascity-dashboard-361 decision):
// the dataset is small (<50KB even for repos with hundreds of items),
// there's no multi-process concurrency to coordinate, and zero new
// dependencies stays in keeping with the project's "calm tool" ethos.
// A later bead can swap this for SQLite if the cache grows multi-repo
// or wants history retention.

export async function readCache(
  cachePath: string,
): Promise<MaintainerTriage | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as MaintainerTriage;
    if (!isValidEnvelope(parsed)) {
      console.warn(`[maintainer] cache at ${cachePath} failed shape check; ignoring`);
      return null;
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn(`[maintainer] cache read failed: ${(err as Error).message}`);
    return null;
  }
}

export async function writeCache(
  cachePath: string,
  envelope: MaintainerTriage,
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
  await fs.rename(tmp, cachePath);
}

function isValidEnvelope(v: unknown): v is MaintainerTriage {
  if (typeof v !== 'object' || v === null) return false;
  const env = v as Partial<MaintainerTriage>;
  return (
    typeof env.repo === 'string' &&
    Array.isArray(env.tiers) &&
    typeof env.totals === 'object' &&
    env.totals !== null &&
    typeof (env.totals as { issues_open: unknown }).issues_open === 'number' &&
    typeof (env.totals as { prs_open: unknown }).prs_open === 'number'
  );
}
