import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, useInvalidate, useMutation, useOperation, useOperations, useTagStats } from '../api';
import { useToast } from '../toast';
import { TagAnalytics } from '../components/TagAnalytics';

// Rough Haiku pricing for the running estimate ($/1M tokens).
const IN_PER_BOOK = 1800;
const OUT_PER_BOOK = 300;
const IN_COST = 1.0;
const OUT_COST = 5.0;

function estimateCost(books: number): string {
  const cost = (books * IN_PER_BOOK * IN_COST + books * OUT_PER_BOOK * OUT_COST) / 1_000_000;
  return `$${cost.toFixed(2)}`;
}

function RadialProgress({ progress }: { progress: number }) {
  const radius = 60;
  const stroke = 8;
  const normalizedRadius = radius - stroke * 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  return (
    <div className="progress-ring-container">
      <svg height={radius * 2} width={radius * 2} className="progress-ring">
        <circle
          className="progress-ring-circle-bg"
          r={normalizedRadius}
          cx={radius}
          cy={radius}
        />
        <circle
          className="progress-ring-circle"
          r={normalizedRadius}
          cx={radius}
          cy={radius}
          strokeDasharray={circumference + ' ' + circumference}
          style={{ strokeDashoffset }}
        />
      </svg>
      <div className="progress-ring-text">
        {progress}%
      </div>
    </div>
  );
}

export function Tagging() {
  const stats = useTagStats();
  const toast = useToast();
  const invalidate = useInvalidate();
  const operationsQuery = useOperations();
  const activeTagOp = operationsQuery.data?.find(o => o.type === 'tag' && !['completed', 'cancelled', 'error'].includes(o.status));
  const opId = activeTagOp?.id;
  
  const [dryRun, setDryRun] = useState(false);
  const [sample, setSample] = useState(false);
  const op = useOperation(opId || null);
  const feedContainerRef = useRef<HTMLDivElement>(null);

  const logs = useQuery({
    queryKey: ['actionLogs', opId],
    queryFn: () => api.actionLogs({ operationId: opId as string, limit: '200' }),
    enabled: Boolean(opId),
    refetchInterval: op.data && ['completed', 'cancelled', 'error'].includes(op.data.status) ? false : 1000,
  });

  useEffect(() => {
    if (feedContainerRef.current) {
      feedContainerRef.current.scrollTop = feedContainerRef.current.scrollHeight;
    }
  }, [logs.data]);

  useEffect(() => {
    if (op.data && ['completed', 'cancelled', 'error'].includes(op.data.status)) {
      invalidate(['tagStats', 'books', 'vocabulary']);
    }
  }, [op.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useMutation({
    mutationFn: () => api.tagRun({ dryRun, sample }),
    onSuccess: () => {
      invalidate(['operations']);
      toast(dryRun ? 'Dry run started' : 'Tagging started', 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const untagged = stats.data?.untaggedBooks ?? 0;
  const active = op.data && !['completed', 'cancelled', 'error'].includes(op.data.status);
  const progress = op.data?.progress;
  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div>
      <h1>Tagging</h1>
      <div className="grid stat-grid">
        <div className="card stat">
          <div className="num">{stats.data?.taggedBooks ?? '—'}</div>
          <div className="label">Tagged</div>
        </div>
        <div className="card stat">
          <div className="num">{untagged}</div>
          <div className="label">Untagged</div>
        </div>
        <div className="card stat">
          <div className="num">{estimateCost(untagged)}</div>
          <div className="label">Est. cost (full)</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row">
          <label className="checkbox">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={active} />
            Dry run (no API calls)
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} disabled={active} />
            Sample only (max 20 or 5%)
          </label>
          <span className="spacer" />
          <button className="btn" onClick={() => run.mutate()} disabled={Boolean(active) || untagged === 0}>
            Tag all untagged
          </button>
        </div>

        {op.data && (
          <div className="glass-hero" style={{ marginTop: 24 }}>
            {active && op.data.status === 'running' && (
              <div className="ai-pulsing-indicator">
                <div className="ai-dot" />
                AI Tagging in Progress...
              </div>
            )}
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
              <RadialProgress progress={pct} />
              
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: '1.2rem' }}>
                  Processing Batch
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                  <span className={`badge ${op.data.status}`}>{op.data.status.toUpperCase()}</span>
                  <span className="muted" style={{ fontWeight: 500 }}>
                    {progress?.current ?? 0} of {progress?.total ?? 0} Books Completed
                  </span>
                </div>
                {progress?.message && (
                  <div style={{ color: 'var(--accent)', fontWeight: 500, fontSize: '13px' }}>
                    Currently analyzing: {progress.message}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {active && op.data.status === 'running' && (
                  <button className="glass-btn" onClick={() => api.pauseOp(op.data!.id)}>
                    Pause Workflow
                  </button>
                )}
                {active && op.data.status === 'paused' && (
                  <button className="glass-btn" onClick={() => api.resumeOp(op.data!.id)}>
                    Resume Workflow
                  </button>
                )}
                {active && (
                  <button className="glass-btn danger" onClick={() => api.cancelOp(op.data!.id)}>
                    Cancel Workflow
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {opId && (
        <div style={{ marginTop: 32 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            Live Neural Feed
            {active && op.data.status === 'running' && (
               <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 5px var(--green)', animation: 'pulse-glow 1s infinite alternate' }} />
            )}
          </h2>
          <div className="live-neural-feed" ref={feedContainerRef}>
            {(logs.data ?? []).map((l, i) => {
              // Determine class based on level/message
              let levelClass = 'info';
              if (l.level === 'error') levelClass = 'error';
              else if (l.level === 'warn') levelClass = 'warn';
              else if (l.message.toLowerCase().includes('success') || l.message.toLowerCase().includes('completed') || l.message.toLowerCase().includes('saved')) {
                levelClass = 'success';
              }

              return (
                <div key={i} className={`neural-line ${levelClass}`}>
                  <span className="neural-time">[{new Date(l.ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]</span>
                  <span className="neural-event">[{l.event}]</span>
                  <span className="neural-msg">{l.message}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ marginTop: 40 }}>
        <TagAnalytics />
      </div>
    </div>
  );
}
