# gas-city-dashboard — session notes for Claude

Editorial-typographic ambient dashboard for a single Gas City operator. Read [`PRODUCT.md`](PRODUCT.md) and [`DESIGN.md`](DESIGN.md) at the repo root before any design work. They are the contract; they outrank assumed conventions.

## What this codebase is

Five-view dashboard surfacing live state from a [Gas City](https://github.com/gastownhall/gascity) (`gc`) supervisor running on `http://127.0.0.1:8372`:

- **Agents** — session state, peek modal
- **Beads** — engineering work queue, inline claim/close/nudge
- **Mail** — read any agent's inbox via persistent "Reading as" strip; sends always go from the operator
- **Activity** — commits + dev-deploy log, live SSE updates
- **Health** — supervisor + host + admin process + dolt-noms trend

Stack: Node 20 + Express + TS (backend), React 18 + Vite + Tailwind + Inter Variable (frontend), `gas-city-dashboard-shared` workspace package for wire-shape types.

## The operator

`stephanie` — hardcoded in `frontend/src/contexts/ViewingAsContext.tsx` and `backend/src/audit.ts`. Any "Reading as <X>" state where `X !== stephanie` is impersonation: read-only for mail, no send. The `OPERATOR_ALIAS` constant + `ViewingAs.isOperator` field are the source of truth.

## Standalone repo, no upstream

This codebase was extracted from [Wldc4rd/citadel](https://github.com/Wldc4rd/citadel) for the project shape (security model, wire-shape contract, the systemd-separated-from-supervisor decision). The visual register was rebuilt from scratch via [impeccable](https://impeccable.style/). **There is no upstream to track** — the `origin` remote was removed deliberately. Charlie Coutts's MIT copyright is preserved in `LICENSE` (required); the codebase is otherwise ours.

## Quick start (dev)

```bash
# Source local env (gitignored; defines GC_CITY_NAME, ADMIN_AUDIT_LOG_PATH, etc.)
set -a; . ./.env.local; set +a

# Terminal 1
npm run dev:backend      # :8081

# Terminal 2
npm run dev:frontend     # :5174, proxies /api → :8081
```

For remote dev over SSH: forward port 5174 from the host. The backend is `127.0.0.1`-only by design.

## Design-iteration tooling

`scripts/snap.mjs` is a Playwright headless harness for screenshot-driven iteration:

```bash
node scripts/snap.mjs                 # all 5 routes × both themes → /tmp/cp-snaps/
node scripts/snap.mjs agents          # one route, both themes
node scripts/snap.mjs agents light    # one route, one theme
```

Read the resulting PNGs back into the conversation with the Read tool — Claude sees them as actual images.

`scripts/inspect.mjs <route> <theme>` returns computed-style JSON for the body / headings / panels on a given route. Useful for confirming token resolution after CSS changes.

`scripts/snap-peek.mjs` opens the Peek modal in both themes and captures the post-click state. Logs API calls + status codes so CSRF / origin issues surface in the script output.

## After any visual change

1. `npm --workspace frontend run typecheck` (and `--workspace backend` if you touched backend)
2. `node scripts/snap.mjs <route>` to regenerate snaps
3. Read the PNG in to your conversation context
4. Compare against `DESIGN.md` — especially **The One Mark Rule**, **The Flat Page Rule**, **The One Voice Rule**, **The Greyscale Test**

If you've materially changed the visual system, re-run `/impeccable document` afterward to regenerate `DESIGN.md` from the actual implementation.

## Cache traps to know

- **Tailwind config changes need a full Vite restart**, not just HMR. The JIT cache in `node_modules/.vite/` will serve stale class definitions until you `rm -rf node_modules/.vite && npm run dev:frontend`.
- **Vite proxy `changeOrigin: true`** is wired in `vite.config.ts` so write requests carry `Origin: http://127.0.0.1:8081` and pass the backend's allow-list. Don't undo it.

## Style absolutes (from DESIGN.md, summarised)

- No em dashes in UI copy. Commas, colons, semicolons, periods, parentheses. (Interpunct `·` is fine for missing-data sentinels.)
- No `#000` / `#fff` — every neutral tints toward hue 75 (warm amber).
- No side-stripe borders > 1px as a colored accent.
- No gradient text, no glassmorphism, no card-grid hero metrics.
- No bordered cards as a structural default — sections separated by space + type, not by containers.
- One typeface family (Inter Variable). No serif accent, no monospace except inside Peek's ANSI-rendered transcript blocks.
- Tabular figures on every column of numbers (`.tnum` utility).

## Layout

```
PRODUCT.md, DESIGN.md, README.md, LICENSE   # design + project docs at root
shared/                                      # gas-city-dashboard-shared (types)
backend/src/{server.ts, routes/, middleware/, gc-client.ts, exec.ts, audit.ts}
frontend/src/{components/, contexts/, hooks/, routes/, styles/, api/}
scripts/{snap,snap-peek,inspect}.mjs         # design iteration harness
deploy/gas-city-dashboard.service            # systemd unit (templated via %h)
docs/{ARCHITECTURE, SECURITY, EXTENDING}.md
```

## When in doubt

- Visual decision? Re-read `DESIGN.md`. The Named Rules are designed to be quotable.
- Strategic decision (what to build, who it's for)? Re-read `PRODUCT.md`.
- Technical decision (how a thing is wired)? `docs/ARCHITECTURE.md`.
- Adding a new route or backend endpoint? `docs/EXTENDING.md`.


## Issue tracker

This project uses **bd (beads)** with a standalone embedded-dolt store at `.beads/`. The store is isolated from the gc supervisor; beads here are **not** visible in the running dashboard's `/api/beads` view.

```bash
bd list                              # show all open beads
bd ready                             # show beads ready to claim (no open deps)
bd show <id>                         # view detail
bd update <id> --claim               # claim it
bd close <id> --reason "what shipped" # close it
bd create "title" --type bug --priority 2 --description "..."
```

`bd prime` (run automatically on `SessionStart` via `.claude/settings.json`) loads full bd workflow context. `bd remember "fact"` records persistent knowledge in the store.

### Task tracking discipline

- **`bd`** is for project-scoped work items: feature requests, bug reports, follow-up commitments, anything that should survive past this session.
- **In-session TaskCreate** is fine for tracking the steps of a single task you're currently doing — the Claude Code task list is ephemeral and scoped to the conversation.
- Avoid markdown TODO scattered through files; everything that's not "doing right now" goes through `bd`.

## Session end

When wrapping up a session:

1. **File follow-ups.** Anything you noticed but didn't finish goes into a bead via `bd create`.
2. **Run quality gates** if code changed — `npm --workspace frontend run typecheck`, `npm --workspace backend run typecheck`, and a `node scripts/snap.mjs` pass for any view you touched.
3. **Update bead status.** Close what's done, set `--status=in_progress` on what's claimed but ongoing.
4. **Commit locally.** This is a standalone repo with no remote at present, so the bar is "commit, don't strand work in the working tree." `git status` should be clean before you stop.
5. **Hand off.** If the next session is a fresh Claude, leave a `bd remember` note or a short paragraph in your reply describing where things stand.

If a GitHub remote is added later, that's when the bd-default `git push` / `bd dolt push` workflow becomes relevant. Until then, local commits are the contract.
