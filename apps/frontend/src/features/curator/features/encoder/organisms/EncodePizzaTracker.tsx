import React from 'react';
import { useEncodeSocket } from '../ws';

export function EncodePizzaTracker({ itemId }: { itemId: string }) {
  const { connected, progress, status } = useEncodeSocket(itemId);

  // Pizza tracker steps: Initializing, Encoding, Finalizing
  // If progress > 0, we are at Encoding.
  // If progress === 100 or status is completed, Finalizing.
  
  const currentProgress = progress?.current || 0;
  
  let stepIndex = 0;
  if (currentProgress > 0 && currentProgress < 100) stepIndex = 1;
  else if (currentProgress === 100 || status === 'completed') stepIndex = 2;

  const steps = ['Initializing', 'Encoding', 'Finalizing'];

  return (
    <div style={{ marginTop: '12px', padding: '12px', background: 'var(--surface-color, #1e1e1e)', borderRadius: '8px', border: '1px solid var(--border-color, #333)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontSize: '0.85em', color: 'var(--muted-color, #888)' }}>
          {connected ? 'Live Sync Active' : 'Connecting to Encode Hub...'}
        </div>
        <div style={{ fontSize: '0.85em', fontWeight: 600 }}>
          {currentProgress.toFixed(0)}%
        </div>
      </div>
      
      {/* Tracker Bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {steps.map((step, idx) => {
          const isActive = idx === stepIndex;
          const isDone = idx < stepIndex;
          
          let circleBg = 'transparent';
          let circleColor = 'var(--muted-color, #888)';
          let borderColor = 'var(--border-color, #444)';
          
          if (isDone) {
            circleBg = 'var(--primary-color, #007bff)';
            circleColor = '#fff';
            borderColor = 'var(--primary-color, #007bff)';
          } else if (isActive) {
            circleBg = 'rgba(0, 123, 255, 0.2)';
            circleColor = 'var(--primary-color, #007bff)';
            borderColor = 'var(--primary-color, #007bff)';
          }

          return (
            <React.Fragment key={step}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', flex: 1 }}>
                <div style={{ 
                  width: '24px', height: '24px', borderRadius: '50%', 
                  background: circleBg, color: circleColor, border: `2px solid ${borderColor}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px',
                  fontWeight: 'bold', transition: 'all 0.3s'
                }}>
                  {isDone ? '✓' : (idx + 1)}
                </div>
                <div style={{ fontSize: '0.75em', color: isActive || isDone ? 'var(--text-color, #fff)' : 'var(--muted-color, #888)' }}>
                  {step}
                </div>
              </div>
              {idx < steps.length - 1 && (
                <div style={{ flex: 1, height: '2px', background: isDone ? 'var(--primary-color, #007bff)' : 'var(--border-color, #444)', transition: 'all 0.3s' }} />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
