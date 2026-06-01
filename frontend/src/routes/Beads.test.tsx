import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeadsPage } from './Beads';
import { NowProvider } from '../contexts/NowContext';
import { invalidate } from '../api/cache';
import type { GcBead } from 'gas-city-dashboard-shared';

// gascity-dashboard-lcnb: the Beads tab is board-only — the list view and
// the board/list selector are gone. These tests assert (a) the kanban board
// renders by default with no toggle, and (b) there is no "View" radiogroup
// (the SortToggle that used to switch views).

const PROJECT = 'gascity';

beforeEach(() => {
  // The board implies "show all", so the page only ever reads the
  // showAll=1 cache key plus the sessions feed.
  invalidate('beads:all');
  invalidate('sessions');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/city/test-city/beads')) {
        return jsonResponse(beadListPayload([sampleBead()]));
      }
      if (url === '/api/city/test-city/sessions') {
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BeadsPage', () => {
  it('renders the kanban board by default', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /^beads$/i });
    // The board renders one <section aria-label={project}> per project
    // group; the list view rendered a <table> instead.
    const board = await screen.findByRole('region', { name: PROJECT });
    expect(board).not.toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('does not render a board/list view selector', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /^beads$/i });
    // The removed selector was a SortToggle rendered as a radiogroup
    // labelled "View".
    expect(screen.queryByRole('radiogroup', { name: /view/i })).toBeNull();
    expect(screen.queryByRole('radio', { name: /list/i })).toBeNull();
    expect(screen.queryByRole('radio', { name: /board/i })).toBeNull();
  });
});

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={['/beads']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <NowProvider intervalMs={1_000_000}>
        <BeadsPage />
      </NowProvider>
    </MemoryRouter>,
  );
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function beadListPayload(items: ReadonlyArray<GcBead>): {
  items: ReadonlyArray<GcBead>;
  total: number;
} {
  return { items, total: items.length };
}

function sampleBead(): GcBead {
  return {
    id: `${PROJECT}-0001`,
    title: 'Sample bead',
    status: 'open',
    priority: 0,
    issue_type: 'task',
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
  };
}
