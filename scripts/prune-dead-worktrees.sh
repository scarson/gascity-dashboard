#!/usr/bin/env bash
#
# Prune dead-pid agent worktrees under .claude/worktrees/agent-*.
#
# The Claude harness locks each subagent worktree with a reason like
#   "claude agent agent-XXX (pid <parent-pid>)"
# so per-wave teardown cannot remove them while the parent session is live.
# Once the parent exits the pid is dead, the lock is stale, and it is safe
# to unlock and remove.
#
# Usage:
#   scripts/prune-dead-worktrees.sh           # dry-run, prints what would happen
#   scripts/prune-dead-worktrees.sh --apply   # actually unlock + remove dead-pid worktrees
#
# Safety:
#   - Only touches worktrees whose path is exactly <repo>/.claude/worktrees/agent-*.
#   - Never touches a worktree whose owning pid is still alive.
#   - Never touches orchestrator-* or any other path.
#   - On removal failure, logs and continues; does not abort.

set -euo pipefail

APPLY=0
if [[ "${1:-}" == "--apply" ]]; then
  APPLY=1
elif [[ -n "${1:-}" ]]; then
  echo "usage: $0 [--apply]" >&2
  exit 2
fi

# Resolve the main repo root, not the current worktree (this script may be
# invoked from inside a worktree). --git-common-dir always points to the
# main repo's .git directory, regardless of which worktree we're in.
REPO_ROOT="$(realpath "$(git rev-parse --git-common-dir)/..")"
AGENT_PREFIX="${REPO_ROOT}/.claude/worktrees/agent-"

dead=0
alive=0
errors=0
skipped=0

# Parse porcelain output into (path, pid) pairs.
# Each worktree block is separated by a blank line; we only care about
# the `worktree <path>` and (optional) `locked <reason>` lines.
current_path=""
current_pid=""

process_entry() {
  local path="$1"
  local pid="$2"

  # Strict prefix check — refuse anything outside the agent worktree dir.
  if [[ "$path" != "${AGENT_PREFIX}"* ]]; then
    return
  fi

  if [[ -z "$pid" ]]; then
    # Locked without a parseable pid, or not locked at all. Leave it alone.
    skipped=$((skipped + 1))
    return
  fi

  if kill -0 "$pid" 2>/dev/null; then
    alive=$((alive + 1))
    return
  fi

  dead=$((dead + 1))
  if [[ "$APPLY" -eq 1 ]]; then
    echo "REMOVE $path (dead pid $pid)"
    if ! git worktree unlock "$path"; then
      echo "  unlock failed for $path" >&2
      errors=$((errors + 1))
      return
    fi
    if ! git worktree remove "$path"; then
      echo "  remove failed for $path" >&2
      errors=$((errors + 1))
      return
    fi
  else
    echo "DRY-RUN would remove $path (dead pid $pid)"
  fi
}

while IFS= read -r line; do
  if [[ -z "$line" ]]; then
    if [[ -n "$current_path" ]]; then
      process_entry "$current_path" "$current_pid"
    fi
    current_path=""
    current_pid=""
    continue
  fi

  case "$line" in
    "worktree "*)
      current_path="${line#worktree }"
      ;;
    "locked "*)
      # Reason format from the harness: "claude agent agent-XXX (pid 12345)"
      reason="${line#locked }"
      if [[ "$reason" =~ pid[[:space:]]+([0-9]+) ]]; then
        current_pid="${BASH_REMATCH[1]}"
      fi
      ;;
  esac
done < <(git worktree list --porcelain)

# Flush the final entry (porcelain output may not end with a blank line).
if [[ -n "$current_path" ]]; then
  process_entry "$current_path" "$current_pid"
fi

mode="dry-run"
[[ "$APPLY" -eq 1 ]] && mode="apply"
echo "prune-dead-worktrees ($mode): dead=$dead alive=$alive skipped=$skipped errors=$errors"

if [[ "$APPLY" -eq 0 && "$dead" -gt 0 ]]; then
  echo "re-run with --apply to remove the $dead dead-pid worktree(s)."
fi
