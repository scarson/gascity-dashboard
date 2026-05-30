import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { GcBead, GcMailItem, GcSession, GcSessionState } from 'gas-city-dashboard-shared';
import { effectiveContextPct } from 'gas-city-dashboard-shared';
import { api, ApiClientError } from '../api/client';
import { BeadDetailModal } from '../components/BeadDetailModal';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { LiveSessionPeek, isSessionStreamable } from '../components/LiveSessionPeek';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { RelatedEntities } from '../components/RelatedEntities';
import { useViewingAs } from '../contexts/ViewingAsContext';
import { useAbortableVisibleRefresh } from '../hooks/useAbortableVisibleRefresh';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { useEntityLinks } from '../hooks/useEntityLinks';
import { formatRelative } from '../hooks/time';
import { useVisibleInterval } from '../hooks/useVisibleInterval';

// Read-only drilldown for a single agent. Route: /agents/:slug where
// slug resolves against session_name, alias, then id (see sessionSlug).
//
// Surface:
//   - Header with state badge, identity line, back link
//   - Metadata block (rig, pool, template, model, ctx, attached, timestamps)
//   - Beads assigned to this agent (filtered from /api/beads)
//   - Live peek panel (live SSE stream for active sessions; snapshot otherwise)
//
// Deferred (read-only scope): nudge button, directives panel. Send half
// of the chat thread (compose form) is filed separately. Directives
// needs a new backend endpoint.

const SESSIONS_REFRESH_MS = 15_000;
const BEADS_REFRESH_MS = 30_000;
const CHAT_REFRESH_MS = 10_000;
const CHAT_MAX_MESSAGES = 200;
const PROMPT_INJECTION_NOTICE =
  'Content is agent-generated and may contain misleading instructions.';

export function AgentDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { viewingAs } = useViewingAs();

  const [sessions, setSessions] = useState<GcSession[] | null>(null);
  const [beads, setBeads] = useState<GcBead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewingBead, setViewingBead] = useState<GcBead | null>(null);
  const [viewingBeadId, setViewingBeadId] = useState<string | null>(null);

  const [now, setNow] = useState(() => Date.now());

  const [directivesPrompt, setDirectivesPrompt] = useState<string | null>(null);
  const [directivesLoading, setDirectivesLoading] = useState(false);
  const [directivesError, setDirectivesError] = useState<{
    status?: number;
    kind?: string;
    message: string;
  } | null>(null);
  const [directivesAliasFetched, setDirectivesAliasFetched] = useState<string | null>(null);

  const decoded = useMemo(() => {
    try {
      return decodeURIComponent(slug);
    } catch {
      return slug;
    }
  }, [slug]);

  const refreshSessions = useCallback(async () => {
    try {
      const { items } = await api.listSessions();
      setSessions(items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sessions failed');
    }
  }, []);

  const refreshBeads = useCallback(async () => {
    try {
      const { items } = await api.listBeads(true);
      setBeads(items);
    } catch {
      // Beads panel surfaces its own loading state; don't blank the page.
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
    void refreshBeads();
  }, [refreshSessions, refreshBeads]);

  useVisibleInterval(() => void refreshSessions(), SESSIONS_REFRESH_MS);
  useVisibleInterval(() => void refreshBeads(), BEADS_REFRESH_MS);
  useVisibleInterval(() => setNow(Date.now()), 5_000);

  useGcEventRefresh(['session.', 'bead.'], () => {
    void refreshSessions();
    void refreshBeads();
  });

  const session = useMemo<GcSession | null>(() => {
    if (sessions === null) return null;
    return (
      sessions.find((s) => s.session_name === decoded) ??
      sessions.find((s) => s.alias === decoded) ??
      sessions.find((s) => s.id === decoded) ??
      null
    );
  }, [sessions, decoded]);

  // Beads belonging to this agent. Two link paths in circulation, both
  // need to be matched or polecat-style sessions (empty alias, work
  // bead linked only via metadata.session_id) silently render empty:
  //   1. bead.assignee == alias | session_name | id
  //   2. bead.metadata.session_id == session.id (supervisor-spawned)
  //   3. bead.metadata.session_name == session.session_name (CLI-tagged)
  const assignedBeads = useMemo<GcBead[]>(() => {
    if (session === null || beads === null) return [];
    const candidates = new Set<string>();
    if (session.alias) candidates.add(session.alias);
    if (session.session_name) candidates.add(session.session_name);
    candidates.add(session.id);
    return beads.filter((b) => {
      if (b.assignee !== undefined && candidates.has(b.assignee)) return true;
      // 6bv7: GcBead.metadata is Record<string, string> per OpenAPI (F11)
      // and session_name is required (F10), so neither check needs the
      // prior runtime guards.
      const md = b.metadata;
      if (md) {
        if (md.session_id === session.id) return true;
        if (md.session_name && md.session_name === session.session_name) {
          return true;
        }
      }
      return false;
    });
  }, [session, beads]);

  // Chat thread: wide /api/mail box=all fetch, client-side filter for
  // messages between operator and this agent.
  const agentAliases = useMemo<ReadonlyArray<string>>(() => {
    if (session === null) return [];
    const out = new Set<string>();
    if (session.alias) out.add(session.alias.toLowerCase());
    if (session.session_name) out.add(session.session_name.toLowerCase());
    out.add(session.id.toLowerCase());
    return [...out];
  }, [session]);

  const operatorAliases = useMemo<ReadonlyArray<string>>(
    () => [viewingAs.alias.toLowerCase(), 'human'],
    [viewingAs.alias],
  );

  const loadChatItems = useCallback(async (): Promise<GcMailItem[]> => {
    const { items } = await api.listMail('all', viewingAs.alias);
    return items;
  }, [viewingAs.alias]);

  const chatState = useAbortableVisibleRefresh({
    enabled: session !== null,
    intervalMs: CHAT_REFRESH_MS,
    load: loadChatItems,
    formatError: formatApiError,
  });

  const chatLoading = chatState.status === 'loading';
  const chatError =
    chatState.status === 'failed'
      ? chatState.error
      : chatState.status === 'ready' && chatState.error.length > 0
        ? chatState.error
        : null;

  // Directives: lazy-fetch the agent's composed prompt via `gc prime`.
  // Cached for the lifetime of the page (no auto-refresh); operator can
  // manually re-pull. Bail out (render nothing) when there's no alias
  // candidate — `gc prime` is alias-keyed, not id-keyed.
  const primeAlias = useMemo<string | null>(() => {
    if (session === null) return null;
    return session.alias ?? session.template ?? null;
  }, [session]);

  const refreshDirectives = useCallback(async () => {
    if (primeAlias === null) return;
    setDirectivesLoading(true);
    setDirectivesError(null);
    try {
      const result = await api.agentPrime(primeAlias);
      setDirectivesPrompt(result.prompt);
      setDirectivesAliasFetched(primeAlias);
    } catch (err) {
      const status = err instanceof ApiClientError ? err.status : undefined;
      const kind = err instanceof ApiClientError ? err.kind : undefined;
      const message =
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'directives fetch failed';
      const directivesError: { status?: number; kind?: string; message: string } = { message };
      if (status !== undefined) directivesError.status = status;
      if (kind !== undefined) directivesError.kind = kind;
      setDirectivesError(directivesError);
      setDirectivesPrompt(null);
      setDirectivesAliasFetched(primeAlias);
    } finally {
      setDirectivesLoading(false);
    }
  }, [primeAlias]);

  useEffect(() => {
    if (primeAlias === null) return;
    // Only fetch the first time we see this alias — page-lifetime cache.
    // Manual Refresh button is the documented re-pull path.
    if (directivesAliasFetched === primeAlias) return;
    void refreshDirectives();
  }, [primeAlias, directivesAliasFetched, refreshDirectives]);

  // Related entities (gascity-dashboard-j4x). Focus on the session id so
  // the index surfaces the beads, workflow runs, and PRs adjacent to this
  // agent's work. Hook is called unconditionally (before the early
  // returns) per rules-of-hooks; a null ref leaves it idle.
  const links = useEntityLinks(session?.id ?? null);

  const chatMessages = useMemo<ReadonlyArray<GcMailItem>>(() => {
    const chatItems = chatState.status === 'ready' ? chatState.data : [];
    const agents = new Set(agentAliases);
    const operators = new Set(operatorAliases);
    const filtered = chatItems.filter((m) => {
      const from = (m.from ?? '').toLowerCase();
      const to = (m.to ?? '').toLowerCase();
      // Operator → agent
      if (operators.has(from) && agents.has(to)) return true;
      // Agent → operator
      if (agents.has(from) && operators.has(to)) return true;
      return false;
    });
    filtered.sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (filtered.length > CHAT_MAX_MESSAGES) {
      return filtered.slice(filtered.length - CHAT_MAX_MESSAGES);
    }
    return filtered;
  }, [chatState, agentAliases, operatorAliases]);

  if (sessions === null) {
    return (
      <section>
        <PageHeader title="Agent" synopsis="Loading session list." />
      </section>
    );
  }

  if (session === null) {
    return (
      <section>
        <PageHeader
          title="Agent"
          synopsis={
            <>
              No session matches <code className="text-fg">{decoded}</code>.
            </>
          }
          meta={
            <Button size="sm" tone="quiet" onClick={() => navigate('/agents')}>
              ← Agents
            </Button>
          }
        />
        <p className="text-body text-fg-muted max-w-prose">
          The slug doesn't match any current session's session_name, alias, or id.
          Sessions are listed at{' '}
          <Link to="/agents" className="text-accent hover:underline">
            /agents
          </Link>
          .
        </p>
      </section>
    );
  }

  const label = session.alias ?? session.title ?? session.id;
  const tone = stateTone(session.state);

  const openBead = (id: string) => {
    setViewingBead(null);
    setViewingBeadId(id);
  };
  const closeBead = () => {
    setViewingBead(null);
    setViewingBeadId(null);
  };

  return (
    <section>
      <PageHeader
        title={label}
        synopsis={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <StatusBadge
              tone={tone}
              label={session.state}
              {...(session.attached ? { trailing: 'att' } : {})}
              {...(session.reason ? { title: `reason: ${session.reason}` } : {})}
            />
            <span className="text-fg-faint">·</span>
            <code className="text-fg-muted">{session.template ?? '—'}</code>
            {session.session_name && session.session_name !== session.alias && (
              <>
                <span className="text-fg-faint">·</span>
                <span className="text-fg-faint">{session.session_name}</span>
              </>
            )}
            <span className="text-fg-faint">·</span>
            <span className="text-fg-faint">id <code className="text-fg-muted">{session.id}</code></span>
          </span>
        }
        meta={
          <Link to="/agents">
            <Button size="sm" tone="quiet">
              ← Agents
            </Button>
          </Link>
        }
      />

      {error && (
        <p className="text-body text-accent mb-6" role="alert">
          {error}
        </p>
      )}

      <Metadata session={session} now={now} />

      <BeadsAssigned
        beads={assignedBeads}
        loading={beads === null}
        onSelect={(b) => {
          setViewingBeadId(null);
          setViewingBead(b);
        }}
      />

      <RelatedEntities
        view={links.view}
        loading={links.loading}
        error={links.error}
        now={now}
        onOpenBead={openBead}
      />

      <section>
        <header className="flex items-baseline justify-between mb-4">
          <h2 className="text-label uppercase tracking-wider text-fg-faint">
            Live peek
          </h2>
        </header>
        <LiveSessionPeek
          sessionId={session.id}
          stream={isSessionStreamable(session)}
          showBadge
          showCaption
        />
      </section>

      {primeAlias !== null && (
        <Directives
          alias={primeAlias}
          prompt={directivesPrompt}
          loading={directivesLoading}
          error={directivesError}
          onRefresh={() => void refreshDirectives()}
        />
      )}

      <ChatThread
        messages={chatMessages}
        loading={chatLoading}
        error={chatError}
        now={now}
      />

      <BeadDetailModal
        open={viewingBead !== null || viewingBeadId !== null}
        onClose={closeBead}
        beadId={viewingBead?.id ?? viewingBeadId}
        initialBead={viewingBead}
        onOpenBead={openBead}
      />
    </section>
  );
}

function Metadata({ session, now }: { session: GcSession; now: number }) {
  const pct = effectiveContextPct(session);
  const items: ReadonlyArray<{ label: string; value: React.ReactNode }> = [
    { label: 'Rig', value: session.rig ?? '·' },
    { label: 'Pool', value: session.pool ?? '·' },
    { label: 'Provider', value: session.provider ?? '·' },
    { label: 'Model', value: session.model ?? '·' },
    {
      label: 'Context',
      value:
        typeof pct === 'number' ? (
          <span
            className={`tnum ${
              pct >= 95 ? 'text-accent' : pct >= 80 ? 'text-warn' : 'text-fg'
            }`}
          >
            {pct}%
          </span>
        ) : (
          '·'
        ),
    },
    { label: 'Attached', value: session.attached ? 'yes' : 'no' },
    {
      label: 'Created',
      value: <span className="tnum">{formatRelative(session.created_at, now)}</span>,
    },
    {
      label: 'Last active',
      value: <span className="tnum">{formatRelative(session.last_active, now)}</span>,
    },
  ];

  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-5 mb-12">
      {items.map((it) => (
        <div key={it.label}>
          <dt className="text-label uppercase tracking-wider text-fg-faint mb-1">
            {it.label}
          </dt>
          <dd className="text-body text-fg">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BeadsAssigned({
  beads,
  loading,
  onSelect,
}: {
  beads: ReadonlyArray<GcBead>;
  loading: boolean;
  onSelect: (bead: GcBead) => void;
}) {
  return (
    <section className="mb-12">
      <header className="flex items-baseline justify-between mb-4">
        <h2 className="text-label uppercase tracking-wider text-fg-faint">
          Beads assigned
        </h2>
        <span className="text-label uppercase tracking-wider text-fg-faint tnum">
          {loading ? '·' : beads.length}
        </span>
      </header>
      {loading ? (
        <p className="text-body text-fg-muted italic">Loading beads.</p>
      ) : beads.length === 0 ? (
        <p className="text-body text-fg-muted italic">No beads assigned to this agent.</p>
      ) : (
        <ul className="space-y-2">
          {beads.map((b) => (
            <li key={b.id} className="flex items-baseline gap-3 min-w-0">
              <span className="text-label uppercase tracking-wider text-fg-faint tnum shrink-0">
                {b.id}
              </span>
              <button
                type="button"
                onClick={() => onSelect(b)}
                className="text-body text-fg hover:text-accent truncate min-w-0 text-left focus-mark"
                title={`Open ${b.id}`}
              >
                {b.title}
              </button>
              <span className="text-label uppercase tracking-wider text-fg-faint shrink-0">
                {b.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChatThread({
  messages,
  loading,
  error,
  now,
}: {
  messages: ReadonlyArray<GcMailItem>;
  loading: boolean;
  error: string | null;
  now: number;
}) {
  return (
    <section className="mt-12">
      <header className="flex items-baseline justify-between mb-4">
        <h2 className="text-label uppercase tracking-wider text-fg-faint">
          Chat thread
        </h2>
        <span className="text-label uppercase tracking-wider text-fg-faint tnum">
          {loading ? '·' : messages.length}
        </span>
      </header>
      <p className="text-label uppercase tracking-wider text-fg-faint mb-4">
        <span className="text-accent">▲ {PROMPT_INJECTION_NOTICE}</span>
      </p>
      {loading ? (
        <p className="text-body text-fg-muted italic">Loading messages.</p>
      ) : error !== null ? (
        <p className="text-body text-accent" role="alert">
          {error}
        </p>
      ) : messages.length === 0 ? (
        <p className="text-body text-fg-muted italic">
          No messages between operator and this agent.
        </p>
      ) : (
        <ul className="space-y-6">
          {messages.map((m) => (
            <li key={m.id} className="space-y-2 pb-4 border-b border-rule last:border-0">
              <header className="flex items-baseline justify-between gap-3">
                <div className="text-label uppercase tracking-wider text-fg-muted truncate">
                  <span className="text-fg font-medium">{m.from}</span>
                  <span className="mx-1.5 text-fg-faint">→</span>
                  <span>{m.to}</span>
                </div>
                <span className="text-label uppercase tracking-wider text-fg-faint tnum shrink-0">
                  {formatRelative(m.created_at, now)}
                </span>
              </header>
              {m.subject && (
                <p className="text-body font-medium text-fg">{m.subject}</p>
              )}
              <pre className="text-body whitespace-pre-wrap leading-relaxed text-fg overflow-x-auto">
                {m.body}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Directives({
  alias,
  prompt,
  loading,
  error,
  onRefresh,
}: {
  alias: string;
  prompt: string | null;
  loading: boolean;
  error: { status?: number; kind?: string; message: string } | null;
  onRefresh: () => void;
}) {
  const isNotFound = error?.status === 404 || error?.kind === 'not_found';
  const charsLabel =
    prompt !== null
      ? `${prompt.length.toLocaleString()} chars`
      : loading
        ? 'loading'
        : error !== null
          ? '—'
          : '·';

  return (
    <section className="mt-12">
      <header className="flex items-baseline justify-between mb-4">
        <h2 className="text-label uppercase tracking-wider text-fg-faint">
          Directives
        </h2>
        <div className="flex items-baseline gap-3">
          <span className="text-label uppercase tracking-wider text-fg-faint tnum">
            {charsLabel}
          </span>
          <Button size="sm" tone="quiet" onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing' : 'Refresh'}
          </Button>
        </div>
      </header>
      {loading && prompt === null && error === null ? (
        <p className="text-body text-fg-muted italic">Loading directives.</p>
      ) : isNotFound ? (
        <p className="text-body text-warn">
          Agent <code className="text-fg">{alias}</code> has no entry in city
          config.
        </p>
      ) : error !== null ? (
        <p className="text-body text-accent" role="alert">
          {error.status ? `${error.status} ` : ''}
          {error.message}
        </p>
      ) : prompt !== null ? (
        <pre
          className="text-body whitespace-pre-wrap leading-relaxed text-fg overflow-x-auto max-h-[60vh] overflow-y-auto"
        >
          {prompt}
        </pre>
      ) : null}
    </section>
  );
}

function formatApiError(err: unknown): string {
  if (err instanceof ApiClientError) return `${err.status} ${err.message}`;
  if (err instanceof Error) return err.message;
  return 'mail failed';
}

function stateTone(state: GcSessionState): StatusTone {
  switch (state) {
    case 'active':
    case 'running':
      return 'ok';
    case 'rate-limited':
    case 'rate_limited':
    case 'waiting':
      return 'warn';
    case 'failed':
    case 'closed':
    case 'errored':
    case 'stuck':
      return 'stuck';
    case 'asleep':
    case 'idle':
    case 'creating':
    case 'detached':
    default:
      return 'neutral';
  }
}
