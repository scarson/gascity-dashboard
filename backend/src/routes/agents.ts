import { Router } from 'express';
import { ExecError, execAgentPrime } from '../exec.js';
import { recordAudit } from '../audit.js';

// gascity-dashboard-vq7: per-agent prompt/directive surface. Read-only.
// The bead acceptance is explicitly read-only — direct prompt edit via
// UI is a high-blast-radius action and is filed-for-followup behind a
// security_researcher review.
//
// Why a new router instead of folding into /api/sessions: sessions are
// keyed by id (gc-…/td-…/th-…); agent identity here is the alias
// (e.g. 'mayor' or 'thriva/devpipeline.architect') because that's what
// `gc prime` accepts. Keeping the namespace separate avoids confusion
// about which key type a route takes.
//
// AGENT_ALIAS_RE in exec.ts validates the alias shape; the route forwards
// the raw string and lets exec.ts gate it. 404 vs 502 is distinguished
// by gc's exit code + stderr message: --strict exits 1 with stderr
// "agent ... not found in city config" for unknown agents, exits 0 with
// the composed prompt on success.

export function agentsRouter(cityPath: string): Router {
  const router = Router();

  router.get('/:alias/prime', async (req, res) => {
    const alias = req.params.alias;
    try {
      const result = await execAgentPrime(alias, cityPath);
      // --strict reports "agent X not found in city config" on stderr
      // when the alias doesn't map to a configured agent. Surface as
      // 404 so the UI can render an "agent not configured" state
      // instead of a generic upstream error.
      const exitOk = result.exitCode === 0;
      const stderr = result.stderr.slice(0, 1024);
      const notFound = !exitOk && /not found in city config|no agent/i.test(stderr);
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/agents/:alias/prime',
        parsed_args: {
          agent: alias,
          exit_code: String(result.exitCode),
          ...(exitOk
            ? { prompt_bytes: String(result.stdout.length) }
            : { error_kind: notFound ? 'not_found' : 'upstream' }),
        },
        duration_ms: result.durationMs,
      });
      if (!exitOk) {
        res.status(notFound ? 404 : 502).json({
          error: notFound ? 'agent not configured' : `gc prime failed with exit ${result.exitCode}`,
          kind: notFound ? 'not_found' : 'upstream',
          details: { stderr },
        });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        agent: alias,
        prompt: result.stdout,
        bytes: result.stdout.length,
      });
    } catch (err) {
      // Failed-validation attempts are the most interesting audit
      // entries — they're the probing / scanning signal. Mirror the
      // success-path recordAudit so the forensic record is symmetric
      // across outcomes. error_kind + requested alias only; no raw
      // stderr in the audit body (could contain upstream noise or
      // sensitive paths).
      if (err instanceof ExecError) {
        const status =
          err.kind === 'validation' ? 400 : err.kind === 'timeout' ? 504 : 500;
        void recordAudit({
          type: 'dashboard.fetch',
          endpoint: 'GET /api/agents/:alias/prime',
          parsed_args: { agent: alias, error_kind: err.kind },
          duration_ms: 0,
        });
        // gascity-dashboard-473: spawn-arm host path redaction. See
        // beads.ts / mail-send.ts for rationale.
        const wireMessage =
          err.kind === 'spawn' ? 'subprocess could not be started' : err.message;
        if (err.kind === 'spawn') {
          console.warn(`[agents] /api/agents/${alias}/prime spawn failed: ${err.message}`);
        }
        res.status(status).json({ error: wireMessage, kind: err.kind });
        return;
      }
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/agents/:alias/prime',
        parsed_args: { agent: alias, error_kind: 'unknown' },
        duration_ms: 0,
      });
      // gascity-dashboard-473: mirror the ayr sr6 redaction on the
      // catch-all 500. Raw err.message can embed OS detail; details.name
      // (Error class) is the only safe channel.
      console.warn(`[agents] /api/agents/${alias}/prime failed: ${(err as Error).message}`);
      res
        .status(500)
        .json({ error: 'internal error', kind: 'internal', details: { name: (err as Error).name ?? 'Error' } });
    }
  });

  return router;
}
