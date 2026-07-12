import { useEncodeSocket } from '../ws';

export function EncodePizzaTracker({ itemId }: { itemId: string }) {
  const { connected, progress, status } = useEncodeSocket(itemId);

  const currentProgress = progress?.current || 0;
  
  let stepIndex = 0;
  if (currentProgress > 0 && currentProgress < 100) stepIndex = 1;
  else if (currentProgress === 100 || status === 'completed') stepIndex = 2;

  const steps = ['Initializing', 'Encoding', 'Finalizing'];

  return (
    <div style={{ marginTop: '16px', marginBottom: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', padding: '0 4px' }}>
        <div style={{ fontSize: '0.85em', color: 'var(--muted-color, #888)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ 
            width: '8px', height: '8px', borderRadius: '50%', 
            backgroundColor: connected ? 'var(--success-color, #28a745)' : 'var(--warning-color, #ffc107)' 
          }} />
          {connected ? 'Live Sync Active' : 'Connecting...'}
        </div>
        {stepIndex === 1 && (
          <div style={{ fontSize: '0.85em', fontWeight: 600, color: 'var(--text-color, #ffffff)' }}>
            {currentProgress.toFixed(0)}%
          </div>
        )}
      </div>
      
      {/* Tracker Bar */}
      <div style={{ 
        display: 'flex', 
        height: '40px',
        overflow: 'hidden',
        borderRadius: '8px',
        border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.8))',
        backgroundColor: 'var(--glass-bg, rgba(255, 255, 255, 0.5))',
      }}>
        {steps.map((step, idx) => {
          const isActive = idx === stepIndex;
          const isDone = idx < stepIndex;
          
          let bgColor = 'transparent';
          let textColor = 'var(--muted-color, #888)';
          
          if (isDone) {
            bgColor = 'var(--primary-color, #007bff)';
            textColor = '#ffffff';
          } else if (isActive) {
            bgColor = 'color-mix(in srgb, var(--primary-color, #007bff) 40%, rgba(255,255,255,0.1))';
            textColor = '#ffffff';
          }

          // We use clip-path to create slanted dividers. 
          // First item: straight left, slanted right.
          // Middle items: slanted left, slanted right.
          // Last item: slanted left, straight right.
          let clipPath = 'polygon(0 0, calc(100% - 15px) 0, 100% 100%, 0 100%)';
          if (idx === 0) clipPath = 'polygon(0 0, calc(100% - 15px) 0, 100% 100%, 0 100%)';
          else if (idx === steps.length - 1) clipPath = 'polygon(0 0, 100% 0, 100% 100%, 15px 100%)';
          else clipPath = 'polygon(0 0, calc(100% - 15px) 0, 100% 100%, 15px 100%)';

          // Ensure overlap so the slant lines up perfectly. We use negative margins.
          const isFirst = idx === 0;

          return (
            <div 
              key={step} 
              style={{ 
                flex: 1, 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center',
                backgroundColor: bgColor,
                color: textColor,
                clipPath,
                marginLeft: isFirst ? '0' : '-15px',
                paddingLeft: isFirst ? '0' : '15px', // compensate for the slant overlap
                fontWeight: isActive || isDone ? 600 : 400,
                transition: 'all 0.3s ease',
                position: 'relative',
                zIndex: isActive ? 10 : (isDone ? 5 : 1),
                borderRight: (idx < steps.length - 1 && !isActive && !isDone) ? '1px solid var(--glass-border, rgba(255, 255, 255, 0.8))' : 'none'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {isDone && <span style={{ fontSize: '14px' }}>✓</span>}
                <span style={{ fontSize: '0.85em', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {step}
                </span>
              </div>
              
              {/* If active, optionally add a pulsing bottom border or glow */}
              {isActive && (
                <div style={{
                  position: 'absolute',
                  bottom: 0, left: 0, right: 0,
                  height: '3px',
                  backgroundColor: 'var(--primary-color, #007bff)'
                }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
