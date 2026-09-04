import { BookOpen, Bot, ChevronDown, CircleAlert, Compass, Info, Library, LoaderCircle, Plus, RotateCcw, Search, Send, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Book } from '../api.js';
import { beginLibrarianChat, EMPTY_LIBRARIAN_CHAT, getLibrarianConversation, hydratePersistedTurn, listLibrarianConversations, mergeLibrarianConversationPages, reduceLibrarianChat, streamLibrarianChat, type LibrarianAction, type LibrarianChatState, type LibrarianConversationSummary, type LibrarianRecommendation, type LibrarianRetrieval, type MergedLibrarianConversationDetail } from '../librarianChat.js';

/**
 * The one "ask the librarian" surface (surface-unification plan §2.1).
 *
 * Both `/desk` and Scout's recommendations tab land here, so the same question
 * always reaches the same engine. Scout's distinctive inputs survive as
 * structured openers on this surface — the seed picker below the composer, and
 * the `?q=`/`?seeds=` deep link Scout hands over — rather than as a second
 * front door with its own backend and its own failure modes.
 *
 * The scope toggle is deliberately gone (§3). Owned books are always retrieved
 * and always rendered first; "could be acquired" is a separate section below
 * them, fetched from the existing verified `POST /recommendations` path only
 * when the shelf answer is thin or the reader asks for it. The chat loop
 * itself still emits no external recommendation — §5.4 rule 3 — and nothing
 * here changes that: the acquire half is a different call to a different,
 * iTunes-verified path, never prose from the loop.
 */

const ACTION_LABELS: Record<string, string> = {
  search_library: 'Searched the catalog', search_semantic: 'Browsed by mood and meaning', get_book: 'Opened a book card', find_similar: 'Compared nearby books', tag_coverage: 'Checked metadata coverage',
};
function actionLabel(action: LibrarianAction): string { return ACTION_LABELS[action.tool] ?? action.label.replaceAll('_', ' '); }

/** Same rendering as the Scout card so the two surfaces agree on what an
 *  unknown duration looks like: a word, never `0h 0m`. */
function duration(seconds: number | null | undefined): string {
  if (!seconds) return 'Length unknown';
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

const MAX_SEEDS = 8;

interface ExternalCandidate {
  title: string;
  author: string;
  reason: string;
  durationSeconds: number | null;
  genre: string | null;
  coverUrl: string | null;
}

interface AcquireState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  items: ExternalCandidate[];
  error: string | null;
}

const EMPTY_ACQUIRE: AcquireState = { status: 'idle', items: [], error: null };

/**
 * The retrieval disclosure (§2.2 step 2), built only from `retrieval` events —
 * every number here was measured by the tool that ran, never inferred from the
 * answer. Candidate counts are reported per call rather than summed: two
 * searches over the same library are not twice the library.
 */
function RetrievalAudit({ retrievals }: { retrievals: LibrarianRetrieval[] }) {
  if (retrievals.length === 0) return null;
  const considered = retrievals.reduce((total, entry) => total + entry.evidenceCount, 0);
  const notes = retrievals.flatMap((entry) => entry.tagResolution ?? []);
  const personalized = retrievals.some((entry) => entry.personalized);
  return (
    <details className="v2-recommendation-audit">
      <summary>
        <Info size={14}/>
        {' '}{retrievals.length} retrieval{retrievals.length === 1 ? '' : 's'} · {considered} book{considered === 1 ? '' : 's'} considered
        {personalized ? ' · tuned to your taste' : ''}
        {notes.length > 0 ? ' · query adjusted' : ''}
      </summary>
      <ul>
        {retrievals.map((entry, index) => (
          <li key={`${entry.tool}-${index}`}>
            <b>{ACTION_LABELS[entry.tool] ?? entry.tool}</b>: searched {entry.candidateCount} book{entry.candidateCount === 1 ? '' : 's'}, considered {entry.evidenceCount}, {entry.semanticScored} ranked on meaning.
          </li>
        ))}
        {notes.map((note, index) => (
          <li key={`${note.field}-${note.from}-${index}`}>
            Read <b>{note.from}</b> as <b>{note.to.join(', ')}</b> — {note.reason.toLowerCase()}.
          </li>
        ))}
        {!personalized && <li>Ranking is not personalized yet — not enough listening or feedback signal.</li>}
        {notes.length === 0 && <li>Your wording was used as written; nothing was rewritten.</li>}
      </ul>
    </details>
  );
}

function Trace({ state, turnId }: { state: LibrarianChatState; turnId: string }) {
  const [expanded, setExpanded] = useState(false);
  const count = state.actions.length;
  return <div className="v2-librarian-trace"><button type="button" className="v2-librarian-trace-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><span className="v2-eyebrow">Research trail</span><span>{count} action{count === 1 ? '' : 's'}</span><ChevronDown className={expanded ? 'expanded' : ''} /></button>{expanded && <div className="v2-librarian-actions">{count === 0 && state.phase === 'running' && <p><LoaderCircle className="spin" /> Reading your request…</p>}{state.actions.map((action, index) => <div key={`${turnId}-${action.tool}-${index}`}><Search /><span><strong>{actionLabel(action)}</strong><small>{action.detail} · {action.resultSummary}</small></span></div>)}</div>}</div>;
}

function Disclosures({ state }: { state: LibrarianChatState }) {
  if (state.audits.length === 0 && state.candidateBookIds.length === 0) return null;
  return <div className="v2-librarian-disclosures">{state.audits.map((audit, index) => <p className="v2-librarian-audit" key={`${audit.note}-${index}`}><CircleAlert /> {audit.note}</p>)}{state.candidateBookIds.length > 0 && <section className="v2-librarian-pile" aria-label="Candidates found"><span className="v2-eyebrow">Candidates found</span><div>{state.candidateBookIds.map((id) => <span className="v2-librarian-candidate" key={id}><Library /><span>Library book</span><small>{id}</small></span>)}</div></section>}</div>;
}

/**
 * One owned-shelf card. Same anatomy as the Scout card it replaces: title,
 * author and length, the librarian's reason verbatim, the tags the ranker
 * actually scored, a link onto the shelf, and the thumbs that feed the taste
 * profile.
 *
 * `matchedTags` is rendered only when retrieval reported one. Absent means no
 * ranker spoke for this book — not that it matched nothing — so the row is
 * omitted rather than shown empty.
 */
function ShelfCard({ recommendation, verdict, onVerdict }: {
  recommendation: LibrarianRecommendation;
  verdict: 'accepted' | 'rejected' | undefined;
  onVerdict: (bookId: string, verdict: 'accepted' | 'rejected') => void;
}) {
  const title = recommendation.title ?? recommendation.bookId;
  return (
    <article className="v2-recommendation-card">
      <div className="v2-recommendation-cover"><BookOpen/></div>
      <div>
        <h3>{title}</h3>
        <p>{recommendation.author || 'Unknown author'} · {duration(recommendation.durationSeconds)}</p>
        <blockquote>
          {recommendation.reason}
          {recommendation.reasonReplaced && (
            <small className="v2-recommendation-reason-note"> Written from the matching tags — the model&apos;s own note described a different book.</small>
          )}
        </blockquote>
        {recommendation.matchedTags && recommendation.matchedTags.length > 0 && (
          <div className="v2-recommendation-tags">{recommendation.matchedTags.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}</div>
        )}
        <Link to={`/curate/books/${recommendation.bookId}`}>View on shelf</Link>
        <div className="v2-recommendation-feedback">
          {verdict
            ? <span className="v2-recommendation-verdict">{verdict === 'accepted' ? 'Noted — more like this' : 'Noted — fewer like this'}</span>
            : <>
              <button type="button" aria-label={`More like ${title}`} onClick={() => onVerdict(recommendation.bookId, 'accepted')}><ThumbsUp size={14}/> More like this</button>
              <button type="button" aria-label={`Fewer like ${title}`} onClick={() => onVerdict(recommendation.bookId, 'rejected')}><ThumbsDown size={14}/> Not for me</button>
            </>}
        </div>
      </div>
    </article>
  );
}

interface AssistantProps {
  state: LibrarianChatState;
  turnId: string;
  verdicts: Record<string, 'accepted' | 'rejected'>;
  onVerdict: (turnId: string, bookId: string, queryText: string, verdict: 'accepted' | 'rejected') => void;
  onRetry: ((question: string) => void) | null;
}

function Assistant({ state, turnId, verdicts, onVerdict, onRetry }: AssistantProps) {
  const failed = state.phase === 'exhausted' || state.phase === 'failed';
  return <div className={`v2-librarian-bubble assistant ${state.phase}`}>
    {state.phase === 'running' && <><LoaderCircle className="spin" /><span>Following the evidence through your shelf…</span></>}
    {failed && <><CircleAlert /><span>{state.error}</span></>}
    {/* A failed turn keeps its research trail and candidate pile above this
        bubble, so the reader can see what had been retrieved before it broke
        rather than a bare apology (§6). */}
    {failed && onRetry && state.question.trim().length > 0 && (
      <button type="button" className="v2-button-secondary v2-librarian-retry" onClick={() => onRetry(state.question)}><RotateCcw size={14}/> Ask again</button>
    )}
    {state.tokens.length > 0 && <div className="v2-librarian-prose">{state.tokens.join('')}</div>}
    {state.phase === 'answered' && state.recommendations.length === 0 && <span>I couldn&apos;t find a shelf match I could support from the available evidence.</span>}
    {state.phase === 'answered' && state.recommendations.length > 0 && (
      <section aria-label="On your shelf">
        <div className="v2-recommendation-section-head"><div><span className="v2-kicker success"><BookOpen/> On your shelf now</span></div><strong>{state.recommendations.length}</strong></div>
        <div className="v2-recommendation-grid">
          {state.recommendations.map((recommendation) => (
            <ShelfCard
              key={recommendation.bookId}
              recommendation={recommendation}
              verdict={verdicts[`${turnId}:${recommendation.bookId}`]}
              onVerdict={(bookId, verdict) => onVerdict(turnId, bookId, state.question, verdict)}
            />
          ))}
        </div>
      </section>
    )}
  </div>;
}

/**
 * The acquire half (§2.3 option (a), §3.2), kept alive through the existing
 * verified path rather than through the chat loop.
 *
 * Rendered only for the live turn: re-running an external lookup for a
 * conversation the reader is scrolling back through would spend an LLM call
 * and an iTunes round trip on a question they already have an answer to.
 */
function AcquireSection({ acquire, onLoad }: { acquire: AcquireState; onLoad: () => void }) {
  return (
    <section className="v2-librarian-acquire" aria-label="Could be acquired">
      <div className="v2-recommendation-section-head">
        <div><span className="v2-kicker cyan"><Compass/> Could be acquired</span></div>
        {acquire.status === 'loaded' && <strong>{acquire.items.length}</strong>}
      </div>
      {acquire.status === 'idle' && <button type="button" className="v2-button-secondary" onClick={onLoad}><Compass size={14}/> Look outside my library</button>}
      {acquire.status === 'loading' && <p role="status"><LoaderCircle className="spin"/> Checking what could be pulled in…</p>}
      {acquire.status === 'error' && <p role="alert">{acquire.error} <button type="button" onClick={onLoad}>Retry</button></p>}
      {acquire.status === 'loaded' && <div className="v2-recommendation-grid">
        {acquire.items.map((book) => <article key={`${book.title}-${book.author}`} className="v2-recommendation-card">
          {book.coverUrl ? <img className="v2-recommendation-cover" src={book.coverUrl} alt=""/> : <div className="v2-recommendation-cover"><Compass/></div>}
          <div>
            <h3>{book.title}</h3>
            <p>{book.author} · {duration(book.durationSeconds)}</p>
            <blockquote>{book.reason}</blockquote>
            <div className="v2-recommendation-tags">{book.genre && <span>{book.genre}</span>}<span>iTunes verified</span></div>
            <Link to={`/scout/search?q=${encodeURIComponent(`${book.title} ${book.author}`)}`}><Search/> Find a download</Link>
          </div>
        </article>)}
        {acquire.items.length === 0 && <p className="v2-recommendation-empty">No external candidates could be verified against your request.</p>}
      </div>}
    </section>
  );
}

interface WorkProps extends Omit<AssistantProps, 'state'> {
  state: LibrarianChatState;
  acquire?: { state: AcquireState; onLoad: () => void };
}

function Work({ state, turnId, verdicts, onVerdict, onRetry, acquire }: WorkProps) {
  return <div className="v2-librarian-work">
    <Trace state={state} turnId={turnId} />
    <div>
      <RetrievalAudit retrievals={state.retrievals} />
      <Disclosures state={state} />
      <Assistant state={state} turnId={turnId} verdicts={verdicts} onVerdict={onVerdict} onRetry={onRetry} />
      {acquire && state.phase === 'answered' && <AcquireSection acquire={acquire.state} onLoad={acquire.onLoad} />}
    </div>
  </div>;
}

function TurnView({ turn, verdicts, onVerdict, onRetry }: {
  turn: MergedLibrarianConversationDetail['turns'][number];
  verdicts: AssistantProps['verdicts'];
  onVerdict: AssistantProps['onVerdict'];
  onRetry: AssistantProps['onRetry'];
}) {
  const state = hydratePersistedTurn(turn);
  return <div className="v2-librarian-history-turn">{turn.question !== null && <div className="v2-librarian-bubble user">{turn.question}</div>}<Work state={state} turnId={turn.id} verdicts={verdicts} onVerdict={onVerdict} onRetry={onRetry} /></div>;
}

/** The acquire response is read defensively for the same reason every other
 *  librarian payload is: a route that quietly returns something else must
 *  surface as an error, not as an empty section that looks like an answer. */
function externalCandidates(value: unknown): ExternalCandidate[] {
  const available = (value as { available?: unknown } | null)?.available;
  if (!Array.isArray(available)) throw new Error('The acquire lookup returned an unreadable response.');
  return available.filter((item): item is ExternalCandidate => Boolean(item) && typeof item === 'object' && typeof (item as ExternalCandidate).title === 'string');
}

export function LibrarianChatPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [draft, setDraft] = useState(''); const [state, setState] = useState<LibrarianChatState>(EMPTY_LIBRARIAN_CHAT);
  const [seeds, setSeeds] = useState<Book[]>([]); const [seedSearch, setSeedSearch] = useState(''); const [seedResults, setSeedResults] = useState<Book[]>([]); const [seedBusy, setSeedBusy] = useState(false); const [seedNotice, setSeedNotice] = useState<string | null>(null);
  const [liveSeedIds, setLiveSeedIds] = useState<string[]>([]);
  const [acquire, setAcquire] = useState<AcquireState>(EMPTY_ACQUIRE);
  const [verdicts, setVerdicts] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const [conversations, setConversations] = useState<LibrarianConversationSummary[]>([]); const [listCursor, setListCursor] = useState<string | null>(null); const [listBusy, setListBusy] = useState(true); const [listError, setListError] = useState<string | null>(null); const [listRetry, setListRetry] = useState<{ cursor?: string; replace: boolean } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null); const [liveTurnId, setLiveTurnId] = useState<string | null>(null); const [detail, setDetail] = useState<MergedLibrarianConversationDetail | null>(null); const [detailCursor, setDetailCursor] = useState<string | null>(null); const [detailBusy, setDetailBusy] = useState(false); const [detailError, setDetailError] = useState<string | null>(null); const [detailRetry, setDetailRetry] = useState<{ cursor?: string } | null>(null); const [historyRefreshError, setHistoryRefreshError] = useState<string | null>(null);
  const streamController = useRef<AbortController | null>(null); const requestController = useRef<AbortController | null>(null); const generation = useRef(0); const listGeneration = useRef(0); const acquireGeneration = useRef(0);

  const loadList = async (cursor?: string, replace = false): Promise<boolean> => { const request = ++listGeneration.current; setListBusy(true); setListError(null); setListRetry(null); const controller = new AbortController(); requestController.current?.abort(); requestController.current = controller; try { const page = await listLibrarianConversations(20, cursor, controller.signal); if (controller.signal.aborted || request !== listGeneration.current) return false; setConversations((old) => replace ? page.conversations : [...old, ...page.conversations]); setListCursor(page.nextCursor); return true; } catch (error) { if (!controller.signal.aborted && request === listGeneration.current) { setListError(error instanceof Error ? error.message : 'Could not load conversation history.'); setListRetry({ ...(cursor ? { cursor } : {}), replace }); } return false; } finally { if (request === listGeneration.current) setListBusy(false); } };
  useEffect(() => { void loadList(); return () => { generation.current += 1; streamController.current?.abort(); requestController.current?.abort(); }; }, []);

  /**
   * Scout's hand-off (§2.2 step 3): `?q=` and `?seeds=` prefill the composer.
   * Deliberately prefill only — a deep link must never spend an LLM call the
   * reader did not press a button for. The parameters are consumed once so a
   * reload does not resurrect a question the reader has moved on from.
   */
  useEffect(() => {
    const question = searchParams.get('q');
    const seedParam = searchParams.get('seeds');
    if (question === null && seedParam === null) return;
    if (question) setDraft(question.slice(0, 4_000));
    const ids = (seedParam ?? '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, MAX_SEEDS);
    setSearchParams((params) => { const next = new URLSearchParams(params); next.delete('q'); next.delete('seeds'); return next; }, { replace: true });
    if (ids.length === 0) return;
    void (async () => {
      const resolved = await Promise.all(ids.map((id) => api.book(id).catch(() => null)));
      const books = resolved.filter((book): book is Book => book !== null);
      setSeeds(books);
      // Named, not swallowed: a dropped anchor changes the answer, so the
      // reader has to be told rather than quietly given a different question.
      if (books.length < ids.length) setSeedNotice(`${ids.length - books.length} reference book${ids.length - books.length === 1 ? '' : 's'} could not be loaded and ${ids.length - books.length === 1 ? 'was' : 'were'} not used.`);
    })();
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const term = seedSearch.trim();
    if (term.length < 2 || seeds.length >= MAX_SEEDS) { setSeedResults([]); setSeedBusy(false); return; }
    setSeedBusy(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.books({ limit: '8', search: term })
        .then((page) => { if (!controller.signal.aborted) setSeedResults(page.books); })
        .catch(() => { if (!controller.signal.aborted) setSeedResults([]); })
        .finally(() => { if (!controller.signal.aborted) setSeedBusy(false); });
    }, 200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [seedSearch, seeds.length]);

  useEffect(() => { if (liveTurnId && detail?.turns.some((turn) => turn.id === liveTurnId)) { setState(EMPTY_LIBRARIAN_CHAT); setLiveTurnId(null); } }, [detail, liveTurnId]);
  useEffect(() => { if (state.phase === 'running' || selectedId !== null) { setListError(null); setListRetry(null); setDetailError(null); setDetailRetry(null); } }, [selectedId, state.phase]);

  const loadAcquire = (question: string, seedIds: string[]) => {
    const token = ++acquireGeneration.current;
    setAcquire({ status: 'loading', items: [], error: null });
    api.recommendations({ prompt: question, seedBookIds: seedIds, scope: 'discover' })
      .then((result) => { if (token === acquireGeneration.current) setAcquire({ status: 'loaded', items: externalCandidates(result), error: null }); })
      .catch((error: unknown) => { if (token === acquireGeneration.current) setAcquire({ status: 'error', items: [], error: error instanceof Error ? error.message : 'The acquire lookup failed.' }); });
  };

  /**
   * §3.2: the acquire section is fetched lazily, and only when the shelf
   * section is thin or the reader asks. "Thin" is an answered turn with no
   * owned book behind it — the one case where showing nothing else would
   * leave the reader with an empty page and no next step.
   */
  useEffect(() => {
    if (state.phase !== 'answered' || state.recommendations.length > 0 || acquire.status !== 'idle') return;
    if (!state.question.trim()) return;
    loadAcquire(state.question, liveSeedIds);
  }, [state.phase, state.recommendations.length, state.question, acquire.status, liveSeedIds]);

  // Feedback is fire-and-forget: it feeds the taste profile, and failing to
  // record an opinion must never break the answer the reader is looking at.
  const sendVerdict = (turnId: string, bookId: string, queryText: string, verdict: 'accepted' | 'rejected') => {
    const key = `${turnId}:${bookId}`;
    setVerdicts((prior) => ({ ...prior, [key]: verdict }));
    api.sendFeedback({ bookId, queryText, verdict }).catch(() => setVerdicts((prior) => { const next = { ...prior }; delete next[key]; return next; }));
  };

  const selectConversation = async (id: string, cursor?: string) => { setListError(null); setListRetry(null); setDetailError(null); setDetailRetry(null); const token = ++generation.current; streamController.current?.abort(); requestController.current?.abort(); setState(EMPTY_LIBRARIAN_CHAT); setAcquire(EMPTY_ACQUIRE); setSelectedId(id); if (!cursor) { setDetail(null); setDetailCursor(null); } setDetailBusy(true); const controller = new AbortController(); requestController.current = controller; try { const page = await getLibrarianConversation(id, 20, cursor, controller.signal); if (!controller.signal.aborted && token === generation.current) { setDetail(cursor ? (old) => mergeLibrarianConversationPages(old, page) : () => mergeLibrarianConversationPages(null, page)); setDetailCursor(page.nextCursor); } } catch (error) { if (!controller.signal.aborted && token === generation.current) { setDetailError(error instanceof Error ? error.message : 'Could not load this conversation.'); setDetailRetry(cursor ? { cursor } : {}); } } finally { if (token === generation.current) setDetailBusy(false); } };
  const loadMoreDetail = async () => { if (!selectedId || !detailCursor || detailBusy) return; const token = ++generation.current; const cursor = detailCursor; setDetailBusy(true); setDetailError(null); setDetailRetry(null); const controller = new AbortController(); requestController.current = controller; try { const page = await getLibrarianConversation(selectedId, 20, cursor, controller.signal); if (!controller.signal.aborted && token === generation.current) { setDetail((old) => mergeLibrarianConversationPages(old, page)); setDetailCursor(page.nextCursor); } } catch (error) { if (!controller.signal.aborted && token === generation.current) { setDetailError(error instanceof Error ? error.message : 'Could not load more turns.'); setDetailRetry({ cursor }); } } finally { if (token === generation.current) setDetailBusy(false); } };
  const newConversation = () => { generation.current += 1; listGeneration.current += 1; acquireGeneration.current += 1; streamController.current?.abort(); requestController.current?.abort(); setListBusy(false); setDetailBusy(false); setListRetry(null); setDetailRetry(null); setSelectedId(null); setLiveTurnId(null); setDetail(null); setDetailCursor(null); setDetailError(null); setState(EMPTY_LIBRARIAN_CHAT); setAcquire(EMPTY_ACQUIRE); setDraft(''); setSeeds([]); setSeedSearch(''); setSeedNotice(null); };

  const runTurn = async (question: string, seedIds: string[]) => {
    if (!question || state.phase === 'running') return;
    const token = ++generation.current; streamController.current?.abort();
    const controller = new AbortController(); streamController.current = controller;
    const threadAtStart = selectedId;
    setLiveTurnId(null); setState(beginLibrarianChat(question)); setDraft(''); setHistoryRefreshError(null);
    setLiveSeedIds(seedIds); acquireGeneration.current += 1; setAcquire(EMPTY_ACQUIRE);
    try {
      const result = await streamLibrarianChat(question, (librarianEvent) => { if (token === generation.current) setState((old) => reduceLibrarianChat(old, librarianEvent)); }, controller.signal, threadAtStart ?? undefined, seedIds);
      if (controller.signal.aborted || token !== generation.current) return;
      const id = threadAtStart ?? result.conversationId;
      if (result.turnId) setLiveTurnId(result.turnId);
      if (result.conversationId) setSelectedId(result.conversationId);
      try {
        if (id) { const page = await getLibrarianConversation(id, 20, undefined, controller.signal); if (token === generation.current) { setDetail(mergeLibrarianConversationPages(null, page)); setDetailCursor(page.nextCursor); } }
        if (!await loadList(undefined, true) && token === generation.current) setHistoryRefreshError('The saved history could not be refreshed.');
      } catch (error) { if (!controller.signal.aborted && token === generation.current) setHistoryRefreshError(error instanceof Error ? error.message : 'The saved history could not be refreshed.'); }
    } catch (error) {
      if (!controller.signal.aborted && token === generation.current) setState((old) => ({ ...old, phase: 'failed', recommendations: [], error: error instanceof Error ? error.message : 'The librarian connection failed.' }));
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Seeds alone are a complete request — that is what Scout's "Inspired by"
    // always meant — so the composer writes the question the picks imply
    // rather than persisting an empty one.
    const question = draft.trim() || (seeds.length > 0 ? `More books like ${seeds.map((book) => book.title).join(', ')}.` : '');
    await runTurn(question, seeds.map((book) => book.id));
  };

  const seedIdSet = new Set(seeds.map((book) => book.id));
  const suggestions = seedResults.filter((book) => !seedIdSet.has(book.id)).slice(0, 6);
  const canSubmit = (draft.trim().length > 0 || seeds.length > 0) && state.phase !== 'running';

  return <section className="v2-librarian-chat" aria-labelledby="librarian-chat-title"><div className="v2-librarian-chat-head"><div><span className="v2-kicker cyan"><Bot /> Ask your shelf</span><h2 id="librarian-chat-title">What should you listen to next?</h2><p>Describe a mood, a constraint, or a book you want more of. Your own shelf is always searched first.</p></div><span className="v2-librarian-local"><Library /> Shelf first</span></div><div className="v2-librarian-history"><div className="v2-librarian-history-bar"><div className="v2-librarian-history-head"><label className="v2-librarian-history-picker"><span className="v2-eyebrow">Conversation history</span><select aria-label="Reopen a past conversation" className="v2-librarian-history-select" value={selectedId ?? ''} disabled={state.phase === 'running' || (conversations.length === 0 && !listBusy)} onChange={(event) => { const id = event.target.value; if (id) void selectConversation(id); else newConversation(); }}><option value="">{listBusy && conversations.length === 0 ? 'Loading history…' : conversations.length === 0 ? 'No saved conversations yet' : 'New conversation'}</option>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{`${conversation.latestQuestion ?? 'Untitled conversation'} · ${conversation.turnCount} turn${conversation.turnCount === 1 ? '' : 's'} · ${conversation.latestStatus}`}</option>)}</select></label>{listCursor && <button type="button" className="v2-button-secondary" onClick={() => void loadList(listCursor)} disabled={listBusy}>Load more conversations</button>}<button type="button" className="v2-button-secondary" onClick={newConversation} disabled={state.phase === 'running'}>New conversation</button></div>{listError && <p role="alert">{listError} <button type="button" onClick={() => void loadList(listRetry?.cursor, listRetry?.replace ?? true)}>Retry</button></p>}</div><div className="v2-librarian-history-main">
    <form className="v2-librarian-composer" onSubmit={(event) => void submit(event)}>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} maxLength={4_000} disabled={state.phase === 'running'} placeholder="Something atmospheric and coastal, under nine hours, without a chosen-one plot…" aria-label="Ask the librarian" />
      <div className="v2-seed-picker">
        <label><span><BookOpen/> Inspired by</span><input value={seedSearch} disabled={seeds.length >= MAX_SEEDS || state.phase === 'running'} onChange={(event) => setSeedSearch(event.target.value)} placeholder={seeds.length >= MAX_SEEDS ? 'Eight reference books selected' : 'Search your shelf by title or author'} /></label>
        {seedSearch.trim() && seeds.length < MAX_SEEDS && <div className="v2-seed-suggestions">{seedSearch.trim().length < 2 ? <p>Type at least two characters.</p> : seedBusy ? <p>Searching your shelf…</p> : <>{suggestions.map((book) => <button type="button" key={book.id} onClick={() => { setSeeds((current) => current.length >= MAX_SEEDS ? current : [...current, book]); setSeedSearch(''); }}><Plus/><span><strong>{book.title}</strong><small>{book.author || 'Unknown author'}</small></span></button>)}{suggestions.length === 0 && <p>No matching shelf books.</p>}</>}</div>}
        {seeds.length > 0 && <div className="v2-seed-chips">{seeds.map((book) => <span key={book.id}><BookOpen/><b>{book.title}</b><button type="button" aria-label={`Remove ${book.title}`} onClick={() => setSeeds((current) => current.filter((entry) => entry.id !== book.id))}><X/></button></span>)}</div>}
        {seedNotice && <p role="alert">{seedNotice}</p>}
      </div>
      <button className="v2-button" type="submit" disabled={!canSubmit}>{state.phase === 'running' ? <LoaderCircle className="spin" /> : <Send />}{state.phase === 'running' ? 'Researching' : selectedId ? 'Follow up' : 'Ask librarian'}</button>
    </form>
    {historyRefreshError && <p role="alert">{historyRefreshError} <button type="button" onClick={() => void loadList(undefined, true)}>Retry history refresh</button></p>}{detailBusy && !detail && <p role="status">Loading conversation…</p>}{detailError && <p role="alert">{detailError} <button type="button" onClick={() => selectedId && void selectConversation(selectedId, detailRetry?.cursor)}>Retry</button></p>}
    {detail?.turns.map((turn) => <TurnView key={turn.id} turn={turn} verdicts={verdicts} onVerdict={sendVerdict} onRetry={(question) => void runTurn(question, [])} />)}
    {detailCursor && <button type="button" className="v2-button-secondary" onClick={() => void loadMoreDetail()} disabled={detailBusy}>Load more turns</button>}
    {state.phase !== 'idle' && <div className="v2-librarian-conversation" aria-live="polite"><div className="v2-librarian-bubble user">{state.question}</div><Work state={state} turnId="live" verdicts={verdicts} onVerdict={sendVerdict} onRetry={(question) => void runTurn(question, liveSeedIds)} acquire={{ state: acquire, onLoad: () => loadAcquire(state.question, liveSeedIds) }} /></div>}
  </div></div></section>;
}
