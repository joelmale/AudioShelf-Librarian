/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, type ProposedVocabTerm } from '../api.js';
import { ToastProvider } from '../toast.js';
import { VocabularySuggestionsPanel } from './VocabularySuggestionsPanel.js';

let root: Root | undefined;

const terms: ProposedVocabTerm[] = [
  { term: 'coastal-town', category: 'setting', status: 'proposed', bookCount: 29, firstSeen: 1, sampleBooks: ['Alpha'], origin: 'tagger', categoryCollision: false, aliasSuggestions: ['coastal'] },
  { term: 'adventure', category: 'mood', status: 'proposed', bookCount: 20, firstSeen: 1, sampleBooks: ['Beta'], origin: 'tagger', categoryCollision: true, aliasSuggestions: [] },
  { term: 'adventure', category: 'theme', status: 'proposed', bookCount: 19, firstSeen: 1, sampleBooks: ['Gamma'], origin: 'tagger', categoryCollision: true, aliasSuggestions: [] },
  { term: 'one-off', category: 'theme', status: 'proposed', bookCount: 1, firstSeen: 1, sampleBooks: ['Delta'], origin: 'tagger', categoryCollision: false, aliasSuggestions: [] },
];

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mount(): Promise<HTMLElement> {
  vi.spyOn(api, 'proposedVocabTerms').mockResolvedValue(terms);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  await act(async () => root?.render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><VocabularySuggestionsPanel /></ToastProvider>
    </QueryClientProvider>
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return element;
}

describe('VocabularySuggestionsPanel', () => {
  it('defaults to five-book support and keeps singletons deferred', async () => {
    const element = await mount();
    expect(element.textContent).toContain('3 shown of 4');
    expect(element.textContent).toContain('1 singletons deferred');
    expect(element.textContent).toContain('coastal-town');
    expect(element.textContent).not.toContain('one-off');
  });

  it('blocks bulk promotion when a selected visible term crosses categories', async () => {
    const element = await mount();
    const selectAll = element.querySelector('input[aria-label="Select all visible terms"]') as HTMLInputElement;
    await act(async () => selectAll.click());
    const promote = [...element.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Promote selected')) as HTMLButtonElement;
    expect(promote.disabled).toBe(true);
    expect(element.textContent).toContain('Review that term individually');
  });

  it('can reveal deferred terms and filter them by search', async () => {
    const element = await mount();
    const minimum = element.querySelector('input[type="number"]') as HTMLInputElement;
    const numberSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      numberSetter?.call(minimum, '1');
      minimum.dispatchEvent(new Event('input', { bubbles: true }));
      minimum.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(element.textContent).toContain('one-off');

    const search = element.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      numberSetter?.call(search, 'coastal');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(element.textContent).toContain('coastal-town');
    expect(element.textContent).not.toContain('one-off');
  });

  it('submits a selected safe term through the batch endpoint', async () => {
    const review = vi.spyOn(api, 'reviewVocabBatch').mockResolvedValue({
      action: 'promote', reviewed: 1, retagged: 29, affectedBooks: 29, reembed: {},
    });
    const element = await mount();
    const checkbox = element.querySelector('input[aria-label="Select coastal-town"]') as HTMLInputElement;
    await act(async () => checkbox.click());
    const promote = [...element.querySelectorAll('button')].find((button) => button.textContent === 'Promote selected (1)')!;
    await act(async () => promote.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(review).toHaveBeenCalledWith('promote', [{ term: 'coastal-town', category: 'setting' }]);
  });

  it('loads every matching book and its description only when requested', async () => {
    const books = vi.spyOn(api, 'proposedVocabBooks').mockResolvedValue({
      term: 'coastal-town', category: 'setting', total: 1,
      books: [{ id: 'b1', title: 'Alpha', author: 'A. Writer', description: 'A sunny coastal mystery.', descriptionSource: 'abs' }],
    });
    const element = await mount();
    expect(books).not.toHaveBeenCalled();
    const view = [...element.querySelectorAll('button')].find((button) => button.textContent === 'View supporting books')!;
    await act(async () => view.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(books).toHaveBeenCalledWith('coastal-town', 'setting');
    expect(element.textContent).toContain('A sunny coastal mystery.');
    expect(element.textContent).toContain('Description source: abs');
  });
});
