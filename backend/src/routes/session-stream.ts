import { Router, type Request, type Response } from 'express';
import type { GcClient } from '../gc-client.js';
import { SESSION_ID_RE } from '../lib/sessionId.js';
import { routeValidationError, writeRouteError } from '../route-errors.js';
import { lastEventIdFor, proxySupervisorSse } from './sse-proxy.js';

const DEFAULT_HEARTBEAT_MS = 15_000;

export interface SessionStreamRouterOptions {
  gc: GcClient;
  heartbeatMs?: number;
}

export function sessionStreamRouter(opts: SessionStreamRouterOptions): Router {
  const router = Router();
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  router.get('/:id/stream', async (req: Request, res: Response) => {
    const id = req.params.id;
    if (typeof id !== 'string') {
      writeRouteError(res, routeValidationError('invalid session id'));
      return;
    }
    if (!SESSION_ID_RE.test(id)) {
      writeRouteError(res, routeValidationError('invalid session id'));
      return;
    }

    const lastEventId = lastEventIdFor(req);
    const upstream = opts.gc.sessionStreamUrl(id, lastEventId ?? undefined);

    await proxySupervisorSse(req, res, {
      upstream,
      heartbeatMs,
      unreachableMessage: 'gc supervisor session stream unreachable',
      noBodyMessage: 'gc supervisor session stream response had no body',
    });
  });

  return router;
}
