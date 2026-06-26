import React, { useEffect, useState } from "react";
import { useWebSocket } from "../../../contexts/WebSocketProvider.js";
import type { OrganizationAction } from "@audioshelf/shared";

export const ScanResultsReview: React.FC = () => {
  const { lastMessage } = useWebSocket();
  const [actions, setActions] = useState<OrganizationAction[]>([]);
  const [isScanActive, setIsScanActive] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitMessage, setCommitMessage] = useState<string | null>(null);

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

  if (actions.length === 0 && !isScanActive && !commitMessage) return null;

  return (
    <div className="glass-panel" style={{ marginTop: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ margin: 0 }}>Proposed Actions (Dry Run)</h3>
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

      {commitMessage && (
        <div style={{ marginBottom: '16px', color: commitMessage.startsWith('Error') ? 'var(--secondary-accent)' : 'var(--primary-accent)' }}>
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
              </tr>
            </thead>
            <tbody>
              {actions.map((action, i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '8px 4px' }}>{action.book.title}</td>
                  <td style={{ padding: '8px 4px', textTransform: 'uppercase', fontSize: '0.8rem', color: 'var(--primary-accent)' }}>
                    {action.action_type}
                  </td>
                  <td style={{ padding: '8px 4px', color: 'var(--text-secondary)' }}>{action.reason}</td>
                </tr>
              ))}
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
