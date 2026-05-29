import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowDiffResponse } from 'gas-city-dashboard-shared';
import { WorkflowDiffPanel } from './WorkflowDiffPanel';
import { assertAtMostOneMark } from '../../test/assertions/oneMarkRule';

afterEach(() => cleanup());

describe('WorkflowDiffPanel', () => {
  it('shows quiet skipped states when the execution folder is unknown or not git', () => {
    const { rerender } = render(<WorkflowDiffPanel diff={diffFor('path_unknown')} />);

    expect(screen.getByText(/execution folder is unknown/i)).toBeTruthy();

    rerender(<WorkflowDiffPanel diff={diffFor('not_git')} />);
    expect(screen.getByText(/not a git work tree/i)).toBeTruthy();
  });

  it('labels staged and unstaged diffs and preserves prefix-based structural classes', () => {
    const { container } = render(
      <WorkflowDiffPanel
        diff={{
          kind: 'ok',
          rootPath: { kind: 'known', path: '/tmp/rig' },
          status: [' M src/workflow.ts', 'A  src/workflow.test.ts'],
          changedFiles: [
            { path: 'src/workflow.ts', status: 'M', kind: 'code' },
            { path: 'src/workflow.test.ts', status: 'A', kind: 'test' },
          ],
          unstagedDiff: [
            'diff --git a/src/workflow.ts b/src/workflow.ts',
            '@@ -1 +1 @@',
            '-old session',
            '+new session',
          ].join('\n'),
          stagedDiff: [
            'diff --git a/src/workflow.test.ts b/src/workflow.test.ts',
            '@@ -0,0 +1 @@',
            '+test coverage',
          ].join('\n'),
          truncated: true,
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Unstaged Diff' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Staged Diff' })).toBeTruthy();
    expect(screen.getByText(/diff truncated/i)).toBeTruthy();
    expect(container.querySelector('.diff-line-add')?.textContent).toContain('+new session');
    expect(container.querySelector('.diff-line-remove')?.textContent).toContain('-old session');
    expect(container.querySelector('.diff-line-hunk')?.textContent).toContain('@@');
  });

  it('never colors body-type diff lines with the maroon accent (One Mark Rule + Greyscale Test)', () => {
    const { container } = render(
      <WorkflowDiffPanel
        diff={{
          kind: 'ok',
          rootPath: { kind: 'known', path: '/tmp/rig' },
          status: [' M src/workflow.ts'],
          changedFiles: [{ path: 'src/workflow.ts', status: 'M', kind: 'code' }],
          unstagedDiff: [
            'diff --git a/src/workflow.ts b/src/workflow.ts',
            '@@ -1,2 +1,2 @@',
            '-old session one',
            '-old session two',
            '+new session one',
            '+new session two',
          ].join('\n'),
          stagedDiff: '',
          truncated: false,
        }}
      />,
    );

    // The +/- glyph carries the add/remove signal; color must not. No diff
    // line may carry the maroon accent — multiple remove lines would otherwise
    // breach the One Mark Rule (at most one maroon per viewport). The shared
    // helper enforces the <=1 invariant (calm state: 0 satisfies <=1); the
    // remove-specific guard below pins the test's documented intent — remove
    // rows in particular must never gain the accent — which the helper alone
    // cannot express.
    assertAtMostOneMark(container);
    expect(container.querySelectorAll('.diff-line-remove.text-accent').length).toBe(0);
  });
});

function diffFor(kind: 'path_unknown' | 'not_git'): WorkflowDiffResponse {
  return {
    kind,
    rootPath: { kind: 'unavailable', reason: kind },
    status: [],
    changedFiles: [],
    unstagedDiff: '',
    stagedDiff: '',
    truncated: false,
  };
}
