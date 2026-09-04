/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../curator/api.js';
import { RecommendationFinder } from './RecommendationFinder.js';

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function externalResult(available: Array<Record<string, unknown>> = []) {
  return {
    interpretation: 'Beach mysteries you do not own.',
    slateId: 'slate-1',
    constraints: { maxDurationHours: null, genres: [], moods: [] },
    scope: 'discover',
    retrieval: { candidateCount: 961, evidenceCount: 20, tagResolution: [], personalized: false },
    onShelf: [],
    available,
  };
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
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

function typePrompt(container: HTMLElement, value: string) {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(container: HTMLElement) {
  await act(async () => {
    (container.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('RecommendationFinder (acquire-only)', () => {
  it('always asks for discover scope, and offers no scope choice', async () => {
    // This panel's whole job is books you do NOT own. Owned-shelf answers are
    // the Desk's, because §5.4 rule 3 bars the chat loop from external picks.
    const spy = vi.spyOn(api, 'recommendations').mockResolvedValue(externalResult() as never);
    const container = await render();
    expect(container.textContent).not.toContain('On my shelf');
    expect(container.textContent).not.toContain('Discover new');

    typePrompt(container, 'beach mysteries');
    await submit(container);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ scope: 'discover' }));
  });

  it('renders verified external suggestions with their store listing', async () => {
    vi.spyOn(api, 'recommendations').mockResolvedValue(externalResult([{
      title: 'Key West Normal',
      author: 'Laurence Shames',
      reason: 'A sunny caper close to what you already enjoy.',
      description: null,
      durationSeconds: 7_200,
      genre: 'Mystery',
      coverUrl: null,
      storeUrl: 'https://example.test/listing',
    }]) as never);
    const container = await render();

    typePrompt(container, 'beach mysteries');
    await submit(container);

    expect(container.textContent).toContain('Key West Normal');
    expect(container.textContent).toContain('2h 0m');
    expect(container.querySelector('a[href="https://example.test/listing"]')).not.toBeNull();
  });

  it('never presents owned books as the answer here', async () => {
    // A regression guard: if this panel ever started rendering `onShelf` it
    // would be a second front door onto the Desk's job all over again.
    vi.spyOn(api, 'recommendations').mockResolvedValue({
      ...externalResult(),
      onShelf: [{ id: 'owned', title: 'Already Owned Book', author: null, reason: 'x', tags: [], matchedTags: [] }],
    } as never);
    const container = await render();

    typePrompt(container, 'anything');
    await submit(container);

    expect(container.textContent).not.toContain('Already Owned Book');
  });

  it('says an empty result means unverified, not nonexistent', async () => {
    vi.spyOn(api, 'recommendations').mockResolvedValue(externalResult([]) as never);
    const container = await render();

    typePrompt(container, 'something obscure');
    await submit(container);

    expect(container.textContent).toContain('cleared verification');
  });

  it('records a verdict against the external key', async () => {
    vi.spyOn(api, 'recommendations').mockResolvedValue(externalResult([{
      title: 'Key West Normal',
      author: 'Laurence Shames',
      reason: 'Close to your taste.',
      description: null,
      durationSeconds: null,
      genre: null,
      coverUrl: null,
      storeUrl: null,
    }]) as never);
    const feedback = vi.spyOn(api, 'sendFeedback').mockResolvedValue({ id: 1 } as never);
    const container = await render();

    typePrompt(container, 'beach mysteries');
    await submit(container);

    const button = [...container.querySelectorAll('button')]
      .find((element) => element.getAttribute('aria-label') === 'More like Key West Normal') as HTMLButtonElement;
    await act(async () => button.click());

    expect(feedback).toHaveBeenCalledWith(expect.objectContaining({
      externalKey: 'Key West Normal|Laurence Shames',
      verdict: 'accepted',
    }));
  });

  it('does not call the API with nothing entered', async () => {
    const spy = vi.spyOn(api, 'recommendations');
    const container = await render();

    await submit(container);

    expect(spy).not.toHaveBeenCalled();
  });
});
