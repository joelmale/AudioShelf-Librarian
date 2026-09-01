/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecommendationFinder } from './RecommendationFinder.js';

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

async function render(): Promise<HTMLDivElement> {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/scout/recommendations']}>
        <QueryClientProvider client={new QueryClient()}>
          <RecommendationFinder />
          <LocationProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

function location(container: HTMLElement): string {
  return container.querySelector('[data-testid="location"]')?.textContent ?? '';
}

function submit(container: HTMLElement) {
  (container.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('RecommendationFinder', () => {
  it('offers no scope choice and reads no scope setting', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const container = await render();

    expect(container.querySelector('[aria-label="Recommendation scope"]')).toBeNull();
    expect(container.textContent).not.toContain('Discover new');
    // The scope setting used to be read on mount purely to seed that toggle.
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/settings'))).toBe(false);
  });

  it('hands the prompt to the unified surface instead of answering it here', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const container = await render();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'Something light and funny');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => submit(container));

    expect(location(container)).toBe('/desk?q=Something+light+and+funny');
  });

  it('carries picked reference books across as seed ids', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/api/books?')
      ? new Response(JSON.stringify({ books: [{ id: 'seed-1', title: 'Harbor Fog', author: 'M. Shore' }], total: 1, limit: 8, offset: 0 }), { status: 200 })
      : new Response('{}', { status: 200 })));
    const container = await render();
    const input = container.querySelector('.v2-seed-picker input') as HTMLInputElement;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'harbor');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => (container.querySelector('.v2-seed-suggestions button') as HTMLButtonElement).click());
    await act(async () => submit(container));

    // Seeds alone are a complete request, exactly as they were on the old form.
    expect(location(container)).toBe('/desk?seeds=seed-1');
  });

  it('does not navigate with nothing entered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const container = await render();

    expect((container.querySelector('.v2-recommend-submit') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => submit(container));
    expect(location(container)).toBe('/scout/recommendations');
  });
});
