import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { api, formatDuration, useInvalidate, useMutation, type BookTag, type TagCategory } from '../api';
import { useToast } from '../toast';

const CATEGORIES: TagCategory[] = ['genre', 'mood', 'theme', 'era', 'pacing', 'length', 'audience'];

export function BookDetail() {
  const { id = '' } = useParams();
  const book = useQuery({ queryKey: ['book', id], queryFn: () => api.book(id) });
  const invalidate = useInvalidate();
  const toast = useToast();

  const retag = useMutation({
    mutationFn: () => api.retag([id]),
    onSuccess: () => {
      toast('Re-tag started — check the Tagging page', 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (book.isLoading) return <p className="muted">Loading…</p>;
  if (!book.data) return <p className="muted">Book not found.</p>;
  const b = book.data;

  const byCategory: Record<string, BookTag[]> = {};
  for (const t of b.tags ?? []) (byCategory[t.category] ??= []).push(t);

  return (
    <div>
      <Link to="/books" className="muted">
        ← Books
      </Link>
      <h1 style={{ marginTop: 8 }}>{b.title}</h1>
      <div className="card">
        <div className="row">
          <div>
            <div className="muted">Author</div>
            <div>{b.author ?? 'Unknown'}</div>
          </div>
          <div>
            <div className="muted">Series</div>
            <div>{b.series ? `${b.series}${b.seriesSequence ? ` #${b.seriesSequence}` : ''}` : '—'}</div>
          </div>
          <div>
            <div className="muted">Duration</div>
            <div>{formatDuration(b.durationSeconds)}</div>
          </div>
          <div>
            <div className="muted">Published</div>
            <div>{b.publishedYear ?? '—'}</div>
          </div>
          <span className="spacer" />
          <button className="btn" onClick={() => retag.mutate()} disabled={retag.isPending}>
            Re-tag
          </button>
        </div>
        {b.description && <p style={{ marginTop: 14 }}>{b.description}</p>}
      </div>

      <h2>Tags</h2>
      <div className="card">
        {CATEGORIES.filter((c) => byCategory[c]).map((c) => (
          <div key={c} style={{ marginBottom: 12 }}>
            <div className="muted" style={{ marginBottom: 4 }}>
              {c}
            </div>
            {byCategory[c]!.map((t) => (
              <div key={t.id} className="row" style={{ marginBottom: 2 }}>
                <span className={`pill ${t.category}`} style={{ minWidth: 120 }}>
                  {t.tag}
                </span>
                <span className="conf-bar">
                  <div style={{ width: `${Math.round(t.confidence * 100)}%` }} />
                </span>
                <span className="muted">{Math.round(t.confidence * 100)}%</span>
              </div>
            ))}
          </div>
        ))}
        {(b.tags ?? []).length === 0 && <span className="muted">No tags yet.</span>}
        <div style={{ marginTop: 12 }}>
          <button
            className="btn danger"
            onClick={async () => {
              await api.deleteBookTags(id);
              invalidate(['book']);
              toast('Tags cleared');
            }}
          >
            Clear tags
          </button>
        </div>
      </div>
    </div>
  );
}
