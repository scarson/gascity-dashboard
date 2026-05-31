import type {
  BeadUpdateInput,
  CityList,
  GcAgent,
  GcAgentList,
  GcBead,
  GcBeadList,
  GcEventList,
  GcFormulaDetail,
  GcFormulaRunList,
  GcFormulaRunsResponse,
  GcMailList,
  GcOrderHistoryDetail,
  GcOrderHistoryList,
  GcOrdersFeedResponse,
  GcRigList,
  GcRunSnapshot,
  GcSessionList,
  GcStatus,
  MailSendInput,
  MailSendResponse,
  RunScopeKind,
  SlingInput,
  SlingResponse,
  SupervisorHealth,
} from 'gas-city-dashboard-shared';
import {
  gcSupervisorDecoders,
  type GcDecoder,
  type GcTranscriptResponse,
  invalidGeneratedSupervisorPayload,
  type SupervisorCity,
} from './gc-supervisor-decoders.js';
import {
  createClient as createGeneratedSupervisorClient,
  type Client as GeneratedSupervisorClient,
} from '@hey-api/client-fetch';
import {
  getV0Cities,
  getV0CityByCityNameAgentByBase,
  getV0CityByCityNameAgents,
  getV0CityByCityNameBeadById,
  getV0CityByCityNameBeads,
  getV0CityByCityNameEvents,
  getV0CityByCityNameFormulasByName,
  getV0CityByCityNameFormulasByNameRuns,
  getV0CityByCityNameFormulasFeed,
  getV0CityByCityNameHealth,
  getV0CityByCityNameMail,
  getV0CityByCityNameOrderHistoryByBeadId,
  getV0CityByCityNameOrdersFeed,
  getV0CityByCityNameOrdersHistory,
  getV0CityByCityNameRigs,
  getV0CityByCityNameSessionByIdTranscript,
  getV0CityByCityNameSessions,
  getV0CityByCityNameStatus,
  getV0CityByCityNameWorkflowByWorkflowId,
  patchV0CityByCityNameBeadById,
  postV0CityByCityNameSling,
  sendMail as sendSupervisorMail,
} from './generated/gc-supervisor-client/sdk.gen.js';

// Typed client for the gc supervisor HTTP API. All reads of supervisor
// state go through here; no other module fetches from supervisor
// directly. That keeps the wire-shape boundary in ONE place.
//
// Performance posture (gascity-dashboard-kz8):
//   - Every upstream call has a default timeout (DEFAULT_TIMEOUT_MS or
//     opts.defaultTimeoutMs). Without this, Node fetch waits indefinitely
//     and a hung supervisor surfaces as a >10s dashboard timeout.
//   - Concurrent identical GET requests are coalesced (single-flight) so
//     bursty load (multi-tab refresh, SSE-driven reload) collapses to one
//     upstream call. This is request de-duplication, not result caching:
//     once the inflight promise settles the slot is released; the very
//     next call hits upstream again.

const DEFAULT_TIMEOUT_MS = (() => {
  const raw = process.env.GC_CLIENT_TIMEOUT_MS;
  if (typeof raw !== 'string') return 5_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 5_000;
})();

// Sling does real work upstream (creates a bead, attaches a wisp, dispatches
// to a rig, roughly 30s measured on this deployment). 60s gives the request
// enough headroom while still bounding a hung supervisor.
const SLING_TIMEOUT_MS = 60_000;

type SupervisorFetchResult<RawValue> = {
  response?: Response | undefined;
  data?: RawValue | undefined;
  error?: unknown;
};

export interface GcClientOptions {
  baseUrl: string;
  cityName: string;
  /** Per-request timeout for upstream supervisor calls. Defaults to GC_CLIENT_TIMEOUT_MS env, then 5000ms. */
  defaultTimeoutMs?: number;
}

export class GcClient {
  private readonly defaultTimeoutMs: number;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly supervisor: GeneratedSupervisorClient;

  constructor(private readonly opts: GcClientOptions) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.supervisor = createGeneratedSupervisorClient({
      baseUrl: opts.baseUrl,
      headers: { Accept: 'application/json' },
      responseStyle: 'fields',
      throwOnError: false,
    });
    // gascity-dashboard-9lvq: the supervisor (Go) emits RFC3339 datetimes with
    // a numeric tz offset (e.g. `-04:00`), but the generated SDK validates
    // them with Zod's `z.iso.datetime()`, which accepts only a `Z` suffix.
    // One offset-bearing datetime rejected the whole listAgents/listBeads
    // array (HTTP 502, blank panels). Normalize offset datetimes to the
    // equivalent UTC `Z` instant at the transport edge, before validation, so
    // valid supervisor data is accepted rather than discarded.
    //
    // The deprecated standalone @hey-api/client-fetch package ships
    // `interceptors` typed as `unknown` in this project's resolution, so reach
    // its documented response-interceptor API through a narrow typed view of
    // the known runtime shape.
    (this.supervisor.interceptors as SupervisorResponseInterceptors).response.use(
      normalizeOffsetDatetimesInterceptor,
    );
  }

  /** Base URL of the gc supervisor (no trailing slash). Used for non-city endpoints (e.g. /v0/health) + frontend CSP connect-src. */
  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** City name this client is scoped to. */
  get cityName(): string {
    return this.opts.cityName;
  }

  /**
   * True if `err` originated from the per-request timeout. Caller-supplied
   * AbortSignals fire as AbortError and are NOT timeouts — they map to
   * client-disconnect handling, not 504.
   */
  static isTimeoutError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.name === 'TimeoutError') return true;
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error && cause.name === 'TimeoutError';
  }

  private async getOperation<RawValue, DecodedValue>(
    key: string,
    decoder: GcDecoder<RawValue, DecodedValue>,
    run: (signal: AbortSignal) => Promise<SupervisorFetchResult<RawValue>>,
    signal?: AbortSignal,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<DecodedValue> {
    // Coalesce concurrent identical GETs. The cache key is the generated
    // operation path plus semantic path/query params. A caller-supplied
    // signal does NOT change the slot: all coalesced callers ride the same
    // upstream request; if any caller aborts they get the abort error, but
    // the request itself continues for the other waiters.
    const existing = this.inflight.get(key);
    if (existing) {
      return this.awaitWithSignal(existing as Promise<DecodedValue>, signal);
    }

    const promise = this.fetchOnce(
      run,
      timeoutMs,
      decoderPayloadName(decoder),
    ).then(decoder);
    this.inflight.set(key, promise);
    // Detach a no-throw cleanup so the slot is released on both settle
    // paths. Returning the original `promise` keeps the rejection surface
    // attached to the caller's await.
    const cleanup = () => {
      if (this.inflight.get(key) === promise) {
        this.inflight.delete(key);
      }
    };
    void promise.then(cleanup, cleanup);
    return this.awaitWithSignal(promise, signal);
  }

  private async awaitWithSignal<T>(
    p: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!signal) return p;
    if (signal.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  private async fetchOnce<RawValue>(
    run: (signal: AbortSignal) => Promise<SupervisorFetchResult<RawValue>>,
    timeoutMs: number,
    payloadName?: string,
  ): Promise<RawValue> {
    // Default timeout only. Caller-supplied signals are handled at the
    // `awaitWithSignal` layer so that one caller's abort does not kill a
    // coalesced fetch shared with other waiters.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    let result: SupervisorFetchResult<RawValue>;
    try {
      result = await run(timeoutSignal);
    } catch (err) {
      throw errorFromGeneratedClient(err, payloadName);
    }
    if (result.response === undefined) {
      throw errorFromGeneratedClient(result.error, payloadName);
    }
    if (!result.response.ok) {
      throw sanitizedSupervisorStatusError(result.response.status);
    }
    if (result.error !== undefined) {
      throw errorFromGeneratedClient(result.error, payloadName);
    }
    if (
      result.data === undefined ||
      isGeneratedEmptyJsonBody(result.response, result.data)
    ) {
      throw new Error('gc supervisor returned an empty response body');
    }
    return result.data;
  }

  private operationKey(
    operation: string,
    params: readonly (string | number | boolean | undefined)[] = [],
  ): string {
    return JSON.stringify([operation, ...params]);
  }

  private cityPathParams(): { cityName: string } {
    return { cityName: this.opts.cityName };
  }

  private cityUrl(
    url: string,
    pathParams: Record<string, string>,
    queryParams: Record<string, string> = {},
  ): URL {
    return new URL(this.supervisor.buildUrl({
      baseUrl: this.baseUrl,
      url,
      path: pathParams,
      query: queryParams,
    }));
  }

  private async writeOperation<RawValue>(
    run: (signal: AbortSignal) => Promise<SupervisorFetchResult<RawValue>>,
    timeoutMs: number,
    payloadName: string,
  ): Promise<RawValue> {
    return this.fetchOnce(run, timeoutMs, payloadName);
  }

  private mutationHeaders(): { 'X-GC-Request': string } {
    return { 'X-GC-Request': 'dashboard' };
  }

  private async writeSling(input: SlingInput): Promise<unknown> {
    return this.writeOperation(
      (upstreamSignal) => postV0CityByCityNameSling({
        client: this.supervisor,
        path: this.cityPathParams(),
        headers: this.mutationHeaders(),
        body: input,
        signal: upstreamSignal,
      }),
      SLING_TIMEOUT_MS,
      'sling',
    );
  }

  private async writeBeadUpdate(id: string, body: BeadUpdateInput): Promise<unknown> {
    return this.writeOperation(
      (upstreamSignal) => patchV0CityByCityNameBeadById({
        client: this.supervisor,
        path: { ...this.cityPathParams(), id },
        headers: this.mutationHeaders(),
        body,
        signal: upstreamSignal,
      }),
      this.defaultTimeoutMs,
      'updateBead',
    );
  }

  private async writeMail(body: MailSendInput): Promise<unknown> {
    return this.writeOperation(
      (upstreamSignal) => sendSupervisorMail({
        client: this.supervisor,
        path: this.cityPathParams(),
        headers: this.mutationHeaders(),
        body,
        signal: upstreamSignal,
      }),
      this.defaultTimeoutMs,
      'sendMail',
    );
  }

  /**
   * `POST /sling` — auto-creates a bead from `input.bead` text and routes it
   * to `input.target`. The caller reads `root_bead_id` off the response to
   * record slung-state.
   */
  async sling(input: SlingInput): Promise<SlingResponse> {
    const raw = await this.writeSling(input);
    // Decode at the write edge: the supervisor emits the wire field
    // `workflow_id`, which the decoder maps onto the renamed `run_id`
    // property (#61). A raw cast would silently drop the routed run id.
    return gcSupervisorDecoders.decodeSling(raw);
  }

  /**
   * `PATCH /bead/{id}` — the bead-CLAIM path. PATCH is the canonical update
   * verb per the supervisor's api-ops-design.md; both PATCH and the
   * supervisor's update action take the same
   * `BeadUpdateBody`. The supervisor returns OKResponseBody{status}; the caller
   * ignores the body (success = 2xx). Unlike sling, this is a fast metadata
   * write, so it uses the read default timeout. Bead CLOSE + agent NUDGE stay
   * on the CLI (no reason field / no HTTP route respectively).
   */
  async updateBead(id: string, body: BeadUpdateInput): Promise<void> {
    await this.writeBeadUpdate(id, body);
  }

  /**
   * `POST /mail` — operator mail send. The supervisor returns 201 with the
   * created Message; the caller reads `id` off the response. Fast write, so it
   * uses the read default timeout. `from` is pinned to 'human' by the caller,
   * never the browser; the browser-facing shape has no `from` slot.
   */
  async sendMail(body: MailSendInput): Promise<MailSendResponse> {
    const raw = await this.writeMail(body);
    return gcSupervisorDecoders.sendMail(raw);
  }

  async listSessions(signal?: AbortSignal): Promise<GcSessionList> {
    return this.getOperation(
      this.operationKey('getV0CityByCityNameSessions'),
      gcSupervisorDecoders.listSessions,
      (upstreamSignal) => getV0CityByCityNameSessions({
        client: this.supervisor,
        path: this.cityPathParams(),
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * `GET /v0/city/{name}/status` — supervisor city status. The dashboard
   * reads `store_health.size_bytes` off this for the dolt-noms on-disk size
   * trend (gascity-dashboard-x82). Mirrors `listSessions`: coalesced GET
   * through the typed client, decoded at the wire-shape edge, default
   * timeout. `store_health` is optional — a degraded supervisor omits it,
   * and the sampler signals unavailable rather than reporting a fake zero.
   */
  async getStatus(signal?: AbortSignal): Promise<GcStatus> {
    return this.getOperation(
      this.operationKey('getV0CityByCityNameStatus'),
      gcSupervisorDecoders.getStatus,
      (upstreamSignal) => getV0CityByCityNameStatus({
        client: this.supervisor,
        path: this.cityPathParams(),
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * `GET /v0/city/{name}/rigs` — list of configured rigs for this city.
   * Used by the cityStatus snapshot collector to source rigs from the
   * HTTP API instead of parsing city.toml off the host filesystem
   * (gascity-dashboard-19w). The supervisor's RigResponse carries more
   * fields (agent_count, running_count, git status, etc.); the decoder
   * narrows to name+path which is all the dashboard's CityRig contract
   * uses today.
   */
  async listRigs(signal?: AbortSignal): Promise<GcRigList> {
    return this.getOperation(
      this.operationKey('getV0CityByCityNameRigs'),
      gcSupervisorDecoders.listRigs,
      (upstreamSignal) => getV0CityByCityNameRigs({
        client: this.supervisor,
        path: this.cityPathParams(),
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * `GET /v0/cities` — the supervisor's registry of managed cities
   * (gascity-dashboard-ucc). This is the ONLY non-city-scoped GET on the
   * client: it takes no `cityName` path param (the operationKey carries no
   * cityName either, but that is harmless — a GcClient instance is bound to
   * a single supervisor baseUrl, and the cities list is identical for every
   * per-city client pointed at that supervisor). The decoder drops the
   * untrusted host `path` so it never reaches the browser.
   */
  async listCities(signal?: AbortSignal): Promise<CityList> {
    return this.getOperation(
      this.operationKey('getV0Cities'),
      gcSupervisorDecoders.listCities,
      (upstreamSignal) => getV0Cities({
        client: this.supervisor,
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * Host-side variant of {@link listCities} that RETAINS the untrusted
   * supervisor host `path` on each city (gascity-dashboard-ucc). Used ONLY
   * by the per-city runtime registry to source each CityRuntime's rig root;
   * the path is kept host-side and never serialized to the browser. A
   * distinct operationKey from `listCities` so the two decodes don't share
   * an inflight slot (different decoded shapes).
   */
  async listSupervisorCities(
    signal?: AbortSignal,
  ): Promise<readonly SupervisorCity[]> {
    return this.getOperation(
      this.operationKey('getV0Cities', ['supervisor']),
      gcSupervisorDecoders.listSupervisorCities,
      (upstreamSignal) => getV0Cities({
        client: this.supervisor,
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * `GET /v0/city/{name}/agents` — first-class agent roster
   * (gascity-dashboard-ay6). Supersedes the previous derive-from-sessions
   * path which under-counted agents that are configured but not currently
   * bound to a running session. Alias-keyed (each item's `name` is the
   * stable alias the operator types into `gc sling`). The Agents view
   * consumes this directly; the cityStatus snapshot collector now also
   * consumes this for sessionsByProvider (gascity-dashboard-sd4) because
   * /sessions doesn't carry provider for every entry.
   */
  async listAgents(signal?: AbortSignal): Promise<GcAgentList> {
    return this.getOperation(
      this.operationKey('getV0CityByCityNameAgents'),
      gcSupervisorDecoders.listAgents,
      (upstreamSignal) => getV0CityByCityNameAgents({
        client: this.supervisor,
        path: this.cityPathParams(),
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * `GET /v0/city/{name}/agent/{base}` — per-agent detail keyed by the
   * agent's alias (`base` in the supervisor's path naming, but it is the
   * agent's `name`, not a session id). gascity-dashboard-ay6. The caller
   * is responsible for URL-encoding any '/' inside qualified names
   * (e.g. 'thriva/devpipeline.architect') — the generated SDK handles the
   * `{base}` substitution and applies encodeURIComponent.
   */
  async getAgent(base: string, signal?: AbortSignal): Promise<GcAgent> {
    return this.getOperation(
      this.operationKey('getV0CityByCityNameAgentByBase', [base]),
      gcSupervisorDecoders.getAgent,
      (upstreamSignal) => getV0CityByCityNameAgentByBase({
        client: this.supervisor,
        path: { ...this.cityPathParams(), base },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async getBead(id: string, signal?: AbortSignal): Promise<GcBead> {
    return this.getOperation(
      this.operationKey('getV0CityByCityNameBeadById', [id]),
      gcSupervisorDecoders.getBead,
      (upstreamSignal) => getV0CityByCityNameBeadById({
        client: this.supervisor,
        path: { ...this.cityPathParams(), id },
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async listBeads(
    signal?: AbortSignal,
    params?: {
      limit?: number;
      status?: string;
      type?: string;
      label?: string;
      assignee?: string;
      rig?: string;
      all?: boolean;
    },
  ): Promise<GcBeadList> {
    // td-7t24i6 (the operator's corrected diagnosis): gc supervisor defaults
    // /beads to limit=50, which is far below the city's working set
    // (~2139 total, ~183 eng-only). The client-side spam filter then
    // operates on a 50-item window and the operator sees an undercount.
    // Pass an explicit large limit to cover the working set; the spam
    // filter shrinks back down on the client side.
    const query: {
      limit?: number;
      status?: string;
      type?: string;
      label?: string;
      assignee?: string;
      rig?: string;
      all?: boolean;
    } = {};
    if (params?.limit !== undefined) query.limit = params.limit;
    if (params?.status !== undefined) query.status = params.status;
    if (params?.type !== undefined) query.type = params.type;
    if (params?.label !== undefined) query.label = params.label;
    if (params?.assignee !== undefined) query.assignee = params.assignee;
    if (params?.rig !== undefined) query.rig = params.rig;
    if (params?.all !== undefined) query.all = params.all;
    return this.getOperation(
      this.operationKey('getV0CityByCityNameBeads', [
        params?.limit,
        params?.status,
        params?.type,
        params?.label,
        params?.assignee,
        params?.rig,
        params?.all,
      ]),
      gcSupervisorDecoders.listBeads,
      (upstreamSignal) => getV0CityByCityNameBeads({
        client: this.supervisor,
        path: this.cityPathParams(),
        query,
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async listMail(
    signal?: AbortSignal,
    params?: { box?: 'inbox' | 'sent'; alias?: string; limit?: number },
  ): Promise<GcMailList> {
    // td-h3n2ar: the supervisor's `/mail` endpoint silently ignores `box`
    // and `alias` query params today. We still accept them in the method
    // signature (and key the operation cache by them) so callers don't
    // need to change when a future supervisor version starts honoring the
    // filter upstream — the no-op today is harmless. The actual
    // sender/recipient filter happens in routes/mail.ts::filterByBox.
    const query: { limit?: number } = {};
    if (params?.limit !== undefined) query.limit = params.limit;
    return this.getOperation(
      this.operationKey('getV0CityByCityNameMail', [
        params?.box,
        params?.alias,
        params?.limit,
      ]),
      gcSupervisorDecoders.listMail,
      (upstreamSignal) => getV0CityByCityNameMail({
        client: this.supervisor,
        path: this.cityPathParams(),
        query,
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async listEvents(signal?: AbortSignal, after?: number): Promise<GcEventList> {
    const query: { index?: string } = {};
    if (after !== undefined) query.index = String(after);
    return this.getOperation(
      this.operationKey('getV0CityByCityNameEvents', [after]),
      gcSupervisorDecoders.listEvents,
      (upstreamSignal) => getV0CityByCityNameEvents({
        client: this.supervisor,
        path: this.cityPathParams(),
        query,
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async getRun(
    runId: string,
    signal?: AbortSignal,
    scope?: { scopeKind: RunScopeKind; scopeRef: string },
  ): Promise<GcRunSnapshot> {
    const query: { scope_kind?: string; scope_ref?: string } = {};
    if (scope !== undefined) {
      query.scope_kind = scope.scopeKind;
      query.scope_ref = scope.scopeRef;
    }
    return this.getOperation(
      this.operationKey('getV0CityByCityNameWorkflowByWorkflowId', [
        runId,
        scope?.scopeKind,
        scope?.scopeRef,
      ]),
      gcSupervisorDecoders.getRun,
      (upstreamSignal) => getV0CityByCityNameWorkflowByWorkflowId({
        client: this.supervisor,
        path: { ...this.cityPathParams(), workflow_id: runId },
        query,
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  /**
   * Cross-rig discovery of formula runs the supervisor knows about.
   * Mirrors `GET /v0/city/<city>/formulas/feed`. Returns rig-stored
   * workflow roots that `listBeads` (city-scoped) does NOT return —
   * see gascity-dashboard-ej9y. The dashboard's workflows snapshot
   * collector uses this to bootstrap its rig set for downstream
   * per-rig listBeads queries.
   */
  async listFormulaRuns(
    scope: { scopeKind: RunScopeKind; scopeRef: string },
    signal?: AbortSignal,
  ): Promise<GcFormulaRunList> {
    const query = {
      scope_kind: scope.scopeKind,
      scope_ref: scope.scopeRef,
    };
    return this.getOperation(
      this.operationKey('getV0CityByCityNameFormulasFeed', [
        scope.scopeKind,
        scope.scopeRef,
      ]),
      gcSupervisorDecoders.listFormulaRuns,
      (upstreamSignal) => getV0CityByCityNameFormulasFeed({
        client: this.supervisor,
        path: this.cityPathParams(),
        query,
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  async getFormulaDetail(
    formulaName: string,
    scope: { scopeKind: RunScopeKind; scopeRef: string },
    target: string,
    signal?: AbortSignal,
  ): Promise<GcFormulaDetail> {
    const query = {
      scope_kind: scope.scopeKind,
      scope_ref: scope.scopeRef,
      target,
    };
    return this.getOperation(
      this.operationKey('getV0CityByCityNameFormulasByName', [
        formulaName,
        scope.scopeKind,
        scope.scopeRef,
        target,
      ]),
      gcSupervisorDecoders.getFormulaDetail,
      (upstreamSignal) => getV0CityByCityNameFormulasByName({
        client: this.supervisor,
        path: { ...this.cityPathParams(), name: formulaName },
        query,
        signal: upstreamSignal,
      }),
      signal,
    );
  }

  // ── hvx: formula/order run history feeds ────────────────────────────
  //
  // These four methods mirror the supervisor's per-formula and order
  // history endpoints. They have no consumer in the dashboard today; they
  // pin the GcClient boundary so future formula-detail / orders pages
  // don't reinvent the decoder edge or duplicate scope+pagination
  // handling. Aligned with the existing listFormulaRuns (ej9y) pattern
  // for the cross-formula feed.
  //
  // SD4 coexistence: kept under a single named region so a parallel
  // worktree adding sibling methods to this class can merge into a
  // distinct block (or below) without textual conflict.

  /**
   * `GET /v0/city/{name}/formulas/{name}/runs` — recent runs for one named
   * formula (e.g. 'mol-adopt-pr-v2'). Distinct from `listFormulaRuns`
   * (the cross-formula `/formulas/feed`). Used by future formula-detail
   * pages and any reporting surface that needs per-formula history.
   * `scope` is optional in the supervisor's OpenAPI but always passed
   * here — runs are scope-keyed and unscoped requests return the city's
   * default scope, which is not what consumers reading a formula's
   * history want. `limit` accepts 0 to mean "supervisor default".
   */
  async listFormulaRunsByName(
    formulaName: string,
    scope: { scopeKind: RunScopeKind; scopeRef: string },
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<GcFormulaRunsResponse> {
    const query: { scope_kind: string; scope_ref: string; limit?: number } = {
      scope_kind: scope.scopeKind,
      scope_ref: scope.scopeRef,
    };
    if (options.limit !== undefined) query.limit = options.limit;
    return this.getOperation(
      this.operationKey('getV0CityByCityNameFormulasByNameRuns', [
        formulaName,
        scope.scopeKind,
        scope.scopeRef,
        options.limit,
      ]),
      gcSupervisorDecoders.listFormulaRunsByName,
      (upstreamSignal) => getV0CityByCityNameFormulasByNameRuns({
        client: this.supervisor,
        path: { ...this.cityPathParams(), name: formulaName },
        query,
        signal: upstreamSignal,
      }),
      options.signal,
    );
  }

  /**
   * `GET /v0/city/{name}/orders/feed` — currently-active order runs (the
   * supervisor's recurring-job feed). Per-item shape is the same
   * `MonitorFeedItemResponse` as `/formulas/feed`; `type` discriminates
   * (`'order'` vs `'formula'`). Scope is optional — omitting it asks the
   * supervisor for the city-wide feed.
   */
  async listOrdersFeed(
    options: {
      scope?: { scopeKind: RunScopeKind; scopeRef: string };
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<GcOrdersFeedResponse> {
    const query: { scope_kind?: string; scope_ref?: string; limit?: number } = {};
    if (options.scope !== undefined) {
      query.scope_kind = options.scope.scopeKind;
      query.scope_ref = options.scope.scopeRef;
    }
    if (options.limit !== undefined) query.limit = options.limit;
    return this.getOperation(
      this.operationKey('getV0CityByCityNameOrdersFeed', [
        options.scope?.scopeKind,
        options.scope?.scopeRef,
        options.limit,
      ]),
      gcSupervisorDecoders.listOrdersFeed,
      (upstreamSignal) => getV0CityByCityNameOrdersFeed({
        client: this.supervisor,
        path: this.cityPathParams(),
        query,
        signal: upstreamSignal,
      }),
      options.signal,
    );
  }

  /**
   * `GET /v0/city/{name}/orders/history?scoped_name=<...>` — full history
   * for one named order. `scopedName` is the supervisor's scoped form
   * (e.g. `'city:check-mail'` or `'rig:gascity:check-mail'`); the
   * unscoped `name` alone is not enough because two rigs may register the
   * same order. `before` is an RFC3339 timestamp pagination cursor;
   * `limit=0` asks the supervisor for its default.
   */
  async listOrderHistory(
    scopedName: string,
    options: { limit?: number; before?: string; signal?: AbortSignal } = {},
  ): Promise<GcOrderHistoryList> {
    const query: { scoped_name: string; limit?: number; before?: string } = {
      scoped_name: scopedName,
    };
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.before !== undefined) query.before = options.before;
    return this.getOperation(
      this.operationKey('getV0CityByCityNameOrdersHistory', [
        scopedName,
        options.limit,
        options.before,
      ]),
      gcSupervisorDecoders.listOrderHistory,
      (upstreamSignal) => getV0CityByCityNameOrdersHistory({
        client: this.supervisor,
        path: this.cityPathParams(),
        query,
        signal: upstreamSignal,
      }),
      options.signal,
    );
  }

  /**
   * `GET /v0/city/{name}/order/history/{bead_id}` — single historical
   * order-run detail (captured output + labels). `storeRef` is optional
   * but recommended: bead IDs are store-local, so without `store_ref` the
   * supervisor disambiguates against the city store by default and can
   * 404 on rig-stored runs.
   */
  async getOrderHistoryDetail(
    beadId: string,
    options: { storeRef?: string; signal?: AbortSignal } = {},
  ): Promise<GcOrderHistoryDetail> {
    const query: { store_ref?: string } = {};
    if (options.storeRef !== undefined) query.store_ref = options.storeRef;
    return this.getOperation(
      this.operationKey('getV0CityByCityNameOrderHistoryByBeadId', [
        beadId,
        options.storeRef,
      ]),
      gcSupervisorDecoders.getOrderHistoryDetail,
      (upstreamSignal) => getV0CityByCityNameOrderHistoryByBeadId({
        client: this.supervisor,
        path: { ...this.cityPathParams(), bead_id: beadId },
        query,
        signal: upstreamSignal,
      }),
      options.signal,
    );
  }

  async health(options: {
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<SupervisorHealth> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return this.getOperation(
      this.operationKey('getV0CityByCityNameHealth', [timeoutMs]),
      gcSupervisorDecoders.health,
      (upstreamSignal) => getV0CityByCityNameHealth({
        client: this.supervisor,
        path: this.cityPathParams(),
        signal: upstreamSignal,
      }),
      options.signal,
      timeoutMs,
    );
  }

  eventsStreamUrl(after?: string): URL {
    const query = after === undefined || after.length === 0 ? {} : { after };
    return this.cityUrl(
      '/v0/city/{cityName}/events/stream',
      this.cityPathParams(),
      query,
    );
  }

  sessionStreamUrl(sessionId: string, after?: string): URL {
    const query = after === undefined || after.length === 0 ? {} : { after };
    return this.cityUrl(
      '/v0/city/{cityName}/session/{id}/stream',
      { ...this.cityPathParams(), id: sessionId },
      query,
    );
  }

  /**
   * Architect addendum (td-wisp-ijk7g + mechanic td-wisp-e1v14): peek is an
   * HTTP endpoint, not shell-exec. Returns structured turns.
   */
  async fetchTranscript(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<GcTranscriptResponse> {
    return this.getOperation(
      this.operationKey('getV0CityByCityNameSessionByIdTranscript', [sessionId]),
      gcSupervisorDecoders.fetchTranscript,
      (upstreamSignal) => getV0CityByCityNameSessionByIdTranscript({
        client: this.supervisor,
        path: { ...this.cityPathParams(), id: sessionId },
        signal: upstreamSignal,
      }),
      signal,
    );
  }
}

function sanitizedSupervisorStatusError(status: number): Error {
  // gascity-dashboard-ais: route handlers forward this message verbatim
  // into the 502 details.message field, so the message must not include
  // the supervisor URL (port + city name = topology leak to the browser).
  // The status code is enough: the route already labels the failure with
  // its own error string and kind:'upstream'.
  return new Error(`gc supervisor returned ${status}`);
}

function decoderPayloadName(decoder: unknown): string {
  const entry = Object.entries(gcSupervisorDecoders).find(([, candidate]) =>
    candidate === decoder
  );
  return entry?.[0] ?? 'response';
}

function errorFromGeneratedClient(error: unknown, payloadName?: string): Error {
  if (payloadName !== undefined) {
    const invalidPayload = invalidGeneratedSupervisorPayload(payloadName, error);
    if (invalidPayload !== null) return invalidPayload;
  }
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.length > 0) return new Error(error);
  return new Error('gc supervisor request failed');
}

function isGeneratedEmptyJsonBody(response: Response, data: unknown): boolean {
  if (response.status === 204) return false;
  if (response.headers.get('Content-Length') !== '0') return false;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  return Object.keys(data).length === 0;
}

// Narrow view of the client-fetch response-interceptor registration API. The
// generated client types `interceptors` as `unknown` in this project's
// resolution (deprecated standalone package), so this captures only the one
// method we call. The runtime invokes the interceptor as
// `(response, request, options)`; the `...rest` keeps this faithful to that
// arity even though our interceptor only reads `response`. See the constructor.
type SupervisorResponseInterceptors = {
  response: {
    use(
      fn: (response: Response, ...rest: unknown[]) => Response | Promise<Response>,
    ): number;
  };
};

// Matches an RFC3339 date-time string with a numeric tz offset (`+HH:MM` /
// `-HH:MM`), as a JSON string literal. The `Z`-suffixed form is intentionally
// NOT matched — it already passes `z.iso.datetime()` and needs no rewrite.
const RFC3339_OFFSET_RE =
  /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2})"/g;

// Rewrites offset-bearing RFC3339 datetimes in a JSON body to the equivalent
// UTC `Z` instant. Conversion goes through `Date`, so sub-millisecond digits
// (the supervisor occasionally emits nanoseconds) are truncated to ms — lossless
// for the dashboard's display/sort use of these timestamps. A datetime `Date`
// cannot parse is left verbatim so the downstream validator still reports it.
function normalizeOffsetDatetimes(jsonText: string): string {
  return jsonText.replace(RFC3339_OFFSET_RE, (match, value: string) => {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return match;
    return `"${new Date(ms).toISOString()}"`;
  });
}

// Response interceptor: normalize offset datetimes in JSON bodies before the
// generated SDK's offset-intolerant Zod validator runs. Non-JSON responses
// (SSE streams, empty bodies) and bodies with no offset datetime pass through
// untouched (no re-allocation). See gascity-dashboard-9lvq.
async function normalizeOffsetDatetimesInterceptor(
  response: Response,
): Promise<Response> {
  // Non-ok responses are turned into thrown errors by GcClient before the SDK
  // validator runs (see fetchOnce), so they never reach Zod — skip them.
  if (!response.ok) return response;
  if (!response.headers.get('content-type')?.includes('application/json')) {
    return response;
  }
  const body = await response.clone().text();
  const normalized = normalizeOffsetDatetimes(body);
  if (normalized === body) return response;
  // Normalization shortens the body (e.g. `-04:00` -> `Z`), so the original
  // Content-Length is now stale — drop it rather than advertise a wrong length.
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(normalized, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
