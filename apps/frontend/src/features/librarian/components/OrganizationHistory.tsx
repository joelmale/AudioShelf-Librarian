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

  const undoBatch = async (batchId: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/librarian/scan/rollback", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Rollback Error: ${data.error}`);
      } else {
        alert(`Rollback Success: ${data.message}`);
        fetchHistory(); // Refresh after successful rollback
      }
    } catch (e: any) {
      alert(`Rollback Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  if (history.length === 0) return null;

  return (
    <div className="v2-card" style={{ marginTop: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ margin: 0 }}>Organization History</h3>
        <button className="v2-button v2-button-secondary" onClick={fetchHistory} disabled={loading} style={{ padding: '4px 12px', fontSize: '0.8rem' }}>
          Refresh
        </button>
      </div>

      <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
        {history.map(batch => (
          <div key={batch.id} style={{ marginBottom: '16px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                <strong>Batch:</strong> {new Date(batch.timestamp).toLocaleString()}
              </div>
              <button 
                className="v2-button v2-button-secondary" 
                onClick={() => undoBatch(batch.id)} 
                disabled={loading}
                style={{ padding: '4px 12px', fontSize: '0.75rem' }}
                title="Undo this specific batch of changes"
              >
                Undo
              </button>
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
