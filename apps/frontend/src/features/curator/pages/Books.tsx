import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { api, formatDuration, useVocabulary, type TagCategory } from '../api';
import { TagCloud } from '../components/TagPill';

const CATEGORIES: TagCategory[] = ['genre', 'mood', 'theme', 'era', 'pacing', 'length', 'audience'];
const PAGE_SIZE = 24;

export function Books({ basePath = '/curator/books' }: { basePath?: string }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [untagged, setUntagged] = useState(false);
  const [page, setPage] = useState(0);

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
              <Link key={b.id} to={`${basePath}/${b.id}`} className="book-card">
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
