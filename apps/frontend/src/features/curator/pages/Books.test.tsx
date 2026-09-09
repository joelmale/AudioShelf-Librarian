/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { browseContext } from '../../librarian/context/browseContext.js';
import { Books } from './Books';
import { BookDetail } from './BookDetail';

let container: HTMLDivElement;
let root: Root;

const flushEffects = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const mockBooksData = {
  books: [
    {
      id: 'book-1',
      title: 'Dune',
      author: 'Frank Herbert',
      durationSeconds: 72000,
      coverPath: '',
      tags: [],
    },
  ],
  total: 50,
  limit: 24,
  offset: 0,
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  browseContext.clearBookListSnapshot();
  vi.spyOn(api, 'books').mockResolvedValue(mockBooksData as never);
  vi.spyOn(api, 'vocabulary').mockResolvedValue([] as never);
  vi.spyOn(api, 'book').mockResolvedValue(mockBooksData.books[0] as never);
});

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  browseContext.clearBookListSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Books and BookDetail filter/page retention', () => {
  it('retains filters and page from URL and session snapshot', async () => {
    browseContext.setBookListSnapshot({
      search: 'Herbert',
      category: 'genre',
      tag: 'sci-fi',
      untagged: false,
      page: 1,
    });

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/library/books']}>
          <QueryClientProvider client={new QueryClient()}>
            <Books basePath="/library/books" />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushEffects();

    const searchInput = container.querySelector<HTMLInputElement>('input[placeholder="title or author"]');
    expect(searchInput?.value).toBe('Herbert');

    const pageSpan = container.querySelector('.row span.muted:last-of-type');
    expect(pageSpan?.textContent).toContain('2 /');
  });

  it('restores filters and page on Back navigation from BookDetail', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/library/books?search=Dune&page=1']}>
          <QueryClientProvider client={new QueryClient()}>
            <Routes>
              <Route path="/library/books" element={<Books basePath="/library/books" />} />
              <Route path="/library/books/:id" element={<BookDetail backPath="/library/books" />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushEffects();

    const bookLink = container.querySelector<HTMLAnchorElement>('a.book-card');
    expect(bookLink).not.toBeNull();
    expect(bookLink?.getAttribute('href')).toBe('/library/books/book-1');

    // Click book detail link
    await act(async () => {
      bookLink?.click();
    });
    await flushEffects();

    // Now on BookDetail page
    const backLink = container.querySelector<HTMLAnchorElement>('a.muted');
    expect(backLink).not.toBeNull();
    expect(backLink?.getAttribute('href')).toBe('/library/books?search=Dune&page=1');
  });
});
