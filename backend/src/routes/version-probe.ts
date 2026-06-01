import { runExec } from '../exec-core.js';
import { errorMessage } from '../logging.js';
import {
  parseVersion,
  type VersionProbe,
  type VersionProbeResult,
} from './health-diagnostics.js';

// gascity-dashboard-1cob: the gc supervisor API exposes no Dolt or Beads
// binary version (see gascity-dashboard-1cob.1), so the dashboard probes them
// locally on the 127.0.0.1 backend host via `dolt version` / `bd version`.
// This is the IO edge; parsing + diagnostics translation are pure (see
// health-diagnostics.ts). A failed probe is surfaced as `error` with a reason,
// never swallowed into a fake version string.

const VERSION_PROBE_TIMEOUT_MS = 3_000;

async function probeVersion(cmd: string): Promise<VersionProbeResult> {
  try {
    const result = await runExec(cmd, ['version'], VERSION_PROBE_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || 'no output';
      return { kind: 'error', reason: `${cmd} version exited ${result.exitCode}: ${detail}` };
    }
    const version = parseVersion(result.stdout);
    if (version === null) {
      return { kind: 'error', reason: `${cmd} version output had no recognizable version` };
    }
    return { kind: 'ok', version };
  } catch (err) {
    return { kind: 'error', reason: `${cmd} version probe failed: ${errorMessage(err)}` };
  }
}

export const probeDoltVersion: VersionProbe = () => probeVersion('dolt');

export const probeBeadsVersion: VersionProbe = () => probeVersion('bd');
