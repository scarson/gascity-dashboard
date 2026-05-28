import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GcWorkflowBead, WorkflowExecutionInstance } from 'gas-city-dashboard-shared';
import {
  buildWorkflowDisplayNode,
  latestIterationsByLoop,
  type WorkflowNodeGroup,
} from '../src/workflows/execution-instances.js';

describe('workflow execution instance presentation', () => {
  test('marks only the latest loop iteration current and streamable', () => {
    const group = nodeGroup({
      loopControlNodeId: 'review-loop',
      beads: [
        bead({
          id: 'review-i1',
          status: 'closed',
          iteration: 1,
          sessionId: 'session-i1',
        }),
        bead({
          id: 'review-i2',
          status: 'in_progress',
          iteration: 2,
          sessionId: 'session-i2',
          assignee: 'session-i2',
        }),
      ],
    });

    const node = buildWorkflowDisplayNode(group, [], 2);

    assert.equal(node.status, 'active');
    assert.deepEqual(node.iterationSummary, {
      kind: 'stacked',
      visibleIteration: 2,
      iterationCount: 2,
      control: { kind: 'known', id: 'review-loop' },
    });
    assert.equal(node.visibleInGraph, true);
    assert.equal(node.historicalOnly, false);
    assert.equal(node.executionInstances[0]?.historical, true);
    assert.equal(streamable(node.executionInstances[0]), false);
    assert.equal(node.executionInstances[1]?.currentIteration, true);
    assert.equal(streamable(node.executionInstances[1]), true);
  });

  test('preserves older-only loop nodes as historical evidence', () => {
    const group = nodeGroup({
      loopControlNodeId: 'review-loop',
      beads: [
        bead({
          id: 'old-review',
          status: 'closed',
          iteration: 1,
          sessionId: 'session-i1',
        }),
      ],
    });

    const node = buildWorkflowDisplayNode(group, [], 2);

    assert.equal(node.visibleInGraph, false);
    assert.equal(node.historicalOnly, true);
    assert.deepEqual(node.iterationSummary, {
      kind: 'stacked',
      visibleIteration: 1,
      iterationCount: 1,
      control: { kind: 'known', id: 'review-loop' },
    });
    assert.equal(node.executionInstances[0]?.historical, true);
    assert.equal(node.executionInstances[0]?.currentIteration, false);
    assert.equal(streamable(node.executionInstances[0]), false);
    assert.equal(sessionId(node.executionInstances[0]), 'session-i1');
  });

  test('summarizes retry attempts without hiding failed transcript history', () => {
    const group = nodeGroup({
      constructKind: 'retry',
      beads: [
        bead({
          id: 'retry-a1',
          status: 'closed',
          attempt: 1,
          outcome: 'failed',
          sessionId: 'session-a1',
          maxAttempts: 3,
        }),
        bead({
          id: 'retry-a2',
          status: 'closed',
          attempt: 2,
          sessionId: 'session-a2',
          maxAttempts: 3,
        }),
      ],
    });

    const node = buildWorkflowDisplayNode(group, [], undefined);

    assert.equal(node.status, 'completed');
    assert.deepEqual(node.attemptSummary, {
      kind: 'tracked',
      count: 2,
      badge: { kind: 'bounded', label: '2/3' },
      active: { kind: 'idle' },
    });
    assert.equal(node.executionInstances[0]?.status, 'failed');
    assert.equal(sessionId(node.executionInstances[0]), 'session-a1');
    assert.equal(streamable(node.executionInstances[0]), false);
    assert.equal(node.executionInstances[1]?.status, 'completed');
  });

  test('does not render attempt badges from malformed max-attempt metadata', () => {
    const group = nodeGroup({
      constructKind: 'retry',
      beads: [
        bead({
          id: 'retry-a1',
          attempt: 1,
          maxAttempts: '3x',
        }),
      ],
    });

    const node = buildWorkflowDisplayNode(group, [], undefined);

    assert.deepEqual(node.attemptSummary, {
      kind: 'tracked',
      count: 1,
      badge: { kind: 'count-only' },
      active: { kind: 'idle' },
    });
  });

  test('tracks latest iteration per loop control independently', () => {
    const latest = latestIterationsByLoop([
      nodeGroup({
        semanticNodeId: 'a',
        loopControlNodeId: 'loop-a',
        beads: [bead({ id: 'a1', iteration: 1 }), bead({ id: 'a3', iteration: 3 })],
      }),
      nodeGroup({
        semanticNodeId: 'b',
        loopControlNodeId: 'loop-b',
        beads: [bead({ id: 'b2', iteration: 2 })],
      }),
      nodeGroup({
        semanticNodeId: 'plain',
        beads: [bead({ id: 'plain', iteration: 9 })],
      }),
    ]);

    assert.equal(latest.get('loop-a'), 3);
    assert.equal(latest.get('loop-b'), 2);
    assert.equal(latest.has('plain'), false);
  });
});

function nodeGroup(overrides: Partial<WorkflowNodeGroup> = {}): WorkflowNodeGroup {
  return {
    semanticNodeId: 'review-node',
    title: 'Review node',
    kind: 'step',
    constructKind: 'step',
    beads: [],
    ...overrides,
  };
}

function streamable(instance: WorkflowExecutionInstance | undefined): boolean {
  return instance?.session.kind === 'attached' && instance.session.streamable;
}

function sessionId(instance: WorkflowExecutionInstance | undefined): string {
  assert.equal(instance?.session.kind, 'attached');
  return instance.session.link.sessionId;
}

function bead(opts: {
  id: string;
  status?: string;
  iteration?: number;
  attempt?: number;
  outcome?: string;
  sessionId?: string;
  assignee?: string;
  maxAttempts?: number | string;
}): GcWorkflowBead {
  const metadata: Record<string, string> = {};
  if (opts.iteration !== undefined) metadata['gc.iteration'] = String(opts.iteration);
  if (opts.attempt !== undefined) metadata['gc.attempt'] = String(opts.attempt);
  if (opts.outcome) metadata['gc.outcome'] = opts.outcome;
  if (opts.sessionId) metadata.session_id = opts.sessionId;
  if (opts.maxAttempts !== undefined) metadata['gc.max_attempts'] = String(opts.maxAttempts);
  const result: GcWorkflowBead = {
    id: opts.id,
    title: opts.id,
    status: opts.status ?? 'ready',
    kind: 'task',
    metadata,
  };
  if (opts.assignee !== undefined) result.assignee = opts.assignee;
  return result;
}
