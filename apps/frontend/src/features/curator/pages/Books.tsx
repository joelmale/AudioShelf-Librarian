import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';

import { api, formatDuration, useVocabulary, type TagCategory } from '../api';
import { TagCloud } from '../components/TagPill';
import { useToast } from '../toast';
import { browseContext } from '../../librarian/context/browseContext.js';

const CATEGORIES: TagCategory[] = ['genre', 'mood', 'theme', 'era', 'pacing', 'length', 'audience'];
const PAGE_SIZE = 24;

export async function copyAllBookTitles(
  loadTitles: () => Promise<string[]> = api.bookTitles,
  writeText: (value: string) => Promise<void> = (value) => {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable');
    return navigator.clipboard.writeText(value);
  },
): Promise<number> {
  const titles = await loadTitles();
  await writeText(titles.join('\n'));
  return titles.length;
}

export function Books({ basePath = '/curator/books' }: { basePath?: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const snapshot = browseContext.getBookListSnapshot();

  const [search, setSearch] = useState(() => searchParams.get('search') ?? snapshot?.search ?? '');
  const [category, setCategory] = useState(() => searchParams.get('category') ?? snapshot?.category ?? '');
  const [tag, setTag] = useState(() => searchParams.get('tag') ?? snapshot?.tag ?? '');
  const [untagged, setUntagged] = useState(() => {
    if (searchParams.has('untagged')) {
      return searchParams.get('untagged') === 'true';
    }
    return snapshot?.untagged ?? false;
  });
  const [page, setPage] = useState(() => {
    const p = searchParams.get('page');
    if (p != null) {
      const parsed = parseInt(p, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
    }
    return snapshot?.page ?? 0;
  });
  const [copying, setCopying] = useState(false);
  const toast = useToast();

  useEffect(() => {
    browseContext.setBookListSnapshot({ search, category, tag, untagged, page });
    const nextParams = new URLSearchParams();
    if (search) nextParams.set('search', search);
    if (category) nextParams.set('category', category);
    if (tag) nextParams.set('tag', tag);
    if (untagged) nextParams.set('untagged', 'true');
    if (page > 0) nextParams.set('page', String(page));

    const searchString = nextParams.toString();
    const currentSearch = location.search.replace(/^\?/, '');
    if (searchString !== currentSearch) {
      navigate({ search: searchString ? `?${searchString}` : '' }, { replace: true });
    }
  }, [search, category, tag, untagged, page, navigate, location.search]);

  const vocab = useVocabulary();
  const params: Record<string, string> = { limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) };
  if (search) params.search = search;
  if (category) params.category = category;
  if (tag) params.tag = tag;
  if (untagged) params.untagged = 'true';

  const books = useQuery({ queryKey: ['books', params], queryFn: () => api.books(params) });
  const total = books.data?.total ?? 0;
  const pages = Math.ceil(total / PAGE_SIZE);
  const tagsForCategory = category
    ? (vocab.data ?? []).filter((v) => v.category === category)
    : (vocab.data ?? []);

  const copyTitles = async () => {
    setCopying(true);
    try {
      const count = await copyAllBookTitles();
      toast(`Copied ${count} book titles to the clipboard.`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not copy book titles.', 'error');
    } finally {
      setCopying(false);
    }
  };

  return (
    <div>
      <h1>Books</h1>
      <div className="layout-row">
        <aside className="card" style={{ alignSelf: 'start' }}>
          <label>Search</label>
          <input
            style={{ width: '100%', marginBottom: 12 }}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="title or author"
          />
          <label>Category</label>
          <select
            style={{ width: '100%', marginBottom: 12 }}
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setTag('');
              setPage(0);
            }}
          >
            <option value="">any</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label>Tag</label>
          <select
            style={{ width: '100%', marginBottom: 12 }}
            value={tag}
            onChange={(e) => {
              setTag(e.target.value);
              setPage(0);
            }}
          >
            <option value="">any</option>
            {tagsForCategory.map((v) => (
              <option key={`${v.category}-${v.tag}`} value={v.tag}>
                {v.tag} ({v.count})
              </option>
            ))}
          </select>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={untagged}
              onChange={(e) => {
                setUntagged(e.target.checked);
                setPage(0);
              }}
            />
            Untagged only
          </label>
        </aside>

        <div>
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="muted">{total} books</span>
            <span className="spacer" />
            <button className="btn secondary v2-copy-titles" disabled={copying} onClick={() => void copyTitles()}>
              <Copy /> {copying ? 'Copying…' : 'Copy all titles'}
            </button>
            <button className="btn secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Prev
            </button>
            <span className="muted">
              {page + 1} / {Math.max(pages, 1)}
            </span>
            <button className="btn secondary" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
          <div className="book-grid">
            {(books.data?.books ?? []).map((b) => (
              <Link
                key={b.id}
                to={`${basePath}/${b.id}`}
                state={{ from: `${location.pathname}${location.search}` }}
                className="book-card"
              >
                {b.coverPath ? <div className="cover" /> : <div className="cover" />}
                <div className="title">{b.title}</div>
                <div className="author">{b.author ?? 'Unknown'} · {formatDuration(b.durationSeconds)}</div>
                <TagCloud tags={b.tags ?? []} />
              </Link>
            ))}
          </div>
          {books.data && books.data.books.length === 0 && (
            <p className="muted">No books match these filters.</p>
          )}
        </div>
      </div>
    </div>
  );
}
