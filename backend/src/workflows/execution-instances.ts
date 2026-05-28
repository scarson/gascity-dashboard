import type {
  GcWorkflowBead,
  WorkflowAttempt,
  WorkflowAttemptSummary,
  WorkflowConstructKind,
  WorkflowControlBadge,
  WorkflowDisplayNode,
  WorkflowExecutionInstance,
  WorkflowIteration,
  WorkflowIterationSummary,
  WorkflowNodeScope,
  WorkflowSessionAttachment,
} from 'gas-city-dashboard-shared';
import {
  attemptFor,
  iterationFor,
  nonEmpty,
  positiveIntegerMeta,
} from './bead-fields.js';
import { workflowSessionLinkFor } from './session-link.js';
import type { WorkflowSessionLinkContext } from './session-link.js';
import {
  aggregateStatus,
  isRunningStatus,
  presentationStatus,
} from './status.js';

export interface WorkflowNodeGroup {
  semanticNodeId: string;
  title: string;
  kind: string;
  constructKind: WorkflowConstructKind;
  scopeRef?: string;
  loopControlNodeId?: string;
  beads: GcWorkflowBead[];
}

export function buildWorkflowDisplayNode(
  group: WorkflowNodeGroup,
  controlBadges: WorkflowControlBadge[],
  latestLoopIteration: number | undefined,
  sessionContext: WorkflowSessionLinkContext = {},
): WorkflowDisplayNode {
  const instances = group.beads
    .map((bead, index) =>
      buildExecutionInstance(group.semanticNodeId, bead, index, sessionContext),
    )
    .sort(compareExecutionInstances);
  const visibleInstance = preferredExecutionInstance(instances);
  const iterations = new Set(
    instances
      .map((instance) => iterationValue(instance.iteration))
      .filter(isNumber),
  );
  const visibleIteration =
    (visibleInstance ? iterationValue(visibleInstance.iteration) : undefined) ??
    (iterations.size > 0 ? Math.max(...iterations) : undefined);
  const historicalOnly =
    group.loopControlNodeId !== undefined &&
    visibleIteration !== undefined &&
    latestLoopIteration !== undefined &&
    visibleIteration < latestLoopIteration;

  for (const instance of instances) {
    const currentIteration =
      !historicalOnly &&
      (visibleIteration === undefined || iterationValue(instance.iteration) === visibleIteration);
    instance.currentIteration = currentIteration;
    instance.historical = !currentIteration;
    instance.session =
      instance.session.kind === 'attached'
        ? {
            ...instance.session,
            streamable: currentIteration && isRunningStatus(instance.status),
          }
        : instance.session;
  }

  if (visibleInstance === undefined) {
    throw new Error(`workflow node ${group.semanticNodeId} has no execution instances`);
  }

  const node: WorkflowDisplayNode = {
    id: group.semanticNodeId,
    semanticNodeId: group.semanticNodeId,
    title: group.title,
    kind: group.kind,
    constructKind: group.constructKind,
    status: aggregateStatus(instances, visibleInstance),
    currentBeadId: visibleInstance.beadId,
    scope: workflowNodeScope(group.scopeRef),
    visibleInGraph: !historicalOnly,
    historicalOnly,
    iterationSummary: iterationSummaryFor(
      visibleIteration,
      iterations.size,
      group.loopControlNodeId,
    ),
    attemptSummary: attemptSummaryFor(instances, group.beads),
    visibleExecutionInstanceId: visibleInstance.id,
    executionInstances: instances,
    controlBadges,
  };
  return node;
}

export function latestIterationsByLoop(groups: WorkflowNodeGroup[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const group of groups) {
    if (!group.loopControlNodeId) continue;
    for (const bead of group.beads) {
      const iteration = iterationFor(bead);
      if (!isNumber(iteration)) continue;
      const current = latest.get(group.loopControlNodeId);
      if (current === undefined || iteration > current) {
        latest.set(group.loopControlNodeId, iteration);
      }
    }
  }
  return latest;
}

function buildExecutionInstance(
  semanticNodeId: string,
  bead: GcWorkflowBead,
  index: number,
  sessionContext: WorkflowSessionLinkContext,
): WorkflowExecutionInstance {
  const beadId = nonEmpty(bead.id);
  if (beadId === undefined) {
    throw new Error(`workflow node ${semanticNodeId} has a bead with an empty id`);
  }
  const iteration = iterationFor(bead);
  const attempt = attemptFor(bead);
  const status = presentationStatus(bead);
  const sessionLink = workflowSessionLinkFor(bead, status, sessionContext);
  const instance: WorkflowExecutionInstance = {
    id: beadId || `${semanticNodeId}:iteration-${iteration ?? 0}:attempt-${attempt ?? index}`,
    semanticNodeId,
    beadId,
    iteration: iterationState(iteration),
    attempt: attemptState(attempt),
    label: instanceLabel(iteration, attempt),
    status,
    session: sessionState(status, sessionLink),
    currentIteration: true,
    historical: false,
  };
  return instance;
}

function preferredExecutionInstance(
  instances: WorkflowExecutionInstance[],
): WorkflowExecutionInstance | undefined {
  return [...instances].sort(compareExecutionInstances).at(-1);
}

function compareExecutionInstances(
  left: WorkflowExecutionInstance,
  right: WorkflowExecutionInstance,
): number {
  return (
    iterationOrder(left.iteration) - iterationOrder(right.iteration) ||
    attemptOrder(left.attempt) - attemptOrder(right.attempt) ||
    left.beadId.localeCompare(right.beadId)
  );
}

function attemptSummaryFor(
  instances: WorkflowExecutionInstance[],
  beads: GcWorkflowBead[],
): WorkflowAttemptSummary {
  const attemptCount = attemptCountFor(instances);
  const activeAttempt = activeAttemptFor(instances);
  const badgeLabel = attemptBadgeFor(beads);
  if (attemptCount === 0 && badgeLabel === undefined) return { kind: 'none' };
  return {
    kind: 'tracked',
    count: Math.max(attemptCount, 1),
    badge:
      badgeLabel === undefined
        ? { kind: 'count-only' }
        : { kind: 'bounded', label: badgeLabel },
    active:
      activeAttempt === undefined
        ? { kind: 'idle' }
        : { kind: 'running', value: activeAttempt },
  };
}

function attemptBadgeFor(beads: GcWorkflowBead[]): string | undefined {
  const max = beads
    .map((bead) => positiveIntegerMeta(bead, 'gc.max_attempts'))
    .find((value) => value !== undefined);
  if (max === undefined) return undefined;
  const attempts = new Set(beads.map(attemptFor).filter(isNumber));
  return `${Math.max(attempts.size, 1)}/${max}`;
}

function attemptCountFor(instances: WorkflowExecutionInstance[]): number {
  const attempts = new Set(
    instances
      .map((instance) => attemptValue(instance.attempt))
      .filter(isNumber),
  );
  return attempts.size;
}

function activeAttemptFor(instances: WorkflowExecutionInstance[]): number | undefined {
  const active = instances.find((instance) => isRunningStatus(instance.status));
  return active ? attemptValue(active.attempt) : undefined;
}

function instanceLabel(
  iteration: number | undefined,
  attempt: number | undefined,
): string {
  if (iteration !== undefined && attempt !== undefined) {
    return `iteration ${iteration}, attempt ${attempt}`;
  }
  if (iteration !== undefined) return `iteration ${iteration}`;
  if (attempt !== undefined) return `attempt ${attempt}`;
  return 'base';
}

function workflowNodeScope(scopeRef: string | undefined): WorkflowNodeScope {
  return scopeRef === undefined ? { kind: 'workflow' } : { kind: 'scoped', ref: scopeRef };
}

function iterationSummaryFor(
  visibleIteration: number | undefined,
  iterationCount: number,
  loopControlNodeId: string | undefined,
): WorkflowIterationSummary {
  if (visibleIteration === undefined || iterationCount === 0) return { kind: 'single' };
  return {
    kind: 'stacked',
    visibleIteration,
    iterationCount,
    control:
      loopControlNodeId === undefined
        ? { kind: 'unknown' }
        : { kind: 'known', id: loopControlNodeId },
  };
}

function iterationState(value: number | undefined): WorkflowIteration {
  return value === undefined ? { kind: 'base' } : { kind: 'loop', value };
}

function attemptState(value: number | undefined): WorkflowAttempt {
  return value === undefined ? { kind: 'untracked' } : { kind: 'attempt', value };
}

function sessionState(
  status: WorkflowExecutionInstance['status'],
  link: ReturnType<typeof workflowSessionLinkFor>,
): WorkflowSessionAttachment {
  if (link !== undefined) {
    return { kind: 'attached', link, streamable: false };
  }
  return {
    kind: 'none',
    reason: status === 'pending' || status === 'ready' ? 'not_started' : 'session_unresolved',
  };
}

function iterationValue(iteration: WorkflowIteration): number | undefined {
  return iteration.kind === 'loop' ? iteration.value : undefined;
}

function attemptValue(attempt: WorkflowAttempt): number | undefined {
  return attempt.kind === 'attempt' ? attempt.value : undefined;
}

function iterationOrder(iteration: WorkflowIteration): number {
  return iterationValue(iteration) ?? 0;
}

function attemptOrder(attempt: WorkflowAttempt): number {
  return attemptValue(attempt) ?? 0;
}

function isNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
