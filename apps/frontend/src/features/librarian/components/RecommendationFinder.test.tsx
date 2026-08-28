/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecommendationFinder } from './RecommendationFinder.js';

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('RecommendationFinder', () => {
  async function renderWithSettings(response: Promise<Response>): Promise<HTMLDivElement> {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('fetch', vi.fn(() => response));
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <MemoryRouter>
          <QueryClientProvider client={new QueryClient()}>
            <RecommendationFinder />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    return container;
  }

  it('uses a configured recommendation scope', async () => {
    const container = await renderWithSettings(Promise.resolve(new Response(JSON.stringify({
      data: { recommendationScope: 'shelf' },
    }), { status: 200 })));
    const shelf = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Recommendation scope"] button')]
      .find((button) => button.textContent?.includes('On my shelf'));
    expect(shelf?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps discover as a live configured recommendation scope', async () => {
    const container = await renderWithSettings(Promise.resolve(new Response(JSON.stringify({
      data: { recommendationScope: 'discover' },
    }), { status: 200 })));
    const discover = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Recommendation scope"] button')]
      .find((button) => button.textContent?.includes('Discover new'));
    expect(discover?.getAttribute('aria-pressed')).toBe('true');
  });

  it('falls back to both when settings cannot be read', async () => {
    const container = await renderWithSettings(Promise.reject(new Error('offline')));
    const both = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Recommendation scope"] button')]
      .find((button) => button.textContent?.includes('Both'));
    expect(both?.getAttribute('aria-pressed')).toBe('true');
  });
});
