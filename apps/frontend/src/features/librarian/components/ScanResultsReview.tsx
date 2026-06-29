import React, { useEffect, useState } from "react";
import { useWebSocket } from "../../../contexts/WebSocketProvider.js";
import type { OrganizationAction } from "@audioshelf/shared";

export const ScanResultsReview: React.FC = () => {
  const { lastMessage } = useWebSocket();
  const [actions, setActions] = useState<OrganizationAction[]>([]);
  const [isScanActive, setIsScanActive] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitMessage, setCommitMessage] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.type === "librarian:scan_progress") {
      const status = lastMessage.payload.status;
      if (status === "scanning") {
        if (!isScanActive) {
          // New scan started, clear old actions
          setActions([]);
          setCommitMessage(null);
          setIsScanActive(true);
        }
      } else {
        // completed, error, or cancelled
        setIsScanActive(false);
        if (status === "completed" && lastMessage.payload.results) {
          setActions(lastMessage.payload.results);
        }
      }
    }

    if (lastMessage.type === "librarian:scan_action") {
      setActions(prev => [...prev, lastMessage.payload as OrganizationAction]);
    }
  }, [lastMessage, isScanActive]);

  const commitChanges = async () => {
    setIsCommitting(true);
    setCommitMessage(null);
    try {
      const res = await fetch("/api/librarian/scan/commit", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setCommitMessage(`Error: ${data.error}`);
      } else {
        setCommitMessage(`Success: ${data.message} (${data.total} actions)`);
        setActions([]);
      }
    } catch (e: any) {
      setCommitMessage(`Error: ${e.message}`);
    } finally {
      setIsCommitting(false);
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
        setActions(prev => prev.map(a => a.source_path === action.source_path ? data.data : a));
      } else {
        setCommitMessage(`Enhance Error: ${data.error}`);
      }
    } catch (e: any) {
      setCommitMessage(`Enhance Error: ${e.message}`);
    } finally {
      setEnhancing(prev => ({ ...prev, [action.source_path]: false }));
    }
  };

  if (actions.length === 0 && !isScanActive && !commitMessage) return null;

  return (
    <div className="glass-panel" style={{ marginTop: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ margin: 0 }}>Proposed Actions (Dry Run)</h3>
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
              disabled={isCommitting}
              style={{ 
                background: 'var(--primary-accent)', 
                color: 'var(--bg-primary)',
                borderColor: 'transparent'
              }}
            >
              {isCommitting ? 'Committing...' : 'Commit Changes'}
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
                    {action.reason}
                  </td>
                  <td style={{ padding: '8px 4px', textAlign: 'right' }}>
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
    </div>
  );
};
