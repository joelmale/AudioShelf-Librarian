import { useMemo, useState } from 'react';

import {
  api,
  useInvalidate,
  useMutation,
  useProposedVocabBooks,
  useProposedVocabTerms,
  type ProposedVocabTerm,
  type TagCategory,
  type VocabTermOrigin,
} from '../api';
import { useToast } from '../toast';
import { TagPill } from './TagPill';

const CATEGORIES: TagCategory[] = [
  'genre', 'mood', 'theme', 'era', 'pacing', 'length', 'structure', 'character', 'setting', 'trope', 'audience',
];

function rowKey(term: string, category: TagCategory): string {
  return `${term}:${category}`;
}

function TermBooks({ term, category }: { term: string; category: TagCategory }) {
  const query = useProposedVocabBooks(term, category);
  if (query.isLoading) return <p className="muted">Loading all matching books…</p>;
  if (query.isError) return <p className="muted">Couldn’t load books: {(query.error as Error).message}</p>;
  const books = query.data?.books ?? [];
  return (
    <div style={{ display: 'grid', gap: 8, padding: '10px 0' }}>
      <strong>{books.length} matching book{books.length === 1 ? '' : 's'}</strong>
      {books.map((book) => (
        <details key={book.id} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 10px' }}>
          <summary style={{ cursor: 'pointer' }}>{book.title}{book.author ? ` — ${book.author}` : ''}</summary>
          <p className="muted" style={{ margin: '8px 0 0', lineHeight: 1.5 }}>
            {book.description ?? 'No effective description is available.'}
          </p>
          {book.descriptionSource && <small className="muted">Description source: {book.descriptionSource}</small>}
        </details>
      ))}
    </div>
  );
}

/** Review high-support proposals first; low-support terms remain deferred and untrusted. */
export function VocabularySuggestionsPanel() {
  const { data: terms, isLoading, isError, error, refetch } = useProposedVocabTerms();
  const invalidate = useInvalidate();
  const toast = useToast();
  const [aliasInputs, setAliasInputs] = useState<Record<string, string>>({});
  const [minimumBooks, setMinimumBooks] = useState(5);
  const [category, setCategory] = useState<'all' | TagCategory>('all');
  const [origin, setOrigin] = useState<'all' | VocabTermOrigin>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  const afterMutate = (message: string) => {
    invalidate(['proposedVocabTerms', 'vocabulary', 'books']);
    toast(message, 'success');
  };

  const promote = useMutation({
    mutationFn: ({ term, category: selectedCategory }: { term: string; category: TagCategory }) =>
      api.promoteVocabTerm(term, selectedCategory),
    onSuccess: (result) => afterMutate(`Promoted "${result.term}" (${result.retagged} tags updated)`),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const reject = useMutation({
    mutationFn: ({ term, category: selectedCategory }: { term: string; category: TagCategory }) =>
      api.rejectVocabTerm(term, selectedCategory),
    onSuccess: (result) => afterMutate(`Rejected "${result.term}"`),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const alias = useMutation({
    mutationFn: ({ term, category: selectedCategory, canonical }: { term: string; category: TagCategory; canonical: string }) =>
      api.aliasVocabTerm(term, canonical, selectedCategory),
    onSuccess: (result) => {
      afterMutate(`Aliased "${result.alias}" → "${result.canonical}" (${result.retagged} tags updated)`);
      setAliasInputs((previous) => {
        const next = { ...previous };
        delete next[rowKey(result.alias, result.category)];
        return next;
      });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const batch = useMutation({
    mutationFn: ({ action, selectedTerms }: { action: 'promote' | 'reject'; selectedTerms: ProposedVocabTerm[] }) =>
      api.reviewVocabBatch(action, selectedTerms.map(({ term, category: selectedCategory }) => ({ term, category: selectedCategory }))),
    onSuccess: (result) => {
      setSelected(new Set());
      afterMutate(`${result.action === 'promote' ? 'Promoted' : 'Rejected'} ${result.reviewed} terms${result.action === 'promote' ? `; ${result.affectedBooks} books re-embedded in one pass` : ''}`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (terms ?? []).filter((term) =>
      term.bookCount >= minimumBooks &&
      (category === 'all' || term.category === category) &&
      (origin === 'all' || term.origin === origin) &&
      (!needle || term.term.toLowerCase().includes(needle))
    );
  }, [terms, minimumBooks, category, origin, search]);

  if (isLoading) return <div className="muted" style={{ padding: '12px 0' }}>Loading proposed vocabulary…</div>;
  if (isError) return <div className="card" style={{ marginTop: 16 }}><p className="muted">Couldn’t load proposed vocabulary: {(error as Error)?.message ?? 'unknown error'}</p><button className="btn secondary" onClick={() => refetch()}>Retry</button></div>;

  const allTerms = terms ?? [];
  const selectedRows = allTerms.filter((term) => selected.has(rowKey(term.term, term.category)));
  const selectedHasCollision = selectedRows.some((term) => term.categoryCollision);
  const visibleKeys = rows.map((term) => rowKey(term.term, term.category));
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((key) => selected.has(key));
  const singletons = allTerms.filter((term) => term.bookCount === 1).length;
  const setAllVisible = (checked: boolean) => setSelected((previous) => {
    const next = new Set(previous);
    for (const key of visibleKeys) {
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
    }
    return next;
  });

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div><h2 style={{ margin: 0 }}>Vocabulary suggestions</h2><small className="muted">Low-support terms remain deferred and untrusted; nothing is rejected automatically.</small></div>
        <span className="muted" style={{ fontSize: 13 }}>{rows.length} shown of {allTerms.length} · {singletons} singletons deferred</span>
      </div>

      <div className="btn-row" style={{ alignItems: 'end', marginBottom: 12, flexWrap: 'wrap' }}>
        <label>Minimum books<input type="number" min={1} value={minimumBooks} onChange={(event) => setMinimumBooks(Math.max(1, Number(event.target.value) || 1))} style={{ width: 76, display: 'block' }} /></label>
        <label>Category<select value={category} onChange={(event) => setCategory(event.target.value as 'all' | TagCategory)} style={{ display: 'block' }}><option value="all">All</option>{CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Source<select value={origin} onChange={(event) => setOrigin(event.target.value as 'all' | VocabTermOrigin)} style={{ display: 'block' }}><option value="all">All</option><option value="tagger">LLM tagger</option><option value="enrichment">Provider cache</option></select></label>
        <label>Search<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a term…" style={{ display: 'block' }} /></label>
        <button className="btn" disabled={selectedRows.length === 0 || selectedHasCollision || batch.isPending} title={selectedHasCollision ? 'Cross-category collisions require individual review' : undefined} onClick={() => batch.mutate({ action: 'promote', selectedTerms: selectedRows })}>Promote selected ({selectedRows.length})</button>
        <button className="btn danger" disabled={selectedRows.length === 0 || batch.isPending} onClick={() => {
          if (window.confirm(`Reject ${selectedRows.length} selected proposals? Their book tags will remain untrusted and will not be purged.`)) batch.mutate({ action: 'reject', selectedTerms: selectedRows });
        }}>Reject selected ({selectedRows.length})</button>
      </div>
      {selectedHasCollision && <p className="muted">Bulk promotion is disabled because the selection contains a term used in multiple categories. Review that term individually.</p>}

      {rows.length === 0 ? <p className="muted">No proposals match these filters.</p> : (
        <div style={{ overflowX: 'auto' }}><table className="table">
          <thead><tr><th><input aria-label="Select all visible terms" type="checkbox" checked={allVisibleSelected} onChange={(event) => setAllVisible(event.target.checked)} /></th><th>Term</th><th>Category</th><th>Source</th><th>Books</th><th>Examples</th><th>Actions</th></tr></thead>
          <tbody>{rows.flatMap((term) => {
            const key = rowKey(term.term, term.category);
            const busy = batch.isPending || (promote.isPending && promote.variables?.term === term.term) || (reject.isPending && reject.variables?.term === term.term) || (alias.isPending && alias.variables?.term === term.term);
            const isExpanded = expanded === key;
            return [
              <tr key={key}>
                <td><input aria-label={`Select ${term.term}`} type="checkbox" checked={selected.has(key)} onChange={(event) => setSelected((previous) => {
                  const next = new Set(previous);
                  if (event.target.checked) {
                    next.add(key);
                  } else {
                    next.delete(key);
                  }
                  return next;
                })} /></td>
                <td>{term.term}{term.categoryCollision && <small className="muted" style={{ display: 'block' }}>multiple categories · individual promotion only</small>}</td>
                <td><TagPill tag={term.category} category={term.category} /></td>
                <td className="muted">{term.origin === 'enrichment' ? 'Provider cache' : 'LLM tagger'}</td>
                <td>{term.bookCount}</td>
                <td className="muted"><span>{term.sampleBooks.join(', ') || (term.origin === 'enrichment' ? 'No tagger samples' : '—')}</span><button className="btn secondary" style={{ marginLeft: 6 }} onClick={() => setExpanded(isExpanded ? null : key)}>{isExpanded ? 'Hide books' : 'View supporting books'}</button></td>
                <td><div className="btn-row">
                  <button className="btn" disabled={busy} onClick={() => promote.mutate({ term: term.term, category: term.category })}>Promote</button>
                  <button className="btn danger" disabled={busy} onClick={() => reject.mutate({ term: term.term, category: term.category })}>Reject</button>
                  <input placeholder="Alias to…" value={aliasInputs[key] ?? ''} onChange={(event) => setAliasInputs((previous) => ({ ...previous, [key]: event.target.value }))} style={{ width: 120 }} disabled={busy} />
                  <button className="btn secondary" disabled={busy || !(aliasInputs[key] ?? '').trim()} onClick={() => alias.mutate({ term: term.term, category: term.category, canonical: (aliasInputs[key] ?? '').trim() })}>Alias</button>
                  {term.aliasSuggestions.map((suggestion) => <button key={suggestion} className="btn secondary" disabled={busy} title="Suggested spelling, plural, or hyphen variant" onClick={() => setAliasInputs((previous) => ({ ...previous, [key]: suggestion }))}>Suggest: {suggestion}</button>)}
                </div></td>
              </tr>,
              isExpanded ? <tr key={`${key}:books`}><td colSpan={7}><TermBooks term={term.term} category={term.category} /></td></tr> : null,
            ];
          })}</tbody>
        </table></div>
      )}
    </div>
  );
}
