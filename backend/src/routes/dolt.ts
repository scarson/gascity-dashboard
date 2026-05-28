import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DoltNomsTrend, DoltNomsUnavailableReason } from 'gas-city-dashboard-shared';
import { recordAudit } from '../audit.js';
import { LOG_COMPONENT, errorMessage, logWarn } from '../logging.js';

// In-memory ring buffer of dolt-noms size samples — 24 h at 10-minute
// cadence = 144 slots. The sampler reads the configured city root's
// `.dolt/noms` directory directly. If the dashboard is started without a
// city path, the endpoint reports unavailable rather than guessing from
// the dashboard repo's cwd.

const SLOT_COUNT = 144;
const SAMPLE_INTERVAL_MS = 10 * 60 * 1_000;

interface RingSlot {
  ts: string;
  bytes: number;
}

type DoltNomsAvailability =
  | { kind: 'available'; source: string }
  | { kind: 'unavailable'; reason: DoltNomsUnavailableReason };

export interface DoltNomsTimer {
  unref(): void;
}

export interface DoltNomsRuntime {
  setInterval(callback: () => void, delayMs: number): DoltNomsTimer;
  clearInterval(timer: DoltNomsTimer): void;
}

export interface DoltNomsSampler {
  readonly running: boolean;
  start(): void;
  stop(): void;
  sampleOnce(): Promise<void>;
  trend(): DoltNomsTrend;
}

type SamplerTimerState =
  | { status: 'idle' }
  | { status: 'scheduled'; timer: DoltNomsTimer };

const nodeRuntime: DoltNomsRuntime = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

export interface DoltNomsSample {
  bytes: number;
  source: string;
}

export type DoltNomsSampleResult =
  | { kind: 'available'; sample: DoltNomsSample }
  | { kind: 'unavailable'; reason: 'city_path_missing' }
  | { kind: 'unavailable'; reason: 'city_path_not_absolute'; cityPath: string }
  | { kind: 'unavailable'; reason: 'noms_directory_missing'; source: string }
  | { kind: 'unavailable'; reason: 'noms_path_not_directory'; source: string };

export interface DoltNomsSamplerOptions {
  cityPath: string;
  sample?: (cityPath: string) => Promise<DoltNomsSampleResult>;
  runtime?: DoltNomsRuntime;
  intervalMs?: number;
  slotCount?: number;
}

export function createDoltNomsSampler(opts: DoltNomsSamplerOptions): DoltNomsSampler {
  const sample = opts.sample ?? sampleDoltNomsSize;
  const runtime = opts.runtime ?? nodeRuntime;
  const intervalMs = opts.intervalMs ?? SAMPLE_INTERVAL_MS;
  const slotCount = opts.slotCount ?? SLOT_COUNT;
  const ring: RingSlot[] = [];
  let availability: DoltNomsAvailability = {
    kind: 'unavailable',
    reason: 'city_path_missing',
  };
  let timerState: SamplerTimerState = { status: 'idle' };

  const sampleOnce = async (): Promise<void> => {
    try {
      const result = await sample(opts.cityPath);
      if (result.kind === 'available') {
        ring.push({ ts: new Date().toISOString(), bytes: result.sample.bytes });
        if (ring.length > slotCount) ring.shift();
        availability = { kind: 'available', source: result.sample.source };
      } else {
        availability = { kind: 'unavailable', reason: result.reason };
      }
    } catch (err) {
      availability = { kind: 'unavailable', reason: 'sample_failed' };
      logWarn(LOG_COMPONENT.doltNoms, `sample failed: ${errorMessage(err)}`);
    }
  };

  return {
    get running() {
      return timerState.status === 'scheduled';
    },
    start() {
      if (timerState.status === 'scheduled') return;
      void sampleOnce();
      timerState = {
        status: 'scheduled',
        timer: runtime.setInterval(() => {
          void sampleOnce();
        }, intervalMs),
      };
      timerState.timer.unref();
    },
    stop() {
      if (timerState.status === 'idle') return;
      runtime.clearInterval(timerState.timer);
      timerState = { status: 'idle' };
    },
    sampleOnce,
    trend() {
      const samples = ring.map((s) => ({ ts: s.ts, bytes: s.bytes }));
      return availability.kind === 'available'
        ? {
            available: true,
            samples,
            source: availability.source,
          }
        : {
            available: false,
            samples,
            reason: availability.reason,
          };
    },
  };
}

export async function sampleDoltNomsSize(cityPath: string): Promise<DoltNomsSampleResult> {
  if (cityPath.length === 0) return { kind: 'unavailable', reason: 'city_path_missing' };
  if (!path.isAbsolute(cityPath)) {
    return { kind: 'unavailable', reason: 'city_path_not_absolute', cityPath };
  }
  const source = path.join(cityPath, '.dolt', 'noms');
  try {
    const stat = await fs.stat(source);
    if (!stat.isDirectory()) {
      return { kind: 'unavailable', reason: 'noms_path_not_directory', source };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'unavailable', reason: 'noms_directory_missing', source };
    }
    throw err;
  }
  return {
    kind: 'available',
    sample: {
      bytes: await directoryByteSize(source),
      source,
    },
  };
}

async function directoryByteSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryByteSize(child);
    } else if (entry.isFile()) {
      total += (await fs.stat(child)).size;
    }
  }
  return total;
}

export function doltRouter(sampler: DoltNomsSampler): Router {
  const router = Router();
  router.get('/trend', (_req, res) => {
    const payload = sampler.trend();
    void recordAudit({
      type: 'dashboard.fetch',
      endpoint: 'GET /api/dolt-noms/trend',
      parsed_args: { samples: String(payload.samples.length) },
      duration_ms: 0,
    });
    res.json(payload);
  });
  return router;
}
