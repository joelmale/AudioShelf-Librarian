import { useState, type ReactNode } from 'react';

interface ExpandableChartProps {
  title: string;
  previewHeight: number;
  children: (isExpanded: boolean) => ReactNode;
}

export function ExpandableChart({ title, previewHeight, children }: ExpandableChartProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <>
      <div className="card" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button 
            className="btn icon-btn" 
            onClick={() => setIsExpanded(true)}
            title="Expand chart"
            style={{ 
              background: 'transparent', 
              border: 'none', 
              cursor: 'pointer', 
              padding: '4px',
              color: 'var(--text)',
              opacity: 0.6
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6" />
              <path d="M9 21H3v-6" />
              <path d="M21 3l-7 7" />
              <path d="M3 21l7-7" />
            </svg>
          </button>
        </div>
        
        <div style={{ width: '100%', height: `${previewHeight}px`, overflow: 'hidden' }}>
          {children(false)}
        </div>
      </div>

      {isExpanded && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000,
          padding: '24px'
        }}>
          <div className="card" style={{ 
            width: '90%', 
            height: '90vh', 
            display: 'flex', 
            flexDirection: 'column',
            backgroundColor: 'var(--bg)',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ margin: 0 }}>{title}</h2>
              <button 
                className="btn icon-btn" 
                onClick={() => setIsExpanded(false)}
                title="Close"
                style={{ 
                  background: 'transparent', 
                  border: 'none', 
                  cursor: 'pointer', 
                  padding: '8px',
                  color: 'var(--text)'
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            
            <div style={{ flex: 1, minHeight: 0, width: '100%' }}>
              {children(true)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
