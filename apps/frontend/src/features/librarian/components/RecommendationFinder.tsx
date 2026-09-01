import React from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Compass, Plus, Sparkles, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, type Book } from "../../curator/api.js";

/**
 * Scout's entry into the one "ask the librarian" surface
 * (surface-unification plan §2.2 step 3).
 *
 * This used to be a second recommendation front door: its own form, its own
 * backend (`POST /recommendations`), its own result shape, its own scope
 * toggle — answering the same question as the Desk with no way for a reader to
 * know which would do better. It is now a compact opener that hands the prompt
 * and the picked reference books to the Desk, so one question reaches one
 * engine.
 *
 * `POST /recommendations` is deliberately NOT removed. It still owns
 * impression logging and the verified external (acquire) half, which the
 * unified surface calls directly; retiring it is a separate decision with its
 * own evidence (plan §2.2 step 4).
 *
 * The scope toggle is gone (§3): the shelf is always searched, shown first,
 * and "could be acquired" is a section below the answer rather than a choice
 * made before any result exists.
 */

const MAX_SEEDS = 8;

const EXAMPLES = [
  "Something light and funny",
  "Fantasy for a 6-hour car ride",
  "A clever mystery without graphic violence",
];

export function RecommendationFinder() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = React.useState("");
  const [seedSearch, setSeedSearch] = React.useState("");
  const [seeds, setSeeds] = React.useState<Book[]>([]);
  const deferredSeedSearch = React.useDeferredValue(seedSearch.trim());
  const books = useQuery({
    queryKey: ["recommendationBookPicker", deferredSeedSearch],
    queryFn: () => api.books({ limit: "8", search: deferredSeedSearch }),
    enabled: deferredSeedSearch.length >= 2,
  });

  const seedIds = new Set(seeds.map((book) => book.id));
  const suggestions = (books.data?.books ?? []).filter((book) => !seedIds.has(book.id)).slice(0, 6);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() && seeds.length === 0) return;
    const params = new URLSearchParams();
    if (prompt.trim()) params.set("q", prompt.trim());
    if (seeds.length > 0) params.set("seeds", seeds.map((book) => book.id).join(","));
    // Prefill, never auto-run: arriving on the Desk must not spend a model
    // call the reader has not pressed a button for.
    navigate(`/desk?${params.toString()}`);
  };

  return <section className="v2-recommendations">
    <form className="v2-card v2-recommendation-composer" onSubmit={submit}>
      <div className="v2-recommendation-title"><span className="v2-kicker cyan"><Sparkles/> Recommendation librarian</span><h2>What are you in the mood for?</h2><p>Describe the moment, select books you enjoyed, or combine both. Your shelf is always searched first; anything worth acquiring appears below the answer.</p></div>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="Something light and funny, or a fantasy story for a six-hour car ride…" />
      <div className="v2-recommendation-examples">
        {EXAMPLES.map((example) => <button type="button" key={example} onClick={() => setPrompt(example)}>{example}</button>)}
      </div>
      <div className="v2-seed-picker">
        <label><span><BookOpen/> Inspired by</span><input value={seedSearch} disabled={seeds.length >= MAX_SEEDS} onChange={(event) => setSeedSearch(event.target.value)} placeholder={seeds.length >= MAX_SEEDS ? "Eight reference books selected" : "Search your shelf by title or author"} /></label>
        {seedSearch.trim() && seeds.length < MAX_SEEDS && <div className="v2-seed-suggestions">{seedSearch.trim().length < 2 ? <p>Type at least two characters.</p> : books.isFetching ? <p>Searching your shelf…</p> : <>{suggestions.map((book) => <button type="button" key={book.id} onClick={() => { setSeeds((current) => current.length >= MAX_SEEDS ? current : [...current, book]); setSeedSearch(""); }}><Plus/><span><strong>{book.title}</strong><small>{book.author || "Unknown author"}</small></span></button>)}{suggestions.length === 0 && <p>No matching shelf books.</p>}</>}</div>}
        {seeds.length > 0 && <div className="v2-seed-chips">{seeds.map((book) => <span key={book.id}><BookOpen/><b>{book.title}</b><button type="button" aria-label={`Remove ${book.title}`} onClick={() => setSeeds((current) => current.filter((entry) => entry.id !== book.id))}><X/></button></span>)}</div>}
      </div>
      <button className="v2-button v2-recommend-submit" disabled={!prompt.trim() && seeds.length === 0}><Sparkles/> Ask the librarian</button>
      <p className="v2-muted"><Compass size={13}/> Opens the librarian on your desk, where the conversation is saved and you can follow up.</p>
    </form>
  </section>;
}
