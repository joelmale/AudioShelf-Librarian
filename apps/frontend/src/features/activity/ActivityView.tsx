import React, { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FolderCog,
  Bot,
  Terminal,
  LoaderCircle,
  X,
  Activity,
  Layers,
} from 'lucide-react';
import {
  useActivityFeed,
  useActivityEntity,
  api,
  useInvalidate,
  useMutation,
} from '../curator/api.js';
import { useToast } from '../curator/toast.js';
import { LogPage as CuratorLogs } from '../curator/pages/LogPage.js';
import { OrganizationHistory as LibrarianLogs } from '../librarian/components/OrganizationHistory.js';
import { SystemConsole } from '../logs/SystemConsole.js';
import './ActivityView.css';

export const ActivityView: React.FC = () => {
  const [viewMode, setViewMode] = useState<'feed' | 'diagnostics'>('feed');
  const [diagnosticsTab, setDiagnosticsTab] = useState<'librarian' | 'curator' | 'system'>('librarian');
  const { id: routeEntityId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidate();

  const { data: feed, isLoading, error, refetch } = useActivityFeed();
  const { data: entityData, isLoading: entityLoading } = useActivityEntity(routeEntityId);

  const dismissAcquisition = useMutation({
    mutationFn: (id: string) => api.dismissAcquisitionItem(id),
    onSuccess: () => {
      invalidate(['activity-feed']);
      void refetch();
      toast('Acquisition item dismissed', 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const closeModal = () => {
    navigate('/activity');
  };

  const needsAttention = feed?.needsAttention ?? [];
  const inProgress = feed?.inProgress ?? [];
  const completed = feed?.completed ?? [];
  const counts = feed?.counts ?? { needsAttention: 0, inProgress: 0, completed: 0 };
  const providers = feed?.providers ?? {
    operations: 'ok',
    encodes: 'ok',
    ingest: 'ok',
    torrents: 'ok',
  };

  return (
    <div className="v2-page v2-legacy-surface">
      <div className="v2-page-heading">
        <div>
          <span className="v2-eyebrow">
            <Activity className="inline-icon" size={16} /> Activity & Operations
          </span>
          <h1>System activity and decisions</h1>
          <p>Truth-grounded view of active transfers, background processing, and required decisions.</p>
        </div>
        <div className="v2-activity-providers">
          {providers.torrents === 'error' && (
            <span className="v2-provider-tag v2-provider-tag--error" title={feed?.providerErrors?.torrents}>
              <AlertCircle size={12} /> Torrents Offline
            </span>
          )}
          {providers.encodes === 'error' && (
            <span className="v2-provider-tag v2-provider-tag--error" title={feed?.providerErrors?.encodes}>
              <AlertCircle size={12} /> Encoder Disconnected
            </span>
          )}
          <span className="v2-live">
            <span className="v2-dot ok" /> Live system
          </span>
        </div>
      </div>

      <nav className="v2-section-tabs" aria-label="Activity views">
        <button
          type="button"
          onClick={() => setViewMode('feed')}
          className={viewMode === 'feed' ? 'active' : ''}
        >
          <Layers size={16} />
          <span>Active Operations ({counts.needsAttention + counts.inProgress})</span>
        </button>
        <button
          type="button"
          onClick={() => setViewMode('diagnostics')}
          className={viewMode === 'diagnostics' ? 'active' : ''}
        >
          <Terminal size={16} />
          <span>Diagnostics & History</span>
        </button>
      </nav>

      {viewMode === 'feed' ? (
        <div className="v2-activity-container" style={{ marginTop: '20px' }}>
          <div className="v2-activity-header">
            <div className="v2-activity-counts">
              <span className={`v2-activity-pill ${counts.needsAttention > 0 ? 'v2-activity-pill--attention' : ''}`}>
                <AlertCircle size={14} />
                <span>Needs Attention: {counts.needsAttention}</span>
              </span>
              <span className="v2-activity-pill v2-activity-pill--progress">
                <LoaderCircle size={14} className={counts.inProgress > 0 ? 'spin' : ''} />
                <span>In Progress: {counts.inProgress}</span>
              </span>
              <span className="v2-activity-pill v2-activity-pill--completed">
                <CheckCircle2 size={14} />
                <span>Completed (24h): {counts.completed}</span>
              </span>
            </div>
          </div>

          {isLoading ? (
            <div className="v2-activity-empty">
              <LoaderCircle size={24} className="spin" style={{ margin: '0 auto 8px auto' }} />
              <p>Gathering active operations and task state…</p>
            </div>
          ) : error ? (
            <div className="v2-activity-empty" style={{ color: '#ef4444' }}>
              <AlertCircle size={24} style={{ margin: '0 auto 8px auto' }} />
              <p>Failed to load activity feed. Refresh or check connection.</p>
            </div>
          ) : (
            <>
              {/* SECTION 1: Needs Attention */}
              {needsAttention.length > 0 && (
                <section className="v2-activity-section" aria-label="Items needing attention">
                  <div className="v2-activity-section-title">
                    <h3 style={{ color: '#ef4444' }}>
                      <AlertCircle size={18} /> Needs Attention ({needsAttention.length})
                    </h3>
                  </div>
                  <div className="v2-activity-grid">
                    {needsAttention.map((item) => (
                      <div key={item.id} className="v2-activity-card v2-activity-card--attention">
                        <div className="v2-card-meta">
                          <span className="v2-entity-type-badge">{item.entityType}</span>
                          <span style={{ color: '#ef4444', fontWeight: 600 }}>Action Needed</span>
                        </div>
                        <div className="v2-card-body">
                          <h4>{item.title}</h4>
                          <p>{item.subtitle}</p>
                          {item.error && <p className="v2-card-error">{item.error}</p>}
                        </div>
                        <div className="v2-card-actions">
                          {item.actionRequired?.type === 'review_intake' && (
                            <Link to="/scout/intake" className="v2-action-link">
                              Review in Intake <ExternalLink size={12} />
                            </Link>
                          )}
                          {item.actionRequired?.type === 'retry_encode' && (
                            <Link to="/curate/encode" className="v2-action-link">
                              Review in Encoder <ExternalLink size={12} />
                            </Link>
                          )}
                          {item.actionRequired?.type === 'dismiss_acquisition' && (
                            <button
                              type="button"
                              className="v2-action-link v2-action-link--secondary"
                              onClick={() => dismissAcquisition.mutate(item.rawId)}
                            >
                              Dismiss Item
                            </button>
                          )}
                          <Link to={`/activity/${item.id}`} className="v2-action-link v2-action-link--secondary">
                            View details
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* SECTION 2: In Progress */}
              <section className="v2-activity-section" aria-label="In progress work">
                <div className="v2-activity-section-title">
                  <h3 style={{ color: 'var(--cyan, #06b6d4)' }}>
                    <LoaderCircle size={18} className={inProgress.length > 0 ? 'spin' : ''} /> In Progress ({inProgress.length})
                  </h3>
                </div>
                {inProgress.length === 0 ? (
                  <div className="v2-activity-empty">
                    <p>No active transfers, scans, or encoding operations currently running.</p>
                  </div>
                ) : (
                  <div className="v2-activity-grid v2-activity-grid--multi">
                    {inProgress.map((item) => (
                      <div key={item.id} className="v2-activity-card v2-activity-card--progress">
                        <div className="v2-card-meta">
                          <span className="v2-entity-type-badge">{item.entityType}</span>
                          {item.progress?.percent !== undefined && (
                            <strong style={{ color: 'var(--cyan)' }}>{item.progress.percent}%</strong>
                          )}
                        </div>
                        <div className="v2-card-body">
                          <h4>{item.title}</h4>
                          <p>{item.subtitle}</p>
                          {item.progress?.percent !== undefined && (
                            <div className="v2-activity-progress-bar">
                              <div
                                className="v2-activity-progress-fill"
                                style={{ width: `${item.progress.percent}%` }}
                              />
                            </div>
                          )}
                        </div>
                        <div className="v2-card-actions">
                          <Link to={`/activity/${item.id}`} className="v2-action-link v2-action-link--secondary">
                            Inspect
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* SECTION 3: Completed */}
              <section className="v2-activity-section" aria-label="Recently completed work">
                <div className="v2-activity-section-title">
                  <h3 style={{ color: '#10b981' }}>
                    <CheckCircle2 size={18} /> Recently Completed ({completed.length})
                  </h3>
                </div>
                {completed.length === 0 ? (
                  <div className="v2-activity-empty">
                    <p>No completed tasks recorded in the last 24 hours.</p>
                  </div>
                ) : (
                  <div className="v2-activity-grid v2-activity-grid--multi">
                    {completed.map((item) => (
                      <div key={item.id} className="v2-activity-card v2-activity-card--completed">
                        <div className="v2-card-meta">
                          <span className="v2-entity-type-badge">{item.entityType}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                            <Clock size={10} style={{ display: 'inline', marginRight: 3 }} />
                            {new Date(item.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <div className="v2-card-body">
                          <h4>{item.title}</h4>
                          <p>{item.subtitle}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <span className="v2-activity-retention-note">
                  Showing work completed within the 24-hour retention window. For older raw logs, see Diagnostics & History.
                </span>
              </section>
            </>
          )}
        </div>
      ) : (
        /* ViewMode === 'diagnostics': Preserves existing logs tabs */
        <div style={{ marginTop: '20px' }}>
          <nav className="v2-section-tabs" aria-label="Log sections">
            <button
              type="button"
              onClick={() => setDiagnosticsTab('librarian')}
              className={diagnosticsTab === 'librarian' ? 'active' : ''}
            >
              <FolderCog size={14} />
              <span>Librarian History</span>
            </button>
            <button
              type="button"
              onClick={() => setDiagnosticsTab('curator')}
              className={diagnosticsTab === 'curator' ? 'active' : ''}
            >
              <Bot size={14} />
              <span>Curator Logs</span>
            </button>
            <button
              type="button"
              onClick={() => setDiagnosticsTab('system')}
              className={diagnosticsTab === 'system' ? 'active' : ''}
            >
              <Terminal size={14} />
              <span>System Console</span>
            </button>
          </nav>

          <div className="tab-content" style={{ marginTop: '24px' }}>
            {diagnosticsTab === 'librarian' && (
              <div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '16px' }}>
                  History of all manual bulk folder organizations and metadata commits. You can undo batches here if files were moved to the wrong library path.
                </p>
                <LibrarianLogs />
              </div>
            )}
            {diagnosticsTab === 'curator' && (
              <div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '16px' }}>
                  Real-time logs of automated background jobs including encoding, collections updates, and background metadata tag fetching.
                </p>
                <CuratorLogs />
              </div>
            )}
            {diagnosticsTab === 'system' && <SystemConsole />}
          </div>
        </div>
      )}

      {/* MODAL: Focused Entity Detail when /activity/:id is accessed */}
      {routeEntityId && (
        <div className="v2-entity-modal-overlay" onClick={closeModal} role="dialog" aria-modal="true">
          <div className="v2-entity-modal" onClick={(e) => e.stopPropagation()}>
            <div className="v2-entity-modal-head">
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff' }}>Activity Item Details</h3>
              <button
                type="button"
                className="v2-entity-modal-close"
                onClick={closeModal}
                aria-label="Close dialog"
              >
                <X size={20} />
              </button>
            </div>

            {entityLoading ? (
              <div style={{ textAlign: 'center', padding: '2rem' }}>
                <LoaderCircle size={24} className="spin" style={{ margin: '0 auto 8px auto' }} />
                <p>Loading details for {routeEntityId}…</p>
              </div>
            ) : !entityData?.found ? (
              <div style={{ padding: '1rem', color: '#ef4444' }}>
                <AlertCircle size={20} style={{ marginBottom: 6 }} />
                <p style={{ fontWeight: 600 }}>Item Unavailable</p>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  {entityData?.unavailableReason || `The requested activity item "${routeEntityId}" was not found or has expired from active memory.`}
                </p>
              </div>
            ) : (
              <div>
                <div style={{ marginBottom: '1rem' }}>
                  <span className="v2-entity-type-badge">{entityData.entity?.entityType}</span>
                  <h2 style={{ fontSize: '1.25rem', margin: '0.5rem 0' }}>{entityData.entity?.title}</h2>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
                    {entityData.entity?.subtitle}
                  </p>
                  {entityData.entity?.error && (
                    <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 4 }}>
                      <strong style={{ color: '#ef4444', fontSize: '0.85rem' }}>Error details:</strong>
                      <p style={{ color: '#ff8888', margin: '4px 0 0 0', fontSize: '0.82rem' }}>{entityData.entity.error}</p>
                    </div>
                  )}
                </div>

                {entityData.rawDetails ? (
                  <div>
                    <h5 style={{ margin: '1rem 0 0.5rem 0', color: 'var(--text-secondary)', textTransform: 'uppercase', fontSize: '0.7rem' }}>
                      Raw State Snapshot
                    </h5>
                    <pre className="v2-raw-details-pre">
                      {JSON.stringify(entityData.rawDetails, null, 2)}
                    </pre>
                  </div>
                ) : null}

                <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="button" className="v2-action-link" onClick={closeModal}>
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
