import { useEffect, useRef } from 'react';

import { Badge } from '../atoms/Badge';
import { LogLine } from '../atoms/LogLine';
import { ProgressBar } from '../atoms/ProgressBar';
import { JobControls } from '../molecules/JobControls';
import { useEncodeSocket } from '../ws';

/**
 * Organism: the live, WebSocket-driven encode console. Streams subprocess log
 * lines and progress, and exposes pause/resume/cancel over the same socket.
 */
export function EncodeConsole({ operationId }: { operationId: string }) {
  const { connected, lines, progress, status, control } = useEncodeSocket(operationId);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView();
  }, [lines]);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <strong>Encode console</strong>
        {status && <Badge status={status} />}
        <span className="muted">{connected ? 'live' : 'disconnected'}</span>
        <span className="spacer" />
        <JobControls status={status} onControl={control} />
      </div>

      {progress && (
        <div style={{ marginBottom: 8 }}>
          <div className="muted" style={{ marginBottom: 4 }}>
            {progress.current} / {progress.total} {progress.message ? `· ${progress.message}` : ''}
          </div>
          <ProgressBar current={progress.current} total={progress.total} />
        </div>
      )}

      <div className="log-stream">
        {lines.length === 0 && <div className="muted">Waiting for output…</div>}
        {lines.map((l, i) => (
          <LogLine key={i} ts={l.ts} line={l.line} />
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
