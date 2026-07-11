import React from "react";

interface AntiBotChallengeModalProps {
  challengeUrl: string;
  onClose: (success: boolean) => void;
}

export const AntiBotChallengeModal: React.FC<AntiBotChallengeModalProps> = ({ challengeUrl, onClose }) => {
  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999
    }}>
      <div className="glass-panel" style={{ 
        width: '90%', 
        maxWidth: '800px', 
        height: '80vh', 
        display: 'flex', 
        flexDirection: 'column',
        padding: '0' 
      }}>
        <div style={{ 
          padding: '16px 24px', 
          borderBottom: '1px solid var(--glass-border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'rgba(255,255,255,0.4)'
        }}>
          <div>
            <h3 style={{ margin: 0 }}>Anti-Bot Challenge Detected</h3>
            <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Please solve the challenge below to continue. The system will resume automatically.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="glass-button" onClick={() => onClose(true)}>
              I Solved It
            </button>
            <button className="glass-button" style={{ background: 'var(--secondary-accent)' }} onClick={() => onClose(false)}>
              Cancel
            </button>
          </div>
        </div>
        
        <div style={{ flexGrow: 1, padding: '0', overflow: 'hidden' }}>
          <iframe 
            src={`/api/librarian/abb/proxy${new URL(challengeUrl).pathname}${new URL(challengeUrl).search}`} 
            style={{ width: '100%', height: '100%', border: 'none' }}
            title="Cloudflare Challenge"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>
      </div>
    </div>
  );
};
