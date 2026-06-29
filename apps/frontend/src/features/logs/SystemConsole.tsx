import React, { useEffect, useState, useRef } from "react";
import { useWebSocket } from "../../contexts/WebSocketProvider.js";

interface LogEntry {
  level: "info" | "warn" | "error";
  message: string;
  timestamp: string;
}

export const SystemConsole: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [debugEnabled, setDebugEnabled] = useState(true);
  const endOfLogsRef = useRef<HTMLDivElement>(null);
  const { lastMessage } = useWebSocket();

  // Fetch initial settings and logs
  useEffect(() => {
    fetch('/api/system/settings')
      .then(r => r.json())
      .then(data => {
        if (data.success && data.data) {
          setDebugEnabled(!!data.data.debugLogs);
        }
      })
      .catch(console.error);

    fetch('/api/system/logs')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setLogs(data);
        }
      })
      .catch(console.error);
  }, []);

  const toggleDebug = async () => {
    const newVal = !debugEnabled;
    try {
      await fetch('/api/system/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debugLogs: newVal })
      });
      setDebugEnabled(newVal);
    } catch (e) {
      console.error("Failed to toggle debug logs", e);
    }
  };

  useEffect(() => {
    if (lastMessage && lastMessage.type === "system:log") {
      setLogs(prev => {
        const newLogs = [...prev, lastMessage.payload];
        if (newLogs.length > 1500) return newLogs.slice(newLogs.length - 1500);
        return newLogs;
      });
    }
  }, [lastMessage]);

  useEffect(() => {
    if (endOfLogsRef.current) {
      endOfLogsRef.current.scrollIntoView();
    }
  }, [logs]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
          Real-time backend system output. Helpful for debugging scanner traversal and backend jobs.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.9rem' }}>
          <input 
            type="checkbox" 
            checked={debugEnabled} 
            onChange={toggleDebug} 
          />
          Enable Verbose Output
        </label>
      </div>

      <div style={{
        background: '#1e1e1e',
        color: '#d4d4d4',
        padding: '16px',
        borderRadius: '8px',
        fontFamily: 'monospace',
        fontSize: '0.85rem',
        height: '500px',
        overflowY: 'auto',
        border: '1px solid var(--glass-border)',
        boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)'
      }}>
        {logs.length === 0 ? (
          <div style={{ color: '#808080', fontStyle: 'italic' }}>No system logs available yet...</div>
        ) : (
          logs.map((l, i) => (
            <div key={i} style={{ 
              marginBottom: '4px',
              color: l.level === 'error' ? '#f48771' : l.level === 'warn' ? '#cca700' : '#d4d4d4',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all'
            }}>
              <span style={{ color: '#808080', marginRight: '8px' }}>
                [{new Date(l.timestamp).toLocaleTimeString()}]
              </span>
              {l.message}
            </div>
          ))
        )}
        <div ref={endOfLogsRef} />
      </div>
    </div>
  );
};
