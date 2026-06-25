import React, { useEffect, useState } from "react";
import { useWebSocket } from "../../../contexts/WebSocketProvider.js";

export const ProgressTracker: React.FC = () => {
  const { lastMessage } = useWebSocket();
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("Idle");
  const [currentFile, setCurrentFile] = useState("");

  useEffect(() => {
    if (lastMessage?.type === "librarian:scan_progress") {
      const payload = lastMessage.payload;
      if (payload.total > 0) {
        setProgress((payload.scanned / payload.total) * 100);
      }
      
      setStatusText(payload.status.charAt(0).toUpperCase() + payload.status.slice(1));
      setCurrentFile(payload.currentFile);
    }
  }, [lastMessage]);

  return (
    <div className="glass-panel progress-container" style={{ marginTop: '24px' }}>
      <h3 style={{ marginTop: 0, marginBottom: '16px' }}>Scan Progress</h3>
      
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        <span>Status: {statusText}</span>
        <span>{Math.round(progress)}%</span>
      </div>

      <div style={{
        width: '100%',
        height: '8px',
        background: 'rgba(0,0,0,0.3)',
        borderRadius: '4px',
        overflow: 'hidden',
        position: 'relative'
      }}>
        <div style={{
          width: `${progress}%`,
          height: '100%',
          background: 'linear-gradient(90deg, var(--primary-accent), var(--secondary-accent))',
          boxShadow: '0 0 10px var(--secondary-glow)',
          transition: 'width 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
        }} />
      </div>

      <div style={{ 
        marginTop: '12px', 
        fontSize: '0.85rem', 
        color: 'var(--text-secondary)',
        minHeight: '20px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }}>
        {currentFile ? `Scanning: ${currentFile}` : 'Ready...'}
      </div>
    </div>
  );
};
