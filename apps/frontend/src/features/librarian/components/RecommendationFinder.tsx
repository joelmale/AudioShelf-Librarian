import React from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ExternalLink, LoaderCircle, Plus, Sparkles, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { api, type Book, type RecommendationResult } from "../../curator/api.js";

/**
 * Scout & Acquire's recommendation panel — **acquire only**.
 *
 * This used to be a second front door onto the same question the Desk answers,
 * with its own form, its own scope toggle and its own result shape; a reader
 * had no way to know which surface would do better. Unification moved
 * "what should I listen to next" onto the Desk, and for a while this became a
 * form that simply handed its contents to `/desk` — which meant filling the
 * same fields twice with a page change in between, worse than either surface
 * alone.
 *
 * So the two surfaces now have genuinely different jobs:
 *
 *   Desk  — answers from books you ALREADY OWN.
 *   here  — suggests books you DO NOT own and could acquire.
 *
 * That split is not a UI preference, it is the architecture. Plan §5.4 rule 3
 * forbids the librarian chat loop from emitting external recommendations at
 * all: the loop has no verification path, so anything it said about a book
 * outside the library would be unverifiable prose. `POST /recommendations`
 * with `scope: 'discover'` is the path that CAN do it — every candidate is
 * checked against iTunes and fails closed when a hard constraint cannot be
 * proven from the verified metadata. This panel is the UI for exactly that.
 *
 * Your own shelf is still read, but as CONTEXT rather than as answers: the
 * retrieval step looks at what you own to understand the request, and the
 * suggestions are drawn from outside it.
 */

const MAX_SEEDS = 8;

const EXAMPLES = [
  "More like the mysteries I already enjoy",
  "A fantasy series I haven't started",
  "Something acclaimed I've somehow missed",
];

function duration(seconds: number | null): string {
  if (!seconds) return "Length unknown";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export function RecommendationFinder() {
  const [prompt, setPrompt] = React.useState("");
  const [seedSearch, setSeedSearch] = React.useState("");
  const [seeds, setSeeds] = React.useState<Book[]>([]);
  const [result, setResult] = React.useState<RecommendationResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [verdicts, setVerdicts] = React.useState<Record<string, "accepted" | "rejected">>({});

  const deferredSeedSearch = React.useDeferredValue(seedSearch.trim());
  const books = useQuery({
    queryKey: ["acquireBookPicker", deferredSeedSearch],
    queryFn: () => api.books({ limit: "8", search: deferredSeedSearch }),
    enabled: deferredSeedSearch.length >= 2,
  });

  const seedIds = new Set(seeds.map((book) => book.id));
  const suggestions = (books.data?.books ?? []).filter((book) => !seedIds.has(book.id)).slice(0, 6);

  // Feedback is fire-and-forget: an opinion that fails to record must never
  // break the suggestion the reader is looking at.
  const sendVerdict = React.useCallback(
    (externalKey: string, verdict: "accepted" | "rejected") => {
      setVerdicts((prior) => ({ ...prior, [externalKey]: verdict }));
      api.sendFeedback({ externalKey, queryText: prompt, verdict })
        .catch(() => setVerdicts((prior) => {
          const next = { ...prior };
          delete next[externalKey];
          return next;
        }));
    },
    [prompt]
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() && seeds.length === 0) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setVerdicts({});
    try {
      setResult(await api.recommendations({
        prompt: prompt.trim(),
        seedBookIds: seeds.map((book) => book.id),
        // Always 'discover': this panel exists to suggest what you do NOT own.
        // Owned-shelf answers are the Desk's job — see the module docblock.
        scope: "discover",
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The librarian could not complete that request.");
    } finally {
      setLoading(false);
    }
  };

  return <section className="v2-recommendations">
    <form className="v2-card v2-recommendation-composer" onSubmit={(event) => void submit(event)}>
      <div className="v2-recommendation-title">
        <span className="v2-kicker cyan"><Sparkles/> Worth acquiring</span>
        <h2>What should you add to the shelf?</h2>
        <p>Suggestions for books you don&apos;t own yet. Your shelf is read for context, never returned as the answer — for what you already have, ask the librarian on your desk.</p>
      </div>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="More like the mysteries I already enjoy, or a fantasy series I haven't started…" />
      <div className="v2-recommendation-examples">
        {EXAMPLES.map((example) => <button type="button" key={example} onClick={() => setPrompt(example)}>{example}</button>)}
      </div>
      <div className="v2-seed-picker">
        <label><span><BookOpen/> Inspired by</span><input value={seedSearch} disabled={seeds.length >= MAX_SEEDS} onChange={(event) => setSeedSearch(event.target.value)} placeholder={seeds.length >= MAX_SEEDS ? "Eight reference books selected" : "Search your shelf by title or author"} /></label>
        {seedSearch.trim() && seeds.length < MAX_SEEDS && <div className="v2-seed-suggestions">{seedSearch.trim().length < 2 ? <p>Type at least two characters.</p> : books.isFetching ? <p>Searching your shelf…</p> : <>{suggestions.map((book) => <button type="button" key={book.id} onClick={() => { setSeeds((current) => current.length >= MAX_SEEDS ? current : [...current, book]); setSeedSearch(""); }}><Plus/><span><strong>{book.title}</strong><small>{book.author || "Unknown author"}</small></span></button>)}{suggestions.length === 0 && <p>No matching shelf books.</p>}</>}</div>}
        {seeds.length > 0 && <div className="v2-seed-chips">{seeds.map((book) => <span key={book.id}><BookOpen/><b>{book.title}</b><button type="button" aria-label={`Remove ${book.title}`} onClick={() => setSeeds((current) => current.filter((entry) => entry.id !== book.id))}><X/></button></span>)}</div>}
      </div>
      <button className="v2-button v2-recommend-submit" disabled={loading || (!prompt.trim() && seeds.length === 0)}>
        {loading ? <LoaderCircle className="spin"/> : <Sparkles/>}{loading ? "Looking beyond your shelf…" : "Find something to acquire"}
      </button>
      {error && <p className="v2-recommendation-error" role="alert">{error}</p>}
    </form>

    {result && <div className="v2-recommendation-results">
      <section>
        <div className="v2-recommendation-section-head">
          <div><span className="v2-kicker"><ExternalLink/> Not on your shelf</span><h2>These could be worth acquiring.</h2></div>
          <strong>{result.available.length}</strong>
        </div>
        <p className="v2-muted">
          {/* Honest about what was actually done: the shelf informed the
              request, it did not supply the answers. */}
          Read {result.retrieval.candidateCount} of your own book{result.retrieval.candidateCount === 1 ? "" : "s"} for context.
          {" "}Every suggestion below was verified against a store listing before being shown.
        </p>
        <div className="v2-recommendation-grid">
          {result.available.map((book) => {
            const key = `${book.title}|${book.author}`;
            const verdict = verdicts[key];
            return <article key={key} className="v2-recommendation-card">
              <div className="v2-recommendation-cover">{book.coverUrl ? <img src={book.coverUrl} alt="" /> : <BookOpen/>}</div>
              <div>
                <h3>{book.title}</h3>
                <p>{book.author || "Unknown author"} · {duration(book.durationSeconds)}{book.genre ? ` · ${book.genre}` : ""}</p>
                <blockquote>{book.reason}</blockquote>
                {book.storeUrl && <a href={book.storeUrl} target="_blank" rel="noreferrer noopener">View listing <ExternalLink size={13}/></a>}
                <div className="v2-recommendation-feedback">
                  {verdict
                    ? <span className="v2-recommendation-verdict">{verdict === "accepted" ? "Noted — more like this" : "Noted — fewer like this"}</span>
                    : <>
                      <button type="button" aria-label={`More like ${book.title}`} onClick={() => sendVerdict(key, "accepted")}><ThumbsUp size={14}/> More like this</button>
                      <button type="button" aria-label={`Not interested in ${book.title}`} onClick={() => sendVerdict(key, "rejected")}><ThumbsDown size={14}/> Not for me</button>
                    </>}
                </div>
              </div>
            </article>;
          })}
          {result.available.length === 0 && (
            <p className="v2-recommendation-empty">
              Nothing new cleared verification for that request. Suggestions are dropped when a store listing cannot confirm them, so an empty result means &ldquo;not proven&rdquo; rather than &ldquo;nothing exists&rdquo;.
            </p>
          )}
        </div>
      </section>
    </div>}
  </section>;
}
