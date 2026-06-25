import type { EncodeControl } from '../ws';

const ACTIVE = new Set(['running', 'paused']);

/** Molecule: pause/resume/cancel buttons wired to the WebSocket control channel. */
export function JobControls({
  status,
  onControl,
}: {
  status: string | null;
  onControl: (action: EncodeControl) => void;
}) {
  if (!status || !ACTIVE.has(status)) return null;
  return (
    <div className="row" style={{ gap: 8 }}>
      {status === 'running' && (
        <button className="btn secondary" onClick={() => onControl('pause')}>
          Pause
        </button>
      )}
      {status === 'paused' && (
        <button className="btn secondary" onClick={() => onControl('resume')}>
          Resume
        </button>
      )}
      <button className="btn danger" onClick={() => onControl('cancel')}>
        Cancel
      </button>
    </div>
  );
}
