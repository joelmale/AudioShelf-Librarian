/* @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityView } from './ActivityView.js';
import type { ActivityFeedResponse } from '../curator/api.js';

const mockFeed: ActivityFeedResponse = {
  success: true,
  needsAttention: [
    {
      id: 'ing_fail_1',
      entityType: 'ingest_item',
      rawId: 'fail_1',
      title: 'Above the Bay of Angels',
      subtitle: 'Interrupted by restart',
      status: 'error',
      category: 'needs_attention',
      error: 'Interrupted by restart',
      actionRequired: {
        type: 'review_intake',
        label: 'Review in Intake',
        targetRoute: '/scout/intake',
      },
      updatedAt: Date.now() - 100000,
    },
  ],
  inProgress: [
    {
      id: 'tor_abc123',
      entityType: 'torrent',
      rawId: 'abc123',
      title: 'Project Hail Mary',
      subtitle: '2.5 MB/s · ETA 5m',
      status: 'running',
      category: 'in_progress',
      progress: {
        percent: 65,
        speed: '2.5 MB/s',
        eta: 300,
      },
      updatedAt: Date.now() - 5000,
    },
  ],
  completed: [
    {
      id: 'enc_hist_1',
      entityType: 'encode_job',
      rawId: 'hist_1',
      title: 'Dune Part 1',
      subtitle: 'Successfully converted to M4B',
      status: 'completed',
      category: 'completed',
      progress: { percent: 100 },
      updatedAt: Date.now() - 3600000,
    },
  ],
  counts: {
    needsAttention: 1,
    inProgress: 1,
    completed: 1,
  },
  providers: {
    operations: 'ok',
    encodes: 'ok',
    ingest: 'ok',
    torrents: 'ok',
  },
  generatedAt: Date.now(),
  retentionWindowMs: 86400000,
};

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;

async function flushPromises() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/activity/feed')) {
      return new Response(JSON.stringify(mockFeed), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (urlStr.includes('/api/activity/entities/ing_fail_1')) {
      return new Response(
        JSON.stringify({
          success: true,
          found: true,
          entity: mockFeed.needsAttention[0],
          rawDetails: { mock: true },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    if (urlStr.includes('/api/activity/entities/nonexistent')) {
      return new Response(
        JSON.stringify({
          success: false,
          found: false,
          unavailableReason: 'Item is not found or has expired from active memory.',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ActivityView Component', () => {
  it('renders Needs Attention, In Progress, and Completed work cards with counters', async () => {
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/activity']}>
            <Routes>
              <Route path="/activity" element={<ActivityView />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushPromises();

    expect(container.textContent).toContain('Needs Attention: 1');
    expect(container.textContent).toContain('In Progress: 1');
    expect(container.textContent).toContain('Completed (24h): 1');

    // Check Needs Attention card
    expect(container.textContent).toContain('Above the Bay of Angels');
    expect(container.textContent).toContain('Interrupted by restart');
    expect(container.textContent).toContain('Review in Intake');

    // Check In Progress card
    expect(container.textContent).toContain('Project Hail Mary');
    expect(container.textContent).toContain('65%');

    // Check Completed card
    expect(container.textContent).toContain('Dune Part 1');
  });

  it('switches between Active Operations and Diagnostics & History tabs', async () => {
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/activity']}>
            <Routes>
              <Route path="/activity" element={<ActivityView />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushPromises();

    const diagnosticsTabBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Diagnostics & History'),
    );
    expect(diagnosticsTabBtn).toBeDefined();

    await act(async () => {
      diagnosticsTabBtn?.click();
    });
    await flushPromises();

    expect(container.textContent).toContain('Librarian History');
    expect(container.textContent).toContain('Curator Logs');
    expect(container.textContent).toContain('System Console');
  });

  it('renders modal when navigating to /activity/:id for a valid entity', async () => {
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/activity/ing_fail_1']}>
            <Routes>
              <Route path="/activity/:id" element={<ActivityView />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushPromises();

    expect(container.textContent).toContain('Activity Item Details');
    expect(container.textContent).toContain('Above the Bay of Angels');
    expect(container.textContent).toContain('Raw State Snapshot');
  });

  it('displays honest unavailable message when entity is not found in /activity/:id', async () => {
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/activity/nonexistent']}>
            <Routes>
              <Route path="/activity/:id" element={<ActivityView />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushPromises();

    expect(container.textContent).toContain('Item Unavailable');
    expect(container.textContent).toContain('expired from active memory');
  });
});
