import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthPage } from './Health';
import { invalidate } from '../api/cache';
import type {
  DoltNomsTrend,
  HealthDiagnostics,
  SupervisorHealth,
  SystemHealth,
} from 'gas-city-dashboard-shared';

// gascity-dashboard-e0hh: coverage for the absent
// supervisor.city / supervisor.version paths in Health.tsx —
// (a) the warn-toned <Kv> blocks render "not reported by supervisor",
// (b) buildSynopsis omits the "on <city>" locator clause, asserted
//     via rendered DOM rather than by exporting the module-private
//     helper. Mirrors the WorkflowRunDetail.test.tsx fetch-stub pattern.

let currentHealth: SystemHealth = baseHealth();
let currentTrend: DoltNomsTrend = baseTrend();

beforeEach(() => {
  invalidate('health');
  currentHealth = baseHealth();
  currentTrend = baseTrend();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/city/test-city/health/system') {
      return jsonResponse(currentHealth);
    }
    if (url === '/api/city/test-city/dolt-noms/trend') {
      return jsonResponse(currentTrend);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HealthPage', () => {
  it('renders warn-toned "not reported by supervisor" for absent city and version', async () => {
    currentHealth = withSupervisor(absentLocator());

    const { container } = renderPage();
    await screen.findByRole('heading', { name: /^health$/i });
    await screen.findByRole('heading', { name: /supervisor/i });

    const cityValue = valueFor(container, 'City');
    const versionValue = valueFor(container, 'Version');

    expect(cityValue?.textContent).toBe('not reported by supervisor');
    expect(versionValue?.textContent).toBe('not reported by supervisor');
    expect(cityValue?.className).toMatch(/text-warn/);
    expect(versionValue?.className).toMatch(/text-warn/);
  });

  it('omits the "on <city>" locator clause from the synopsis when city is absent', async () => {
    currentHealth = withSupervisor(absentLocator());

    renderPage();
    // Wait for the data-dependent Supervisor section heading before
    // reading the synopsis — the page-title 'Health' heading renders
    // even during the initial loading state, so anchoring on it could
    // race the fetch resolution on slow CI workers.
    await screen.findByRole('heading', { name: /supervisor/i });
    const heading = await screen.findByRole('heading', { name: /^health$/i });
    const synopsis = synopsisFor(heading);

    expect(synopsis).not.toBeNull();
    // Structural assertion: between "Supervisor" and "uptime" there is
    // no " on " locator clause. Coupled to the synopsis shape, not the
    // exact copy.
    expect(synopsis?.textContent ?? '').toMatch(/Supervisor healthy, uptime /);
    expect(synopsis?.textContent ?? '').not.toMatch(/Supervisor healthy on /);
  });

  it('renders city/version without warn tone and includes the locator clause when present', async () => {
    // Positive contrast for the absent-path tests — guards against a
    // false-positive where the warn tone or the dropped clause was
    // applied to every supervisor render path.
    currentHealth = withSupervisor(presentLocator());

    const { container } = renderPage();
    // Same as the test above: wait for the Supervisor section heading
    // so the data has actually loaded before we query for the City /
    // Version Kvs the assertion reads.
    await screen.findByRole('heading', { name: /supervisor/i });
    const heading = await screen.findByRole('heading', { name: /^health$/i });

    const cityValue = valueFor(container, 'City');
    const versionValue = valueFor(container, 'Version');

    expect(cityValue?.textContent).toBe('racoon-city');
    expect(versionValue?.textContent).toBe('1.4.2');
    expect(cityValue?.className).not.toMatch(/text-warn/);
    expect(versionValue?.className).not.toMatch(/text-warn/);

    const synopsis = synopsisFor(heading);
    // Guard against a vacuous pass: if a future PageHeader refactor
    // restructures the synopsis element, synopsisFor would return null
    // and the positive match below would correctly fail — but assert
    // explicitly so the failure mode is "missing synopsis node" rather
    // than "positive match against an empty string".
    expect(synopsis).not.toBeNull();
    expect(synopsis?.textContent ?? '').toMatch(/Supervisor healthy on racoon-city, uptime /);
  });
});

// gascity-dashboard-1cob: Health diagnostics — Dolt/Beads versions + usage,
// recommended-vs-loaded config comparison. Every datum sources from the
// backend (never hardcoded); unavailable data surfaces explicitly.
describe('HealthPage diagnostics', () => {
  it('renders Dolt and Beads versions from the backend', async () => {
    const { container } = renderPage();
    await screen.findByRole('heading', { name: /diagnostics/i });

    expect(valueFor(container, 'Dolt version')?.textContent).toBe('2.0.7');
    expect(valueFor(container, 'Beads version')?.textContent).toBe('1.0.4');
  });

  it('surfaces a failed version probe explicitly rather than blank', async () => {
    currentHealth = {
      ...baseHealth(),
      diagnostics: {
        ...baseDiagnostics(),
        doltVersion: { status: 'unavailable', reason: 'dolt not on PATH' },
      },
    };
    const { container } = renderPage();
    await screen.findByRole('heading', { name: /diagnostics/i });

    const value = valueFor(container, 'Dolt version');
    expect(value?.textContent).toMatch(/unavailable|dolt not on PATH/i);
    expect(value?.className).toMatch(/text-warn/);
  });

  it('renders Dolt + Beads usage from the backend', async () => {
    const { container } = renderPage();
    await screen.findByRole('heading', { name: /diagnostics/i });

    expect(valueFor(container, 'Live rows')?.textContent).toMatch(/2,?000/);
    expect(valueFor(container, 'Open')?.textContent).toBe('10');
    expect(valueFor(container, 'Ready')?.textContent).toBe('4');
    expect(valueFor(container, 'In progress')?.textContent).toBe('2');
  });

  it('renders the recommended-vs-loaded comparison row, in-bounds', async () => {
    const { container } = renderPage();
    await screen.findByRole('heading', { name: /recommended/i });

    const row = rowFor(container, 'Dolt MB-per-row ratio');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('≤ 1');
    expect(row?.textContent).toContain('0.5');
    // In-bounds row is not warn-toned.
    expect(row?.className ?? '').not.toMatch(/text-warn/);
  });

  it('flags an over-threshold comparison row with a warn tone', async () => {
    currentHealth = {
      ...baseHealth(),
      diagnostics: {
        ...baseDiagnostics(),
        configComparison: {
          status: 'available',
          source: 's',
          value: [
            {
              label: 'Dolt MB-per-row ratio',
              recommended: '≤ 1',
              loaded: '2.5',
              withinRecommendation: false,
            },
          ],
        },
      },
    };
    const { container } = renderPage();
    await screen.findByRole('heading', { name: /recommended/i });

    const row = rowFor(container, 'Dolt MB-per-row ratio');
    expect(row?.className ?? '').toMatch(/text-warn/);
  });

  it('shows comparison unavailable copy when the supervisor reports no baseline', async () => {
    currentHealth = {
      ...baseHealth(),
      diagnostics: {
        ...baseDiagnostics(),
        configComparison: {
          status: 'unavailable',
          reason: 'supervisor reports no recommended baseline to compare against',
        },
      },
    };
    renderPage();
    await screen.findByRole('heading', { name: /recommended/i });

    expect(
      screen.getByText(/no recommended baseline/i),
    ).toBeTruthy();
  });
});

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={['/health']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <HealthPage />
    </MemoryRouter>,
  );
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function valueFor(container: HTMLElement, label: string): HTMLElement | null {
  const terms = Array.from(container.querySelectorAll('dt')).filter(
    (dt) => dt.textContent?.trim() === label,
  );
  if (terms.length !== 1) return null;
  return terms[0]?.nextElementSibling as HTMLElement | null;
}

function rowFor(container: HTMLElement, label: string): HTMLElement | null {
  // The comparison table renders one element per row carrying a
  // data-comparison-row attribute set to the row label.
  return container.querySelector(
    `[data-comparison-row="${label}"]`,
  ) as HTMLElement | null;
}

function synopsisFor(heading: HTMLElement): HTMLElement | null {
  // PageHeader renders the synopsis as a sibling of the heading inside
  // a shared header element. Walk up to the nearest <header>, then look
  // for a paragraph descendant. Specific to PageHeader's structure but
  // stable — the alternative (text search) would over-couple to copy.
  const header = heading.closest('header');
  return header?.querySelector('p') ?? null;
}

function withSupervisor(supervisor: SupervisorHealth): SystemHealth {
  return {
    ...baseHealth(),
    supervisor: { status: 'available', data: supervisor },
  };
}

function presentLocator(): SupervisorHealth {
  return {
    status: 'ok',
    city: 'racoon-city',
    version: '1.4.2',
    uptime_sec: 4200,
  };
}

function absentLocator(): SupervisorHealth {
  // The two fields under test are deliberately omitted, not set to
  // undefined or null — that mirrors what a wire-drifted supervisor
  // payload actually looks like over JSON.
  return {
    status: 'ok',
    uptime_sec: 4200,
  };
}

function baseHealth(): SystemHealth {
  return {
    admin: {
      pid: 4242,
      uptime_sec: 600,
      rss_bytes: 50_000_000,
      heap_used_bytes: 30_000_000,
      node_version: 'v20.10.0',
    },
    host: {
      load_avg_1: 0.42,
      load_avg_5: 0.55,
      load_avg_15: 0.61,
      total_mem_bytes: 16_000_000_000,
      free_mem_bytes: 8_000_000_000,
      cpu_count: 8,
      uptime_sec: 86_400,
    },
    supervisor: {
      status: 'available',
      data: presentLocator(),
    },
    diagnostics: baseDiagnostics(),
  };
}

function baseDiagnostics(): HealthDiagnostics {
  return {
    doltVersion: { status: 'available', value: '2.0.7', source: 'local probe: dolt version' },
    beadsVersion: { status: 'available', value: '1.0.4', source: 'local probe: bd version' },
    doltUsage: {
      status: 'available',
      source: 'supervisor status.store_health',
      value: {
        size_bytes: 1_000_000,
        live_rows: 2000,
        ratio_mb_per_row: 0.5,
        threshold_mb_per_row: 1.0,
        warning: false,
        last_gc_status: 'success',
        path: '/data/store',
      },
    },
    beadsUsage: {
      status: 'available',
      source: 'supervisor status.work',
      value: { open: 10, ready: 4, in_progress: 2 },
    },
    configComparison: {
      status: 'available',
      source: 'supervisor status.store_health (threshold vs actual)',
      value: [
        {
          label: 'Dolt MB-per-row ratio',
          recommended: '≤ 1',
          loaded: '0.5',
          withinRecommendation: true,
        },
      ],
    },
  };
}

function baseTrend(): DoltNomsTrend {
  return {
    available: true,
    samples: [],
    source: '/var/gc/.dolt/noms',
  };
}
