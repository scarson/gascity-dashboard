import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GcWorkflowBead } from 'gas-city-dashboard-shared';
import { resolveWorkflowExecutionPath } from '../src/workflows/execution-path.js';

describe('workflow execution path resolution', () => {
  test('prefers formula execution cwd on the root bead', () => {
    const root = workflowBead({
      metadata: {
        'gc.cwd': ' /runs/adopt-pr ',
        'gc.work_dir': '/runs/older',
        'gc.rig_root': '/rig/root',
      },
    });
    const child = workflowBead({
      id: 'child',
      metadata: { 'gc.cwd': '/runs/child' },
    });

    assert.deepEqual(
      resolveWorkflowExecutionPath(root, [root, child], '/configured/rig'),
      { kind: 'known', path: '/runs/adopt-pr' },
    );
  });

  test('falls back to child or session work-dir metadata before rig roots', () => {
    const root = workflowBead({
      metadata: { 'gc.rig_root': '/rig/root' },
    });
    const sessionBead = workflowBead({
      id: 'session-step',
      metadata: { work_dir: ' /runs/session-step ' },
    });

    assert.deepEqual(
      resolveWorkflowExecutionPath(root, [root, sessionBead], '/configured/rig'),
      { kind: 'known', path: '/runs/session-step' },
    );
  });

  test('uses supervisor rig-root metadata when cwd/work-dir metadata is missing', () => {
    const root = workflowBead({ metadata: { rig_root: ' /rig/from-root ' } });

    assert.deepEqual(
      resolveWorkflowExecutionPath(root, [root], '/configured/rig'),
      { kind: 'known', path: '/rig/from-root' },
    );
  });

  test('uses the configured rig root when supervisor data has no execution path', () => {
    assert.deepEqual(
      resolveWorkflowExecutionPath(workflowBead({}), [], ' /configured/rig '),
      { kind: 'known', path: '/configured/rig' },
    );
  });

  test('returns an explicit unavailable state when no execution path is available', () => {
    assert.deepEqual(resolveWorkflowExecutionPath(workflowBead({}), [], '  '), {
      kind: 'unavailable',
      reason: 'missing_cwd_and_rig_root',
    });
    assert.deepEqual(resolveWorkflowExecutionPath(undefined, [], undefined), {
      kind: 'unavailable',
      reason: 'missing_cwd_and_rig_root',
    });
  });
});

function workflowBead(overrides: Partial<GcWorkflowBead>): GcWorkflowBead {
  return {
    id: 'root',
    title: 'Workflow',
    status: 'ready',
    kind: 'task',
    metadata: {},
    ...overrides,
  };
}
