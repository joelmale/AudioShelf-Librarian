import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, useInvalidate, useMutation, useOperation, useOperations, useTagStats } from '../api';
import { useToast } from '../toast';
import { TagAnalytics } from '../components/TagAnalytics';
import { PipelineRunsPanel } from '../components/PipelineRunsPanel';
import { VocabularySuggestionsPanel } from '../components/VocabularySuggestionsPanel';

// Claude Haiku 4.5 first-party API pricing, verified against
// https://docs.anthropic.com/en/docs/about-claude/pricing on 2026-08-22:
// $1/MTok input, $5/MTok output. These rates are correct and don't need
// updating — only the per-book token counts below are a rough fallback.
const IN_COST_PER_MTOK = 1.0;
const OUT_COST_PER_MTOK = 5.0;

// Fallback per-book token counts, used only when there's no run history yet
// to measure from. These predate the Phase 0 prompt change to "aim for
// 15-30 tags" and understate real output — prefer `avgTagTokens` from
// /tags/stats whenever it's available.
const FALLBACK_IN_PER_BOOK = 1800;
const FALLBACK_OUT_PER_BOOK = 300;

export interface MeasuredTagTokens {
  inputTokensPerBook: number;
  outputTokensPerBook: number;
  sampleSize: number;
}

export interface TagCostEstimate {
  /** Formatted as `$X.XX`. */
  cost: string;
  source: 'measured' | 'rough';
  /** Human-readable note on where the per-book token counts came from. */
  detail: string;
}

/**
 * Estimate the dollar cost of tagging `bookCount` books. Uses the caller's
 * measured per-book token averages (from recent real runs) when available,
 * falling back to the hardcoded rough constants otherwise. `bookCount`
 * should already reflect which run is being estimated — every active book
 * for a retag-all, only the untagged ones for a normal run.
 */
export function estimateTaggingCost(bookCount: number, measured: MeasuredTagTokens | null): TagCostEstimate {
  const inPerBook = measured?.inputTokensPerBook ?? FALLBACK_IN_PER_BOOK;
  const outPerBook = measured?.outputTokensPerBook ?? FALLBACK_OUT_PER_BOOK;
  const cost = (bookCount * inPerBook * IN_COST_PER_MTOK + bookCount * outPerBook * OUT_COST_PER_MTOK) / 1_000_000;
  return {
    cost: `$${cost.toFixed(2)}`,
    source: measured ? 'measured' : 'rough',
    detail: measured
      ? `estimate based on your last ${measured.sampleSize} tagged book${measured.sampleSize === 1 ? '' : 's'}`
      : 'rough estimate (no tagging history yet)',
  };
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
  const [retagAll, setRetagAll] = useState(false);
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
    mutationFn: () => (retagAll ? api.retagAll({ dryRun, sample }) : api.tagRun({ dryRun, sample })),
    onSuccess: () => {
      invalidate(['operations']);
      toast(dryRun ? 'Dry run started' : retagAll ? 'Retag started' : 'Tagging started', 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const untagged = stats.data?.untaggedBooks ?? 0;
  const total = stats.data?.totalBooks ?? 0;
  // A retag-all run processes every active book, not just the untagged ones.
  const runBookCount = retagAll ? total : untagged;
  const estimate = estimateTaggingCost(runBookCount, stats.data?.avgTagTokens ?? null);
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
          <div className="num">{estimate.cost}</div>
          <div className="label">Est. cost ({retagAll ? 'retag all' : 'full'})</div>
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
          <label className="checkbox">
            <input
              type="checkbox"
              checked={retagAll}
              onChange={(e) => setRetagAll(e.target.checked)}
              disabled={active}
            />
            Retag all books (clears existing tags first)
          </label>
          <span className="spacer" />
          <button className="btn" onClick={() => run.mutate()} disabled={Boolean(active) || runBookCount === 0}>
            {retagAll ? 'Retag entire library' : 'Tag all untagged'}
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {runBookCount} book{runBookCount === 1 ? '' : 's'} would be processed — {estimate.detail}.
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
        <PipelineRunsPanel />
      </div>

      <div style={{ marginTop: 40 }}>
        <VocabularySuggestionsPanel />
      </div>

      <div style={{ marginTop: 40 }}>
        <TagAnalytics />
      </div>
    </div>
  );
}
