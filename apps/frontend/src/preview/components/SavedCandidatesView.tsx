import { useState } from 'react';
import {
  BookmarkCheck,
  Clock,
  Check,
  X,
  Undo2,
  Search,
  Library,
  CheckCircle2,
  AlertCircle,
  Download,
  LoaderCircle,
  RotateCw,
} from 'lucide-react';
import { useNavigate, Link } from 'react-router-dom';
import {
  useSavedCandidates,
  useSetCandidateIntent,
  useUndoCandidateIntent,
  useCandidateAcquisition,
  useRetryAcquisition,
  type CandidateIntentType,
  type SavedCandidateItem,
} from '../../features/curator/api.js';
import './SavedCandidatesView.css';

interface SavedCandidateCardProps {
  item: SavedCandidateItem;
  onSetIntent: (item: SavedCandidateItem, newIntent: CandidateIntentType) => void;
  onUndo: (candidateId: string) => void;
  onAcquire: (item: SavedCandidateItem) => void;
}

export function SavedCandidateCard({
  item,
  onSetIntent,
  onUndo,
  onAcquire,
}: SavedCandidateCardProps) {
  const { candidate, intent, ownership, isFinished } = item;
  const isWant = intent.intent === 'want';
  const isLater = intent.intent === 'later';
  const isPass = intent.intent === 'pass';

  const { data: acqRes } = useCandidateAcquisition(candidate.id);
  const acquisition = acqRes?.data;
  const retryMutation = useRetryAcquisition();

  const percent =
    acquisition?.progress !== undefined && acquisition.progress !== null
      ? Math.min(100, Math.max(0, Math.round(acquisition.progress * 100)))
      : null;

  const isAcquiring =
    acquisition &&
    ['requested', 'downloading', 'seeding', 'importing', 'processing'].includes(acquisition.status);

  const isShelved = acquisition?.status === 'shelved';

  return (
    <div className={`saved-candidate-card saved-candidate-card--${intent.intent}`}>
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
            ) : ownership === 'owned' || isShelved ? (
              <span className="saved-ownership-badge saved-ownership-badge--owned">
                <Library size={12} /> In Library
              </span>
            ) : null}

            {/* Acquisition status badges */}
            {acquisition && acquisition.status === 'downloading' && (
              <span className="saved-acquisition-badge saved-acquisition-badge--downloading">
                <Download size={11} /> Downloading {percent !== null ? `${percent}%` : '…'}
              </span>
            )}
            {acquisition && (acquisition.status === 'importing' || acquisition.status === 'processing') && (
              <span className="saved-acquisition-badge saved-acquisition-badge--importing">
                <LoaderCircle size={11} className="spin" /> Importing…
              </span>
            )}
            {acquisition && acquisition.status === 'seeding' && (
              <span className="saved-acquisition-badge saved-acquisition-badge--seeding">
                <CheckCircle2 size={11} /> Downloaded
              </span>
            )}
            {acquisition && acquisition.status === 'requested' && (
              <span className="saved-acquisition-badge saved-acquisition-badge--queued">
                <Clock size={11} /> Queued
              </span>
            )}
            {acquisition && acquisition.status === 'failed' && (
              <span
                className="saved-acquisition-badge saved-acquisition-badge--failed"
                title={acquisition.detail || 'Acquisition failed'}
              >
                <AlertCircle size={11} /> Failed
              </span>
            )}
            {acquisition && acquisition.status === 'needs_confirmation' && (
              <span
                className="saved-acquisition-badge saved-acquisition-badge--conflict"
                title="Ambiguous or duplicate file in intake"
              >
                <AlertCircle size={11} /> Intake conflict
              </span>
            )}
          </div>

          <h4 className="saved-card-title" title={candidate.title}>
            {candidate.title}
          </h4>
          <p className="saved-card-author" title={candidate.author}>
            {candidate.author}
          </p>

          {/* Acquisition Progress Bar */}
          {acquisition && acquisition.status === 'downloading' && percent !== null && (
            <div className="saved-acquisition-progress-wrap">
              <div className="saved-acquisition-progress-bar">
                <div
                  className="saved-acquisition-progress-fill"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          )}

          {/* Acquisition Failure / Action info */}
          {acquisition && acquisition.status === 'failed' && (
            <div className="saved-acquisition-action-row">
              <span className="saved-acquisition-error-text">
                {acquisition.detail || 'Download or match failed'}
              </span>
              <button
                type="button"
                className="saved-acquisition-retry-btn"
                disabled={retryMutation.isPending}
                onClick={() => retryMutation.mutate(acquisition.id)}
              >
                <RotateCw size={11} className={retryMutation.isPending ? 'spin' : ''} />
                <span>Retry</span>
              </button>
            </div>
          )}

          {acquisition && acquisition.status === 'needs_confirmation' && (
            <div className="saved-acquisition-action-row">
              <Link to="/scout/intake" className="saved-acquisition-intake-link">
                Review intake decision →
              </Link>
            </div>
          )}

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
            onClick={() => onSetIntent(item, 'want')}
          >
            <Check size={14} />
            <span>Want</span>
          </button>
          <button
            type="button"
            className={`saved-triage-btn ${isLater ? 'active later' : ''}`}
            title="Mark as Later"
            onClick={() => onSetIntent(item, 'later')}
          >
            <Clock size={14} />
            <span>Later</span>
          </button>
          <button
            type="button"
            className={`saved-triage-btn ${isPass ? 'active pass' : ''}`}
            title="Mark as Pass"
            onClick={() => onSetIntent(item, 'pass')}
          >
            <X size={14} />
            <span>Pass</span>
          </button>
          <button
            type="button"
            className="saved-undo-btn"
            title="Undo triage decision"
            onClick={() => onUndo(candidate.id)}
          >
            <Undo2 size={14} />
            <span>Undo</span>
          </button>
        </div>

        {isShelved ? (
          <Link
            to="/desk"
            className="saved-search-btn saved-search-btn--shelved"
            title="Shelved on AudioShelf library"
          >
            <Library size={13} />
            <span>Shelved</span>
          </Link>
        ) : isAcquiring ? (
          <Link
            to="/activity"
            className="saved-search-btn saved-search-btn--tracking"
            title="View active transfer in Activity"
          >
            <LoaderCircle size={13} className="spin" />
            <span>Tracking</span>
          </Link>
        ) : (
          <button
            type="button"
            className="saved-search-btn"
            title="Find on AudioShelf acquisition sources"
            onClick={() => onAcquire(item)}
          >
            <Search size={14} />
            <span>Find</span>
          </button>
        )}
      </div>
    </div>
  );
}

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
    navigate(`/discover/search?q=${encodeURIComponent(query)}&candidateId=${encodeURIComponent(item.candidate.id)}`);
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
          {items.map((item) => (
            <SavedCandidateCard
              key={item.candidate.id}
              item={item}
              onSetIntent={handleSetIntent}
              onUndo={handleUndo}
              onAcquire={handleAcquire}
            />
          ))}
        </div>
      )}
    </div>
  );
}
