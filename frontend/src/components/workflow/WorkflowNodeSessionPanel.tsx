import { useEffect, useMemo, useState } from 'react';
import type {
  WorkflowDisplayNode,
  WorkflowExecutionInstance,
} from 'gas-city-dashboard-shared';
import { SessionPeekContent } from '../SessionPeek';
import { StatusBadge, type StatusTone } from '../StatusBadge';
import {
  useSessionStream,
  type SessionStreamProgress,
} from '../../hooks/useSessionStream';

interface WorkflowNodeSessionPanelProps {
  node: WorkflowDisplayNode | null;
  visible: boolean;
}

export function WorkflowNodeSessionPanel({
  node,
  visible,
}: WorkflowNodeSessionPanelProps) {
  const sessionInstances = useMemo(
    () =>
      node?.executionInstances
        .filter((instance) => instance.session.kind === 'attached')
        .sort(compareInstances) ?? [],
    [node],
  );
  const defaultInstance = useMemo(
    () => preferredInstance(sessionInstances),
    [sessionInstances],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    setSelectedKey(defaultInstance ? instanceKey(defaultInstance) : null);
  }, [node?.id, defaultInstance]);

  if (!node) {
    return <p className="text-body text-fg-muted italic">Select a node to inspect its session.</p>;
  }
  if (sessionInstances.length === 0) {
    return <p className="text-body text-fg-muted italic">No session is attached to this node.</p>;
  }

  const selected =
    sessionInstances.find((instance) => instanceKey(instance) === selectedKey) ??
    defaultInstance ??
    sessionInstances[0];
  const selectedIteration = selected ? iterationValue(selected) : 'base';
  const iterationGroups = groupIterations(sessionInstances);
  const attempts = sessionInstances.filter(
    (instance) => iterationValue(instance) === selectedIteration,
  );
  if (!selected) {
    return <p className="text-body text-fg-muted italic">No session is attached to this node.</p>;
  }

  return (
    <section>
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-body font-semibold text-fg">{node.title}</h3>
        {(node.historicalOnly || selected?.historical) && (
          <span className="text-label uppercase tracking-wider text-fg-faint">
            {node.historicalOnly ? 'historical-only' : 'historical'}
          </span>
        )}
      </div>
      {iterationGroups.length > 1 && (
        <div
          className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-label"
          role="radiogroup"
          aria-label="Iterations"
        >
          <span className="uppercase tracking-wider text-fg-faint">Iterations</span>
          {iterationGroups.map((group) => {
            const instance = group.instances.at(-1);
            if (!instance) return null;
            const label = group.iteration === 'base' ? 'Base' : `Iteration ${group.iteration}`;
            const active = group.iteration === selectedIteration;
            return (
              <span key={label} className="flex items-baseline gap-1">
                <span aria-hidden className="text-fg-faint">·</span>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`focus-mark rounded-sm px-0.5 uppercase tracking-wider ${
                    active
                      ? 'text-fg font-semibold underline decoration-fg underline-offset-4'
                      : 'text-fg-muted hover:text-fg'
                  }`}
                  onClick={() => setSelectedKey(instanceKey(instance))}
                >
                  {label}
                </button>
              </span>
            );
          })}
        </div>
      )}
      {attempts.length > 1 && (
        <div
          className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-label"
          role="radiogroup"
          aria-label="Attempts"
        >
          <span className="uppercase tracking-wider text-fg-faint">Attempts</span>
          {attempts.map((instance) => (
            <span key={instanceKey(instance)} className="flex items-baseline gap-1">
              <span aria-hidden className="text-fg-faint">·</span>
              <button
                type="button"
                role="radio"
                aria-checked={instanceKey(instance) === instanceKey(selected)}
                className={`focus-mark rounded-sm px-0.5 uppercase tracking-wider ${
                  instanceKey(instance) === instanceKey(selected)
                    ? 'text-fg font-semibold underline decoration-fg underline-offset-4'
                    : 'text-fg-muted hover:text-fg'
                }`}
                onClick={() => setSelectedKey(instanceKey(instance))}
              >
                Attempt {attemptValue(instance)}
              </button>
            </span>
          ))}
        </div>
      )}
      <SessionTranscript instance={selected} visible={visible} />
    </section>
  );
}

function SessionTranscript({
  instance,
  visible,
}: {
  instance: WorkflowExecutionInstance;
  visible: boolean;
}) {
  const attached = instance.session.kind === 'attached' ? instance.session : null;
  const sessionId = attached?.link.sessionId ?? null;
  const stream = visible && Boolean(attached?.streamable);
  const sessionState = useSessionStream(sessionId, stream);
  const badge = streamBadge(sessionState.stream);
  const loading = sessionState.status === 'loading';
  const result = sessionState.status === 'ready' ? sessionState.result : null;
  const error = sessionState.status === 'failed' ? sessionState.error : null;
  const streamError =
    sessionState.status === 'ready' && sessionState.stream.status === 'degraded'
      ? sessionState.stream.error
      : null;
  return (
    <div className="mt-5 space-y-4">
      {attached?.streamable && (
        <div className="flex justify-end">
          <StatusBadge
            tone={badge.tone}
            label={badge.label}
            title={`Session stream: ${sessionState.stream.status}`}
            className="text-label uppercase tracking-wider"
          />
        </div>
      )}
      {streamError !== null && (
        <p className="text-accent" role="alert">
          {streamError}
        </p>
      )}
      <SessionPeekContent loading={loading} error={error} result={result} />
    </div>
  );
}

function streamBadge(stream: SessionStreamProgress): {
  tone: StatusTone;
  label: string;
} {
  switch (stream.status) {
    case 'open':
      return { tone: 'ok', label: 'live' };
    case 'connecting':
      return { tone: 'warn', label: 'connecting' };
    case 'closed':
      return { tone: 'stuck', label: 'offline' };
    case 'degraded':
      return { tone: 'warn', label: 'degraded' };
    case 'idle':
      return { tone: 'neutral', label: 'snapshot' };
  }
}

function preferredInstance(
  instances: WorkflowExecutionInstance[],
): WorkflowExecutionInstance | undefined {
  return (
    instances.find((instance) => instance.session.kind === 'attached' && instance.session.streamable) ??
    [...instances].sort(compareInstances).at(-1)
  );
}

function groupIterations(instances: WorkflowExecutionInstance[]) {
  const groups = new Map<number | 'base', WorkflowExecutionInstance[]>();
  for (const instance of instances) {
    const key = iterationValue(instance);
    groups.set(key, [...(groups.get(key) ?? []), instance]);
  }
  return [...groups.entries()]
    .map(([iteration, groupInstances]) => ({
      iteration,
      instances: groupInstances.sort(compareInstances),
    }))
    .sort((a, b) => iterationOrder(a.iteration) - iterationOrder(b.iteration));
}

function compareInstances(
  left: WorkflowExecutionInstance,
  right: WorkflowExecutionInstance,
): number {
  return (
    iterationOrder(iterationValue(left)) - iterationOrder(iterationValue(right)) ||
    attemptValue(left) - attemptValue(right) ||
    left.id.localeCompare(right.id)
  );
}

function instanceKey(instance: WorkflowExecutionInstance): string {
  return instance.id;
}

function iterationValue(instance: WorkflowExecutionInstance): number | 'base' {
  return instance.iteration.kind === 'loop' ? instance.iteration.value : 'base';
}

function iterationOrder(iteration: number | 'base'): number {
  return iteration === 'base' ? 0 : iteration;
}

function attemptValue(instance: WorkflowExecutionInstance): number {
  return instance.attempt.kind === 'attempt' ? instance.attempt.value : 1;
}
