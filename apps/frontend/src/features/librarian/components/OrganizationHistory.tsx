import React, { useEffect, useState } from "react";
import { OrganizationAction } from "@audioshelf/shared";

interface HistoryBatch {
  id: string;
  timestamp: string;
  actions: OrganizationAction[];
}

export const OrganizationHistory: React.FC = () => {
  const [history, setHistory] = useState<HistoryBatch[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/librarian/scan/history");
      const data = await res.json();
      if (data.success) {
        setHistory(data.data);
      }
    } catch (e) {
      console.error("Failed to load history", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
    // Refresh history every 10 seconds just in case
    const interval = setInterval(fetchHistory, 10000);
    return () => clearInterval(interval);
  }, []);

  if (history.length === 0) return null;

  return (
    <div className="glass-panel" style={{ marginTop: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ margin: 0 }}>Organization History</h3>
        <button className="glass-button" onClick={fetchHistory} disabled={loading} style={{ padding: '4px 8px', fontSize: '0.8rem' }}>
          Refresh
        </button>
      </div>

      <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
        {history.map(batch => (
          <div key={batch.id} style={{ marginBottom: '16px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '16px' }}>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '8px' }}>
              <strong>Batch:</strong> {new Date(batch.timestamp).toLocaleString()}
            </div>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <tbody>
                {batch.actions.map((action, i) => (
                  <tr key={i}>
                    <td style={{ padding: '4px 0' }}>{action.book.title}</td>
                    <td style={{ padding: '4px 0', color: 'var(--primary-accent)' }}>{action.action_type}</td>
                    <td style={{ padding: '4px 0', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{action.target_path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
};
