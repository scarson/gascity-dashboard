# Code Quality Remediation Plan

Status: proposed. No code changed yet. This plan is the synthesis of two independent review passes against `main` (clean working tree, ~31k LOC of non-test source):

1. **Thermo-nuclear review (TN)** — 8 parallel slice reviewers auditing the whole codebase for abstraction quality, god-files, spaghetti growth, and canonical-helper drift.
2. **Codex remediation prompt (claims A–H)** — validated claim-by-claim against the actual source by 8 verifier agents. Each verdict below carries file:line evidence.

Every item in this plan is **evidence-backed and validated**. Where the two passes overlap they are merged; where Codex was imprecise the correction is called out.

The four open decisions were resolved in a `/grill-me` session against the architecture specs and the upstream `gascity` dashboard as a reference (`~/code/gastownhall/gascity/cmd/gc/dashboard/web`). See **Resolved decisions** at the end; the affected workstreams (WS-2, WS-10, WS-12) reflect the final calls.

## Guardrails (non-negotiable)

These bound every workstream. They come from `AGENTS.md`, the architecture-best-practices block in `CLAUDE.md`, and the Codex prompt.

- **Product language is Formula / Run / Formula Run.** `workflow` may remain **only** where it is literally the GC supervisor wire contract: an endpoint path, a generated wire type, or a raw decoder input shape. Translate at the edge; never let it flow into dashboard DTOs, routes, or components.
- **Move-fast-and-break-it.** No legacy redirects, no backward-compat shims, no deprecation aliases unless the GC supervisor wire API itself requires them. Rename freely.
- **Do not hand-edit generated code.** Change OpenAPI inputs / generator config / source modules and regenerate.
- **TDD.** Write or update the test first (or alongside). A change is not done until red→green. Static warnings count as failures.
- **Behavior-preserving by default.** Exactly **one** workstream (WS-12, the run-detail tab decoupling) is an intentional user-facing behavior change; it is flagged as a decision point. Everything else preserves behavior except where it *correctly surfaces a previously-hidden failure*.
- **Match CI locally before pushing:** root `npm run typecheck`, backend + frontend `typecheck:test`, `frontend run build`, and both test suites. A `shared` wire-shape change breaks `*.test.ts(x)` fixtures the app typecheck never sees.

## Validation summary

| Claim | Title | Verdict | Disposition | Workstream |
| --- | --- | --- | --- | --- |
| A | `/workflows` + `/kanban` redirects exist; delete them | **partial** (redirects exist `App.tsx:80-84`; spec already forbids them; safe to delete) | include as-stated | WS-1 |
| B | Dashboard-owned `workflow` types/fields → run vocab | **confirmed** | include as-stated | WS-2 |
| C | Formula identity resolution duplicated 6× | **confirmed** (some divergence is *intentional*) | include **modified** | WS-5 |
| D | Run scope parsed in 5 places; 1 true duplicate | **confirmed** | include as-stated | WS-6 |
| E | `snapshot/collectors/runs.ts` (878 LOC) does too much | **confirmed** | include **modified** (after C, D) | WS-8 |
| F | Supervisor schema authority split; write-edge casts | **confirmed** | **redesigned** → generate client+Zod from OpenAPI (`@hey-api`); see WS-10 | WS-10 |
| G | Split detail/diff resources; honest diff errors; decouple tab | **confirmed** | **accepted in full** (split hooks + decouple tab); see WS-12 | WS-12 |
| H | Diff reviewability policy split across `exec.ts` + `diff.ts` | **confirmed** (genuinely cross-file) | include as-stated | WS-7 |

Additional **TN-only** findings not in the Codex prompt are folded in as WS-3, WS-4, WS-9, WS-11, WS-13, WS-14, plus the lower-priority cleanups list.

---

## Workstreams

Each workstream lists: **Why** · **Evidence** (file:line) · **Change** · **Tests** · **Risk** · **Deps**. Workstreams are grouped by tier; the tier is the recommended execution order.

### Tier 0 — Vocabulary isolation (low risk, high signal; do first)

#### WS-1 — Delete the dashboard `/workflows` and `/kanban` route surface  *(Codex A)*

- **Why:** Product language is Run/Formula. The dashboard owns no `workflow` routes per `specs/architecture/formula-run-detail-type.md:63,472`, yet `App.tsx` still ships client-side redirects — a documentation-vs-implementation divergence keeping the dead concept alive.
- **Evidence:** `frontend/src/App.tsx:80-84` — `<Route path="/workflows" element={<Navigate to="/runs" replace />} />` and the same for `/kanban` (SPA client redirect, not an HTTP 302). `shared/src/views.ts:69-70` — a `legacyPaths` redirect field that is **defined but never used** by any module.
- **Change:**
  1. Delete the two `<Route>` redirects and the explaining comment in `App.tsx`.
  2. Delete the unused `legacyPaths` field from the view-registry type in `shared/src/views.ts` (no module declares it → dead contract).
- **Tests:** Add a route test asserting `/workflows` and `/kanban` render the not-found surface (not a redirect to `/runs`); confirm `/runs` still works. Verify no `<Link>`/`navigate()` in `frontend/src` targets these paths (grep clean today).
- **Risk:** Minimal. No inbound navigation exists. Old bookmarks now 404 — intentional per spec.
- **Deps:** none.

#### WS-2 — Rename dashboard-owned `workflow` types/fields to run vocabulary  *(Codex B)*

- **Why:** The `workflow → run` translation is applied at only ~half the wire edge, so the dashboard interior speaks two dialects for one concept. AGENTS.md mandates translating at the edge.
- **Evidence (rename — dashboard-owned leaks):**
  - `shared/src/run-detail.ts:202,205` — `WorkflowFormulaSource` → **`RunFormulaSource`** (consumed by `backend/src/runs/formula-name.ts:1,17` and `frontend/src/routes/FormulaRunDetail.tsx:250`).
  - `shared/src/index.ts:649` — `GcFormulaRun.workflow_id` → **`run_id`**.
  - `shared/src/index.ts:693` — `GcFormulaRecentRun.workflow_id` → **`run_id`**.
  - `shared/src/index.ts:1038` — `TriageItem.workflow_run_id` → **`run_id`** (stamped at `backend/src/views/modules/maintainer/router.ts:546`, read at `frontend/src/views/modules/maintainer/TriageSignals.tsx:39,43`).
- **Evidence (keep — genuine wire):** `gc-client.ts:86` endpoint path `/v0/city/{city}/workflow/{workflow_id}`; `gc-supervisor-decoders.ts:50-51,299-300,347,362` raw Zod schemas mirroring OpenAPI `WorkflowSnapshotResponse`/`FormulaRunResponse`. These stay `workflow_*`.
- **Change:** Rename the four dashboard symbols. **Critically:** because `GcFormulaRun`/`GcFormulaRecentRun` are the *decoder output* shape and the wire still sends `workflow_id`, the rename must happen **at the decoder via `.transform()`/property remap** — exactly the pattern `getRun()` already uses at `gc-supervisor-decoders.ts:596-602` (`workflow_id → run_id`). Apply the same remap in `FormulaRunSchema` and `FormulaRecentRunSchema`. Then update the propagation site `snapshot/collectors/runs.ts:808` (`run.root_bead_id ?? run.workflow_id`). Also fix the `TriageItem` field JSDoc, which points at the **deleted** `/workflows/<id>` route (`index.ts:1026`) → `/runs/<id>`. **Field name is `run_id`** (resolved — spec Naming Boundary L62 "Dashboard DTO identity is runId"; the "best-known-at-sling-time, not live" nuance stays in the JSDoc, not the name).
- **Tests:** Update `backend/src/views/modules/maintainer/maintainer-sling.test.ts` (asserts `workflow_run_id` stamping ~799-876) and `shared/src/index.test.ts`. Add a decoder test proving wire `workflow_id` maps to DTO `run_id`.
- **Risk:** `shared` is the cross-workspace contract → run **both** `typecheck:test`s. The `TriageItem.workflow_run_id` JSDoc carries "best-known-at-sling-time" semantics — preserve that meaning in a one-line comment on the renamed `run_id`.
- **Deps:** none (but conceptually pairs with WS-5/WS-6 which finish the same translation in logic).

---

### Tier 1 — Quick-win de-duplication (low risk; reverses drift and deletes lines)  *(TN review)*

#### WS-3 — Reuse the canonical clock / format / tone / error helpers

These are pure deletion-via-reuse. Each fork has **drifted into a user-visible inconsistency**, so fixing them removes bugs, not just lines.

- **Clock (`useNow`) — 6 routes reintroduce a banned anti-pattern.**
  - **Why/Evidence:** `frontend/src/contexts/NowContext.tsx` is mounted app-wide (`App.tsx:54`) and its own header comment names per-hook intervals as "the explicit anti-pattern flagged in the Phase 1 review." Yet `Mail.tsx:60-61`, `Agents.tsx:142,157`, `Activity.tsx:21-22`, `AgentDetail.tsx:60,115`, `Runs.tsx:63,68`, and `FormulaRunDetail.tsx:87-93` each run their own `useState(Date.now())` clock — and `FormulaRunDetail` hand-rolls a raw `setInterval` + `document.hidden` guard, re-implementing `useVisibleInterval`.
  - **Change:** Delete all six clock pairs → `const now = useNow()`. If a route needs a coarser cadence, that's a `NowContext` granularity prop, not a sixth timer.
- **Date/time formatters — forked and drifted (48h vs 24h).**
  - **Why/Evidence:** `lib/format.ts:7,14` (`formatDate`, `formatDateTime`) and `hooks/time.ts:30` (`formatRelative`) are unit-tested canonical helpers. `Maintainer.tsx:641,648,653` and `TriageSections.tsx:535` re-implement them — `formatRelative` forks roll to days at **48h** vs the shared **24h**, so the same screen renders ages by two grammars.
  - **Change:** Delete the four local helpers; import the shared ones. Thread `useNow()` in as the explicit `now` arg (also fixes the never-re-ticking-age staleness in the forks).
- **`beadStatusTone` — same bead, different color in list vs modal.**
  - **Why/Evidence:** `BeadDetailModal.tsx:328` maps `open → warn`; `routes/Beads.tsx:388` maps `open → neutral`.
  - **Change:** One exported `beadStatusTone(status)` next to `StatusBadge` (which owns `StatusTone`/`TONE_*`). Pick the correct mapping once; delete both.
- **`ApiClientError` formatting ladder — re-rolled 4×.**
  - **Why/Evidence:** `Beads.tsx:82`, `AgentDetail.tsx:214,411` each re-implement `err instanceof ApiClientError ? ... : err instanceof Error ? ...` while the shared `errorMessage()` is ignored.
  - **Change:** Promote one `formatApiError(err): string` (and `apiErrorParts(err)` for the structured case) into `api/client.ts` next to `ApiClientError`; all sites call it.
- **Tests:** Existing `format.test.ts` / `time.test.ts` cover the canonical helpers; add component assertions that maintainer ages and bead tones now match the rest of the app. Pick the 24h vs 48h grammar deliberately and lock it.
- **Risk:** None structural; verify the chosen `formatRelative` boundary is the intended one before deleting the 48h forks.
- **Deps:** none.

#### WS-4 — One partial-list predicate + one degraded-source notice

- **Why:** The "is this supervisor list degraded?" check is product-critical (drives the partial badge) and is hand-duplicated; a comment at `routes/runs.ts:168` records it was **lost once in the workflow→run rename and had to be restored**.
- **Evidence (backend):** `routes/runs.ts:171`, `routes/links.ts:117,128` all repeat `list.partial === true || (list.partial_errors?.length ?? 0) > 0`. **Evidence (frontend):** `Agents.tsx:351-359` and `Runs.tsx:154-162` duplicate the `role="status"` "X partial" banner (the Runs comment at `:80` says "Mirrors the roster-partial signal in Agents.tsx").
- **Change:** Backend — `isPartialList(list)` + `partialReasonsFromList(list)` in a shared `lib/` module (pairs with `formatPartialErrors` from `links.ts:149`). Frontend — a tiny `<PartialDataNotice show title>` warn-toned `role="status"` component.
- **Tests:** Unit-test the predicate; component test the notice; keep existing route partial-path coverage green.
- **Risk:** Low. This is the canonical-helper extraction the prose comments are groping toward.
- **Deps:** none. (Conceptually overlaps WS-13's error-honesty theme.)

---

### Tier 2 — Canonical resolvers & policy (medium risk; unblocks Tier 3 splits)

#### WS-5 — Canonical run-formula identity resolver  *(Codex C — include modified)*

- **Why:** Formula name/source/target is resolved in **6 places** with divergent precedence, kept in sync by ~40 lines of prose. The UI can disagree with itself about the same run.
- **Evidence (the 6 ladders, verbatim from validation):**
  1. `runs/formula-name.ts:59-74` `resolveRunFormulaName` — NAME: `gc.formula → title` (gated on `gc.formula_contract='graph.v2' && gc.run_target && !closed`).
  2. `runs/formula-run.ts:208-210` `runFormula` — NAME: `gc.formula → gc.formula_name → null`.
  3. `runs/formula-run.ts:216-238` `runFormulaState` — NAME: `runFormula() → formulaDetail?.name → resolveRunFormulaName()`.
  4. `runs/formula-run.ts:240-256` `runFormulaDetailState` — NAME: `runFormula(root) → formulaDetail?.name`.
  5. `routes/runs.ts:120-124` `getRunFormulaDetail` — NAME: `(source==='metadata' ? resolved.name) → gc.formula_name → resolved.name`. **Intentional** (comment `:114-119`: `gc.formula_name` must win over title-fallback).
  6. `snapshot/collectors/runs.ts:524-546` `runFormula` — NAME: `pr_review.workflow_formula → gc.formula → title` with **extra gate** `title.startsWith('mol-')`. **Intentional** (comment `:502-523`).
  - TARGET is **byte-for-byte identical** at `formula-run.ts:213` and `routes/runs.ts:126`: `gc.run_target ?? gc.routed_to ?? assignee`.
- **Change:** One `resolveRunFormulaIdentity(root, formulaDetail?, mode)` in `formula-name.ts` returning typed `{ name, source: 'metadata'|'title_fallback'|'formula_detail'|null, target }`. **Use an explicit `mode` enum (`'lane' | 'detail' | 'route' | 'state'`), NOT boolean option flags** — the validation explicitly warns that flag combinations (`includeFormulaNameKey` + `requireTitlePrefix` + …) create untested permutations. The mode encodes each call site's *intentional* divergence (the `mol-` prefix gate, the `pr_review.workflow_formula` key, the `gc.formula_name`-wins rule). Delete `runFormula`/`runFormulaTarget` copies and the inline target resolution.
- **Tests (write first):** Lock each mode's precedence and the missing-metadata behavior as separate cases, especially: (a) `gc.formula_name` beats title-fallback in `route` mode; (b) `lane` mode rejects a non-`mol-` title that `detail` mode would accept; (c) target precedence identical across modes.
- **Risk:** Behavior-change risk if the consolidated internal order shifts — the two intentional divergences (`mol-` gate, `gc.formula_name`-wins) **must** survive. Pin them with red tests before refactoring.
- **Deps:** Pairs with WS-2 (same vocabulary edge). Prerequisite for WS-8.

#### WS-6 — Canonical run-scope / store-ref module  *(Codex D)*

- **Why:** Scope is parsed from 5 input formats across the backend, with one true duplicate and three different missing-scope contracts.
- **Evidence:** Request query `routes/runs.ts:251-281`; bead metadata `gc.scope_kind`/`gc.scope_ref` `snapshot/collectors/runs.ts:287-344`; feed snapshot `discoverFromFeed` `:788-835`; store-ref `"kind:ref"` parsing `:348-361` (`parseRunScopeKind`, `scopeKindFromStoreRef`, `scopeRefFromStoreRef`); `GcRunSnapshot` fields `runs/enrich.ts:40-50`. **True duplicate:** `enrich.ts:126` `parseScopeKind` re-implements `collectors/runs.ts:348` `parseRunScopeKind`.
- **Change:** A typed `backend/src/lib/run-scope.ts` exposing `RunScope`/`StoreRef` types and `fromRequest`, `fromSnapshot`, `fromFeed`, `fromRootMetadata`, `fromStoreRef`. Collapse the duplicate `parseScopeKind`. Apply `SCOPE_REF_RE` consistently (today it's enforced at feed + route but **not** at bead-metadata parse).
- **Critical — preserve the 3 distinct missing-scope contracts:** HTTP query → silent `undefined` (`routes/runs.ts:280`); lane builder → structured `status:'unavailable'` (`collectors/runs.ts:341-343`); enrichment → **throws `UnsupportedRunError`** (`enrich.ts:50`). The helpers must keep these per-layer behaviors, not unify them into one.
- **Tests:** Unit-test each `fromX` and each missing-scope contract boundary; keep existing route/enrich scope-validation tests green.
- **Risk:** Conflating the three contracts would silently change error behavior. Keep return types layer-appropriate.
- **Deps:** Prerequisite for WS-8.

#### WS-7 — Consolidate run-diff reviewability policy  *(Codex H)*

- **Why:** The `.beads`/`.gc` exclusion rule exists in **two backend files in two representations** that can drift.
- **Evidence:** `backend/src/exec.ts:70-77` `RUN_REVIEWABLE_PATHS` (git pathspec syntax `:(exclude,top).beads/**`) vs `backend/src/runs/diff.ts:20` `CONTROL_PLANE_PATH_PREFIXES = ['.beads','.gc']` (string-prefix), with `isReviewableRunDiffPath` applied at **8 call sites** in `diff.ts` (`:50,52,190,193,284,346,352,381`).
- **Change:** One `backend/src/runs/run-diff-policy.ts` exposing `PATHSPECS` (the git exclude args), `isReviewablePath(path)`, and `classifyFile(path)`. `exec.ts` imports `PATHSPECS`; `diff.ts` replaces its 8 prefix checks + the classify call. Within `diff.ts`, also drop the redundant re-filter in `mergeChangedFiles:284` (paths already filtered upstream) and centralize the `a/`…`b/` path-normalization so the patch/name-status/status parsers share one extract-then-test pair (TN runs/routes #5).
- **Tests:** Property-style test asserting the git-pathspec exclusion and the string-prefix `isReviewablePath` produce **identical** results across a diverse path set (including `.beads/x`, `.gcfoo`, `src/.gc/...`). Keep `diff.ts` route coverage green; preserve "untracked non-ignored agent output stays visible, `.beads/**` + `.gc/**` always excluded."
- **Risk:** Low–medium; the two formats must stay provably equivalent — the property test is the guard.
- **Deps:** none.

---

### Tier 3 — Module decomposition (behavior-preserving relocation)

#### WS-8 — Decompose `snapshot/collectors/runs.ts` (878 LOC)  *(Codex E — include modified)*

- **Why:** A god-collector fusing transport, grouping, scope, formula identity, feed discovery, lane projection, and presentation. Four section banners already exist (`:70,91,437,593`) but 180 lines of async transport (`:698-878`) are unlabeled.
- **Change:** Split into `snapshot/collectors/runs/` modules along the validated seams:
  - `filter.ts` (pure: `runBeadFilter`), `presentation.ts` (pure: `displayTitle`, `statusCounts`, `externalReference`/`externalUrl`/`externalLabel`, `recentChanges`, `metadataString`, `compareLanes`), `progress.ts` (pure: `runProgress`, `runStagePosition`, `runStepAttempt`), `grouping.ts` (`buildRunSummary`, `runLane`, `runRootId`, `runCounts`, `runKind`), `discovery.ts` (async: `loadRunBeads`, `discoverFromFeed`, `runRigNames`, `unionRigNames`, `uniqueBeads`), `cache.ts` (`createRunsSourceCache`, `buildDefaultLoad`, the unavailable/empty placeholders), and `index.ts` as the re-export facade preserving the current public surface.
  - **Consume the canonical modules, do not re-extract:** formula identity → WS-5's resolver; scope → WS-6's `run-scope.ts`. (This is why E is sequenced after C and D.)
- **Tests:** Reorganize collector tests to mirror modules; the pure transforms become unit-testable without IO. Public API unchanged → existing consumers compile.
- **Risk:** **Preserve the n6f1 degrade-not-collapse block verbatim** (`:734-756`, per-source try/catch + `partial` flag + `logWarn`) — do not "simplify" it into `Promise.allSettled` that hides per-source semantics. Verify no circular import (`phaseMapping` is a pure leaf; confirmed). Grep for any deep import of internal functions before moving.
- **Deps:** WS-5, WS-6.

#### WS-9 — Decompose `shared/src/index.ts` (1139 LOC) + introduce `Avail<T>` / `GcList<T>` generics  *(TN shared)*

- **Why:** A god-barrel that changes independently for beads, mail, health, triage, runs, and events (SRP violated wholesale); the type-only import cycle it already worked around (`gc-client-types.ts`) is a symptom of the barrel being load-bearing.
- **Evidence:** `shared/src/index.ts` domains: sessions/context (`:64-124`), transcript (`:136-153`), agents (`:170-226`), rigs (`:239-253`), beads (`:257-368`), mail (`:377-464`), activity (`:469-501`), health (`:505-593`), events (`:597-624`), formula/order runs (`:634-802`), maintainer triage (`:815-1121`). Two boilerplate patterns hand-copied: the `{status:'available'} | {status:'unavailable',error}` union ~9× in `snapshot/types.ts:239-480`; the `{items,total?,partial?,partial_errors?}` list envelope 8× (`index.ts:217,244,319,429,612,662`; `gc-client-types.ts:63`).
- **Change:**
  1. Carve domain leaves (`gc-beads.ts`, `gc-mail.ts`, `gc-agents.ts`, `gc-rigs.ts`, `gc-health.ts`, `gc-events.ts`, `gc-formula-runs.ts`, `maintainer-triage.ts`, `context-window.ts` for `effectiveContextPct`+registry). Keep `index.ts` a pure `export type *` barrel + genuinely cross-cutting primitives.
  2. Add `type Avail<T> = { status:'available' } & T | { status:'unavailable'; error:string }` → collapses ~9 unions to one (~90 lines → ~10) and surfaces the 3 genuinely-irregular unions.
  3. Add `GcList<T>` / `GcCountedList<T> extends GcPartialAware` → collapses the 8 envelopes; model the required-vs-optional `partial` outliers as an explicit one-token override (today a silent prose divergence).
- **Tests:** `shared/src/index.test.ts` + both workspaces' `typecheck:test` (the real gate for `shared` shape changes). Re-export surface unchanged → consumers compile.
- **Interaction with WS-10 (important):** once WS-10 adopts `@hey-api/openapi-ts`, the **raw `Gc*` wire-mirror types here are shed, not relocated** — they are replaced by generated supervisor types (backend-side), and `shared` keeps only the dashboard-owned run-vocab DTOs (`RunDetail`, `FormulaRunDetail`, `TriageItem`, …) the frontend actually consumes. So WS-9 splits a smaller surface than its 1139-line starting point implies; sequence the barrel split **after** WS-10 G-1 so you carve the right boundary (dashboard DTOs vs generated wire).
- **Risk:** This is the largest mechanical change; do it as a pure relocation in one pass and lean on the compiler. Pairs with WS-2 (rename happens in the same files).
- **Deps:** After WS-2 (rename) and WS-10 G-1 (so the generated/dashboard boundary is set before carving leaves).

#### WS-10 — Replace the hand-written supervisor edge with a generated client (`@hey-api/openapi-ts`)  *(Codex F + TN supervisor — redesigned per resolved decision)*

**Decision (grill + gascity reference):** Don't tidy the hand-rolled edge — **replace it.** Generate the supervisor client + types (+ SSE) from `backend/openapi/gc-supervisor.openapi.json` with `@hey-api/openapi-ts`, exactly as the upstream `gascity` dashboard does (`~/code/gastownhall/gascity/cmd/gc/dashboard/web/openapi-ts.config.ts`: plugins `@hey-api/client-fetch`, `@hey-api/typescript`, `@hey-api/sdk`, generating the whole `client.gen.ts`/`sdk.gen.ts`/`types.gen.ts`/SSE surface with **zero** hand-written client). Unlike gascity (which validates **nothing** at runtime), also enable the **Zod plugin** so the same spec generates runtime response validators — honoring this repo's spec invariant *"runtime deserialization at GcClient rejects malformed payloads"* (Ideal #2, L691).

- **Why:** `gc-client.ts` (866) and `gc-supervisor-decoders.ts` (879) are ~1.7k hand-written lines reimplementing what the generator produces — path/param construction, request/response types, and per-resource validation — plus three overlapping representations (generated OpenAPI/AJV + hand-Zod + the `SchemaOutputFor` type-machine) and a write edge that casts unknown via `writeJson<T>` (`:261-282`).
- **Generated code is backend-only.** The security model (backend binds 127.0.0.1, redacts, proxies; the browser only talks to `/api/*`) keeps supervisor types out of the frontend bundle. Add `backend/openapi-ts.config.ts` + a `gen` step beside the existing `openapi:gc-supervisor:*` scripts; output under `backend/src/generated/`.
- **`GcClient` becomes a thin policy facade** over the generated SDK, owning only what the generator can't: **single-flight URL-keyed coalescing**, **topology-safe error redaction**, **timeouts/output-cap**, the **`workflow_id → run_id` vocabulary normalization** at the edge, and **sane method names** (generated `getV0CityByCityNameWorkflowByWorkflowId` → `getRun`). The 866-line client collapses to this facade; the ~16× `getOperation` template (TN supervisor #5) disappears into the generated SDK.
- **Delete:** `gc-supervisor-decoders.ts` (hand-Zod), `gc-supervisor-schema-validator.ts` (AJV overlay), the `SchemaOutputFor`/`componentName`-gate machinery, all 15 `componentName: null` opt-outs, and `writeJson<T>` — writes (`sendMail`, `updateBead`, `sling`) now go through the generated SDK + validation, killing the `as T` casts.
- **Accuracy fixed upstream.** The 15 opt-outs exist because the supervisor OpenAPI rejects valid degraded payloads (nullable `Bead.priority`; legacy bead fields `owner`/`updated_at`/`closed_at`; the phantom event `next` key; `description`-required formula detail). Fix these **in gastownhall/gascity's Huma/OpenAPI source** so the committed spec matches observed output; this repo re-pulls via `npm run openapi:gc-supervisor:update`. **This is a cross-repo dependency — the single riskiest part of this plan.**
- **Phased rollout (forced by the accuracy dependency):**
  - **G-1 (behavior-preserving):** Add `@hey-api/openapi-ts`; generate client+types+SDK. Re-point `GcClient` internals at the generated SDK (transport + types) with response validation **off / lenient (`passthrough`)**. Delete the hand client plumbing. Translate `workflow_id → run_id` in the facade.
  - **G-2 (upstream):** Land the OpenAPI accuracy fixes in gascity; refresh the committed spec here; add fixtures for the previously-degraded shapes.
  - **G-3 (strict):** Enable generated-**Zod response validation** at the `GcClient` edge; delete the hand-Zod decoders + AJV overlay + `SchemaOutputFor`. A malformed payload now fails at the edge per the spec invariant. This subsumes the WS-13 `getStatus`/`decodeSling` all-optional fixes (the generated validators + accurate required fields replace those hand schemas).
- **hey-api features to leverage (verified against current docs, May 2026 — maximize generated code per the directive):**
  - **SDK `validator` option** — `validator: { response: 'zod' }` wires the generated Zod schemas into every SDK call (async `parseAsync`), so **runtime response validation is generated, not hand-written**. This is what deletes `gc-supervisor-decoders.ts` wholesale. Use response-only validation (we build request shapes; the supervisor's responses are what need guarding).
  - **Zod v4 plugin** — generates Zod 4 schemas by default; backend is already on `zod ^4.4.3`, so no version bump.
  - **`@hey-api/transformers`** — generates response transformers (e.g. ISO date-time → `Date`, big-int handling) so any hand date/number coercion at the edge disappears.
  - **client-fetch interceptors + `createClientConfig()`** — `client.interceptors.{request,response,error}.use(...)` is where facade policy lives: **topology-safe error redaction** (response/error interceptor), `Origin`/auth headers, and logging — instead of hand-wrapping each call. `runtimeConfigPath`'s `createClientConfig()` centralizes `baseUrl` (the city URL), a custom `fetch` (timeout + output-cap + 127.0.0.1), and `throwOnError`.
  - **What must stay hand-written (interceptors can't express it):** single-flight URL-keyed **coalescing** (a dedupe layer above the SDK) and the **`workflow_id → run_id` rename** (a field remap, not a type transform). These two are the irreducible core of the `GcClient` facade.
  - **Prerequisite (verified):** hey-api is **ESM-only as of 2026**; backend is already `"type": "module"` + `moduleResolution: bundler` → no blocker. The migration removes `ajv` (the AJV overlay) and supersedes `openapi-typescript`/`openapi-fetch` (drop them once G-1 lands).
  - **Out of scope (noted, not silently dropped):** hey-api's TanStack Query plugin would cut the *frontend's* per-route fetch/poll boilerplate — but only if the dashboard's own `/api/*` had an OpenAPI to generate from, which it doesn't today. Authoring a dashboard-side OpenAPI to unlock that is a separate, larger initiative, not part of WS-10.
- **Tests:** Retire `gc-supervisor-decoders-types.test.ts` (the `SchemaOutputFor` contract dies with the machine); replace with generated-Zod validation tests. **Keep `GcClient`'s coalescing / redaction / `workflow_id→run_id` tests green — those behaviors must survive the rewrite.** Add a test proving a malformed supervisor payload is rejected at the edge.
- **Risk (do-not-break invariants):** single-flight coalescing, topology-safe **redaction**, timeouts/output-cap, and the `workflow_id → run_id` edge normalization must all survive in the thin facade. **SSE:** this repo proxies supervisor SSE same-origin (`routes/sse-proxy.ts`) for CSP — that's a security boundary, not just transport; **default: keep the proxy**, don't replace it with the generated browser SSE handlers. Do **not** ship G-3 before G-2 or the 15 degraded-payload cases break. **Spec status:** `specs/architecture/formula-run-detail-type.md` has been amended (Naming Boundary, Ideal Target State, Invariants, Risk #5 now describe the generated client + runtime validation as the boundary). `docs/ARCHITECTURE.md` still needs a wiring/SSE-boundary update — do it in the implementation PR.
- **Deps:** G-2 depends on upstream gascity work (schedule it early — it gates G-3). Coordinate the `workflow_id → run_id` normalization with WS-2. Unblocks WS-9's shedding of the raw `Gc*` wire mirrors.

#### WS-11 — Decompose the maintainer modules + reuse canonical helpers  *(TN maintainer)*

- **Why:** `backend/.../maintainer/router.ts` (589) fuses the HTTP edge with the serve-time overlay engine and re-implements three helpers that already exist canonically; `frontend/.../Maintainer.tsx` (682) hoards pure transforms, a storage hook, and sub-views.
- **Evidence (backend):** `router.ts:182-196` re-inlines the ExecError→HTTP map that `lib/sanitise-error.ts:50-69 writeExecError` owns (used canonically in `routes/beads.ts:263`, `agents.ts:187`, `git.ts:52`); `triage.ts:154-168 parseJsonArray` duplicates `lib/parse-json.ts:4-18` (its sibling `contributor.ts:11` already imports the lib version); `router.ts:428-435,463-474` (`findContributor`, `countItems`) re-walk the envelope by hand instead of the exported `triage.ts:289-298 collectItems`; the in-flight-PR set is rebuilt at `triage.ts:327` and `:384`; the `/sling` handler is a 60-line inline validation gauntlet (`router.ts:215-276`).
- **Evidence (frontend):** `Maintainer.tsx` pure tier transforms (`:68,92,121`), `useCollapseState` (`:140-180`), `SelectionActionBar` (`:508-609`), `Footer`/`buildSynopsis`; `TriageSections.tsx` + `ProjectGroupHeader.tsx` ship 3+ incompatible collapsible-header implementations with two glyph conventions.
- **Change (backend):** Replace the inline ExecError map with `writeExecError(..., { fallbackStatus: 502 })`; delete the duplicate `parseJsonArray`; route `findContributor`/`countItems` through `collectItems`; extract `issueNumbersWithInFlightPr(items)` consumed by both call sites; extract `decodeSlingRequest(body): SlingCommand | RouteErrorWire`; split a `serve-overlay.ts` + `sling-dispatch.ts` so `router.ts` shrinks to thin handlers.
- **Change (frontend):** Move pure tier transforms to `triageFilters.ts`; promote `useCollapseState` → `hooks/usePersistedCollapseSet`; extract one `<CollapsibleHeader>` + `CollapseGlyph`; move `SelectionActionBar`/`Footer` to `MaintainerChrome.tsx`. Folds in WS-3's format reuse.
- **Tests:** Repoint maintainer test imports to real modules (delete the re-export shims at `Maintainer.tsx:31-32`); keep sling/overlay coverage green.
- **Risk:** The One-Mark invariant is split across compose-time (`triage.ts`) and serve-time (`router.ts`); the `serve-overlay.ts` extraction should put both halves under one concept. Behavior-preserving.
- **Deps:** WS-3 (format helpers). Independent of backend Tier 2.

#### WS-14 — `groups.ts` single-pass identity model; remove in-place `delete` mutation  *(TN runs/routes)*

- **Why:** `backend/src/runs/groups.ts` has five overlapping notions of bead identity computed redundantly, plus order-dependent in-place mutation — the area `relation-index.ts:7-14` flags as "the single biggest premortem failure mode."
- **Evidence:** `groups.ts:126-157` `resolveSemanticIds` computes `duplicateResolutionIdentity` twice per bead; `visibleNodeAliases:235` recomputes `groupingBaseSemanticId`; `assignOptional:106-116` does `delete group[key]` to "unset" optional fields mid-iteration (`:71-79`).
- **Change:** Compute one `BeadIdentity { base, disambiguator, aliases }` per bead, memoized in a `Map`. Group by `base`; disambiguate only when a base has >1 distinct disambiguator. Build each `RunNodeGroup` once by reducing its full bead list (two-pass: bucket → reduce) — no in-place promotion, no `delete`, no iteration-order dependence.
- **Tests:** Existing `run-groups.test.ts` golden fixtures must stay green; add a test asserting group shape is independent of bead order.
- **Risk:** Medium — this is dense, well-tested logic. Lean on the golden fixtures.
- **Deps:** none.

---

### Tier 4 — Boundary correctness (surfaces previously-hidden failures)

#### WS-12 — Split run detail/diff into independent resources; honest diff errors; decouple tab from node-selection  *(Codex G + TN hooks — resolved: both moves accepted)*

**Decision (grill):** Both Codex moves confirmed — **split the hooks** and **decouple the tab**, overriding the spec's single-hook/auto-switch model. The spec must be amended to match (see Risk).

- **Why:** Detail and diff are independently refreshable/failable, but the hook fetches them as one `Promise.all` and **fabricates a fake success** when the diff fails; and node-selection forcibly overrides the user's tab choice.
- **Evidence:** `useFormulaRunDetail.ts:79-96` — `Promise.all([detail, diff])`; the `api.runDiff` catch (`:81-93`) returns a hand-built `{kind:'error', ...} satisfies RunDiffResponse` and the outer state still resolves `ready` (`:95`). `FormulaRunTabs.tsx:16-18` — a `useEffect` forces `tab='session'` whenever `selectedNodeId` changes; `FormulaRunDetail.test.tsx:164-169` locks this in. `RunNodeEvidencePanel.tsx:22` renders the Diff tab from `diff` alone (node-independent), so the diff is run-level/execution-folder evidence (spec invariant L721).
- **Change:**
  1. **Split** into `useFormulaRunDetail` (detail resource) and `useRunDiff` (diff resource), each its own `useCachedData` key and explicit `idle|loading|ready|failed` union; `FormulaRunDetailPage` composes both → a failed `api.runDiff` surfaces a real `failed` state instead of a fabricated `RunDiffResponse`.
  2. **Decouple** the tab: remove the `FormulaRunTabs.tsx:16-18` effect so tab state responds only to user clicks / initialization. Selecting a node no longer auto-switches to Session.
- **Tests:** **Rewrite** `FormulaRunDetail.test.tsx:164-169` to assert the tab **persists** across node-selection (was: asserts auto-switch to Session). The focused browser harness **`scripts/snap-formula-run-detail.mjs`** clicks Session *before* selecting a node, so it survives — but verify. Add a test asserting a failed `api.runDiff` yields `useRunDiff → failed`, not a silent empty diff.
- **Risk:** This is the **one user-facing behavior change** in the plan: clicking a node no longer jumps to Session, and because the diff is node-independent, a node-click while on Diff now changes only the node's pressed state, not the right panel. Consumers that checked `diff.kind !== 'error'` now get an explicit `failed` state — audit them. **Spec status:** `specs/architecture/formula-run-detail-type.md` (UI Consumption + Invariants) has been amended to the two-resource + tab-as-user-state model; implement to match. The harness hardcodes `BASE=http://127.0.0.1:5174`.
- **Deps:** none.

#### WS-13 — Close the remaining swallowed-error gaps  *(TN maintainer / supervisor / hooks)*

- **Why:** "Don't swallow errors" is an explicit project rule, violated where it's least visible.
- **Evidence + Change:**
  - `maintainerSelection.ts:64` `buildSlingRequests` silently `continue`s past selected-but-vanished items → the success line "Slung N" can be fewer than selected. **Change:** return dropped keys; surface "M skipped" in the action bar (`Maintainer.tsx:549`).
  - `gc-supervisor-decoders.ts:419` `getStatus` and `:739` `decodeSling` are all-optional schemas → a broken-shape response decodes to `{}` indistinguishable from benign degradation. **Now subsumed by WS-10:** the generated-Zod validators (G-3) plus the upstream accuracy fixes (G-2, making the identity fields `required`) replace these hand schemas, so a wrong shape fails at the edge. No separate `.refine()` work — fix it where the schema is generated.
  - `api/client.ts:65` `request<T>` does `(await res.json()) as T` for ~25 methods while the SSE hooks validate every field. This is the **frontend `/api/*` edge** (dashboard DTOs), separate from the supervisor edge WS-10 covers. **Change:** thread a per-endpoint decoder (or `assertShape`) at this single chokepoint; at minimum document the trust boundary explicitly.
- **Tests:** Add a decode-failure test per fix; component test for the "M skipped" surfacing.
- **Risk:** These intentionally turn silent degradations into visible errors — confirm each surfaced error has a sensible UI path.
- **Deps:** `getStatus`/`decodeSling` now fold into WS-10 G-2/G-3. The `buildSlingRequests` and `api/client.ts` items are independent.

---

## Lower-priority cleanups (fold in opportunistically; not standalone PRs)

- **`useVisibleRefresh` vs `useAbortableVisibleRefresh`** duplicate the backoff state machine (`useVisibleRefresh.ts:37-61` vs `useAbortableVisibleRefresh.ts:44-90`). Extract `useVisibleBackoffTick({enabled,intervalMs,run,...})`; build both on top. *(TN hooks #3)*
- **`useLiveCachedData` composite** — `useCachedData(...).refresh` + `useGcEventRefresh(prefix, refresh)` is copy-pasted per route (`Beads.tsx:36,65`; `Agents.tsx:124,159`; `Runs.tsx:52,117`). Promote one hook. *(TN routes #2 / hooks #2)*
- **`ViewingAsContext` over-defensiveness** — `getSessionsRetryDelay` is ~45 lines of comment guarding a 3-element lookup (`:69-100`); the provider fuses alias-selection, sessions-retry, mail+sessions prefetch, and StrictMode bookkeeping (`:146-376`). Extract `useAliasRoster()` so the security-relevant impersonation logic isn't buried in retry/join plumbing. *(TN hooks #6/#7)*
- **Comment-archaeology / dead scaffolds** — `triage.ts:412-451 selectOneMark` carries ~25 lines refuting deleted code (violates "no comments for removed functionality"); `slung-state.ts:27-45,135-212` is ~90 lines of legacy-normalization scaffold to default one optional field. Delete the archaeology; collapse the scaffold to a single `?? null` at the read edge. *(TN maintainer #7/#8)*
- **`AgentDetail.tsx`** hand-rolls 4 parallel fetch/loading/error state machines instead of `useCachedData` (`:54-58,83-120,205-243`). Migrate to the canonical hook. *(TN routes #1/#5)*
- **`run-snapshot.ts:48,50`** `Record<string,never>[]` is `any` in disguise for `logical_nodes`/`scope_groups` — type honestly as `readonly unknown[] | null` or model the real shape. *(TN shared #7)*

## Explicitly NOT in scope (rejected to keep the plan high-conviction)

- A "unified entity chip" across `RelatedEntities` / `TriageSections` / run panels — they render genuinely different wire shapes; a shared model would be speculative (YAGNI).
- `RunNodeSessionPanel.tsx` (335) — dense but legitimately so; cleanest of the large files.
- Generated supervisor artifacts — change generator inputs, never hand-edit.
- The read-edge architecture (single decode chokepoint, single-flight coalescing, n6f1 degrade-not-collapse) — genuinely good; preserve it.

---

## Sequencing & dependency graph

```
Tier 0 (vocabulary)      WS-1 ─┐
                         WS-2 ─┼─► (unblocks run vocab; WS-2 coordinates w/ WS-10 normalization)
Tier 1 (quick wins)      WS-3, WS-4   (independent, parallelizable, ship first for momentum)
Tier 2 (resolvers)       WS-5 ─┐
                         WS-6 ─┼─► WS-8 (collector split consumes WS-5 + WS-6)
                         WS-7   (independent)
Tier 3 (decomposition)   WS-10 G-1 (adopt @hey-api, lenient) ──► [gascity OpenAPI accuracy = G-2] ──► WS-10 G-3 (strict Zod)
                         WS-9 (after WS-2 + WS-10 G-1), WS-11 (after WS-3), WS-14
Tier 4 (correctness)     WS-12 (split + decouple + spec amend), WS-13 (getStatus/decodeSling fold into WS-10 G-3)
```

**Recommended order:** WS-1, WS-2 → WS-3, WS-4 (quick wins, reverse drift) → WS-5, WS-6, WS-7 (canonical resolvers/policy) → **WS-10 G-1** (adopt the generator, lenient validation) + WS-13 cheap-correctness items → WS-8, WS-9, WS-11, WS-14 (decomposition) → **[upstream gascity accuracy = WS-10 G-2]** (start early; it gates G-3) → **WS-10 G-3** (strict generated-Zod validation) → WS-12. Kick off the cross-repo G-2 work as soon as G-1 lands, since it's the long pole.

Land each workstream as its own PR against `main` with passing CI. Several are parallelizable across branches (WS-3, WS-4, WS-7, WS-14 touch disjoint files).

## Validation gate (run before every push)

```
npm run typecheck
npm --workspace backend run typecheck:test
npm --workspace frontend run typecheck:test
npm --workspace frontend run build
npm --workspace backend test
npm --workspace frontend test
npm run lint
```

For run-detail-affecting workstreams (WS-5, WS-6, WS-7, WS-8, WS-12), also run the focused harness against a live dev server:

```
npm run dev:frontend   # serving 127.0.0.1:5174
node scripts/snap-formula-run-detail.mjs --test
```

## Resolved decisions (locked via `/grill-me` against the specs + the upstream `gascity` dashboard)

1. **WS-12 tab behavior — DECOUPLE.** Tab is explicit user state; selecting a node no longer auto-switches to Session. Rewrite the locked test. *(Overrode the "keep auto-switch" recommendation; the diff being node-independent made the call genuinely debatable, but the user chose Codex's model.)*
2. **WS-12 resource shape — SPLIT into two hooks** (`useFormulaRunDetail` + `useRunDiff`). *(Overrode the spec's single-hook `ready={detail,diff}` model — spec amendment required.)*
3. **WS-2 `TriageItem` field — `run_id`.** Spec Naming Boundary L62 mandates uniform `runId`/`run_id` dashboard vocabulary; the "best-known-at-sling-time, not live" nuance stays in the JSDoc; fix the stale `/workflows/<id>` → `/runs/<id>` reference.
4. **WS-10 supervisor edge — GENERATE from OpenAPI.** Adopt `@hey-api/openapi-ts` (full SDK + thin `GcClient` policy facade), modeled on gascity's dashboard. **Enable the Zod plugin** for runtime validation (diverges from gascity, which validates nothing; honors this repo's reject-malformed invariant). Fix accuracy **upstream** in gascity's OpenAPI. Phased G-1/G-2/G-3.

### Follow-on consequences (architecture-determined; no further decision needed)

- **The generated supervisor SDK + Zod are backend-only.** The security model (backend-only supervisor access, 127.0.0.1, redaction, proxy) keeps supervisor types out of the frontend bundle. The frontend keeps `api/client.ts` as its own dashboard-DTO edge (WS-13 covers it).
- **WS-9 sheds the raw `Gc*` wire-mirror types** (replaced by generated types backend-side) rather than relocating them; `shared` keeps only dashboard-owned run-vocab DTOs. Sequence the barrel split after WS-10 G-1.
- **The architecture spec has been amended** (`specs/architecture/formula-run-detail-type.md`): *Naming Boundary*, *UI Consumption*, *Ideal Target State*, *Invariants*, *Risk #5*, and *Current Implementation Against The Ideal* now describe the generated `@hey-api` client + runtime validation, the two-resource hook model, and tab-as-user-state. `docs/ARCHITECTURE.md` still needs a wiring/SSE-boundary line — land it in the WS-10 implementation PR.

### Remaining risk to watch

- **The cross-repo accuracy dependency (WS-10 G-2)** is the long pole: strict generated-Zod validation (G-3) cannot ship until gascity's OpenAPI matches observed supervisor output, or the 15 previously-degraded payload shapes will be rejected. Start the upstream work as soon as G-1 lands.
