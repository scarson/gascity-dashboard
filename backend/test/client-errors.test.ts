import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { clientErrorsRouter } from '../src/routes/client-errors.js';
import { LOG_COMPONENT } from '../src/logging.js';

async function withRouter<T>(
  logs: string[],
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(
    '/api/client-errors',
    clientErrorsRouter({
      log: (component, message) => logs.push(`${component}:${message}`),
    }),
  );

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('client error reporting route', () => {
  test('logs a validated browser error event', async () => {
    const logs: string[] = [];
    await withRouter(logs, async (url) => {
      const res = await fetch(`${url}/api/client-errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          component: 'ThemeContext',
          operation: 'localStorage.getItem',
          message: 'storage blocked',
        }),
      });

      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { ok: true });
    });

    assert.equal(logs.length, 1);
    assert.equal(
      logs[0],
      `${LOG_COMPONENT.client}:ThemeContext localStorage.getItem: storage blocked`,
    );
  });

  test('rejects malformed browser error events', async () => {
    const logs: string[] = [];
    await withRouter(logs, async (url) => {
      const res = await fetch(`${url}/api/client-errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          component: 'ThemeContext',
          operation: '',
          message: 'storage blocked',
        }),
      });

      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), {
        error: 'operation must be a non-empty string',
        kind: 'validation',
      });
    });
    assert.deepEqual(logs, []);
  });
});
