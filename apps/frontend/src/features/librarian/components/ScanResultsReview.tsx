import React, { useEffect, useState } from "react";
import { useWebSocket } from "../../../contexts/WebSocketProvider.js";
import type { OrganizationAction } from "@audioshelf/shared";
import { EnhanceMetadataModal } from "./EnhanceMetadataModal.js";

export const ScanResultsReview: React.FC = () => {
  const { lastMessage } = useWebSocket();
  const [actions, setActions] = useState<OrganizationAction[]>([]);
  const [isScanActive, setIsScanActive] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitMessage, setCommitMessage] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState<Record<string, boolean>>({});
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [pendingEnhancement, setPendingEnhancement] = useState<{original: OrganizationAction, suggested: OrganizationAction} | null>(null);
  const [absUrl, setAbsUrl] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState<Record<string, boolean>>({});
  const [commitStatus, setCommitStatus] = useState<{ executed: number, total: number, currentFile: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then(res => res.json())
      .then(data => {
        if (data.settings?.absUrl) {
          setAbsUrl(data.settings.absUrl);
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.type === "librarian:scan_progress") {
      const status = lastMessage.payload.status;
      if (status === "discovering") {
        setActions([]);
        setCommitMessage(null);
        setIsScanActive(true);
      } else if (status === "scanning") {
        setIsScanActive(true);
      } else {
        // completed, error, or cancelled
        setIsScanActive(false);
        if (status === "completed" && lastMessage.payload.results) {
          setActions(lastMessage.payload.results);
        }
      }
    }

    if (lastMessage.type === "librarian:scan_action") {
      setActions(prev => {
        // Prevent duplicate insertions
        if (prev.some(a => a.source_path === (lastMessage.payload as OrganizationAction).source_path)) {
          return prev;
        }
        const action = lastMessage.payload as OrganizationAction;
        setSelectedPaths(s => {
          const ns = new Set(s);
          ns.add(action.source_path);
          return ns;
        });
        return [...prev, action];
      });
    }

    if (lastMessage.type === "librarian:commit_progress") {
      const payload = lastMessage.payload;
      if (payload.status === "completed") {
        setIsCommitting(false);
        setCommitStatus(null);
        setActions(prev => prev.filter(a => !selectedPaths.has(a.source_path)));
        setSelectedPaths(new Set());
      } else {
        setCommitStatus({
          executed: payload.executed,
          total: payload.total,
          currentFile: payload.currentFile
        });
      }
    }
  }, [lastMessage]);

  const commitChanges = async () => {
    setIsCommitting(true);
    setCommitMessage(null);
    setCommitStatus({ executed: 0, total: selectedPaths.size, currentFile: "Preparing..." });
    try {
      const res = await fetch("/api/librarian/scan/commit", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedPaths: Array.from(selectedPaths) })
      });
      const data = await res.json();
      if (!res.ok) {
        setCommitMessage(`Error: ${data.error}`);
        setIsCommitting(false);
        setCommitStatus(null);
      } else {
        setCommitMessage(`Success: ${data.message} (${data.total} actions)`);
        // We wait for the completed websocket event to actually clear the list and reset isCommitting
      }
    } catch (e: any) {
      setCommitMessage(`Error: ${e.message}`);
      setIsCommitting(false);
      setCommitStatus(null);
    }
  };

  const rollbackChanges = async () => {
    setIsCommitting(true);
    setCommitMessage(null);
    try {
      const res = await fetch("/api/librarian/scan/rollback", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setCommitMessage(`Rollback Error: ${data.error}`);
      } else {
        setCommitMessage(`Rollback Success: ${data.message}`);
      }
    } catch (e: any) {
      setCommitMessage(`Rollback Error: ${e.message}`);
    } finally {
      setIsCommitting(false);
    }
  };

  const enhanceMetadata = async (action: OrganizationAction) => {
    setEnhancing(prev => ({ ...prev, [action.source_path]: true }));
    try {
      const res = await fetch("/api/librarian/scan/enhance-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setPendingEnhancement({ original: action, suggested: data.data });
      } else {
        setCommitMessage(`Enhance Error: ${data.error}`);
      }
    } catch (e: any) {
      setCommitMessage(`Enhance Error: ${e.message}`);
    } finally {
      setEnhancing(prev => ({ ...prev, [action.source_path]: false }));
    }
  };

  const deleteDuplicate = async (action: OrganizationAction) => {
    if (!window.confirm(`Are you sure you want to completely delete "${action.book.title}" from the inbox? This cannot be undone.`)) return;
    
    setIsDeleting(prev => ({ ...prev, [action.source_path]: true }));
    try {
      const res = await fetch("/api/librarian/scan/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_path: action.source_path })
      });
      const data = await res.json();
      if (res.ok) {
        setActions(prev => prev.filter(a => a.source_path !== action.source_path));
        setCommitMessage(`Successfully deleted ${action.book.title}`);
      } else {
        setCommitMessage(`Delete Error: ${data.error}`);
      }
    } catch (e: any) {
      setCommitMessage(`Delete Error: ${e.message}`);
    } finally {
      setIsDeleting(prev => ({ ...prev, [action.source_path]: false }));
    }
  };

  const integrateDuplicate = async (action: OrganizationAction) => {
    if (!window.confirm(`Are you sure you want to force integrate "${action.book.title}" even though a duplicate was detected?`)) return;
    
    setIsDeleting(prev => ({ ...prev, [action.source_path]: true }));
    try {
      const res = await fetch("/api/librarian/scan/integrate-duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_path: action.source_path })
      });
      const data = await res.json();
      if (res.ok) {
        setActions(prev => prev.filter(a => a.source_path !== action.source_path));
        setCommitMessage(`Successfully integrated ${action.book.title}`);
      } else {
        setCommitMessage(`Integration Error: ${data.error}`);
      }
    } catch (e: any) {
      setCommitMessage(`Integration Error: ${e.message}`);
    } finally {
      setIsDeleting(prev => ({ ...prev, [action.source_path]: false }));
    }
  };

  if (actions.length === 0 && !isScanActive && !commitMessage) return null;

  return (
    <div className="glass-panel" style={{ marginTop: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ margin: 0 }}>Action Required / Conflicts</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          {commitMessage && commitMessage.startsWith('Success') && actions.length === 0 && (
            <button 
              className="glass-button" 
              onClick={rollbackChanges} 
              disabled={isCommitting}
              style={{ 
                background: 'var(--bg-secondary)', 
                color: 'var(--text-primary)'
              }}
            >
              {isCommitting ? 'Rolling back...' : 'Undo Last Run'}
            </button>
          )}
          {!isScanActive && actions.length > 0 && (
            <button 
              className="glass-button" 
              onClick={commitChanges} 
              disabled={isCommitting || selectedPaths.size === 0}
              style={{ 
                background: 'var(--primary-accent)', 
                color: 'var(--bg-primary)',
                borderColor: 'transparent',
                opacity: selectedPaths.size === 0 ? 0.5 : 1
              }}
            >
              {isCommitting 
                ? (commitStatus ? `Moving ${commitStatus.executed + 1} of ${commitStatus.total}: ${commitStatus.currentFile}` : 'Committing...') 
                : `Commit ${selectedPaths.size} Changes`
              }
            </button>
          )}
        </div>
      </div>

      {commitMessage && (
        <div style={{ marginBottom: '16px', color: commitMessage.includes('Error') ? 'var(--secondary-accent)' : 'var(--primary-accent)' }}>
          {commitMessage}
        </div>
      )}

      {actions.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', textAlign: 'left' }}>
                <th style={{ padding: '8px 4px', width: '30px' }}>
                  <input 
                    type="checkbox" 
                    checked={actions.length > 0 && selectedPaths.size === actions.length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedPaths(new Set(actions.map(a => a.source_path)));
                      } else {
                        setSelectedPaths(new Set());
                      }
                    }}
                  />
                </th>
                <th style={{ padding: '8px 4px', color: 'var(--text-secondary)' }}>Book</th>
                <th style={{ padding: '8px 4px', color: 'var(--text-secondary)' }}>Action</th>
                <th style={{ padding: '8px 4px', color: 'var(--text-secondary)' }}>Reason</th>
                <th style={{ padding: '8px 4px', color: 'var(--text-secondary)', width: '60px' }}></th>
              </tr>
            </thead>
            <tbody>
              {actions.map((action, i) => {
                const isDuplicate = action.action_type === 'duplicate';
                const isEnhancing = enhancing[action.source_path];
                return (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', opacity: isDuplicate ? 0.7 : 1 }}>
                  <td style={{ padding: '8px 4px' }}>
                    <input 
                      type="checkbox" 
                      checked={selectedPaths.has(action.source_path)}
                      onChange={(e) => {
                        const ns = new Set(selectedPaths);
                        if (e.target.checked) ns.add(action.source_path);
                        else ns.delete(action.source_path);
                        setSelectedPaths(ns);
                      }}
                    />
                  </td>
                  <td style={{ padding: '8px 4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {action.book.cover_file ? (
                      <span title="Cover image detected" style={{ fontSize: '1.2rem' }}>🖼️</span>
                    ) : (
                      <span title="No cover image" style={{ fontSize: '1.2rem', opacity: 0.2 }}>📄</span>
                    )}
                    {action.book.title}
                  </td>
                  <td style={{ 
                    padding: '8px 4px', 
                    textTransform: 'uppercase', 
                    fontSize: '0.8rem', 
                    color: isDuplicate ? 'var(--secondary-accent)' : 'var(--primary-accent)',
                    fontWeight: isDuplicate ? 'bold' : 'normal'
                  }}>
                    {action.action_type}
                  </td>
                  <td style={{ 
                    padding: '8px 4px', 
                    color: isDuplicate ? 'var(--secondary-accent)' : 'var(--text-secondary)' 
                  }}>
                    {isDuplicate && absUrl && action.reason.includes('here') ? (
                      <>
                        {action.reason.split('here')[0]}
                        <a 
                          href={action.duplicate_abs_item_id 
                            ? `${absUrl.replace(/\/+$/, '')}/#/item/${action.duplicate_abs_item_id}` 
                            : `${absUrl.replace(/\/+$/, '')}/#/search?q=${encodeURIComponent(action.book.title)}`} 
                          target="_blank" 
                          rel="noreferrer"
                          style={{ color: 'var(--primary-accent)', textDecoration: 'underline' }}
                        >
                          here
                        </a>
                        {action.reason.split('here')[1]}
                      </>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span>{action.reason}</span>
                        {!isDuplicate && action.target_path && (
                          <div style={{ fontSize: '0.8rem', opacity: 0.8, fontFamily: 'monospace', background: 'var(--bg-secondary)', padding: '4px 6px', borderRadius: '4px', wordBreak: 'break-all' }}>
                            <span style={{ color: 'var(--text-tertiary)', marginRight: '4px' }}>↳</span>
                            {action.target_path}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '8px 4px', textAlign: 'right', display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
                    {isDuplicate && (
                      <>
                        <button 
                          className="glass-button" 
                          onClick={() => integrateDuplicate(action)}
                          disabled={isDeleting[action.source_path]}
                          title="Integrate Anyway"
                          style={{ 
                            padding: '4px 8px', 
                            fontSize: '0.8rem', 
                            opacity: isDeleting[action.source_path] ? 0.5 : 1,
                            background: 'transparent',
                            color: 'var(--primary-accent)'
                          }}
                        >
                          {isDeleting[action.source_path] ? '⏳' : '✅'}
                        </button>
                        <button 
                          className="glass-button" 
                          onClick={() => deleteDuplicate(action)}
                          disabled={isDeleting[action.source_path]}
                          title="Delete from Inbox"
                          style={{ 
                            padding: '4px 8px', 
                            fontSize: '0.8rem', 
                            opacity: isDeleting[action.source_path] ? 0.5 : 1,
                            background: 'transparent',
                            color: 'var(--secondary-accent)'
                          }}
                        >
                          {isDeleting[action.source_path] ? '⏳' : '🗑️'}
                        </button>
                      </>
                    )}
                    <button 
                      className="glass-button" 
                      onClick={() => enhanceMetadata(action)}
                      disabled={isEnhancing}
                      title="Fix with AI"
                      style={{ 
                        padding: '4px 8px', 
                        fontSize: '0.8rem', 
                        opacity: isEnhancing ? 0.5 : 1,
                        background: 'transparent'
                      }}
                    >
                      {isEnhancing ? '⏳' : '✨'}
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      
      {isScanActive && actions.length === 0 && (
        <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>
          Analyzing files...
        </div>
      )}

      {pendingEnhancement && (
        <EnhanceMetadataModal
          original={pendingEnhancement.original}
          suggested={pendingEnhancement.suggested}
          onAccept={(action) => {
            setActions(prev => prev.map(a => a.source_path === action.source_path ? action : a));
            setPendingEnhancement(null);
          }}
          onReject={() => setPendingEnhancement(null)}
        />
      )}
    </div>
  );
};
