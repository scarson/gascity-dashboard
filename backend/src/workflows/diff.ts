import type {
  WorkflowChangedFile,
  WorkflowChangedFileKind,
  WorkflowDiffResponse,
  WorkflowDiffRootPath,
  WorkflowExecutionPath,
} from 'gas-city-dashboard-shared';
import { execWorkflowGit } from '../exec.js';
import { LOG_COMPONENT, errorMessage, logWarn } from '../logging.js';

export async function readWorkflowGitDiff(
  executionPath: WorkflowExecutionPath,
): Promise<WorkflowDiffResponse> {
  if (executionPath.kind === 'unavailable') {
    return emptyDiff('path_unknown', unavailableRoot('path_unknown'));
  }
  const cwd = executionPath.path;

  let rootPath: string;
  try {
    const result = await runWorkflowGit(cwd, 'root');
    rootPath = result.stdout.trim();
    if (rootPath.length === 0) return emptyDiff('not_git', unavailableRoot('not_git'));
  } catch (err) {
    logWarn(LOG_COMPONENT.workflows, `workflow git root failed for ${cwd}: ${errorMessage(err)}`);
    return emptyDiff('not_git', unavailableRoot('not_git'));
  }

  try {
    const [statusResult, unstagedResult, stagedResult] = await Promise.all([
      runWorkflowGit(cwd, 'status'),
      runWorkflowGit(cwd, 'diff'),
      runWorkflowGit(cwd, 'diff-cached'),
    ]);
    const status = statusResult.stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    return {
      kind: 'ok',
      rootPath: { kind: 'known', path: rootPath },
      status,
      changedFiles: status.map(parseStatusLine).filter(isChangedFile),
      unstagedDiff: unstagedResult.stdout,
      stagedDiff: stagedResult.stdout,
      truncated:
        statusResult.truncated ||
        unstagedResult.truncated ||
        stagedResult.truncated,
    };
  } catch (err) {
    logWarn(LOG_COMPONENT.workflows, `workflow git diff failed for ${cwd}: ${errorMessage(err)}`);
    return {
      kind: 'error',
      rootPath: { kind: 'known', path: rootPath },
      status: [],
      changedFiles: [],
      unstagedDiff: '',
      stagedDiff: '',
      truncated: false,
      error: 'git diff failed',
    };
  }
}

function emptyDiff(
  kind: Exclude<WorkflowDiffResponse['kind'], 'error'>,
  rootPath: WorkflowDiffRootPath,
): WorkflowDiffResponse {
  return {
    kind,
    rootPath,
    status: [],
    changedFiles: [],
    unstagedDiff: '',
    stagedDiff: '',
    truncated: false,
  };
}

function unavailableRoot(reason: Extract<WorkflowDiffRootPath, { kind: 'unavailable' }>['reason']): WorkflowDiffRootPath {
  return { kind: 'unavailable', reason };
}

async function runWorkflowGit(
  cwd: string,
  view: Parameters<typeof execWorkflowGit>[1],
): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
  const result = await execWorkflowGit(cwd, view);
  const cappedDiff =
    result.truncated && (view === 'diff' || view === 'diff-cached');
  if (result.exitCode !== 0 && !cappedDiff) {
    throw new Error(`git ${view} failed`);
  }
  return result;
}

function parseStatusLine(line: string): WorkflowChangedFile | null {
  if (line.length < 4) return null;
  const rawStatus = line.slice(0, 2);
  const pathPart = line.slice(3);
  const normalizedPath = pathPart.includes(' -> ')
    ? pathPart.split(' -> ').at(-1) ?? pathPart
    : pathPart;
  const status = rawStatus === '??'
    ? '??'
    : rawStatus.replace(/\s/g, '').slice(0, 1);
  return {
    path: normalizedPath,
    status,
    kind: classifyChangedFile(normalizedPath),
  };
}

function classifyChangedFile(filePath: string): WorkflowChangedFileKind {
  const lower = filePath.toLowerCase();
  if (
    lower.endsWith('.test.ts') ||
    lower.endsWith('.test.tsx') ||
    lower.endsWith('.spec.ts') ||
    lower.endsWith('.spec.tsx') ||
    lower.includes('/test/') ||
    lower.includes('/tests/')
  ) {
    return 'test';
  }
  if (
    lower.endsWith('.md') ||
    lower.endsWith('.mdx') ||
    lower.includes('/docs/')
  ) {
    return 'docs';
  }
  if (
    lower.endsWith('.json') ||
    lower.endsWith('.toml') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.config.ts') ||
    lower.endsWith('.config.js') ||
    lower === 'package.json' ||
    lower.endsWith('/package.json')
  ) {
    return 'config';
  }
  if (
    /\.(ts|tsx|js|jsx|go|rs|py|rb|java|kt|swift|c|cc|cpp|h|hpp|css|scss|html)$/.test(lower)
  ) {
    return 'code';
  }
  return 'other';
}

function isChangedFile(value: WorkflowChangedFile | null): value is WorkflowChangedFile {
  return value !== null;
}
