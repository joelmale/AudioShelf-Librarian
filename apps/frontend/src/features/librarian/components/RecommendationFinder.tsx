import React from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Check, Compass, LoaderCircle, Plus, Search, Sparkles, X } from "lucide-react";
import { Link } from "react-router-dom";
import { api, type Book, type RecommendationResult, type RecommendationScope } from "../../curator/api.js";

function duration(seconds: number | null): string {
  if (!seconds) return "Length unknown";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export function RecommendationFinder() {
  const [prompt, setPrompt] = React.useState("");
  const [scope, setScope] = React.useState<RecommendationScope>("discover");
  const [seedSearch, setSeedSearch] = React.useState("");
  const [seeds, setSeeds] = React.useState<Book[]>([]);
  const [result, setResult] = React.useState<RecommendationResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const deferredSeedSearch = React.useDeferredValue(seedSearch.trim());
  const books = useQuery({
    queryKey: ["recommendationBookPicker", deferredSeedSearch],
    queryFn: () => api.books({ limit: "8", search: deferredSeedSearch }),
    enabled: deferredSeedSearch.length >= 2,
  });

  React.useEffect(() => {
    fetch("/api/system/settings")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((body) => setScope(body.data?.recommendationScope ?? "discover"))
      .catch(() => undefined);
  }, []);

  const seedIds = new Set(seeds.map((book) => book.id));
  const suggestions = (books.data?.books ?? [])
    .filter((book) => !seedIds.has(book.id))
    .slice(0, 6);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() && seeds.length === 0) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.recommendations({ prompt: prompt.trim(), seedBookIds: seeds.map((book) => book.id), scope }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  };

  return <section className="v2-recommendations">
    <form className="v2-card v2-recommendation-composer" onSubmit={submit}>
      <div className="v2-recommendation-title"><span className="v2-kicker cyan"><Sparkles/> Recommendation librarian</span><h2>What are you in the mood for?</h2><p>Describe the moment, select books you enjoyed, or combine both.</p></div>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="Something light and funny, or a fantasy story for a six-hour car ride…" />
      <div className="v2-recommendation-examples">
        {["Something light and funny", "Fantasy for a 6-hour car ride", "A clever mystery without graphic violence"].map((example) => <button type="button" key={example} onClick={() => setPrompt(example)}>{example}</button>)}
      </div>
      <div className="v2-seed-picker">
        <label><span><BookOpen/> Inspired by</span><input value={seedSearch} disabled={seeds.length >= 8} onChange={(event) => setSeedSearch(event.target.value)} placeholder={seeds.length >= 8 ? "Eight reference books selected" : "Search your shelf by title or author"} /></label>
        {seedSearch.trim() && seeds.length < 8 && <div className="v2-seed-suggestions">{seedSearch.trim().length < 2 ? <p>Type at least two characters.</p> : books.isFetching ? <p>Searching your shelf…</p> : <>{suggestions.map((book) => <button type="button" key={book.id} onClick={() => { setSeeds((current) => current.length >= 8 ? current : [...current, book]); setSeedSearch(""); }}><Plus/><span><strong>{book.title}</strong><small>{book.author || "Unknown author"}</small></span></button>)}{suggestions.length === 0 && <p>No matching shelf books.</p>}</>}</div>}
        {seeds.length > 0 && <div className="v2-seed-chips">{seeds.map((book) => <span key={book.id}><BookOpen/><b>{book.title}</b><button type="button" aria-label={`Remove ${book.title}`} onClick={() => setSeeds((current) => current.filter((entry) => entry.id !== book.id))}><X/></button></span>)}</div>}
      </div>
      <div className="v2-recommendation-scope" aria-label="Recommendation scope">
        {([['both', 'Both'], ['shelf', 'On my shelf'], ['discover', 'Discover new']] as const).map(([value, label]) => <button type="button" aria-pressed={scope === value} className={scope === value ? "active" : ""} key={value} onClick={() => setScope(value)}>{value === 'shelf' ? <BookOpen/> : value === 'discover' ? <Compass/> : <Sparkles/>}{label}</button>)}
      </div>
      <button className="v2-button v2-recommend-submit" disabled={loading || (!prompt.trim() && seeds.length === 0)}>{loading ? <LoaderCircle className="spin"/> : <Sparkles/>}{loading ? "Thinking like a librarian…" : "Recommend books"}</button>
      {error && <p className="v2-recommendation-error" role="alert">{error}</p>}
    </form>

    {result && <div className="v2-recommendation-results">
      <div className="v2-recommendation-understood"><Check/><div><strong>What I understood</strong><p>{result.interpretation}</p><span>{[...result.constraints.genres, ...result.constraints.moods, result.constraints.maxDurationHours ? `Up to ${result.constraints.maxDurationHours} hours` : ""].filter(Boolean).map((item) => <b key={item}>{item}</b>)}</span></div></div>

      {result.scope !== "discover" && <section>
        <div className="v2-recommendation-section-head"><div><span className="v2-kicker success"><BookOpen/> On your shelf now</span><h2>This is what is on the shelf now.</h2></div><strong>{result.onShelf.length}</strong></div>
        <div className="v2-recommendation-grid">{result.onShelf.map((book) => <article key={book.id} className="v2-recommendation-card"><div className="v2-recommendation-cover"><BookOpen/></div><div><h3>{book.title}</h3><p>{book.author || "Unknown author"} · {duration(book.durationSeconds)}</p><blockquote>{book.reason}</blockquote><div className="v2-recommendation-tags">{book.tags.slice(0, 4).map((tag) => <span key={tag.id}>{tag.tag}</span>)}</div><Link to={`/curate/books/${book.id}`}>View on shelf</Link></div></article>)}{result.onShelf.length === 0 && <p className="v2-recommendation-empty">Nothing currently on your shelf fits tightly enough.</p>}</div>
      </section>}

      {result.scope !== "shelf" && <section>
        <div className="v2-recommendation-section-head"><div><span className="v2-kicker cyan"><Compass/> Available to acquire</span><h2>This could be available to pull in.</h2></div><strong>{result.available.length}</strong></div>
        <div className="v2-recommendation-grid">{result.available.map((book) => <article key={`${book.title}-${book.author}`} className="v2-recommendation-card">{book.coverUrl ? <img className="v2-recommendation-cover" src={book.coverUrl} alt=""/> : <div className="v2-recommendation-cover"><Compass/></div>}<div><h3>{book.title}</h3><p>{book.author} · {duration(book.durationSeconds)}</p><blockquote>{book.reason}</blockquote><div className="v2-recommendation-tags">{book.genre && <span>{book.genre}</span>}<span>iTunes verified</span></div><Link to={`/scout/search?q=${encodeURIComponent(`${book.title} ${book.author}`)}`}><Search/> Find a download</Link></div></article>)}{result.available.length === 0 && <p className="v2-recommendation-empty">No external candidates could be verified against your request.</p>}</div>
      </section>}
    </div>}
  </section>;
}
