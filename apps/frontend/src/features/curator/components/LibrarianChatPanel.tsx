import { Bot, CircleAlert, Library, LoaderCircle, Search, Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  beginLibrarianChat,
  EMPTY_LIBRARIAN_CHAT,
  reduceLibrarianChat,
  streamLibrarianChat,
  type LibrarianAction,
  type LibrarianChatState,
} from '../librarianChat.js';

const ACTION_LABELS: Record<string, string> = {
  search_library: 'Searched the catalog',
  search_semantic: 'Browsed by mood and meaning',
  get_book: 'Opened a book card',
  find_similar: 'Compared nearby books',
  tag_coverage: 'Checked metadata coverage',
};

function actionLabel(action: LibrarianAction): string {
  return ACTION_LABELS[action.tool] ?? action.label.replaceAll('_', ' ');
}

export function LibrarianChatPanel() {
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<LibrarianChatState>(EMPTY_LIBRARIAN_CHAT);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question || state.phase === 'running') return;

    controller.current?.abort();
    controller.current = new AbortController();
    setState(beginLibrarianChat(question));
    try {
      await streamLibrarianChat(
        question,
        (nextEvent) => setState((current) => reduceLibrarianChat(current, nextEvent)),
        controller.current.signal
      );
    } catch (error) {
      if (controller.current.signal.aborted) return;
      setState((current) => ({
        ...current,
        phase: 'failed',
        recommendations: [],
        error: error instanceof Error ? error.message : 'The librarian connection failed.',
      }));
    }
  };

  return (
    <section className="v2-librarian-chat" aria-labelledby="librarian-chat-title">
      <div className="v2-librarian-chat-head">
        <div>
          <span className="v2-kicker cyan"><Bot /> Ask your shelf</span>
          <h2 id="librarian-chat-title">What should you listen to next?</h2>
          <p>Describe a mood, a constraint, or a book you want more of. Recommendations stay inside your library.</p>
        </div>
        <span className="v2-librarian-local"><Library /> Library only</span>
      </div>

      <form className="v2-librarian-composer" onSubmit={(event) => void submit(event)}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          maxLength={4_000}
          disabled={state.phase === 'running'}
          placeholder="Something atmospheric and coastal, under nine hours, without a chosen-one plot…"
          aria-label="Ask the librarian"
        />
        <button className="v2-button" type="submit" disabled={!draft.trim() || state.phase === 'running'}>
          {state.phase === 'running' ? <LoaderCircle className="spin" /> : <Send />}
          {state.phase === 'running' ? 'Researching' : 'Ask librarian'}
        </button>
      </form>

      {state.phase !== 'idle' && (
        <div className="v2-librarian-conversation" aria-live="polite">
          <div className="v2-librarian-bubble user">{state.question}</div>

          <div className="v2-librarian-work">
            <div className="v2-librarian-actions">
              <span className="v2-eyebrow">Research trail</span>
              {state.actions.length === 0 && state.phase === 'running' && (
                <p><LoaderCircle className="spin" /> Reading your request…</p>
              )}
              {state.actions.map((action, index) => (
                <div key={`${action.tool}-${index}`}>
                  <Search />
                  <span>
                    <strong>{actionLabel(action)}</strong>
                    <small>{action.detail} · {action.resultSummary}</small>
                  </span>
                </div>
              ))}
            </div>

            <div className={`v2-librarian-bubble assistant ${state.phase}`}>
              {state.phase === 'running' && <><LoaderCircle className="spin" /><span>Following the evidence through your shelf…</span></>}
              {(state.phase === 'exhausted' || state.phase === 'failed') && (
                <><CircleAlert /><span>{state.error}</span></>
              )}
              {state.phase === 'answered' && state.recommendations.length === 0 && (
                <span>I couldn&apos;t find a shelf match I could support from the available evidence.</span>
              )}
              {state.phase === 'answered' && state.recommendations.length > 0 && (
                <ol>
                  {state.recommendations.map((recommendation) => (
                    <li key={recommendation.bookId}>
                      <strong>{recommendation.title ?? recommendation.bookId}</strong>
                      {recommendation.author && <small>{recommendation.author}</small>}
                      <p>{recommendation.reason}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
