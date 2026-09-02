import { useState } from 'react';

import { api, useInvalidate, useMutation, useProposedVocabTerms, type TagCategory } from '../api';
import { useToast } from '../toast';
import { TagPill } from './TagPill';

/** Row-local state for the inline "alias to…" input, keyed by `term:category`. */
function rowKey(term: string, category: TagCategory): string {
  return `${term}:${category}`;
}

/**
 * The vocabulary promotion queue (librarian engine plan §3 "Promotion loop",
 * §8.7): llm-open tags the tagger proposed that have accumulated enough
 * book_count to be worth a human look. Promote folds a term into the
 * canonical vocabulary; reject drops it; aliasing folds it into an existing
 * term instead (e.g. "spooky" -> "tense").
 */
export function VocabularySuggestionsPanel() {
  const { data: terms, isLoading, isError, error, refetch } = useProposedVocabTerms();
  const invalidate = useInvalidate();
  const toast = useToast();
  const [aliasInputs, setAliasInputs] = useState<Record<string, string>>({});

  const afterMutate = (message: string) => {
    invalidate(['proposedVocabTerms', 'vocabulary', 'books']);
    toast(message, 'success');
  };

  const promote = useMutation({
    mutationFn: ({ term, category }: { term: string; category: TagCategory }) =>
      api.promoteVocabTerm(term, category),
    onSuccess: (result) => afterMutate(`Promoted "${result.term}" (${result.retagged} tag${result.retagged === 1 ? '' : 's'} updated)`),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const reject = useMutation({
    mutationFn: ({ term, category }: { term: string; category: TagCategory }) =>
      api.rejectVocabTerm(term, category),
    onSuccess: (result) => afterMutate(`Rejected "${result.term}"`),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const alias = useMutation({
    mutationFn: ({ term, category, canonical }: { term: string; category: TagCategory; canonical: string }) =>
      api.aliasVocabTerm(term, canonical, category),
    onSuccess: (result) => {
      afterMutate(`Aliased "${result.alias}" -> "${result.canonical}" (${result.retagged} tag${result.retagged === 1 ? '' : 's'} updated)`);
      setAliasInputs((prev) => {
        const next = { ...prev };
        delete next[rowKey(result.alias, result.category)];
        return next;
      });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (isLoading) {
    return <div className="muted" style={{ padding: '12px 0' }}>Loading proposed vocabulary…</div>;
  }

  if (isError) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <p className="muted">Couldn't load proposed vocabulary: {(error as Error)?.message ?? 'unknown error'}</p>
        <button className="btn secondary" onClick={() => refetch()}>Retry</button>
      </div>
    );
  }

  const rows = terms ?? [];

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Vocabulary suggestions</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          {rows.length} term{rows.length === 1 ? '' : 's'} awaiting review
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="muted">
          No proposed terms right now — new llm-open tags show up here once they've been used on a few books, and
          cached provider subjects (genres, moods, themes) show up here once a few books' cached lookups agree on one.
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Term</th>
              <th>Category</th>
              <th>Source</th>
              <th>Books</th>
              <th>Sample titles</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const key = rowKey(t.term, t.category);
              const busy =
                (promote.isPending && promote.variables?.term === t.term && promote.variables?.category === t.category) ||
                (reject.isPending && reject.variables?.term === t.term && reject.variables?.category === t.category) ||
                (alias.isPending && alias.variables?.term === t.term && alias.variables?.category === t.category);
              // R1 (`origin: 'enrichment'`) writes no `book_tags` rows, so
              // `sampleBooks` is always `[]` for these — an empty cell here
              // is the correct, expected state, not a broken sample-titles
              // lookup. Say so explicitly rather than leaving a bare '—'
              // that reads identically to the tagger-side failure case.
              const isEnrichment = t.origin === 'enrichment';

              return (
                <tr key={key}>
                  <td>{t.term}</td>
                  <td><TagPill tag={t.category} category={t.category} /></td>
                  <td className="muted" style={{ fontSize: 12 }} title={
                    isEnrichment
                      ? 'Proposed from cached provider subjects (Open Library, Google Books, Audnexus, Wikidata, Hardcover)'
                      : 'Proposed from LLM-tagged books (llm-open)'
                  }>
                    {isEnrichment ? 'Provider cache' : 'LLM tagger'}
                  </td>
                  <td>{t.bookCount}</td>
                  <td className="muted" style={{ fontSize: 12 }} title={t.sampleBooks.join(', ')}>
                    {isEnrichment ? 'no per-book sample (provider data)' : t.sampleBooks.join(', ') || '—'}
                  </td>
                  <td>
                    <div className="btn-row">
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => promote.mutate({ term: t.term, category: t.category })}
                      >
                        Promote
                      </button>
                      <button
                        className="btn danger"
                        disabled={busy}
                        onClick={() => reject.mutate({ term: t.term, category: t.category })}
                      >
                        Reject
                      </button>
                      <input
                        placeholder="Alias to…"
                        value={aliasInputs[key] ?? ''}
                        onChange={(e) => setAliasInputs((prev) => ({ ...prev, [key]: e.target.value }))}
                        style={{ width: 120 }}
                        disabled={busy}
                      />
                      <button
                        className="btn secondary"
                        disabled={busy || !(aliasInputs[key] ?? '').trim()}
                        onClick={() =>
                          alias.mutate({ term: t.term, category: t.category, canonical: (aliasInputs[key] ?? '').trim() })
                        }
                      >
                        Alias
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
