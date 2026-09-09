import { useState } from 'react';
import { BookmarkCheck, Clock, Check, X, Undo2, Search, Library, CheckCircle2, AlertCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  useSavedCandidates,
  useSetCandidateIntent,
  useUndoCandidateIntent,
  type CandidateIntentType,
  type SavedCandidateItem,
} from '../../features/curator/api.js';
import './SavedCandidatesView.css';

export function SavedCandidatesView() {
  const [activeTab, setActiveTab] = useState<'all' | CandidateIntentType>('all');
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const navigate = useNavigate();

  const queryIntent = activeTab === 'all' ? undefined : activeTab;
  const { data, isLoading, error, refetch } = useSavedCandidates(queryIntent);
  const setIntentMutation = useSetCandidateIntent();
  const undoIntentMutation = useUndoCandidateIntent();

  const handleSetIntent = (item: SavedCandidateItem, newIntent: CandidateIntentType) => {
    setConflictMessage(null);
    setIntentMutation.mutate(
      {
        candidateId: item.candidate.id,
        intent: newIntent,
        expectedRevision: item.intent.revision,
        candidate: item.candidate,
      },
      {
        onError: (err: unknown) => {
          if (err instanceof Error && err.message.includes('conflict')) {
            setConflictMessage('This item was updated in another window. Refreshing list…');
            void refetch();
          }
        },
      }
    );
  };

  const handleUndo = (candidateId: string) => {
    setConflictMessage(null);
    undoIntentMutation.mutate(
      { candidateId },
      {
        onError: () => {
          void refetch();
        },
      }
    );
  };

  const handleAcquire = (item: SavedCandidateItem) => {
    const query = `${item.candidate.title} ${item.candidate.author}`.trim();
    navigate(`/discover/search?q=${encodeURIComponent(query)}`);
  };

  const items = data?.items ?? [];
  const totals = data?.totals ?? { all: 0, want: 0, later: 0, pass: 0 };

  return (
    <div className="saved-candidates-view">
      <div className="saved-candidates-header">
        <div className="saved-candidates-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'all'}
            className={`saved-tab ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            <span>All Saved</span>
            <span className="saved-tab-count">{totals.all}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'want'}
            className={`saved-tab saved-tab--want ${activeTab === 'want' ? 'active' : ''}`}
            onClick={() => setActiveTab('want')}
          >
            <BookmarkCheck size={14} />
            <span>Want</span>
            <span className="saved-tab-count">{totals.want}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'later'}
            className={`saved-tab saved-tab--later ${activeTab === 'later' ? 'active' : ''}`}
            onClick={() => setActiveTab('later')}
          >
            <Clock size={14} />
            <span>Later</span>
            <span className="saved-tab-count">{totals.later}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'pass'}
            className={`saved-tab saved-tab--pass ${activeTab === 'pass' ? 'active' : ''}`}
            onClick={() => setActiveTab('pass')}
          >
            <X size={14} />
            <span>Pass</span>
            <span className="saved-tab-count">{totals.pass}</span>
          </button>
        </div>

        {data?.isShared && (
          <span className="saved-shared-actor-note" title="All changes are saved to the shared local database">
            Shared decisions
          </span>
        )}
      </div>

      {conflictMessage && (
        <div className="saved-conflict-banner" role="alert">
          <AlertCircle size={16} />
          <span>{conflictMessage}</span>
        </div>
      )}

      {isLoading ? (
        <div className="saved-status-msg" role="status">
          Loading saved books…
        </div>
      ) : error ? (
        <div className="saved-status-msg saved-status-msg--error" role="alert">
          Failed to load saved candidates.
        </div>
      ) : items.length === 0 ? (
        <div className="saved-empty-state">
          <BookmarkCheck size={36} className="saved-empty-icon" />
          <h3>No titles saved here yet</h3>
          <p>
            {activeTab === 'all'
              ? 'Browse Charts or Recommendations and tap Want, Later, or Pass to keep track of candidates.'
              : `You haven't marked any books as "${activeTab}" yet.`}
          </p>
        </div>
      ) : (
        <div className="saved-candidates-grid">
          {items.map((item) => {
            const { candidate, intent, ownership, isFinished } = item;
            const isWant = intent.intent === 'want';
            const isLater = intent.intent === 'later';
            const isPass = intent.intent === 'pass';

            return (
              <div key={candidate.id} className={`saved-candidate-card saved-candidate-card--${intent.intent}`}>
                <div className="saved-card-main">
                  {candidate.coverUrl ? (
                    <img
                      src={candidate.coverUrl}
                      alt=""
                      className="saved-card-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="saved-card-cover saved-card-cover--placeholder">
                      <BookmarkCheck size={24} />
                    </div>
                  )}

                  <div className="saved-card-details">
                    <div className="saved-card-badges">
                      <span className={`saved-source-badge saved-source-badge--${candidate.source}`}>
                        {candidate.source}
                      </span>
                      {isFinished ? (
                        <span className="saved-ownership-badge saved-ownership-badge--finished">
                          <CheckCircle2 size={12} /> Finished
                        </span>
                      ) : ownership === 'owned' ? (
                        <span className="saved-ownership-badge saved-ownership-badge--owned">
                          <Library size={12} /> In Library
                        </span>
                      ) : null}
                    </div>

                    <h4 className="saved-card-title" title={candidate.title}>
                      {candidate.title}
                    </h4>
                    <p className="saved-card-author" title={candidate.author}>
                      {candidate.author}
                    </p>

                    {candidate.description && (
                      <p className="saved-card-description">
                        {candidate.description}
                      </p>
                    )}
                  </div>
                </div>

                <div className="saved-card-footer">
                  <div className="saved-triage-controls">
                    <button
                      type="button"
                      className={`saved-triage-btn ${isWant ? 'active want' : ''}`}
                      title="Mark as Want"
                      onClick={() => handleSetIntent(item, 'want')}
                    >
                      <Check size={14} />
                      <span>Want</span>
                    </button>
                    <button
                      type="button"
                      className={`saved-triage-btn ${isLater ? 'active later' : ''}`}
                      title="Mark as Later"
                      onClick={() => handleSetIntent(item, 'later')}
                    >
                      <Clock size={14} />
                      <span>Later</span>
                    </button>
                    <button
                      type="button"
                      className={`saved-triage-btn ${isPass ? 'active pass' : ''}`}
                      title="Mark as Pass"
                      onClick={() => handleSetIntent(item, 'pass')}
                    >
                      <X size={14} />
                      <span>Pass</span>
                    </button>
                    <button
                      type="button"
                      className="saved-undo-btn"
                      title="Undo triage decision"
                      onClick={() => handleUndo(candidate.id)}
                    >
                      <Undo2 size={14} />
                      <span>Undo</span>
                    </button>
                  </div>

                  <button
                    type="button"
                    className="saved-search-btn"
                    title="Find on AudioShelf acquisition sources"
                    onClick={() => handleAcquire(item)}
                  >
                    <Search size={14} />
                    <span>Find</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
